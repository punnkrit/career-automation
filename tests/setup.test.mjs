import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
const result = await build({entryPoints:["worker/setup.ts"],bundle:true,format:"esm",platform:"node",write:false});
const {setupProfile,setupStatus} = await import("data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"));
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


function harness() {
  const h = database(); const objects = new Map();
  h.env.BUCKET = {
    async put(key,body) { objects.set(key,body); return {etag:"test-etag"}; },
    async get(key) { const text=objects.get(key); return text === undefined ? null : {text:async()=>text,json:async()=>JSON.parse(text)}; }
  };
  return {...h,objects};
}
const request=(body)=>new Request("https://private.example/api/setup/profile",{method:"PUT",body:JSON.stringify(body)});
test("tracker is usable without profile, worker, or search secrets",async()=>{
 const h=harness();
 assert.deepEqual(await (await setupStatus(h.env)).json(),{tracker:true,profile:false,worker_configured:false,search:false,demo:false});
});
test("hosted profile saves and reads back all context, with exactly one active version",async()=>{
 const h=harness();
 const first={resume_text:"Alex resume",background:"Verified customer project",preferences:"Remote"};
 const result=await setupProfile(request(first),h.env);assert.equal(result.status,200);
 const get=()=>setupProfile(new Request("https://private.example/api/setup/profile"),h.env);
 assert.deepEqual(await (await get()).json(),first);
 await setupProfile(request({...first,preferences:"New York"}),h.env);
 assert.equal(h.sqlite.prepare("select count(*) n from profile_versions where is_active=1").get().n,1);
 assert.equal((await (await get()).json()).preferences,"New York");
 assert.equal(h.objects.size,4);
 assert.equal((await (await setupStatus(h.env)).json()).profile,true);
});
test("invalid or oversized profile input does not write cloud data",async()=>{
 for (const [body,status] of [[{resume_text:""},400],[{resume_text:"x",unexpected:1},400],[{resume_text:"x",background:[]},400],[{resume_text:"x".repeat(524289)},413],[null,400]]) {
  const h=harness(); assert.equal((await setupProfile(request(body),h.env)).status,status);
  assert.equal(h.objects.size,0);
 }
});
test("R2 failure leaves the previously active profile intact",async()=>{
 const h=harness();await setupProfile(request({resume_text:"Original"}),h.env);
 h.env.BUCKET.put=async()=>{throw new Error("storage unavailable")};
 await assert.rejects(setupProfile(request({resume_text:"Replacement"}),h.env),/storage unavailable/);
 assert.equal((await (await setupProfile(new Request("https://private.example/api/setup/profile"),h.env)).json()).resume_text,"Original");
});
