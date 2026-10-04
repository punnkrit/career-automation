export type JsonObject = Record<string, unknown>;
export type Row = Record<string, any>;

export const ELIGIBLE_JOB_STATUSES = new Set(["needs_review", "ready_to_apply", "applied"]);
export const JOB_STATUSES = new Set(["new", "analyzed", "packet_created", "needs_review", "ready_to_apply", "applied", "skipped", "blocked"]);
export const MANUAL_STATUSES = new Set(["new", "needs_review", "ready_to_apply", "applied", "skipped"]);
export const AI_OPERATION_TYPES = new Set(["analyze_job", "build_packet", "daily_report", "research_company", "research_role"]);
export const CONTACT_BOOLEAN_FIELDS = ["request_accepted", "responded", "coffee_chat", "referral"] as const;
export const EVENT_LABELS: Record<string, string> = {
  linkedin_request: "LinkedIn request sent",
  request_accepted: "Request accepted",
  responded: "Responded",
  coffee_chat: "Coffee chat",
  referral: "Referral received",
  paused: "Company paused",
  resumed: "Company resumed",
};

export function nowIso() {
  return new Date().toISOString();
}

export function todayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function problem(detail: string, status = 400) {
  return json({ detail }, status);
}

export async function requestJson<T extends JsonObject>(request: Request): Promise<T> {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A JSON object is required.");
  return value as T;
}

export function normalizeIdentity(value: unknown) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g)?.join(" ") ?? "";
}

export function normalizedCompany(value: unknown) {
  const suffixes = new Set(["corp", "corporation", "inc", "incorporated", "limited", "llc", "llp", "ltd", "plc"]);
  const parts = normalizeIdentity(value).split(" ").filter(Boolean);
  while (parts.length > 1 && suffixes.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

export function normalizedTitle(value: unknown) {
  return normalizeIdentity(value);
}

export function slugify(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

export async function sha256(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function jobIdentity(job: Row) {
  const companyKey = normalizedCompany(job.company);
  const titleKey = normalizedTitle(job.title);
  const description = normalizeIdentity(job.description);
  const descriptionFingerprint = description.split(" ").length >= 30 ? await sha256(description) : "";
  const opportunityKey = companyKey && titleKey && descriptionFingerprint
    ? `opportunity-${await sha256(`${companyKey}|${titleKey}|${descriptionFingerprint}`)}`
    : `listing-${String(job.dedupe_key || job.job_id || "")}`;
  return { companyKey, titleKey, descriptionFingerprint, opportunityKey };
}

export function descriptionSimilarity(left: unknown, right: unknown) {
  const leftWords = normalizeIdentity(left).split(" ").filter(Boolean);
  const rightWords = normalizeIdentity(right).split(" ").filter(Boolean);
  if (leftWords.length < 30 || rightWords.length < 30) return { jaccard: 0, containment: 0, lengthRatio: 0 };
  const shingles = (words: string[]) => new Set(
    Array.from({ length: words.length - 4 }, (_, index) => words.slice(index, index + 5).join("\u0000")),
  );
  const leftShingles = shingles(leftWords);
  const rightShingles = shingles(rightWords);
  const shared = [...leftShingles].filter((item) => rightShingles.has(item)).length;
  const union = new Set([...leftShingles, ...rightShingles]).size;
  return {
    jaccard: union ? shared / union : 0,
    containment: Math.min(leftShingles.size, rightShingles.size) ? shared / Math.min(leftShingles.size, rightShingles.size) : 0,
    lengthRatio: Math.min(leftWords.length, rightWords.length) / Math.max(leftWords.length, rightWords.length),
  };
}

export function descriptionsAreHighConfidenceMatches(left: unknown, right: unknown) {
  const normalizedLeft = normalizeIdentity(left);
  const normalizedRight = normalizeIdentity(right);
  if (normalizedLeft === normalizedRight && normalizedLeft.split(" ").filter(Boolean).length >= 30) return true;
  const { jaccard, containment, lengthRatio } = descriptionSimilarity(left, right);
  return jaccard >= 0.92 || (containment >= 0.97 && lengthRatio >= 0.70);
}

export async function jobDedupeKey(title: string, company: string, location: string, url: string | null) {
  return sha256([title, company, location, url ?? ""].map((value) => value.trim().toLowerCase()).join("|"));
}

export function cleanJobUrl(raw: unknown): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["gh_src", "ref", "referrer", "source", "trk"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}

const ATS_HOSTS = ["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday.com", "smartrecruiters.com", "jobvite.com", "icims.com"];
const AGGREGATOR_HOSTS = ["indeed.com", "glassdoor.com", "ziprecruiter.com", "talent.com", "monster.com", "simplyhired.com"];

export function classifySource(rawUrl: unknown, company?: unknown) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "unverified";
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (ATS_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return "ats";
    if (AGGREGATOR_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return "aggregator";
    if (host.includes("google.com")) return "discovery";
    const companyTokens = normalizedCompany(company).split(" ").filter((token) => token.length > 3);
    if (companyTokens.some((token) => host.includes(token))) return "employer";
    return "unverified";
  } catch {
    return "unverified";
  }
}

export function publicJob(row: Row) {
  const result: Row = { ...row };
  result.source_resolution = parseJson(result.source_resolution_json, null);
  delete result.source_resolution_json;
  if ((!result.source_tier || result.source_tier === "unverified") && result.source === "manual") result.source_tier = "manual";
  if (result.source_status === "unresolved" && ["employer", "ats", "linkedin", "manual"].includes(result.source_tier)) {
    result.source_status = "preferred";
  }
  if ("packet_owner_key" in result || "packet_path" in result) {
    result.packet_available = Boolean(result.packet_owner_key || result.packet_path);
    delete result.packet_owner_key;
    delete result.packet_path;
  }
  return result;
}

export function publicOperation(row: Row) {
  const operation = { ...row };
  operation.payload = parseJson(operation.payload_json, {});
  operation.result = parseJson(operation.result_json, null);
  delete operation.payload_json;
  delete operation.result_json;
  return operation;
}

export function boolRow(row: Row) {
  const result = { ...row };
  for (const field of CONTACT_BOOLEAN_FIELDS) result[field] = Boolean(result[field]);
  return result;
}

export function safeObjectKeyPart(value: unknown) {
  return slugify(value).slice(0, 100);
}

export function contentTypeFor(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return lower.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

export function constantTimeEqual(left: string, right: string) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function withoutPathFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPathFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([key]) => !key.toLowerCase().includes("path"))
        .map(([key, item]) => [key, withoutPathFields(item)]),
    );
  }
  return value;
}
