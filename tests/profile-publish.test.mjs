import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../worker/profile.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import[\s\S]*?from "\.\/(?:common|store)";\s*/gm, "");
const prelude = `
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  const problem = (detail, status = 400) => json({ detail }, status);
  const nowIso = () => "2026-09-14T12:00:00.000Z";
  const parseJson = (value, fallback) => {
    try { return typeof value === "string" && value ? JSON.parse(value) : fallback; }
    catch { return fallback; }
  };
  const safeObjectKeyPart = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  const sha256 = async (value) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  };
`;
const { profileInit } = await import(
  "data:text/javascript;base64," + Buffer.from(prelude + compiled).toString("base64")
);

function harness({ activeProfile = null } = {}) {
  const prepared = [];
  const batches = [];
  const puts = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          params: [],
          bind(...params) {
            statement.params = params;
            return statement;
          },
          async first() {
            return activeProfile;
          },
        };
        prepared.push(statement);
        return statement;
      },
      async batch(statements) {
        batches.push(statements);
        return statements.map(() => ({ success: true }));
      },
    },
    BUCKET: {
      async put(key, body, options) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        puts.push({ key, bytes: new Uint8Array(bytes), options });
        return { etag: `etag-${puts.length}` };
      },
    },
  };
  return { env, prepared, batches, puts };
}

function publishRequest(payload) {
  return new Request("https://site.invalid/api/profile/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("empty profile request remains a metadata read", async () => {
  const fixture = harness({
    activeProfile: {
      context_version: "profile-existing",
      resume_parser: "pandoc",
      resume_strategies_json: '["ai_product"]',
      created_at: "2026-09-01T00:00:00Z",
    },
  });
  const request = new Request("https://site.invalid/api/profile/init", {
    method: "POST",
    body: new Uint8Array(),
  });
  const response = await profileInit(fixture.env, request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    context_version: "profile-existing",
    resume_parser: "pandoc",
    created_at: "2026-09-01T00:00:00Z",
    resume_strategies: ["ai_product"],
  });
  assert.equal(fixture.puts.length, 0);
  assert.equal(fixture.batches.length, 0);
});

test("profile publish writes content-addressed R2 objects and activates D1 metadata atomically", async () => {
  const fixture = harness();
  const docx = Buffer.from("PK\u0003\u0004test-docx");
  const response = await profileInit(fixture.env, publishRequest({
    resume_text: "# Resume\n\nExperience",
    resume_parser: "pandoc",
    resume_strategies: ["ai_product", "ai_solutions"],
    resume_docx_base64: docx.toString("base64"),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.context_version, /^profile-[a-f0-9]{24}$/);
  assert.equal(result.resume_text.size_bytes, 20);
  assert.equal(result.resume_docx.size_bytes, docx.byteLength);
  assert.equal(JSON.stringify(result).includes("object_key"), false);
  assert.equal(JSON.stringify(result).includes("base64"), false);
  assert.equal(fixture.puts.length, 2);
  assert.match(fixture.puts[0].key, /^profile\/profile-[a-f0-9]{24}\/resume-text-[a-f0-9]{64}\.md$/);
  assert.match(fixture.puts[1].key, /^profile\/profile-[a-f0-9]{24}\/resume-source-[a-f0-9]{64}\.docx$/);
  assert.equal(fixture.batches.length, 1);
  assert.equal(fixture.batches[0].length, 4);
  const sql = fixture.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /update profile_versions set is_active=0/);
  assert.match(sql, /insert into profile_versions/);
  assert.match(sql, /insert into stored_objects/);
  assert.equal(fixture.batches[0].some((statement) => statement.params.includes("resume_text")), true);
  assert.equal(fixture.batches[0].some((statement) => statement.params.includes("resume_docx")), true);
});

test("profile publish requires a source DOCX", async () => {
  const fixture = harness();
  const response = await profileInit(fixture.env, publishRequest({
    resume_text: "Resume text",
    resume_parser: "python-docx",
    resume_strategies: ["bizops"],
  }));
  assert.equal(response.status, 400);
  assert.equal(fixture.puts.length, 0);
  assert.equal(fixture.batches.length, 0);
});

test("profile publish rejects unexpected, malformed, and oversized input before writing", async () => {
  for (const { payload, status } of [
    {
      payload: {
        resume_text: "Resume",
        resume_parser: "pandoc",
        resume_strategies: ["ai_product"],
        resume_path: "/private/resume.docx",
      },
      status: 400,
    },
    {
      payload: {
        resume_text: "Resume",
        resume_parser: "pandoc",
        resume_strategies: ["ai_product"],
        resume_docx_base64: "not base64!",
      },
      status: 400,
    },
    {
      payload: {
        resume_text: "Resume",
        resume_parser: "pandoc",
        resume_strategies: ["ai_product"],
        resume_docx_base64: Buffer.from("not a docx").toString("base64"),
      },
      status: 400,
    },
    {
      payload: {
        resume_text: "x".repeat(2 * 1024 * 1024 + 1),
        resume_parser: "pandoc",
        resume_strategies: ["ai_product"],
        resume_docx_base64: Buffer.from("PK\u0003\u0004test-docx").toString("base64"),
      },
      status: 413,
    },
  ]) {
    const fixture = harness();
    const response = await profileInit(fixture.env, publishRequest(payload));
    assert.equal(response.status, status);
    assert.equal(fixture.puts.length, 0);
    assert.equal(fixture.batches.length, 0);
  }
});
