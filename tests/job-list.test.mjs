import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src-ui/job-list.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { filterJobs, createLatestLoader } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const empty = { query: "", date: "", analyzed: "", status: "", lane: "", location: "", fit: "", confidence: "", decision: "", sponsorship: "" };
const job = (id, extra = {}) => ({ job_id: id, title: "Product Manager", company: "Other", location: "New York, NY", found_date: "2026-09-05", status: "new", decision: null, ...extra });
const ids = (jobs) => jobs.map((row) => row.job_id);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("search spans all cached pages and matches title/company case-insensitively", () => {
  const rows = Array.from({ length: 730 }, (_, i) => job(String(i)));
  rows[41].title = "Licensed Data & Training Services";
  rows[325].company = "Better Brain";
  rows[729].company = "Rain";
  assert.deepEqual(ids(filterJobs(rows, { ...empty, query: "RAIN" })), ["41", "325", "729"]);
  assert.equal(filterJobs(rows, empty).length, 730);
  assert.equal(filterJobs(rows, { ...empty, query: "missing" }).length, 0);
});

test("analysis presence and blank Decisions retain database semantics", () => {
  const rows = [job("new"), job("saved", { decision: "apply", status: "needs_review" }), job("status-only", { status: "analyzed" }), job("empty-analysis", { decision: "" }), job("applied", { status: "applied" })];
  assert.deepEqual(ids(filterJobs(rows, { ...empty, analyzed: "yes" })), ["saved", "empty-analysis"]);
  assert.deepEqual(ids(filterJobs(rows, { ...empty, analyzed: "no" })), ["new", "status-only", "applied"]);
  assert.deepEqual(ids(filterJobs(rows, { ...empty, status: "__blank__,applied" })), ["new", "status-only", "empty-analysis", "applied"]);
});

test("combined filters, lane hints, metro cities, dates, and matched-search scope", () => {
  const rows = [
    job("match", { company: "Rain", location: "San Francisco, CA (Hybrid)", lane: "other", lane_hint: "product_ops", decision: "apply", fit_tier: "strong", confidence: "high", sponsorship_tier: "plausible", status: "applied" }),
    job("wrong-date", { company: "Rain", found_date: "2026-09-04" })
  ];
  const filters = { ...empty, query: "rain", date: "2026-09-04,2026-09-05", lane: "ai_product,product_ops", location: "bay_area", analyzed: "yes", status: "applied", decision: "apply", fit: "strong", confidence: "high", sponsorship: "plausible" };
  const scope = { metros: [{ id: "bay_area", locations: ["San Francisco, California, United States"] }], ids: ["match"] };
  assert.deepEqual(ids(filterJobs(rows, filters, scope)), ["match"]);
  assert.deepEqual(ids(filterJobs(rows, filters, { ...scope, date: "2026-09-04" })), []);
  assert.deepEqual(ids(filterJobs(rows, empty, { ids: [] })), []);
  assert.deepEqual(ids(filterJobs(rows, { ...empty, date: "2026-09-04" }, { date: "2026-09-05" })), ["match"]);
});

test("each exact filter excludes mismatches", () => {
  const row = job("row", { decision: "apply", fit_tier: "strong", confidence: "high", sponsorship_tier: "plausible" });
  for (const field of ["decision", "fit", "confidence", "sponsorship", "lane", "status", "location", "date"]) {
    assert.deepEqual(filterJobs([row], { ...empty, [field]: "mismatch" }), [], field);
  }
});

test("an older refresh cannot replace newer jobs, and active search survives refresh", async () => {
  const older = deferred(), newer = deferred();
  const requests = [older, newer];
  let cached = [];
  const loader = createLatestLoader(() => requests.shift().promise, (rows) => { cached = rows; });
  const first = loader.load(), second = loader.load();
  const full = Array.from({ length: 730 }, (_, i) => job(String(i), { company: i < 3 ? "Rain" : "Other" }));
  newer.resolve(full);
  await second;
  assert.equal(filterJobs(cached, { ...empty, query: "rain" }).length, 3);
  older.resolve([job("stale")]);
  await first;
  assert.equal(cached.length, 730);
  assert.equal(filterJobs(cached, { ...empty, query: "rain" }).length, 3);
  assert.equal(filterJobs(cached, empty).length, 730);
});

test("invalidated requests and stale errors are ignored; current failures propagate", async () => {
  const pending = [deferred(), deferred(), deferred()];
  let call = 0, commits = 0;
  const loader = createLatestLoader(() => pending[call++].promise, () => { commits++; });
  const first = loader.load();
  loader.invalidate();
  pending[0].resolve([]);
  await first;
  assert.equal(commits, 0);
  const second = loader.load(), third = loader.load();
  pending[1].reject(new Error("old failure"));
  await second;
  pending[2].reject(new Error("current failure"));
  await assert.rejects(third, /current failure/);
});

test("loading feedback follows only the latest request and supports retry", async () => {
  const requests = [deferred(), deferred(), deferred()];
  const states = [];
  let call = 0;
  const loader = createLatestLoader(() => requests[call++].promise, () => {}, (state) => states.push(state));
  const first = loader.load(), second = loader.load();
  requests[0].resolve([]);
  await first;
  assert.deepEqual(states, ["loading", "loading"]);
  requests[1].reject(new Error("offline"));
  await assert.rejects(second, /offline/);
  assert.equal(states.at(-1), "error");
  const retry = loader.load();
  requests[2].resolve([]);
  await retry;
  assert.deepEqual(states.slice(-2), ["loading", "ready"]);
});
