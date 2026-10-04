import { json, nowIso, problem, sha256, type Row } from "./common";
import type { BridgeEnv } from "./worker-bridge";

type SetupEnv = BridgeEnv & { SERPAPI_API_KEY?: string };
const LIMIT = 512 * 1024;

export async function setupStatus(env: SetupEnv) {
  await env.DB.prepare("select 1").first();
  const profile = await env.DB.prepare("select context_version from profile_versions where is_active=1 limit 1").first<Row>();
  return json({ tracker: true, profile: Boolean(profile), worker_configured: Boolean(env.CAREER_API_URL && env.CAREER_PROXY_SECRET), search: Boolean(env.SERPAPI_API_KEY), demo: false });
}

export async function setupProfile(request: Request, env: SetupEnv) {
  if (request.method === "GET") {
    const active = await env.DB.prepare("select context_version from profile_versions where is_active=1 limit 1").first<Row>();
    if (!active) return json({ resume_text: "", background: "", preferences: "" });
    const context = await env.BUCKET.get(`profile/${active.context_version}/candidate-context.json`);
    if (context) return json(await context.json());
    const row = await env.DB.prepare("select object_key from stored_objects where category='profile' and owner_key=? and logical_name='resume_text'").bind(active.context_version).first<Row>();
    const resume = row ? await env.BUCKET.get(String(row.object_key)) : null;
    return json({ resume_text: resume ? await resume.text() : "", background: "", preferences: "" });
  }
  if (request.method !== "PUT") return problem("Method not allowed", 405);
  const reader = request.body?.getReader();
  if (!reader) return problem("Profile content is required", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > LIMIT) { await reader.cancel(); return problem("Profile exceeds 512 KB", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: Row;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return problem("Invalid JSON", 400); }
  if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(k => !["resume_text", "background", "preferences"].includes(k))) return problem("Unexpected profile fields", 400);
  if (typeof body.resume_text !== "string" || !body.resume_text.trim()) return problem("Paste your resume text before saving", 400);
  for (const key of ["background", "preferences"]) if (body[key] !== undefined && typeof body[key] !== "string") return problem(`${key} must be text`, 400);
  const profile = { resume_text: body.resume_text.trim(), background: (body.background || "").trim(), preferences: (body.preferences || "").trim() };
  const hash = await sha256(JSON.stringify(profile));
  const version = `profile-${hash.slice(0, 24)}`; const stamp = nowIso();
  const objects = [
    { logical: "resume_text", filename: "resume_text.md", key: `profile/${version}/resume-text.md`, type: "text/markdown", text: profile.resume_text },
    { logical: "candidate_context", filename: "candidate-context.json", key: `profile/${version}/candidate-context.json`, type: "application/json", text: JSON.stringify(profile) },
  ];
  const statements = [];
  for (const object of objects) {
    const stored = await env.BUCKET.put(object.key, object.text, { httpMetadata: { contentType: object.type } });
    statements.push(env.DB.prepare(`insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,size_bytes,etag,sha256,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?) on conflict(category,owner_key,logical_name) do update set updated_at=excluded.updated_at`)
      .bind(object.key, "profile", version, object.logical, object.filename, object.type, new TextEncoder().encode(object.text).byteLength, stored.etag, await sha256(object.text), stamp, stamp));
  }
  statements.push(env.DB.prepare("update profile_versions set is_active=0 where is_active<>0"));
  statements.push(env.DB.prepare(`insert into profile_versions(context_version,resume_parser,resume_strategies_json,is_active,created_at) values(?,?,?,?,?)
    on conflict(context_version) do update set is_active=1`).bind(version, "hosted-text", '["ai_solutions","product_ops","bizops","tpm_epm","ai_product","pmm_gtm_ai"]', 1, stamp));
  await env.DB.batch(statements);
  return json({ saved: true, context_version: version });
}
