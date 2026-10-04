import { bufferResultWrites, commitWorkerCompletion, getWorkerLease, renewWorkerLease, WORKER_HEARTBEAT_SECONDS, WORKER_LEASE_SECONDS } from "./operation-lifecycle";
import {
  AI_OPERATION_TYPES,
  constantTimeEqual,
  contentTypeFor,
  nowIso,
  problem,
  safeObjectKeyPart,
  sha256,
  type Row,
} from "./common";
import {
  createOperation,
  finishOperation,
  getJob,
  getNetworkingCompany,
  getOperation,
  listJobs,
  markOperationRunning,
  saveJobSources,
  setJobStatus,
  type StorageEnv,
} from "./store";

export interface BridgeEnv extends StorageEnv {
  CAREER_API_URL?: string;
  CAREER_PROXY_SECRET?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  CAREER_WORKER_CALLBACK_SECRET?: string;
}

const MAX_CANDIDATE_RESUME_BYTES = 2 * 1024 * 1024;
const JOB_SOURCE_FINGERPRINT_FIELDS = [
  "job_id",
  "title",
  "company",
  "location",
  "source",
  "url",
  "description",
  "found_date",
  "posted_at",
  "lane_hint",
  "dedupe_key",
  "company_key",
  "title_key",
  "description_fingerprint",
  "opportunity_key",
  "opportunity_grouping_version",
  "discovery_url",
  "source_tier",
  "source_status",
  "source_checked_at",
] as const;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value ?? null;
}

function projectedJobSource(job: Row) {
  const projected: Row = {};
  for (const field of JOB_SOURCE_FINGERPRINT_FIELDS) projected[field] = canonicalJson(job[field]);
  projected.source_resolution = canonicalJson(job.source_resolution);
  return projected;
}

export function jobSourceFingerprintMaterial(job: Row) {
  const sourceCandidates = Array.isArray(job.source_candidates)
    ? (job.source_candidates as Row[])
      .map((candidate) => ({
        label: String(candidate.label ?? ""),
        url: String(candidate.url ?? ""),
        source_tier: String(candidate.source_tier ?? ""),
        position: Number(candidate.position ?? 0),
      }))
      .sort((left, right) => left.position - right.position || left.url.localeCompare(right.url) || left.label.localeCompare(right.label))
    : [];
  const opportunityVariants = Array.isArray(job.opportunity_variants)
    ? (job.opportunity_variants as Row[])
      .map(projectedJobSource)
      .sort((left, right) => String(left.job_id).localeCompare(String(right.job_id)))
    : [];
  return canonicalJson({
    ...projectedJobSource(job),
    source_candidates: sourceCandidates,
    opportunity_variants: opportunityVariants,
  });
}

export async function jobSourceFingerprint(job: Row) {
  return sha256(JSON.stringify(jobSourceFingerprintMaterial(job)));
}

function proxyHeaders(env: BridgeEnv) {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (env.CAREER_PROXY_SECRET) headers.set("X-Career-Proxy-Secret", env.CAREER_PROXY_SECRET);
  if (env.CF_ACCESS_CLIENT_ID) headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  if (env.CF_ACCESS_CLIENT_SECRET) headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
  return headers;
}

async function workstationRequest(env: BridgeEnv, path: string, init: RequestInit = {}, timeoutMs = 4000) {
  if (!env.CAREER_API_URL || !env.CAREER_PROXY_SECRET) throw new Error("The workstation connection is not configured.");
  const target = new URL(path, env.CAREER_API_URL.endsWith("/") ? env.CAREER_API_URL : `${env.CAREER_API_URL}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target, { ...init, headers: proxyHeaders(env), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function workstationStatus(env: BridgeEnv) {
  try {
    const response = await workstationRequest(env, "/api/worker/health", {}, 3000);
    if (!response.ok) return { ok: false, mode: "headless", error: "Workstation worker is unavailable." };
    const detail = await response.json() as Row;
    if (Number(detail.protocol_version || 0) < 2) return { ok: false, mode: "headless", error: "Restart the workstation API to enable operation heartbeats." };
    return {
      ok: Boolean(detail.ok ?? detail.online),
      mode: "headless",
      message: "Workstation worker is online.",
      capabilities: detail.capabilities ?? [...AI_OPERATION_TYPES],
      available_slots: detail.available_slots ?? 1,
    };
  } catch {
    return { ok: false, mode: "headless", error: "Workstation worker is offline." };
  }
}

export async function activeCandidateContext(env: BridgeEnv) {
  const profile = await env.DB.prepare(
    "select context_version from profile_versions where is_active=1 order by created_at desc limit 1",
  ).first<Row>();
  if (!profile?.context_version) {
    throw new Error("No active candidate profile is available in Sites. Publish a profile before running AI actions.");
  }
  const contextVersion = String(profile.context_version);
  const stored = await env.DB.prepare(
    "select object_key,size_bytes from stored_objects where category='profile' and owner_key=? and logical_name='resume_text'",
  ).bind(contextVersion).first<Row>();
  if (!stored?.object_key) {
    throw new Error("The active candidate profile is missing its resume text in Sites storage. Publish the profile again.");
  }
  const recordedSize = Number(stored.size_bytes || 0);
  if (recordedSize > MAX_CANDIDATE_RESUME_BYTES) {
    throw new Error("The active candidate resume text exceeds the 2 MB worker limit.");
  }
  const object = await env.BUCKET.get(String(stored.object_key));
  if (!object) {
    throw new Error("The active candidate resume text could not be found in Sites storage. Publish the profile again.");
  }
  if (object.size > MAX_CANDIDATE_RESUME_BYTES) {
    throw new Error("The active candidate resume text exceeds the 2 MB worker limit.");
  }
  const resumeText = await object.text();
  if (new TextEncoder().encode(resumeText).byteLength > MAX_CANDIDATE_RESUME_BYTES) {
    throw new Error("The active candidate resume text exceeds the 2 MB worker limit.");
  }
  if (!resumeText.trim()) {
    throw new Error("The active candidate resume text is empty. Publish the profile again before running AI actions.");
  }
  // Hosted profiles carry verified background and preferences, not local repo facts.
  const additional = await env.BUCKET.get("profile/" + contextVersion + "/candidate-context.json");
  const profileContext = additional ? await additional.json<Row>() : {};
  return { context_version: contextVersion, resume_text: resumeText,
    background: typeof profileContext.background === "string" ? profileContext.background : "",
    preferences: typeof profileContext.preferences === "string" ? profileContext.preferences : "" };
}

function resourceKey(operationType: string, payload: Row) {
  if (operationType === "analyze_job" || operationType === "build_packet") return String(payload.job_id);
  if (operationType === "research_company") return String(payload.company_key);
  if (operationType === "research_role") return `${payload.company_key}:${payload.opportunity_key}`;
  if (operationType === "daily_report") return String(payload.date || "today");
  throw new Error("Unsupported workstation operation.");
}

async function operationInput(env: BridgeEnv, operationType: string, payload: Row) {
  const candidateContext = await activeCandidateContext(env);
  if (operationType === "analyze_job" || operationType === "build_packet") {
    const job = await getJob(env.DB, String(payload.job_id));
    if (!job) throw new Error("Job not found.");
    return { job, candidate_context: candidateContext };
  }
  if (operationType === "research_company" || operationType === "research_role") {
    const company = await getNetworkingCompany(env.DB, String(payload.company_key));
    if (!company) throw new Error("Networking company not found.");
    const jobs = [];
    for (const role of company.roles as Row[]) {
      const job = await getJob(env.DB, String(role.job_id));
      if (job) jobs.push(job);
    }
    return { company, jobs, opportunity_key: payload.opportunity_key ?? null, candidate_context: candidateContext };
  }
  if (operationType === "daily_report") {
    const date = String(payload.date || new Date().toISOString().slice(0, 10));
    const url = new URL("https://site.invalid/api/jobs");
    url.searchParams.set("date", date);
    const summaries = await listJobs(env.DB, url);
    const jobs = [];
    for (const summary of summaries) {
      const job = await getJob(env.DB, String(summary.job_id));
      if (job) jobs.push(job);
    }
    return { date, jobs, candidate_context: candidateContext };
  }
  throw new Error("Unsupported workstation operation.");
}

export async function dispatchWorkstationOperation(env: BridgeEnv, operationType: string, payload: Row) {
  if (!AI_OPERATION_TYPES.has(operationType)) throw new Error("Unsupported workstation operation.");
  const input = await operationInput(env, operationType, payload);
  const requestedAt = nowIso();
  const inputHash = await sha256(JSON.stringify(input));
  const operationPayload: Row = { ...payload, _input_hash: inputHash };
  if (operationType === "analyze_job") {
    operationPayload._job_source_fingerprint = await jobSourceFingerprint((input as Row).job as Row);
  }
  const created = await createOperation(env.DB, operationType, resourceKey(operationType, payload), operationPayload, "workstation", "starting");
  if (!created.created) return created;
  const operation = created.operation as Row;
  const envelope = {
    schema_version: 1,
    operation_id: operation.operation_id,
    operation_type: operationType,
    requested_at: requestedAt,
    lease_required: true,
    input_hash: inputHash,
    input,
  };
  try {
    const availability = await workstationStatus(env);
    if (!availability.ok) throw new Error(availability.error || "Workstation worker is offline.");
    const response = await workstationRequest(
      env,
      "/api/worker/execute",
      { method: "POST", body: JSON.stringify(envelope) },
      5000,
    );
    if (!response.ok) {
      const body = await response.text();
      let detail = `Workstation rejected this action (HTTP ${response.status}).`;
      try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch {
        // Keep the bounded status message.
      }
      await finishOperation(env.DB, String(operation.operation_id), "failed", null, detail);
      throw new Error(detail);
    }
    await markOperationRunning(env.DB, String(operation.operation_id));
    return { operation: await getOperation(env.DB, String(operation.operation_id)), created: true };
  } catch (error) {
    const message = error instanceof Error && error.name !== "AbortError"
      ? error.message
      : "Workstation worker is offline or did not acknowledge the action.";
    await finishOperation(env.DB, String(operation.operation_id), "failed", null, message);
    throw new Error(message);
  }
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

class ResultValidationError extends Error {}

async function storeArtifact(env: BridgeEnv, category: string, ownerKey: string, artifact: Row) {
  const logicalName = String(artifact.name || artifact.logical_name || "").trim();
  if (!logicalName) throw new ResultValidationError("Artifact name is required.");
  const filename = String(artifact.filename || logicalName);
  const bytes = decodeBase64(String(artifact.content_base64 || ""));
  if (bytes.byteLength > 10 * 1024 * 1024) throw new ResultValidationError("An artifact exceeded the 10 MB callback limit.");
  const actualHash = await sha256(bytes.buffer);
  const expectedHash = String(artifact.sha256 || "");
  if (expectedHash && expectedHash !== actualHash) throw new ResultValidationError(`Artifact checksum mismatch: ${logicalName}`);
  const objectKey = `${category}/${safeObjectKeyPart(ownerKey)}/${crypto.randomUUID()}/${safeObjectKeyPart(filename)}`;
  const contentType = String(artifact.content_type || contentTypeFor(filename));
  const object = await env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType } });
  const stamp = nowIso();
  await env.DB.prepare(
    `insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,size_bytes,etag,sha256,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?)
    on conflict(category,owner_key,logical_name) do update set
      object_key=excluded.object_key,filename=excluded.filename,content_type=excluded.content_type,size_bytes=excluded.size_bytes,
      etag=excluded.etag,sha256=excluded.sha256,updated_at=excluded.updated_at`,
  ).bind(objectKey, category, ownerKey, logicalName, filename, contentType, bytes.byteLength, object.etag, actualHash, stamp, stamp).run();
  return objectKey;
}

async function applySuccessfulResult(env: BridgeEnv, operation: Row, callback: Row) {
  const operationType = String(operation.operation_type);
  const result = callback.result as Row || {};
  const stamp = nowIso();
  if (operationType === "analyze_job") {
    const memo = (result.decision_memo as Row | undefined) || (result.memo as Row | undefined) || result;
    const jobId = String((operation.payload as Row).job_id);
    const previous = await getJob(env.DB, jobId);
    const expectedSourceFingerprint = String((operation.payload as Row)._job_source_fingerprint || "");
    if (expectedSourceFingerprint) {
      const currentSourceFingerprint = previous ? await jobSourceFingerprint(previous) : "";
      if (currentSourceFingerprint !== expectedSourceFingerprint) {
        throw new ResultValidationError("The job details or source identity changed while analysis was running. No AI result was applied; retry Analyze for the current job.");
      }
    }
    for (const field of ["decision", "fit_tier", "sponsorship_tier", "lane", "resume_strategy", "confidence"]) {
      if (!String(memo[field] ?? "").trim()) throw new ResultValidationError(`Analysis result is missing ${field}.`);
    }
    await env.DB.prepare(
      `insert into analyses(job_id,decision_memo_json,decision,fit_tier,sponsorship_tier,lane,resume_strategy,confidence,created_at)
      values(?,?,?,?,?,?,?,?,?)
      on conflict(job_id) do update set decision_memo_json=excluded.decision_memo_json,decision=excluded.decision,
        fit_tier=excluded.fit_tier,sponsorship_tier=excluded.sponsorship_tier,lane=excluded.lane,resume_strategy=excluded.resume_strategy,
        confidence=excluded.confidence,created_at=excluded.created_at`,
    ).bind(jobId, JSON.stringify(memo), memo.decision, memo.fit_tier, memo.sponsorship_tier, memo.lane, memo.resume_strategy, memo.confidence, stamp).run();
    const refreshed = result.job as Row | undefined;
    if (refreshed && String(refreshed.job_id) === jobId) {
      await env.DB.prepare(
        `update jobs set title=?,company=?,location=?,url=?,description=?,company_key=?,title_key=?,description_fingerprint=?,
          opportunity_key=?,opportunity_grouping_version=?,discovery_url=?,source_tier=?,source_status=?,source_checked_at=?,
          source_resolution_json=?,updated_at=? where job_id=?`,
      ).bind(
        refreshed.title, refreshed.company, refreshed.location, refreshed.url, refreshed.description, refreshed.company_key,
        refreshed.title_key, refreshed.description_fingerprint, refreshed.opportunity_key, refreshed.opportunity_grouping_version,
        refreshed.discovery_url, refreshed.source_tier, refreshed.source_status, refreshed.source_checked_at,
        refreshed.source_resolution ? JSON.stringify(refreshed.source_resolution) : null, stamp, jobId,
      ).run();
      if (Array.isArray(refreshed.source_candidates)) {
        await saveJobSources(env.DB, jobId, refreshed.source_candidates as Row[]);
      }
      if (
        refreshed.source_resolution
        && JSON.stringify(previous?.source_resolution ?? null) !== JSON.stringify(refreshed.source_resolution)
      ) {
        await env.DB.prepare(
          `insert into job_source_resolution_events(job_id,resolution_status,source_tier,payload_json,created_at)
          values(?,?,?,?,?)`,
        ).bind(
          jobId,
          refreshed.source_status || "unresolved",
          refreshed.source_tier || "unverified",
          JSON.stringify(refreshed.source_resolution),
          stamp,
        ).run();
      }
    }
  } else if (operationType === "research_company") {
    const companyKey = String((operation.payload as Row).company_key);
    const research = (result.research as Row | undefined) || result;
    const displayName = String(research.official_name || companyKey);
    await env.DB.prepare(
      `insert into networking_companies(company_key,display_name,research_json,researched_at,created_at,updated_at) values(?,?,?,?,?,?)
      on conflict(company_key) do update set research_json=excluded.research_json,researched_at=excluded.researched_at,updated_at=excluded.updated_at`,
    ).bind(companyKey, displayName, JSON.stringify(research), stamp, stamp, stamp).run();
  } else if (operationType === "research_role") {
    const payload = operation.payload as Row;
    const research = (result.research as Row | undefined) || result;
    const company = await getNetworkingCompany(env.DB, String(payload.company_key));
    const role = (company?.roles as Row[] | undefined)?.find((item) => String(item.opportunity_key) === String(payload.opportunity_key));
    const jobId = String(result.job_id || payload.job_id || role?.job_id || "");
    const job = await getJob(env.DB, jobId);
    if (!job) throw new ResultValidationError("Role research callback references an unknown job.");
    await env.DB.prepare(
      `insert into networking_role_research(company_key,opportunity_key,job_id,title,location,jd_fingerprint,company_researched_at,research_json,researched_at)
      values(?,?,?,?,?,?,?,?,?)
      on conflict(company_key,opportunity_key) do update set job_id=excluded.job_id,title=excluded.title,location=excluded.location,
        jd_fingerprint=excluded.jd_fingerprint,company_researched_at=excluded.company_researched_at,research_json=excluded.research_json,
        researched_at=excluded.researched_at`,
    ).bind(
      payload.company_key, payload.opportunity_key, job.job_id, job.title, job.location, job.description_fingerprint || "",
      company?.researched_at || "", JSON.stringify(research), stamp,
    ).run();
  } else if (operationType === "build_packet") {
    const jobId = String((operation.payload as Row).job_id);
    const artifacts = Array.isArray(callback.artifacts) ? callback.artifacts as Row[] : [];
    if (!artifacts.length) throw new ResultValidationError("Packet callback did not include artifacts.");
    let total = 0;
    for (const artifact of artifacts) {
      total += String(artifact.content_base64 || "").length;
      if (total > 20 * 1024 * 1024 * 1.4) throw new ResultValidationError("Packet callback exceeded the total artifact limit.");
      await storeArtifact(env, "application", jobId, artifact);
    }
    const resumeStrategy = String(result.resume_strategy || "master");
    const currentJob = await getJob(env.DB, jobId);
    const status = currentJob?.status === "applied" ? "applied" : "packet_created";
    await env.DB.prepare(
      `insert into applications(job_id,packet_owner_key,resume_strategy,status,packet_date,notes,updated_at) values(?,?,?,?,?,?,?)
      on conflict(job_id) do update set packet_owner_key=excluded.packet_owner_key,resume_strategy=excluded.resume_strategy,
        status=excluded.status,packet_date=excluded.packet_date,updated_at=excluded.updated_at`,
    ).bind(jobId, jobId, resumeStrategy, status, stamp.slice(0, 10), "", stamp).run();
    if (status !== currentJob?.status) await setJobStatus(env.DB, jobId, status, "packet");
  } else if (operationType === "daily_report") {
    const reportDate = String((operation.payload as Row).date || stamp.slice(0, 10));
    const content = String(result.content || "");
    if (!content) throw new ResultValidationError("Daily report callback did not include content.");
    const objectKey = `reports/${reportDate}/${crypto.randomUUID()}/daily-report.md`;
    const stored = await env.BUCKET.put(objectKey, content, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    const hash = await sha256(content);
    await env.DB.batch([
      env.DB.prepare(
        `insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,size_bytes,etag,sha256,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?)
        on conflict(category,owner_key,logical_name) do update set object_key=excluded.object_key,size_bytes=excluded.size_bytes,
          etag=excluded.etag,sha256=excluded.sha256,updated_at=excluded.updated_at`,
      ).bind(objectKey, "report", reportDate, "daily_report", `${reportDate}.md`, "text/markdown; charset=utf-8", new TextEncoder().encode(content).byteLength, stored.etag, hash, stamp, stamp),
      env.DB.prepare(
        `insert into daily_reports(report_date,object_key,created_at,updated_at) values(?,?,?,?)
        on conflict(report_date) do update set object_key=excluded.object_key,updated_at=excluded.updated_at`,
      ).bind(reportDate, objectKey, stamp, stamp),
    ]);
  }
  for (const artifact of Array.isArray(callback.runs) ? callback.runs as Row[] : []) {
    await storeArtifact(env, "run", String(operation.operation_id), artifact);
  }
}

export async function acceptWorkerCallback(env: BridgeEnv, request: Request, operationId: string) {
  const expected = String(env.CAREER_WORKER_CALLBACK_SECRET || "");
  const provided = String(request.headers.get("x-career-worker-secret") || "");
  if (!constantTimeEqual(expected, provided)) return problem("Unauthorized", 401);
  const callback = await request.json() as Row;
  if (callback.schema_version !== 1) return problem("Unsupported callback schema.", 400);
  const operation = await getOperation(env.DB, operationId) as Row | null;
  if (!operation) return problem("Operation not found.", 404);
  if (String(callback.operation_type) !== String(operation.operation_type)) return problem("Operation type mismatch.", 409);
  const expectedHash = String((operation.payload as Row)._input_hash || "");
  if (String(callback.input_hash || "") !== expectedHash) return problem("Operation input hash mismatch.", 409);
  if (["succeeded", "failed", "interrupted"].includes(String(operation.status))) {
    const receipt = await getWorkerLease(env.DB, operationId);
    if (receipt?.completion_hash === await sha256(JSON.stringify(callback))) return new Response(null, { status: 200 });
    const same = String(operation.status) === String(callback.status)
      && JSON.stringify(operation.result ?? null) === JSON.stringify(callback.result ?? null);
    return same ? new Response(null, { status: 200 }) : problem("Conflicting callback for a completed operation.", 409);
  }
  const lease = await getWorkerLease(env.DB, operationId);
  if (!lease || !callback.worker_id || !callback.instance_id
    || lease.worker_id !== callback.worker_id || lease.instance_id !== callback.instance_id) {
    return problem("The callback does not own this operation.", 409);
  }
  const status = String(callback.status);
  if (!["succeeded", "failed", "interrupted"].includes(status)) return problem("Invalid callback status.", 400);
  const buffer = bufferResultWrites(env.DB);
  let finalStatus = status;
  let finalResult = callback.result ?? null;
  let finalError = String(callback.error || "");
  if (status === "succeeded") {
    try {
      await applySuccessfulResult({ ...env, DB: buffer.db }, operation, callback);
    } catch (error) {
      if (!(error instanceof ResultValidationError)) throw error;
      buffer.writes.length = 0;
      const detail = error instanceof Error ? error.message : "The worker result could not be applied.";
      finalStatus = "failed";
      finalResult = null;
      finalError = /retry/i.test(detail) ? detail : `${detail} Retry the action.`;
    }
  }
  try {
    await commitWorkerCompletion(env.DB, operation, callback, buffer.writes, finalStatus, finalResult, finalError);
  } catch (error) {
    const current = await getWorkerLease(env.DB, operationId);
    if (current?.completion_hash === await sha256(JSON.stringify(callback))) return new Response(null, { status: 200 });
    const refreshed = await getOperation(env.DB, operationId);
    if (!refreshed || ["succeeded", "failed", "interrupted"].includes(String(refreshed.status))) {
      return problem("This operation ended before its result could be applied.", 409);
    }
    // Constraint failure means the lease expired or ownership changed; DB/R2
    // failures remain retryable so the worker retains its completion record.
    if (/CHECK constraint|completion_valid/i.test(String(error))) return problem("The operation lease is no longer valid.", 409);
    throw error;
  }
  return new Response(null, { status: 200 });
}

export async function acceptWorkerHeartbeat(env: BridgeEnv, request: Request, operationId: string) {
  if (!constantTimeEqual(String(env.CAREER_WORKER_CALLBACK_SECRET || ""), String(request.headers.get("x-career-worker-secret") || ""))) {
    return problem("Unauthorized", 401);
  }
  const heartbeat = await request.json() as Row;
  const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
  if (heartbeat.schema_version !== 1 || !validId(heartbeat.worker_id) || !validId(heartbeat.instance_id)
    || typeof heartbeat.input_hash !== "string" || !heartbeat.input_hash || heartbeat.input_hash.length > 128) {
    return problem("Invalid operation heartbeat.", 400);
  }
  if (!await renewWorkerLease(env.DB, operationId, heartbeat)) return problem("The operation lease expired or belongs to another instance.", 409);
  return new Response(JSON.stringify({ accepted: true, heartbeat_seconds: WORKER_HEARTBEAT_SECONDS, lease_seconds: WORKER_LEASE_SECONDS }),
    { headers: { "Content-Type": "application/json" } });
}
