import { setupStatus, setupProfile } from "./setup";
import { expireWorkerOperations } from "./operation-lifecycle";
import { json, problem, requestJson, sha256, todayIso, type Row } from "./common";
import { profileInit, type ProfileEnv } from "./profile";
import { searchOptions } from "./search-config";
import { executeSearch } from "./search";
import {
  addNetworkingContacts,
  applicationMetadata,
  applicationObject,
  createOperation,
  deleteNetworkingContact,
  deleteJob,
  deleteJobs,
  type JobDeletion,
  finishOperation,
  getJob,
  getNetworkingCompany,
  getOperation,
  ingestJob,
  listDays,
  listJobs,
  listNetworkingCompanies,
  listOperations,
  reportObject,
  setJobStatus,
  setNetworkingPaused,
  updateJob,
  updateNetworkingContact,
} from "./store";
import {
  acceptWorkerCallback,
  acceptWorkerHeartbeat,
  dispatchWorkstationOperation,
  workstationStatus,
  type BridgeEnv,
} from "./worker-bridge";

interface Env extends BridgeEnv, ProfileEnv {
  ASSETS: Fetcher;
  SERPAPI_API_KEY?: string;
}

function decoded(match: RegExpMatchArray, index: number) {
  return decodeURIComponent(match[index]);
}

function numeric(value: string | null, fallback: number) {
  if (value == null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function startAi(env: Env, operationType: string, payload: Row) {
  const response = await dispatchWorkstationOperation(env, operationType, payload);
  return json(response, 202);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/setup") return setupStatus(env);
  if (path === "/api/setup/profile") return setupProfile(request, env);

  if (method === "GET" && path === "/api/health") {
    await expireWorkerOperations(env.DB);
    const worker = await workstationStatus(env);
    await env.DB.prepare("select 1").first();
    return json({ ok: true, operation_worker_running: worker.ok, analysis_concurrency: worker.ok ? Number(worker.available_slots || 1) : 0 });
  }
  if (method === "GET" && (path === "/api/codex/status" || path === "/api/worker/status")) {
    await expireWorkerOperations(env.DB);
    return json(await workstationStatus(env));
  }


  let match = path.match(/^\/api\/worker\/heartbeat\/([^/]+)$/);
  if (method === "POST" && match) return acceptWorkerHeartbeat(env, request, decoded(match, 1));
  match = path.match(/^\/api\/worker\/complete\/([^/]+)$/);
  if (method === "POST" && match) return acceptWorkerCallback(env, request, decoded(match, 1));

  if (method === "POST" && path === "/api/profile/init") return profileInit(env, request);

  if (method === "GET" && path === "/api/days") return json({ days: await listDays(env.DB) });
  if (method === "GET" && path === "/api/search/options") return json(searchOptions);

  if (method === "GET" && path === "/api/jobs") return json({ jobs: await listJobs(env.DB, url) });
  if (method === "DELETE" && path === "/api/jobs") {
    const body = await requestJson<Row>(request);
    const jobs = body.jobs;
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 1000 || jobs.some((job) =>
      !job || typeof job.job_id !== "string" || !job.job_id
      || job.scope !== "opportunity" || !Number.isInteger(job.expected_count) || job.expected_count < 1
    )) return problem("Select between 1 and 1000 jobs with confirmed listing counts.", 400);
    return json(await deleteJobs(env.DB, jobs as JobDeletion[]));
  }
  if (method === "POST" && path === "/api/jobs/ingest") {
    const body = await requestJson<Row>(request);
    const saved = await ingestJob(env.DB, body);
    let analysisOperation = null;
    let analysisCreated = false;
    if (body.analyze) {
      try {
        const dispatched = await dispatchWorkstationOperation(env, "analyze_job", { job_id: saved.job_id });
        analysisOperation = dispatched.operation;
        analysisCreated = dispatched.created;
      } catch {
        // The job is cloud-persisted even when the optional workstation analysis is unavailable.
      }
    }
    return json({ ...saved, analysis_operation: analysisOperation, analysis_created: analysisCreated });
  }

  if (method === "POST" && path === "/api/jobs/analyze-batch") {
    const body = await requestJson<Row>(request);
    const jobIds = [...new Set((Array.isArray(body.job_ids) ? body.job_ids : []).map(String))];
    if (!jobIds.length || jobIds.length > 200) return problem("Select between 1 and 200 jobs.", 400);
    for (const jobId of jobIds) if (!(await getJob(env.DB, jobId))) return problem("One or more selected jobs were not found.", 404);
    const status = await workstationStatus(env);
    if (!status.ok) return problem("The workstation worker is offline.", 503);
    const availableSlots = Math.max(0, Number(status.available_slots || 0));
    if (jobIds.length > availableSlots) {
      return problem(`The workstation can accept ${availableSlots} more analysis job${availableSlots === 1 ? "" : "s"} right now.`, 409);
    }
    const operations = [];
    let createdCount = 0;
    for (const jobId of jobIds) {
      const result = await dispatchWorkstationOperation(env, "analyze_job", { job_id: jobId });
      operations.push(result.operation);
      createdCount += Number(result.created);
    }
    return json({ operations, created_count: createdCount, existing_count: operations.length - createdCount }, 202);
  }

  match = path.match(/^\/api\/jobs\/([^/]+)\/analyze$/);
  if (method === "POST" && match) return startAi(env, "analyze_job", { job_id: decoded(match, 1) });
  match = path.match(/^\/api\/jobs\/([^/]+)\/build-packet$/);
  if (method === "POST" && match) return startAi(env, "build_packet", { job_id: decoded(match, 1) });
  match = path.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (method === "POST" && match) {
    const jobId = decoded(match, 1);
    const body = await requestJson<Row>(request);
    const status = String(body.status || "");
    const saved = await setJobStatus(env.DB, jobId, status);
    if (!saved) return problem("Job not found.", 404);
    return json({ job_id: jobId, ...saved });
  }
  match = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (match && method === "GET") {
    const job = await getJob(env.DB, decoded(match, 1));
    return job ? json(job) : problem("Job not found.", 404);
  }
  if (match && method === "DELETE") {
    const body = await requestJson<Row>(request);
    if (!["listing", "opportunity"].includes(String(body.scope)) || !Number.isInteger(body.expected_count) || Number(body.expected_count) < 1) {
      return problem("A deletion scope and confirmed listing count are required.", 400);
    }
    const result = await deleteJob(env.DB, decoded(match, 1), body.scope as "listing" | "opportunity", Number(body.expected_count));
    return result ? json(result) : problem("Job not found.", 404);
  }
  if (match && method === "PATCH") {
    const job = await updateJob(env.DB, decoded(match, 1), await requestJson<Row>(request));
    return job ? json(job) : problem("Job not found.", 404);
  }

  if (method === "POST" && (path === "/api/search" || path === "/api/search/retry")) {
    if (!env.SERPAPI_API_KEY) return problem("SerpAPI is not configured on the Site.", 503);
    const body = await requestJson<Row>(request);
    const payload = path.endsWith("/retry") ? body : {
      lanes: body.lanes || (body.lane ? [body.lane] : []),
      locations: body.locations || (body.location ? [body.location] : []),
      metro_ids: body.metro_ids || [],
      limit: body.limit || 20,
      include_edge_check: Boolean(body.include_edge_check),
    };
    const operationType = path.endsWith("/retry") ? "search_retry" : "search";
    const operationKey = await sha256(JSON.stringify(payload));
    const created = await createOperation(env.DB, operationType, operationKey, payload, "site", "running");
    if (created.created) {
      try {
        await executeSearch(env, String((created.operation as Row).operation_id), payload, env.SERPAPI_API_KEY);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishOperation(env.DB, String((created.operation as Row).operation_id), "failed", null, message);
      }
    }
    return json({ operation: await getOperation(env.DB, String((created.operation as Row).operation_id)), created: created.created }, 202);
  }

  if (method === "GET" && path === "/api/operations") {
    return json({
      operations: await listOperations(
        env.DB,
        numeric(url.searchParams.get("limit"), 50),
        url.searchParams.get("status"),
        url.searchParams.get("operation_type"),
      ),
    });
  }
  match = path.match(/^\/api\/operations\/([^/]+)$/);
  if (method === "GET" && match) {
    const operation = await getOperation(env.DB, decoded(match, 1));
    return operation ? json(operation) : problem("Operation not found.", 404);
  }

  if (method === "GET" && path === "/api/networking/companies") {
    return json({ companies: await listNetworkingCompanies(env.DB, url.searchParams.get("include_inactive") === "true", true) });
  }
  match = path.match(/^\/api\/networking\/companies\/([^/]+)\/contacts$/);
  if (method === "POST" && match) {
    const companyKey = decoded(match, 1);
    const body = await requestJson<Row>(request);
    const contactIds = await addNetworkingContacts(
      env.DB,
      companyKey,
      String(body.display_name || companyKey),
      Array.isArray(body.contacts) ? body.contacts as Row[] : [],
    );
    return json({ company_key: companyKey, contact_ids: contactIds });
  }
  match = path.match(/^\/api\/networking\/contacts\/(\d+)$/);
  if (match && method === "PATCH") {
    const contactId = Number(match[1]);
    return (await updateNetworkingContact(env.DB, contactId, await requestJson<Row>(request)))
      ? json({ contact_id: contactId, updated: true })
      : problem("Networking contact not found.", 404);
  }
  if (match && method === "DELETE") {
    const contactId = Number(match[1]);
    return (await deleteNetworkingContact(env.DB, contactId))
      ? json({ contact_id: contactId, deleted: true })
      : problem("Networking contact not found.", 404);
  }
  match = path.match(/^\/api\/networking\/companies\/([^/]+)\/pause$/);
  if (method === "PATCH" && match) {
    const companyKey = decoded(match, 1);
    const body = await requestJson<Row>(request);
    await setNetworkingPaused(env.DB, companyKey, String(body.display_name || companyKey), Boolean(body.paused));
    return json({ company_key: companyKey, paused: Boolean(body.paused) });
  }
  match = path.match(/^\/api\/networking\/companies\/([^/]+)\/roles\/([^/]+)\/research$/);
  if (method === "POST" && match) {
    const companyKey = decoded(match, 1);
    const opportunityKey = decoded(match, 2);
    return startAi(env, "research_role", { company_key: companyKey, opportunity_key: opportunityKey });
  }
  match = path.match(/^\/api\/networking\/companies\/([^/]+)\/research$/);
  if (method === "POST" && match) return startAi(env, "research_company", { company_key: decoded(match, 1) });
  match = path.match(/^\/api\/networking\/companies\/([^/]+)$/);
  if (method === "GET" && match) {
    const company = await getNetworkingCompany(env.DB, decoded(match, 1));
    return company ? json(company) : problem("Networking company not found.", 404);
  }

  match = path.match(/^\/api\/applications\/([^/]+)\/artifact\/([^/]+)$/);
  if (method === "GET" && match) {
    const jobId = decoded(match, 1);
    const logicalName = decoded(match, 2);
    const metadata = await applicationObject(env.DB, jobId, logicalName);
    if (!metadata) return problem("Artifact not found.", 404);
    const object = await env.BUCKET.get(String(metadata.object_key));
    if (!object) return problem("Artifact not found.", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", String(metadata.content_type || "application/octet-stream"));
    headers.set("Content-Disposition", `inline; filename="${String(metadata.filename).replace(/["\\]/g, "_")}"`);
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { headers });
  }
  match = path.match(/^\/api\/applications\/([^/]+)$/);
  if (method === "GET" && match) {
    const application = await applicationMetadata(env.DB, decoded(match, 1));
    return application ? json(application) : problem("Application packet not found.", 404);
  }

  match = path.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && match) {
    const metadata = await reportObject(env.DB, match[1]);
    if (!metadata) return problem("Report not found.", 404);
    const object = await env.BUCKET.get(String(metadata.object_key));
    if (!object) return problem("Report not found.", 404);
    return new Response(object.body, { headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: object.httpEtag } });
  }
  if (method === "POST" && path === "/api/daily-report") {
    const body = await requestJson<Row>(request);
    return startAi(env, "daily_report", { date: body.date || todayIso() });
  }

  return problem("Not found.", 404);
}

export default {
  async scheduled(_controller, env): Promise<void> {
    const result = await expireWorkerOperations(env.DB);
    console.info("worker_operation_cleanup", { expired: Number(result.meta?.changes || 0) });
  },
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404 || request.method !== "GET") return asset;
      const root = new URL(request.url);
      root.pathname = "/";
      root.search = "";
      return env.ASSETS.fetch(new Request(root, request));
    }
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The Site could not complete this request.";
      const callbackRoute = /^\/api\/worker\/(complete|heartbeat)\//.test(url.pathname);
      const status = callbackRoute ? 503 : /offline|unavailable|not configured|did not acknowledge/i.test(detail) ? 503 : 400;
      return problem(detail, status);
    }
  },
} satisfies ExportedHandler<Env>;
