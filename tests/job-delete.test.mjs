import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../worker/store.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import[\s\S]*?from "\.\/(?:common|search-config)";\s*/gm, "");
const prelude = `
  const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
`;
const { deleteJob, deleteJobs } = await import("data:text/javascript;base64," + Buffer.from(prelude + compiled).toString("base64"));

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  }
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql, values,
            first: async () => sqlite.prepare(sql).get(...values) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
            run: async () => sqlite.prepare(sql).run(...values),
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }) => sqlite.prepare(sql).run(...values));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  for (const [id, key] of [["a", "shared"], ["b", "shared"], ["c", "other"]]) {
    sqlite.prepare("insert into jobs(job_id,title,company,found_date,created_at,updated_at,dedupe_key,company_key,opportunity_key) values(?,?,?,'2026-10-01','now','now',?,'company',?)").run(id, "Role " + id, "Company", id, key);
    sqlite.prepare("insert into analyses values(?,'{}','apply','strong','friendly','other','default','high','now')").run(id);
    sqlite.prepare("insert into applications(job_id,packet_owner_key,resume_strategy,status,packet_date,updated_at) values(?,?,'default','ready','today','now')").run(id, id);
    sqlite.prepare("insert into job_status_events(job_id,previous_status,status,source,changed_at) values(?,'new','ready','manual','now')").run(id);
    sqlite.prepare("insert into job_sources values(?,'employer',?,'employer',0,'now')").run(id, "https://example.com/" + id);
    sqlite.prepare("insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,created_at,updated_at) values(?,'application',?,'resume','resume.pdf','application/pdf','now','now')").run(id, id);
  }
  sqlite.exec("insert into networking_companies(company_key,display_name,created_at,updated_at) values('company','Company','now','now')");
  sqlite.exec("insert into networking_contacts(company_key,name,created_at,updated_at) values('company','Contact','now','now')");
  sqlite.exec("insert into networking_role_research values('company','shared','a','Role a','','fingerprint','','{}','now')");
  return { db, sqlite };
}

test("individual deletion cascades job data and preserves sibling jobs and company contacts", async () => {
  const { db, sqlite } = fixture();
  const result = await deleteJob(db, "a", "listing", 1);
  assert.deepEqual(result.deleted_job_ids, ["a"]);
  for (const table of ["jobs", "analyses", "applications", "job_status_events", "job_sources", "networking_role_research"]) {
    assert.equal(sqlite.prepare("select count(*) as n from " + table + " where job_id='a'").get().n, 0, table);
  }
  assert.equal(sqlite.prepare("select count(*) as n from stored_objects where owner_key='a'").get().n, 0);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 2);
  assert.equal(sqlite.prepare("select count(*) as n from networking_contacts").get().n, 1);
  assert.equal(sqlite.prepare("select count(*) as n from networking_companies").get().n, 1);
  assert.equal(await deleteJob(db, "missing", "listing", 1), null);
  sqlite.close();
});

test("opportunity deletion removes every saved variant and keeps other opportunities", async () => {
  const { db, sqlite } = fixture();
  const result = await deleteJob(db, "a", "opportunity", 2);
  assert.deepEqual(result.deleted_job_ids.sort(), ["a", "b"]);
  assert.deepEqual(sqlite.prepare("select job_id from jobs").all().map((row) => row.job_id), ["c"]);
  sqlite.close();
});

test("changed listing counts and active operations prevent all deletion", async () => {
  const { db, sqlite } = fixture();
  await assert.rejects(deleteJob(db, "a", "opportunity", 1), /saved listings changed/);
  sqlite.exec("insert into operations(operation_id,operation_type,resource_key,payload_json,status,created_at,updated_at) values('op','analyze_job','b','{\"job_id\":\"b\"}','running','now','now')");
  await assert.rejects(deleteJob(db, "a", "opportunity", 2), /Work is still running/);
  sqlite.exec("update operations set operation_type='research_role',resource_key='company:shared',payload_json='{}'");
  await assert.rejects(deleteJob(db, "a", "listing", 1), /Work is still running/);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 3);
  assert.equal(sqlite.prepare("select count(*) as n from networking_role_research").get().n, 1);
  sqlite.close();
});

test("a failed deletion rolls back records removed earlier in the batch", async () => {
  const { db, sqlite } = fixture();
  sqlite.exec("create trigger prevent_delete before delete on jobs when old.job_id='b' begin select raise(abort,'temporary failure'); end");
  await assert.rejects(deleteJob(db, "a", "opportunity", 2), /temporary failure/);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 3);
  assert.equal(sqlite.prepare("select count(*) as n from analyses").get().n, 3);
  assert.equal(sqlite.prepare("select count(*) as n from stored_objects").get().n, 3);
  assert.equal(sqlite.prepare("select count(*) as n from networking_role_research").get().n, 1);
  sqlite.close();
});

test("bulk deletion validates every selected opportunity before making any writes", async () => {
  const { db, sqlite } = fixture();
  await assert.rejects(deleteJobs(db, [
    { job_id: "a", scope: "opportunity", expected_count: 2 },
    { job_id: "c", scope: "opportunity", expected_count: 2 },
  ]), /saved listings changed/);
  await assert.rejects(deleteJobs(db, [
    { job_id: "a", scope: "opportunity", expected_count: 2 },
    { job_id: "missing", scope: "opportunity", expected_count: 1 },
  ]), /no longer exists/);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 3);
  sqlite.close();
});

test("bulk deletion deduplicates overlapping groups and removes all selected rows together", async () => {
  const { db, sqlite } = fixture();
  const result = await deleteJobs(db, [
    { job_id: "a", scope: "opportunity", expected_count: 2 },
    { job_id: "b", scope: "opportunity", expected_count: 2 },
    { job_id: "c", scope: "opportunity", expected_count: 1 },
  ]);
  assert.deepEqual(result.deleted_job_ids.sort(), ["a", "b", "c"]);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 0);
  assert.equal(sqlite.prepare("select count(*) as n from analyses").get().n, 0);
  assert.equal(sqlite.prepare("select count(*) as n from networking_contacts").get().n, 1);
  sqlite.close();
});

test("bulk deletion rolls back every selected opportunity if the final row fails", async () => {
  const { db, sqlite } = fixture();
  sqlite.exec("create trigger prevent_bulk_delete before delete on jobs when old.job_id='c' begin select raise(abort,'temporary failure'); end");
  await assert.rejects(deleteJobs(db, [
    { job_id: "a", scope: "opportunity", expected_count: 2 },
    { job_id: "c", scope: "opportunity", expected_count: 1 },
  ]), /temporary failure/);
  assert.equal(sqlite.prepare("select count(*) as n from jobs").get().n, 3);
  assert.equal(sqlite.prepare("select count(*) as n from stored_objects").get().n, 3);
  sqlite.close();
});
