import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src-ui/main.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const updateJobStatus = async");
const end = source.indexOf("  const updateJobDetails = async", start);
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function harness(request) {
  const state = { rows: [{ job_id: "one", status: "new", application_status: "new" }, { job_id: "two", status: "applied" }],
    detail: { job_id: "one", status: "new", application: { status: "new" }, opportunity_variants: [{ job_id: "one", status: "new" }] },
    error: "", busy: "", invalidated: 0 };
  const deps = {
    statusSavePending: { current: false }, detailRevision: { current: 0 }, detailTarget: { current: "one" },
    api: request,
    jobLoader: { invalidate: () => { state.invalidated++; } },
    setJobsLoadStatus: (status) => { state.loadStatus = status; },
    setBusy: (value) => { state.busy = value; },
    setError: (value) => { state.error = value; },
    setAllJobs: (update) => { state.rows = update(state.rows); },
    setDetail: (update) => { state.detail = update(state.detail); }
  };
  const save = new Function(...Object.keys(deps), compiled + "; return updateJobStatus;")(...Object.values(deps));
  return { state, save };
}
test("a confirmed status save makes one POST and updates only that listing", async () => {
  const calls = [];
  const { state, save } = harness(async (...args) => { calls.push(args); return { job_id: "one", status: "applied", applied_at: "2026-09-25T18:00:00.000Z" }; });
  await save("one", "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/jobs/one/status");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(state.rows[0].status, "applied");
  assert.equal(state.rows[0].application_status, "applied");
  assert.equal(state.detail.status, "applied");
  assert.equal(state.detail.applied_at, "2026-09-25T18:00:00.000Z");
  assert.equal(state.detail.application.status, "applied");
  assert.equal(state.detail.opportunity_variants[0].status, "applied");
  assert.equal(state.invalidated, 1);
  assert.equal(state.busy, "");
});
test("a failed save leaves the cached status intact and reports the error", async () => {
  const { state, save } = harness(async () => { throw Error("Could not save"); });
  await save("one", "applied");
  assert.equal(state.rows[0].status, "new");
  assert.equal(state.detail.status, "new");
  assert.equal(state.invalidated, 0);
  assert.equal(state.error, "Could not save");
  assert.equal(state.busy, "");
});
test("duplicate clicks do not create competing writes and navigation is preserved", async () => {
  let resolve;
  let calls = 0;
  const { state, save } = harness(() => { calls++; return new Promise((done) => { resolve = done; }); });
  const first = save("one", "applied");
  await save("one", "skipped");
  state.detail = { job_id: "two", status: "needs_review" };
  resolve({ job_id: "one", status: "applied" });
  await first;
  assert.equal(calls, 1);
  assert.equal(state.detail.job_id, "two");
  assert.equal(state.detail.status, "needs_review");
});
