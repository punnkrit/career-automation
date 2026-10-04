import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";

const directory = mkdtempSync(join(tmpdir(), "career-leases-"));
for (const name of ["operation-lifecycle", "worker-bridge", "index", "store"]) {
  const result = await build({ entryPoints: [`worker/${name}.ts`], bundle: true, format: "esm", platform: "node", write: false });
  writeFileSync(join(directory, `${name}.mjs`), result.outputFiles[0].text);
}
const lifecycle = await import(pathToFileURL(join(directory, "operation-lifecycle.mjs")));
const bridge = await import(pathToFileURL(join(directory, "worker-bridge.mjs")));
const site = (await import(pathToFileURL(join(directory, "index.mjs")))).default;
const store = await import(pathToFileURL(join(directory, "store.mjs")));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const migration of ["0000_striped_mojo", "0001_nappy_veda", "0002_misty_roulette", "0004_operation_leases"]) {
    sqlite.exec(readFileSync(`drizzle/${migration}.sql`, "utf8"));
  }
  const prepare = (sql, params = []) => ({
    sql, params,
    bind(...values) { return prepare(sql, values); },
    async first() { return sqlite.prepare(sql).get(...params) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async run() { const r = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  const db = { prepare, async batch(statements) {
    sqlite.exec("begin");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec("commit"); return result; }
    catch (error) { sqlite.exec("rollback"); throw error; }
  } };
  return { sqlite, db, env: { DB: db, BUCKET: {}, CAREER_WORKER_CALLBACK_SECRET: "test-secret" } };
}

async function operation(h, id = "attempt-1", target = "workstation") {
  const stamp = new Date().toISOString();
  h.sqlite.prepare("insert into operations(operation_id,operation_type,resource_key,execution_target,payload_json,status,created_at,updated_at) values(?,?,?,?,?,'starting',?,?)")
    .run(id, "research_company", "acme", target, JSON.stringify({ company_key: "acme", _input_hash: "input-hash" }), stamp, stamp);
  if (target === "workstation") await lifecycle.createWorkerLease(h.db, id);
  return store.getOperation(h.db, id);
}
const owner = { worker_id: "pc", instance_id: "instance-a", input_hash: "input-hash" };
function request(body) { return new Request("https://site.invalid/api/worker/complete/attempt-1", { method: "POST", headers: { "x-career-worker-secret": "test-secret" }, body: JSON.stringify(body) }); }
const completion = { schema_version: 1, operation_type: "research_company", ...owner, status: "succeeded", result: { official_name: "Acme", summary: "A result" } };

test("one instance claims the lease; a rebooted instance cannot renew it", async () => {
  const h = database(); await operation(h);
  assert.equal(await lifecycle.renewWorkerLease(h.db, "attempt-1", owner), true);
  assert.equal(await lifecycle.renewWorkerLease(h.db, "attempt-1", { ...owner, instance_id: "instance-b" }), false);
  assert.equal(await lifecycle.renewWorkerLease(h.db, "attempt-1", { ...owner, input_hash: "wrong" }), false);
  assert.equal((await lifecycle.getWorkerLease(h.db, "attempt-1")).instance_id, "instance-a");
});

test("status reads expire dead workers; live leases and cloud search remain active", async () => {
  const h = database(); await operation(h); await lifecycle.renewWorkerLease(h.db, "attempt-1", owner);
  h.sqlite.prepare("update operations set updated_at='2000-01-01' where operation_id=?").run("attempt-1");
  assert.equal((await store.getOperation(h.db, "attempt-1")).status, "starting");
  h.sqlite.prepare("update operation_leases set expires_at='2000-01-01'").run();
  assert.equal(await lifecycle.renewWorkerLease(h.db, "attempt-1", owner), false);
  assert.equal((await store.listOperations(h.db, 20))[0].status, "interrupted");
  await operation(h, "search", "site");
  h.sqlite.prepare("update operations set updated_at='2000-01-01' where operation_id='search'").run();
  await site.scheduled({}, h.env);
  assert.equal((await store.getOperation(h.db, "search")).status, "starting");
});

test("a lost lease cannot write results after a fresh retry", async () => {
  const h = database(); const old = await operation(h); await lifecycle.renewWorkerLease(h.db, "attempt-1", owner);
  h.sqlite.prepare("update operation_leases set expires_at='2000-01-01'").run();
  await lifecycle.expireWorkerOperations(h.db);
  const retry = await store.createOperation(h.db, "research_company", "acme", { company_key: "acme", _input_hash: "input-hash" }, "workstation");
  assert.equal(retry.created, true);
  const buffer = lifecycle.bufferResultWrites(h.db);
  await buffer.db.prepare("insert into networking_companies(company_key,display_name,created_at,updated_at) values('acme','STALE','now','now')").run();
  await assert.rejects(lifecycle.commitWorkerCompletion(h.db, old, completion, buffer.writes, "succeeded", completion.result, ""), /CHECK constraint/);
  assert.equal(h.sqlite.prepare("select count(*) n from networking_companies").get().n, 0);
  assert.equal((await bridge.acceptWorkerCallback(h.env, request(completion), "attempt-1")).status, 409);
});

test("completion and results commit together; duplicate delivery is idempotent", async () => {
  const h = database(); await operation(h); await lifecycle.renewWorkerLease(h.db, "attempt-1", owner);
  assert.equal((await bridge.acceptWorkerCallback(h.env, request(completion), "attempt-1")).status, 200);
  assert.equal((await store.getOperation(h.db, "attempt-1")).status, "succeeded");
  assert.equal(h.sqlite.prepare("select display_name from networking_companies").get().display_name, "Acme");
  assert.equal((await bridge.acceptWorkerCallback(h.env, request(completion), "attempt-1")).status, 200);
  assert.equal((await bridge.acceptWorkerCallback(h.env, request({ ...completion, result: { official_name: "Changed" } }), "attempt-1")).status, 409);
});

test("a result SQL failure rolls back both receipt and terminal state", async () => {
  const h = database(); const op = await operation(h); await lifecycle.renewWorkerLease(h.db, "attempt-1", owner);
  await assert.rejects(lifecycle.commitWorkerCompletion(h.db, op, completion, [h.db.prepare("insert into missing_table values(1)")], "succeeded", completion.result, ""));
  assert.equal((await lifecycle.getWorkerLease(h.db, "attempt-1")).completion_hash, null);
  assert.equal((await store.getOperation(h.db, "attempt-1")).status, "starting");
});

test("heartbeat authentication and wrong instance are rejected", async () => {
  const h = database(); await operation(h);
  const unauthenticated = new Request("https://site.invalid/", { method: "POST", body: JSON.stringify({ schema_version: 1, ...owner }) });
  assert.equal((await bridge.acceptWorkerHeartbeat(h.env, unauthenticated, "attempt-1")).status, 401);
  assert.equal((await bridge.acceptWorkerHeartbeat(h.env, request({ schema_version: 1, ...owner }), "attempt-1")).status, 200);
  assert.equal((await bridge.acceptWorkerHeartbeat(h.env, request({ schema_version: 1, ...owner, instance_id: "new" }), "attempt-1")).status, 409);
});


test("cloud callback infrastructure failures remain retryable", async () => {
  const env = { CAREER_WORKER_CALLBACK_SECRET: "test-secret", DB: { prepare() { throw new Error("Temporary D1 failure"); } } };
  const response = await site.fetch(request(completion), env);
  assert.equal(response.status, 503);
  const heartbeat = new Request("https://site.invalid/api/worker/heartbeat/attempt-1", {
    method: "POST", headers: { "x-career-worker-secret": "test-secret" },
    body: JSON.stringify({ schema_version: 1, ...owner }),
  });
  assert.equal((await site.fetch(heartbeat, env)).status, 503);
});

test("late dispatch failure cannot replace an accepted completion", async () => {
  const h = database(); await operation(h); await lifecycle.renewWorkerLease(h.db, "attempt-1", owner);
  assert.equal((await bridge.acceptWorkerCallback(h.env, request(completion), "attempt-1")).status, 200);
  await store.finishOperation(h.db, "attempt-1", "failed", null, "Late dispatch timeout");
  const op = await store.getOperation(h.db, "attempt-1");
  assert.equal(op.status, "succeeded");
  assert.equal(op.error, "");
});
