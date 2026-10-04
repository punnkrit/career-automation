import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../worker/worker-bridge.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import[\s\S]*?from "\.\/(?:common|store|operation-lifecycle)";\s*/gm, "");
const { activeCandidateContext, jobSourceFingerprintMaterial } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

async function loadCallbackBridge(harness) {
  const key = `__workerBridgeHarness_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  globalThis[key] = harness;
  const prelude = `
    const AI_OPERATION_TYPES = new Set(["analyze_job", "build_packet", "research_company", "research_role", "daily_report"]);
    const constantTimeEqual = (expected, provided) => expected === provided && Boolean(expected);
    const problem = (detail, status) => new Response(JSON.stringify({ detail }), { status });
    const getWorkerLease = async () => ({ worker_id: "test-worker", instance_id: "test-instance" });
    const bufferResultWrites = (db) => ({ db, writes: [] });
    const commitWorkerCompletion = (db, operation, callback, writes, status, result, error) => globalThis[${JSON.stringify(key)}].finishOperation(db, operation.operation_id, status, result, error);
    const createOperation = (...args) => globalThis[${JSON.stringify(key)}].createOperation(...args);
    const getOperation = (...args) => globalThis[${JSON.stringify(key)}].getOperation(...args);
    const finishOperation = (...args) => globalThis[${JSON.stringify(key)}].finishOperation(...args);
    const getJob = (...args) => globalThis[${JSON.stringify(key)}].getJob(...args);
    const saveJobSources = (...args) => globalThis[${JSON.stringify(key)}].saveJobSources(...args);
    const sha256 = (...args) => globalThis[${JSON.stringify(key)}].sha256(...args);
    const nowIso = () => "2026-09-14T12:00:00.000Z";
  `;
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(prelude + compiled).toString("base64")
  );
  return { module, cleanup: () => { delete globalThis[key]; } };
}

async function testSha256(value) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function job(extra = {}) {
  return {
    job_id: "job-1",
    title: "AI Product Manager",
    company: "Acme",
    location: "Seattle, WA",
    source: "serpapi",
    url: "https://jobs.acme.example/1",
    description: "Build an AI product.",
    found_date: "2026-09-14",
    posted_at: "1 day ago",
    lane_hint: "ai_product",
    dedupe_key: "dedupe-1",
    company_key: "acme",
    title_key: "ai-product-manager",
    description_fingerprint: "description-1",
    opportunity_key: "opportunity-1",
    opportunity_grouping_version: 2,
    discovery_url: "https://google.example/jobs/1",
    source_tier: "employer",
    source_status: "preferred",
    source_checked_at: "2026-09-14T01:00:00Z",
    source_resolution: { evidence_urls: ["https://jobs.acme.example/1"], status: "resolved" },
    source_candidates: [
      { label: "Acme", url: "https://jobs.acme.example/1", source_tier: "employer", position: 0 },
      { label: "LinkedIn", url: "https://linkedin.example/1", source_tier: "linkedin", position: 1 },
    ],
    opportunity_variants: [],
    status: "needs_review",
    analysis: null,
    application: null,
    ...extra,
  };
}

function env({ profile = { context_version: "profile-v1" }, stored = { object_key: "profile/resume.md", size_bytes: 12 }, object = { size: 12, text: async () => "Resume text" } } = {}) {
  const statements = [];
  return {
    statements,
    DB: {
      prepare(sql) {
        const statement = {
          bind(...params) { statement.params = params; return statement; },
          async first() { return sql.includes("profile_versions") ? profile : stored; },
        };
        statements.push({ sql, statement });
        return statement;
      },
    },
    BUCKET: { async get(key) { if (key.endsWith("candidate-context.json")) return null; assert.equal(key, "profile/resume.md"); return object; } },
  };
}

test("active candidate context reads the selected profile resume from R2", async () => {
  const context = await activeCandidateContext(env());
  assert.deepEqual(context, { context_version: "profile-v1", resume_text: "Resume text", background: "", preferences: "" });
});

test("active candidate context reports missing and empty cloud profile data", async () => {
  await assert.rejects(activeCandidateContext(env({ profile: null })), /No active candidate profile/);
  await assert.rejects(activeCandidateContext(env({ stored: null })), /missing its resume text/);
  await assert.rejects(activeCandidateContext(env({ object: null })), /could not be found/);
  await assert.rejects(activeCandidateContext(env({ object: { size: 3, text: async () => "   " } })), /resume text is empty/);
});

test("active candidate context rejects resume text over the worker limit", async () => {
  await assert.rejects(activeCandidateContext(env({ stored: { object_key: "profile/resume.md", size_bytes: 2 * 1024 * 1024 + 1 } })), /exceeds the 2 MB/);
  await assert.rejects(activeCandidateContext(env({ object: { size: 2 * 1024 * 1024 + 1, text: async () => "not read" } })), /exceeds the 2 MB/);
});

test("job source fingerprint ignores user workflow state and JSON key order", () => {
  const initial = job();
  const afterDecision = job({
    status: "applied",
    analysis: { decision: "apply", confidence: "high" },
    application: { status: "applied", notes: "Submitted" },
    source_resolution: { status: "resolved", evidence_urls: ["https://jobs.acme.example/1"] },
  });
  assert.deepEqual(jobSourceFingerprintMaterial(afterDecision), jobSourceFingerprintMaterial(initial));
});

test("job source fingerprint changes for job content and source identity edits", () => {
  const initial = JSON.stringify(jobSourceFingerprintMaterial(job()));
  for (const changed of [
    job({ title: "Senior AI Product Manager" }),
    job({ company: "Acme Labs" }),
    job({ location: "Remote" }),
    job({ url: "https://jobs.acme.example/2" }),
    job({ description: "A revised description." }),
    job({ source_tier: "ats" }),
    job({ source_resolution: { status: "ambiguous" } }),
    job({ source_candidates: [{ label: "Acme", url: "https://jobs.acme.example/2", source_tier: "employer", position: 0 }] }),
    job({ opportunity_variants: [job({ job_id: "job-2", location: "Portland, OR", opportunity_variants: [] })] }),
  ]) {
    assert.notEqual(JSON.stringify(jobSourceFingerprintMaterial(changed)), initial);
  }
});

test("analysis dispatch stores the source fingerprint with the operation", async () => {
  const dispatchedJob = job();
  const createdPayloads = [];
  const harness = {
    async createOperation(_db, _operationType, _resourceKey, payload) {
      createdPayloads.push(payload);
      return { created: false, operation: { operation_id: "existing" } };
    },
    async getJob() { return dispatchedJob; },
    async getOperation() { return null; },
    async finishOperation() {},
    async saveJobSources() {},
    sha256: testSha256,
  };
  const { module, cleanup } = await loadCallbackBridge(harness);
  try {
    const env = envWithProfile();
    await module.dispatchWorkstationOperation(env, "analyze_job", { job_id: dispatchedJob.job_id });
    assert.equal(createdPayloads.length, 1);
    assert.equal(
      createdPayloads[0]._job_source_fingerprint,
      await testSha256(JSON.stringify(jobSourceFingerprintMaterial(dispatchedJob))),
    );
  } finally {
    cleanup();
  }
});

function envWithProfile() {
  return {
    DB: {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() {
            return sql.includes("profile_versions")
              ? { context_version: "profile-v1" }
              : { object_key: "profile/resume.md", size_bytes: 11 };
          },
        };
        return statement;
      },
    },
    BUCKET: { async get(key) { return key.endsWith("candidate-context.json") ? null : { size: 11, text: async () => "Resume text" }; } },
  };
}

test("stale analysis callback fails safely, returns 200, and performs no result writes", async () => {
  const dispatchedJob = job();
  const expectedFingerprint = await testSha256(JSON.stringify(jobSourceFingerprintMaterial(dispatchedJob)));
  const operation = {
    operation_id: "operation-1",
    operation_type: "analyze_job",
    status: "running",
    payload: {
      job_id: dispatchedJob.job_id,
      _input_hash: "input-1",
      _job_source_fingerprint: expectedFingerprint,
    },
    result: null,
  };
  const finishes = [];
  const writes = [];
  const harness = {
    async getOperation() { return operation; },
    async getJob() { return job({ description: "Edited after dispatch.", status: "applied" }); },
    async finishOperation(...args) { finishes.push(args); },
    async saveJobSources(...args) { writes.push(args); },
    sha256: testSha256,
  };
  const { module, cleanup } = await loadCallbackBridge(harness);
  try {
    const request = new Request("https://site.invalid/api/worker/callback/operation-1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-career-worker-secret": "callback-secret" },
      body: JSON.stringify({
        schema_version: 1,
        worker_id: "test-worker",
        instance_id: "test-instance",
        operation_type: "analyze_job",
        input_hash: "input-1",
        status: "succeeded",
        result: {
          decision_memo: {
            decision: "apply",
            fit_tier: "strong",
            sponsorship_tier: "plausible",
            lane: "ai_product",
            resume_strategy: "master",
            confidence: "high",
          },
          job: dispatchedJob,
        },
      }),
    });
    const env = {
      CAREER_WORKER_CALLBACK_SECRET: "callback-secret",
      DB: { prepare(sql) { writes.push(sql); throw new Error("A stale result must not write to D1."); } },
    };
    const response = await module.acceptWorkerCallback(env, request, "operation-1");
    assert.equal(response.status, 200);
    assert.equal(writes.length, 0);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0][2], "failed");
    assert.equal(finishes[0][3], null);
    assert.match(finishes[0][4], /changed while analysis was running/);
    assert.match(finishes[0][4], /retry Analyze/);
  } finally {
    cleanup();
  }
});

test("legacy analysis operation without a source fingerprint remains acceptable", async () => {
  const operation = {
    operation_id: "operation-legacy",
    operation_type: "analyze_job",
    status: "running",
    payload: { job_id: "job-1", _input_hash: "input-legacy" },
    result: null,
  };
  const finishes = [];
  const statements = [];
  const harness = {
    async getOperation() { return operation; },
    async getJob() { return job({ description: "Current description." }); },
    async finishOperation(...args) { finishes.push(args); },
    async saveJobSources() {},
    sha256: testSha256,
  };
  const { module, cleanup } = await loadCallbackBridge(harness);
  try {
    const request = new Request("https://site.invalid/api/worker/callback/operation-legacy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-career-worker-secret": "callback-secret" },
      body: JSON.stringify({
        schema_version: 1,
        worker_id: "test-worker",
        instance_id: "test-instance",
        operation_type: "analyze_job",
        input_hash: "input-legacy",
        status: "succeeded",
        result: {
          decision_memo: {
            decision: "apply",
            fit_tier: "strong",
            sponsorship_tier: "plausible",
            lane: "ai_product",
            resume_strategy: "master",
            confidence: "high",
          },
        },
      }),
    });
    const env = {
      CAREER_WORKER_CALLBACK_SECRET: "callback-secret",
      DB: {
        prepare(sql) {
          const statement = {
            params: [],
            bind(...params) { statement.params = params; return statement; },
            async run() { statements.push({ sql, params: statement.params }); },
          };
          return statement;
        },
      },
    };
    const response = await module.acceptWorkerCallback(env, request, "operation-legacy");
    assert.equal(response.status, 200);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /insert into analyses/);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0][2], "succeeded");
  } finally {
    cleanup();
  }
});
