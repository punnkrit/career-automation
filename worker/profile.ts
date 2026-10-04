import { json, nowIso, parseJson, problem, safeObjectKeyPart, sha256, type JsonObject, type Row } from "./common";
import type { StorageEnv } from "./store";

export interface ProfileEnv extends StorageEnv {}

const MAX_REQUEST_BYTES = 14 * 1024 * 1024;
const MAX_RESUME_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RESUME_DOCX_BYTES = 8 * 1024 * 1024;
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PARSER_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const STRATEGY_PATTERN = /^[a-z0-9_+-]{1,64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PUBLISH_FIELDS = new Set(["resume_text", "resume_parser", "resume_strategies", "resume_docx_base64"]);

class ProfileRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProfileRequestError";
  }
}

function invalid(message: string, status = 400): never {
  throw new ProfileRequestError(message, status);
}

async function boundedRequestText(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    invalid("Profile request exceeds the 14 MB limit.", 413);
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_REQUEST_BYTES) {
      await reader.cancel();
      invalid("Profile request exceeds the 14 MB limit.", 413);
    }
    chunks.push(value);
  }
  if (!received) return null;
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return invalid("Profile request must be valid UTF-8 JSON.");
  }
}

function parsePublishPayload(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("Profile request must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("Profile request must be a JSON object.");
  }
  const payload = parsed as JsonObject;
  const unexpected = Object.keys(payload).filter((key) => !PUBLISH_FIELDS.has(key));
  if (unexpected.length) return invalid(`Unexpected profile field: ${unexpected[0]}.`);

  if (typeof payload.resume_text !== "string" || !payload.resume_text.trim()) {
    return invalid("resume_text must be a non-empty string.");
  }
  const resumeText = payload.resume_text;
  const resumeTextBytes = new TextEncoder().encode(resumeText);
  if (resumeTextBytes.byteLength > MAX_RESUME_TEXT_BYTES) {
    return invalid("Resume text exceeds the 2 MB limit.", 413);
  }

  if (typeof payload.resume_parser !== "string" || !PARSER_PATTERN.test(payload.resume_parser)) {
    return invalid("resume_parser is invalid.");
  }
  const parser = payload.resume_parser;

  if (!Array.isArray(payload.resume_strategies) || payload.resume_strategies.length < 1 || payload.resume_strategies.length > 16) {
    return invalid("resume_strategies must contain between 1 and 16 values.");
  }
  const strategies = payload.resume_strategies.map((value) => {
    if (typeof value !== "string" || !STRATEGY_PATTERN.test(value)) return invalid("A resume strategy is invalid.");
    return value;
  });
  if (new Set(strategies).size !== strategies.length) return invalid("resume_strategies must be unique.");

  const encoded = payload.resume_docx_base64;
  if (typeof encoded !== "string" || !encoded || !BASE64_PATTERN.test(encoded)) return invalid("resume_docx_base64 is required and must be valid base64.");
  if (encoded.length > Math.ceil(MAX_RESUME_DOCX_BYTES / 3) * 4) {
    return invalid("Resume DOCX exceeds the 8 MB limit.", 413);
  }
  let resumeDocx: Uint8Array;
  try {
    const binary = atob(encoded);
    resumeDocx = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalid("resume_docx_base64 is invalid.");
  }
  if (!resumeDocx.byteLength) return invalid("Resume DOCX is empty.");
  if (resumeDocx.byteLength > MAX_RESUME_DOCX_BYTES) return invalid("Resume DOCX exceeds the 8 MB limit.", 413);
  if (resumeDocx.byteLength < 4 || resumeDocx[0] !== 0x50 || resumeDocx[1] !== 0x4b || resumeDocx[2] !== 0x03 || resumeDocx[3] !== 0x04) {
    return invalid("Resume DOCX is not a valid DOCX/ZIP file.");
  }
  return { resumeText, resumeTextBytes, parser, strategies, resumeDocx };
}

async function activeProfile(env: ProfileEnv) {
  const profile = await env.DB.prepare(
    "select * from profile_versions where is_active=1 order by created_at desc limit 1",
  ).first<Row>();
  if (!profile) return problem("No cloud profile has been published yet.", 404);
  return json({
    context_version: profile.context_version,
    resume_parser: profile.resume_parser,
    created_at: profile.created_at,
    resume_strategies: parseJson(profile.resume_strategies_json, []),
  });
}

async function publishProfile(env: ProfileEnv, raw: string) {
  const { resumeText, resumeTextBytes, parser, strategies, resumeDocx } = parsePublishPayload(raw);
  const stamp = nowIso();
  const contextHash = await sha256(JSON.stringify({
    resume_text: resumeText,
    resume_parser: parser,
    resume_strategies: strategies,
  }));
  const contextVersion = `profile-${contextHash.slice(0, 24)}`;
  const ownerKey = safeObjectKeyPart(contextVersion);
  const resumeTextHash = await sha256(resumeTextBytes.buffer as ArrayBuffer);
  const resumeTextKey = `profile/${ownerKey}/resume-text-${resumeTextHash}.md`;
  const resumeTextObject = await env.BUCKET.put(resumeTextKey, resumeTextBytes, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  const resumeDocxHash = await sha256(resumeDocx.buffer as ArrayBuffer);
  const resumeDocxKey = `profile/${ownerKey}/resume-source-${resumeDocxHash}.docx`;
  const resumeDocxObject = await env.BUCKET.put(
    resumeDocxKey,
    resumeDocx,
    { httpMetadata: { contentType: DOCX_CONTENT_TYPE } },
  );

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update profile_versions set is_active=0 where is_active<>0 and context_version<>?").bind(contextVersion),
    env.DB.prepare(
      `insert into profile_versions(context_version,resume_parser,resume_strategies_json,is_active,created_at)
      values(?,?,?,?,?)
      on conflict(context_version) do update set resume_parser=excluded.resume_parser,
        resume_strategies_json=excluded.resume_strategies_json,is_active=1,created_at=excluded.created_at`,
    ).bind(contextVersion, parser, JSON.stringify(strategies), 1, stamp),
    env.DB.prepare(
      `insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,size_bytes,etag,sha256,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)
      on conflict(category,owner_key,logical_name) do update set object_key=excluded.object_key,filename=excluded.filename,
        content_type=excluded.content_type,size_bytes=excluded.size_bytes,etag=excluded.etag,sha256=excluded.sha256,updated_at=excluded.updated_at`,
    ).bind(
      resumeTextKey,
      "profile",
      contextVersion,
      "resume_text",
      "resume_text.md",
      "text/markdown; charset=utf-8",
      resumeTextBytes.byteLength,
      resumeTextObject.etag,
      resumeTextHash,
      stamp,
      stamp,
    ),
  ];
  statements.push(
    env.DB.prepare(
      `insert into stored_objects(object_key,category,owner_key,logical_name,filename,content_type,size_bytes,etag,sha256,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)
      on conflict(category,owner_key,logical_name) do update set object_key=excluded.object_key,filename=excluded.filename,
        content_type=excluded.content_type,size_bytes=excluded.size_bytes,etag=excluded.etag,sha256=excluded.sha256,updated_at=excluded.updated_at`,
    ).bind(
      resumeDocxKey,
      "profile",
      contextVersion,
      "resume_docx",
      "resume.docx",
      DOCX_CONTENT_TYPE,
      resumeDocx.byteLength,
      resumeDocxObject.etag,
      resumeDocxHash,
      stamp,
      stamp,
    ),
  );
  await env.DB.batch(statements);
  return json({
    context_version: contextVersion,
    resume_parser: parser,
    resume_strategies: strategies,
    created_at: stamp,
    resume_text: { size_bytes: resumeTextBytes.byteLength, sha256: resumeTextHash },
    resume_docx: { size_bytes: resumeDocx.byteLength, sha256: resumeDocxHash },
  });
}

export async function profileInit(env: ProfileEnv, request: Request) {
  try {
    const raw = await boundedRequestText(request);
    return raw === null ? await activeProfile(env) : await publishProfile(env, raw);
  } catch (error) {
    if (
      error instanceof ProfileRequestError
      || (
        error instanceof Error
        && error.name === "ProfileRequestError"
        && "status" in error
        && typeof error.status === "number"
      )
    ) {
      return problem(error.message, Number((error as ProfileRequestError).status));
    }
    throw error;
  }
}
