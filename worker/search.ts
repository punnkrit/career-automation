import { classifySource, cleanJobUrl, jobIdentity, nowIso, slugify, type Row } from "./common";
import { LANES, METROS } from "./search-config";
import { finishOperation, saveDiscoveredJob, type StorageEnv } from "./store";

type SearchSpec = {
  lane: string;
  query: string;
  location: string;
  location_source: string;
  page: number;
  next_page_token: string | null;
};

function unique(values: unknown) {
  const items = Array.isArray(values) ? values : values ? [values] : [];
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

function weekNumber(date = new Date()) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  return Math.ceil((((value.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function searchLocations(payload: Row) {
  const result: Array<{ location: string; source: string }> = [];
  const seen = new Set<string>();
  for (const metroId of unique(payload.metro_ids)) {
    const metro = METROS.find((item) => item.id === metroId);
    if (!metro) throw new Error(`Unknown metro: ${metroId}`);
    for (const location of metro.search_locations) {
      if (!seen.has(location.toLowerCase())) result.push({ location, source: metro.id });
      seen.add(location.toLowerCase());
    }
    if (payload.include_edge_check && metro.edge_locations.length) {
      const location = metro.edge_locations[(weekNumber() - 1) % metro.edge_locations.length];
      if (!seen.has(location.toLowerCase())) result.push({ location, source: `${metro.id}:edge` });
      seen.add(location.toLowerCase());
    }
  }
  for (const location of unique(payload.locations || payload.location)) {
    if (!seen.has(location.toLowerCase())) result.push({ location, source: "manual" });
    seen.add(location.toLowerCase());
  }
  return result;
}

function initialSpecs(payload: Row) {
  const retryRequests = Array.isArray(payload.requests) ? payload.requests as Row[] : null;
  if (retryRequests) {
    if (!retryRequests.length) throw new Error("At least one failed request is required.");
    if (retryRequests.length > 60) throw new Error("Retry at most 60 failed SerpAPI requests at a time.");
    return retryRequests.map((item) => {
      const lane = String(item.lane || "").trim();
      const query = String(item.query || "").trim();
      if (!LANES.some((candidate) => candidate.id === lane && candidate.queries.includes(query))) {
        throw new Error(`Unknown query for lane ${lane}: ${query}`);
      }
      const page = Math.max(1, Number(item.page || 1));
      const token = String(item.next_page_token || "").trim() || null;
      if (page > 1 && !token) throw new Error("A pagination retry requires its next_page_token.");
      return {
        lane,
        query,
        location: String(item.location || "").trim(),
        location_source: String(item.location_source || "manual"),
        page,
        next_page_token: token,
      };
    });
  }
  const laneIds = unique(payload.lanes || payload.lane);
  if (!laneIds.length) throw new Error("At least one lane is required.");
  const locations = searchLocations(payload);
  if (!locations.length) throw new Error("At least one metro or manual location is required.");
  const specs: SearchSpec[] = [];
  for (const laneId of laneIds) {
    const lane = LANES.find((item) => item.id === laneId);
    if (!lane) throw new Error(`Unknown lane: ${laneId}`);
    for (const target of locations) {
      for (const query of lane.queries) {
        specs.push({ lane: laneId, query, location: target.location, location_source: target.source, page: 1, next_page_token: null });
      }
    }
  }
  if (specs.length > 60) {
    throw new Error(`This search expands to ${specs.length} SerpAPI requests. Select fewer lanes or metros (maximum 60 per run).`);
  }
  return specs;
}

function sourceCandidates(raw: Row, company: string) {
  const input = Array.isArray(raw.apply_options) && raw.apply_options.length
    ? raw.apply_options
    : Array.isArray(raw.related_links) && raw.related_links.length
      ? raw.related_links
      : raw.share_link
        ? [{ title: "Google Jobs", link: raw.share_link }]
        : [];
  const seen = new Set<string>();
  return input.flatMap((item: Row, index: number) => {
    const url = cleanJobUrl(item.link || item.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      label: String(item.title || item.label || ""),
      url,
      source_tier: classifySource(url, company),
      position: index,
    }];
  });
}

function preferredCandidate(candidates: Row[]) {
  const rank: Record<string, number> = { employer: 0, ats: 1, linkedin: 2, manual: 3, unverified: 4, aggregator: 5, discovery: 6 };
  return [...candidates].sort((left, right) => (rank[String(left.source_tier)] ?? 9) - (rank[String(right.source_tier)] ?? 9))[0] ?? null;
}

function postedAt(raw: Row) {
  const detected = String((raw.detected_extensions as Row | undefined)?.posted_at || "").trim();
  if (detected) return detected;
  const pattern = /^(?:just posted|today|yesterday|\d+\+?\s+(?:minute|hour|day|week|month)s?\s+ago)$/i;
  return (Array.isArray(raw.extensions) ? raw.extensions : []).map(String).find((item) => pattern.test(item)) ?? null;
}

function redact(value: unknown, secret: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [
      key,
      ["api_key", "authorization", "cookie", "set_cookie", "x_api_key"].includes(key.toLowerCase().replace(/-/g, "_"))
        ? "<redacted>"
        : redact(item, secret),
    ]));
  }
  return typeof value === "string" && secret ? value.split(secret).join("<redacted>") : value;
}

async function fetchSpec(spec: SearchSpec, apiKey: string) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_jobs");
  url.searchParams.set("q", spec.query);
  url.searchParams.set("location", spec.location.split(",").map((item) => item.trim()).join(","));
  url.searchParams.set("google_domain", "google.com");
  url.searchParams.set("gl", "us");
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", apiKey);
  if (spec.next_page_token) url.searchParams.set("next_page_token", spec.next_page_token);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    const data = await response.json() as Row;
    if (!response.ok || data.error) throw new Error(response.ok ? String(data.error) : `SerpAPI returned HTTP ${response.status}.`);
    const jobs = data.jobs_results;
    if (!Array.isArray(jobs)) throw new Error("SerpAPI jobs_results was not a list.");
    return { data, jobs: jobs as Row[], durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRound(specs: SearchSpec[], apiKey: string) {
  const settled: PromiseSettledResult<Awaited<ReturnType<typeof fetchSpec>>>[] = [];
  for (let offset = 0; offset < specs.length; offset += 12) {
    settled.push(...await Promise.allSettled(specs.slice(offset, offset + 12).map((spec) => fetchSpec(spec, apiKey))));
  }
  return settled;
}

export async function executeSearch(env: StorageEnv, operationId: string, payload: Row, apiKey: string) {
  const limit = Math.max(1, Math.min(30, Number(payload.limit || 20)));
  const maxPages = Math.min(3, Math.ceil(limit / 10));
  const isRetry = Array.isArray(payload.requests);
  const runId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = nowIso();
  const initial = initialSpecs(payload);
  const laneIds = [...new Set(initial.map((item) => item.lane))];
  const locations = [...new Set(initial.map((item) => item.location))];
  await env.DB.prepare(
    `insert into search_runs(run_id,operation_id,status,request_json,planned_requests_json,raw_object_prefix,started_at,updated_at)
    values(?,?, 'running',?,?,?,?,?)`,
  ).bind(runId, operationId, JSON.stringify(payload), JSON.stringify(initial), `search/${runId}/raw/`, startedAt, startedAt).run();

  const searches: Row[] = [];
  const errors: Row[] = [];
  const normalized: Row[] = [];
  const matchedJobIds = new Set<string>();
  const createdJobIds = new Set<string>();
  const matchedOpportunityKeys = new Set<string>();
  const fetchedByOrigin = new Map<string, number>();
  let successfulRequests = 0;
  let paginationRequests = 0;
  let cachedRequests = 0;
  let round = initial;
  let sequence = 0;

  while (round.length) {
    const active = round.filter((spec) => {
      const key = `${spec.lane}\u0000${spec.query}\u0000${spec.location}\u0000${spec.location_source}`;
      return (fetchedByOrigin.get(key) || 0) < limit;
    });
    const settled = await fetchRound(active, apiKey);
    const nextRound: SearchSpec[] = [];
    for (let index = 0; index < active.length; index += 1) {
      const spec = active[index];
      const outcome = settled[index];
      const requestKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(spec)))
        .then((bytes) => [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join(""));
      sequence += 1;
      if (outcome.status === "rejected") {
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        const error = { ...spec, type: "request_error", message };
        errors.push(error);
        searches.push({ ...error, status: "failed", fetched: 0 });
        await env.DB.prepare(
          `insert into search_requests(run_id,request_key,sequence,lane,query,location,location_source,page,next_page_token,status,error_type,error_message,created_at,updated_at)
          values(?,?,?,?,?,?,?,?,?,'failed','request_error',?,?,?)`,
        ).bind(runId, requestKey, sequence, spec.lane, spec.query, spec.location, spec.location_source, spec.page, spec.next_page_token, message, nowIso(), nowIso()).run();
        continue;
      }
      const { data, jobs, durationMs } = outcome.value;
      const rawObjectKey = `search/${runId}/raw/${String(sequence).padStart(4, "0")}-${slugify(spec.lane)}-${slugify(spec.location)}-${slugify(spec.query)}-page-${spec.page}.json`;
      await env.BUCKET.put(rawObjectKey, JSON.stringify(redact(data, apiKey), null, 2), { httpMetadata: { contentType: "application/json" } });
      const originKey = `${spec.lane}\u0000${spec.query}\u0000${spec.location}\u0000${spec.location_source}`;
      const alreadyFetched = fetchedByOrigin.get(originKey) || 0;
      const batch = jobs.slice(0, limit - alreadyFetched);
      let created = 0;
      const batchJobIds = new Set<string>();
      const batchOpportunityKeys = new Set<string>();
      for (const raw of batch) {
        const company = String(raw.company_name || raw.company || "Unknown company");
        const candidates = sourceCandidates(raw, company);
        const preferred = preferredCandidate(candidates);
        const job: Row = {
          title: String(raw.title || "Untitled role"),
          company,
          location: String(raw.location || ""),
          url: preferred?.url ?? null,
          description: String(raw.description || ""),
          source: "serpapi",
          lane_hint: spec.lane,
          posted_at: postedAt(raw),
          source_tier: preferred?.source_tier || "unverified",
          source_status: preferred && ["employer", "ats", "linkedin", "manual"].includes(String(preferred.source_tier)) ? "preferred" : "unresolved",
          source_candidates: candidates,
          discovery_url: candidates[0]?.url ?? preferred?.url ?? null,
          status: "new",
        };
        const identity = await jobIdentity(job);
        batchOpportunityKeys.add(identity.opportunityKey);
        const saved = await saveDiscoveredJob(env.DB, job);
        matchedJobIds.add(saved.jobId);
        batchJobIds.add(saved.jobId);
        if (saved.created) {
          created += 1;
          createdJobIds.add(saved.jobId);
        }
        normalized.push({ ...job, job_id: saved.jobId });
      }
      const previousOpportunityCount = matchedOpportunityKeys.size;
      for (const key of batchOpportunityKeys) matchedOpportunityKeys.add(key);
      const newOpportunities = matchedOpportunityKeys.size - previousOpportunityCount;
      fetchedByOrigin.set(originKey, alreadyFetched + batch.length);
      successfulRequests += 1;
      paginationRequests += Number(spec.page > 1);
      const metadata = data.search_metadata as Row | undefined;
      const cached = Boolean(metadata?.cached);
      cachedRequests += Number(cached);
      const nextPageToken = String((data.serpapi_pagination as Row | undefined)?.next_page_token || "").trim();
      const search = {
        ...spec,
        status: "success",
        fetched: batch.length,
        created,
        unique_jobs: batchJobIds.size,
        new_opportunities_in_run: newOpportunities,
        cached,
        duration_ms: durationMs,
        search_id: metadata?.id ?? null,
        poll_count: 0,
        serpapi_location: spec.location.split(",").map((item) => item.trim()).join(","),
        has_next_page: Boolean(nextPageToken),
      };
      searches.push(search);
      await env.DB.prepare(
        `insert into search_requests(run_id,request_key,sequence,lane,query,location,location_source,page,next_page_token,status,serpapi_search_id,
          fetched,created,unique_jobs,new_opportunities,cached,duration_ms,raw_object_key,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,'success',?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        runId, requestKey, sequence, spec.lane, spec.query, spec.location, spec.location_source, spec.page, spec.next_page_token,
        metadata?.id ?? null, batch.length, created, batchJobIds.size, newOpportunities, Number(cached), durationMs, rawObjectKey, nowIso(), nowIso(),
      ).run();
      const shouldPaginate = !isRetry && nextPageToken && spec.page < maxPages
        && (fetchedByOrigin.get(originKey) || 0) < limit
        && (spec.page === 1 || newOpportunities >= 3);
      if (shouldPaginate) nextRound.push({ ...spec, page: spec.page + 1, next_page_token: nextPageToken });
    }
    round = nextRound;
  }

  const status = errors.length ? (successfulRequests ? "partial" : "failed") : "complete";
  const normalizedObjectKey = `search/${runId}/normalized.json`;
  await env.BUCKET.put(normalizedObjectKey, JSON.stringify(normalized, null, 2), { httpMetadata: { contentType: "application/json" } });
  const result = {
    run_id: runId,
    status,
    lanes: laneIds,
    locations,
    limit_per_query_location: limit,
    limit_per_lane_location: limit,
    max_pages: maxPages,
    edge_check_included: Boolean(payload.include_edge_check),
    fetched: normalized.length,
    created: createdJobIds.size,
    unique_jobs: matchedJobIds.size,
    unique_opportunities: matchedOpportunityKeys.size,
    existing_jobs: matchedJobIds.size - createdJobIds.size,
    cached_requests: cachedRequests,
    pagination_requests: paginationRequests,
    search_requests: successfulRequests + errors.length,
    matched_job_ids: [...matchedJobIds].sort(),
    created_job_ids: [...createdJobIds].sort(),
    successful_requests: successfulRequests,
    failed_requests: errors.length,
    searches,
    errors,
    api_call_count: successfulRequests + errors.length,
  };
  const finishedAt = nowIso();
  await env.DB.prepare(
    "update search_runs set status=?,result_json=?,planned_requests_json=?,normalized_object_key=?,finished_at=?,updated_at=? where run_id=?",
  ).bind(status, JSON.stringify(result), JSON.stringify([...initial]), normalizedObjectKey, finishedAt, finishedAt, runId).run();
  await finishOperation(env.DB, operationId, successfulRequests ? "succeeded" : "failed", result, successfulRequests ? "" : "Every SerpAPI request failed.");
  return result;
}
