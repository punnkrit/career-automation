import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Node cannot resolve the Worker's extensionless TypeScript imports directly.
// Compile the actual dependency tree so the test exercises production helpers.
function compiledModule(name) {
  const source = readFileSync(new URL(`../worker/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from "\.\/([\w-]+)"/g, (_, dependency) => `from "${compiledModule(dependency)}"`);
  return "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
}

const { setJobStatus } = await import(compiledModule("store"));

test("Applied records its first click and later status changes keep that date", async () => {
  const job = { status: "ready_to_apply", applied_at: null };
  const events = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => sql.startsWith("select status,applied_at") ? { ...job } : null,
            sql,
            values,
          };
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      const [jobWrite, applicationWrite, eventWrite] = statements;
      assert.match(jobWrite.sql, /update jobs set status=\?,applied_at=\?/);
      assert.match(applicationWrite.sql, /applied_date=coalesce\(applied_date,\?\)/);
      assert.match(eventWrite.sql, /insert into job_status_events/);
      events.push(eventWrite.values);
      job.status = jobWrite.values[0];
      job.applied_at = jobWrite.values[1];
    },
  };

  const applied = await setJobStatus(db, "job-1", "applied");
  assert.equal(applied.status, "applied");
  assert.match(applied.applied_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(events[0].slice(0, 4), ["job-1", "ready_to_apply", "applied", "manual"]);

  await setJobStatus(db, "job-1", "applied");
  assert.equal(events.length, 1);
  await setJobStatus(db, "job-1", "needs_review");
  const reapplied = await setJobStatus(db, "job-1", "applied");
  assert.equal(reapplied.applied_at, applied.applied_at);
  assert.equal(events.length, 3);
});
