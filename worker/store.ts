import {
  ELIGIBLE_JOB_STATUSES,
  EVENT_LABELS,
  JOB_STATUSES,
  MANUAL_STATUSES,
  boolRow,
  classifySource,
  cleanJobUrl,
  descriptionSimilarity,
  descriptionsAreHighConfidenceMatches,
  jobDedupeKey,
  jobIdentity,
  normalizedCompany,
  nowIso,
  parseJson,
  publicJob,
  publicOperation,
  slugify,
  todayIso,
  type Row,
} from "./common";
import { workerLeaseStatement, expireWorkerOperations } from "./operation-lifecycle";
import { LANES, METROS } from "./search-config";

export interface StorageEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

function values(raw: string | null) {
  return String(raw ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function rows(db: D1Database, sql: string, params: unknown[] = []) {
  const result = await db.prepare(sql).bind(...params).all<Row>();
  return result.results ?? [];
}

async function first(db: D1Database, sql: string, params: unknown[] = []) {
  return db.prepare(sql).bind(...params).first<Row>();
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function locationTerms(selections: string[]) {
  const stateAbbreviations: Record<string, string> = {
    California: "CA", Colorado: "CO", Illinois: "IL", Massachusetts: "MA",
    "New Jersey": "NJ", "New York": "NY", Washington: "WA",
  };
  const expanded: string[] = [];
  for (const selection of selections) {
    const metro = METROS.find((item) => item.id === selection);
    const locations = metro?.locations ?? [selection];
    for (const location of locations) {
      const parts = location.split(",").map((item) => item.trim());
      expanded.push(location, parts[0]);
      if (parts.length > 1) {
        expanded.push(`${parts[0]}, ${parts[1]}`);
        if (stateAbbreviations[parts[1]]) expanded.push(`${parts[0]}, ${stateAbbreviations[parts[1]]}`);
      }
    }
  }
  return [...new Set(expanded.map((item) => item.toLowerCase()).filter(Boolean))];
}

export async function listDays(db: D1Database) {
  return (await rows(db, "select distinct found_date from jobs order by found_date desc")).map((row) => String(row.found_date));
}

export async function listJobs(db: D1Database, url: URL) {
  const where: string[] = [];
  const params: unknown[] = [];
  const addIn = (column: string, selected: string[]) => {
    if (!selected.length) return;
    where.push(`${column} in (${placeholders(selected.length)})`);
    params.push(...selected);
  };
  addIn("j.found_date", values(url.searchParams.get("date")));
  addIn("j.job_id", values(url.searchParams.get("ids")));

  const statuses = values(url.searchParams.get("status"));
  if (statuses.length) {
    const selected = statuses.filter((status) => status !== "__blank__");
    const clauses: string[] = [];
    if (selected.length) {
      clauses.push(`j.status in (${placeholders(selected.length)})`);
      params.push(...selected);
    }
    if (statuses.includes("__blank__")) {
      clauses.push("j.status not in ('needs_review','ready_to_apply','applied','skipped')");
    }
    where.push(`(${clauses.join(" or ")})`);
  }

  const analyzed = url.searchParams.get("analyzed");
  if (analyzed === "yes") where.push("a.job_id is not null");
  if (analyzed === "no") where.push("a.job_id is null");

  const lanes = values(url.searchParams.get("lane"));
  if (lanes.length) {
    const tokens = placeholders(lanes.length);
    where.push(`(a.lane in (${tokens}) or j.lane_hint in (${tokens}))`);
    params.push(...lanes, ...lanes);
  }

  const query = String(url.searchParams.get("query") ?? "").trim().toLowerCase();
  if (query) {
    where.push("(lower(j.title) like ? or lower(j.company) like ?)");
    params.push(`%${query}%`, `%${query}%`);
  }

  const locations = locationTerms(values(url.searchParams.get("location")));
  if (locations.length) {
    where.push(`(${locations.map(() => "lower(j.location) like ?").join(" or ")})`);
    params.push(...locations.map((item) => `%${item}%`));
  }

  for (const [queryName, column] of [
    ["decision", "a.decision"],
    ["sponsorship", "a.sponsorship_tier"],
    ["fit", "a.fit_tier"],
    ["confidence", "a.confidence"],
  ] as const) addIn(column, values(url.searchParams.get(queryName)));

  const result = await rows(
    db,
    `select j.*,
      a.decision, a.fit_tier, a.sponsorship_tier, a.lane, a.resume_strategy, a.confidence,
      ap.packet_owner_key, ap.status as application_status,
      (select count(*) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_listing_count,
      (select count(distinct lower(siblings.source)) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_source_count,
      (select count(distinct lower(siblings.location)) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_location_count
    from jobs j
    left join analyses a on a.job_id = j.job_id
    left join applications ap on ap.job_id = j.job_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
    order by j.found_date desc, j.created_at desc`,
    params,
  );
  return result.map(publicJob);
}

export async function getJob(db: D1Database, jobId: string) {
  const rawJob = await first(db, "select * from jobs where job_id = ?", [jobId]);
  if (!rawJob) return null;
  const job = publicJob(rawJob);
  const analysis = await first(db, "select * from analyses where job_id = ?", [jobId]);
  if (analysis) {
    job.analysis = {
      ...analysis,
      decision_memo: parseJson(analysis.decision_memo_json, {}),
    };
    delete job.analysis.decision_memo_json;
  } else {
    job.analysis = null;
  }
  const application = await first(db, "select * from applications where job_id = ?", [jobId]);
  if (application) {
    const sanitized = { ...application };
    delete sanitized.packet_owner_key;
    job.application = sanitized;
  } else {
    job.application = null;
  }
  job.opportunity_variants = (
    await rows(
      db,
      `select j.*, a.decision, a.fit_tier, a.sponsorship_tier, a.lane, a.confidence,
        ap.status as application_status
      from jobs j
      left join analyses a on a.job_id = j.job_id
      left join applications ap on ap.job_id = j.job_id
      where j.opportunity_key = ?
      order by j.found_date desc, j.created_at desc`,
      [job.opportunity_key],
    )
  ).map(publicJob);
  job.source_candidates = await rows(
    db,
    "select label, url, source_tier, candidate_order as position from job_sources where job_id = ? order by candidate_order, url",
    [jobId],
  );
  return job;
}

async function resolvedOpportunityKey(
  db: D1Database,
  identity: Awaited<ReturnType<typeof jobIdentity>>,
  description: string,
) {
  if (!identity.descriptionFingerprint || !identity.companyKey || !identity.titleKey) return identity.opportunityKey;
  const candidates = await rows(
    db,
    "select opportunity_key,description from jobs where company_key=? and title_key=? and opportunity_grouping_version=2",
    [identity.companyKey, identity.titleKey],
  );
  const matches = candidates
    .filter((candidate) => descriptionsAreHighConfidenceMatches(description, candidate.description))
    .map((candidate) => ({ ...descriptionSimilarity(description, candidate.description), key: String(candidate.opportunity_key) }))
    .sort((left, right) => right.jaccard - left.jaccard || right.containment - left.containment || right.key.localeCompare(left.key));
  if (!matches.length) return identity.opportunityKey;
  const selected = matches[0].key;
  const otherKeys = [...new Set(matches.map((match) => match.key).filter((key) => key !== selected))];
  if (otherKeys.length) {
    await db.prepare(`update jobs set opportunity_key=? where opportunity_key in (${placeholders(otherKeys.length)})`)
      .bind(selected, ...otherKeys).run();
  }
  return selected;
}

export async function ingestJob(db: D1Database, input: Row) {
  const lane = String(input.lane_hint ?? "").trim();
  if (![...LANES.map((item) => item.id), "other"].includes(lane)) throw new Error(`Unknown lane: ${lane || "(blank)"}`);
  const status = String(input.status ?? "needs_review").trim();
  if (!MANUAL_STATUSES.has(status)) throw new Error(`Unknown manual decision: ${status}`);
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("Job description is required.");
  const title = String(input.title ?? "Untitled role").trim() || "Untitled role";
  const company = String(input.company ?? "Unknown company").trim() || "Unknown company";
  const location = String(input.location ?? "").trim();
  const url = cleanJobUrl(input.url);
  const dedupeKey = await jobDedupeKey(title, company, location, url);
  const existing = await first(db, "select job_id from jobs where dedupe_key = ?", [dedupeKey]);
  let jobId = String(existing?.job_id ?? "");
  let created = false;
  const stamp = nowIso();
  if (!jobId) {
    jobId = `${slugify(`${company}-${title}-${location}`)}-${crypto.randomUUID().slice(0, 8)}`;
    const identity = await jobIdentity({ job_id: jobId, dedupe_key: dedupeKey, title, company, description });
    const opportunityKey = await resolvedOpportunityKey(db, identity, description);
    await db.prepare(
      `insert into jobs (
        job_id,title,company,location,source,url,description,found_date,posted_at,created_at,updated_at,lane_hint,status,dedupe_key,
        company_key,title_key,description_fingerprint,opportunity_key,opportunity_grouping_version,discovery_url,source_tier,source_status
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      jobId, title, company, location, "manual", url, description, todayIso(), null, stamp, stamp, lane, "new", dedupeKey,
      identity.companyKey, identity.titleKey, identity.descriptionFingerprint, opportunityKey, 2, url, "manual", "preferred",
    ).run();
    created = true;
  }
  await db.prepare("update jobs set lane_hint = ?, updated_at = ? where job_id = ?").bind(lane, stamp, jobId).run();
  await setJobStatus(db, jobId, status, "manual_ingest");
  return { job_id: jobId, created, job: await getJob(db, jobId) };
}

export async function saveDiscoveredJob(db: D1Database, input: Row) {
  const title = String(input.title || "Untitled role");
  const company = String(input.company || "Unknown company");
  const location = String(input.location || "");
  const url = cleanJobUrl(input.url);
  const dedupeKey = String(input.dedupe_key || await jobDedupeKey(title, company, location, url));
  const existing = await first(db, "select job_id,posted_at from jobs where dedupe_key=?", [dedupeKey]);
  if (existing) {
    if (!existing.posted_at && input.posted_at) {
      await db.prepare("update jobs set posted_at=?,updated_at=? where job_id=?")
        .bind(input.posted_at, nowIso(), existing.job_id).run();
    }
    await saveJobSources(db, String(existing.job_id), Array.isArray(input.source_candidates) ? input.source_candidates : []);
    return { jobId: String(existing.job_id), created: false };
  }
  const jobId = String(input.job_id || `${slugify(`${company}-${title}-${location}`)}-${crypto.randomUUID().slice(0, 8)}`);
  const identity = await jobIdentity({ ...input, job_id: jobId, dedupe_key: dedupeKey, title, company });
  const opportunityKey = await resolvedOpportunityKey(db, identity, String(input.description || ""));
  const stamp = nowIso();
  const sourceTier = String(input.source_tier || classifySource(url, company));
  await db.prepare(
    `insert into jobs(
      job_id,title,company,location,source,url,description,found_date,posted_at,created_at,updated_at,lane_hint,status,dedupe_key,
      company_key,title_key,description_fingerprint,opportunity_key,opportunity_grouping_version,discovery_url,source_tier,source_status
    ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    jobId, title, company, location, String(input.source || "serpapi"), url, String(input.description || ""),
    String(input.found_date || todayIso()), input.posted_at ?? null, stamp, stamp, input.lane_hint ?? null, String(input.status || "new"),
    dedupeKey, identity.companyKey, identity.titleKey, identity.descriptionFingerprint, opportunityKey, 2,
    cleanJobUrl(input.discovery_url) || url, sourceTier,
    String(input.source_status || (["employer", "ats", "linkedin", "manual"].includes(sourceTier) ? "preferred" : "unresolved")),
  ).run();
  await saveJobSources(db, jobId, Array.isArray(input.source_candidates) ? input.source_candidates : []);
  return { jobId, created: true };
}

export async function saveJobSources(db: D1Database, jobId: string, candidates: Row[]) {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const url = cleanJobUrl(candidate.url || candidate.link);
    if (!url) continue;
    await db.prepare(
      `insert into job_sources(job_id,label,url,source_tier,candidate_order,created_at) values(?,?,?,?,?,?)
      on conflict(job_id,url) do update set label=excluded.label,source_tier=excluded.source_tier,candidate_order=excluded.candidate_order`,
    ).bind(
      jobId, String(candidate.label || candidate.title || ""), url,
      String(candidate.source_tier || classifySource(url)), Number(candidate.position ?? index), nowIso(),
    ).run();
  }
}

export async function updateJob(db: D1Database, jobId: string, changes: Row) {
  const allowed = new Set(["location", "url", "description"]);
  const keys = Object.keys(changes);
  if (!keys.length) throw new Error("At least one job field is required.");
  if (keys.some((key) => !allowed.has(key))) throw new Error("Only location, URL, and description can be edited.");
  const current = await first(db, "select * from jobs where job_id = ?", [jobId]);
  if (!current) return null;
  const updated: Row = { ...current };
  if ("location" in changes) updated.location = String(changes.location ?? "").trim();
  if ("url" in changes) updated.url = cleanJobUrl(changes.url);
  if ("description" in changes) {
    if (changes.description === null) throw new Error("Job description cannot be null.");
    updated.description = String(changes.description).trim();
  }
  const identity = await jobIdentity(updated);
  const opportunityKey = await resolvedOpportunityKey(db, identity, String(updated.description || ""));
  const sourceTier = "url" in changes ? classifySource(updated.url, updated.company) : updated.source_tier;
  const sourceStatus = "url" in changes ? (["employer", "ats", "linkedin", "manual"].includes(sourceTier) ? "preferred" : "unresolved") : updated.source_status;
  await db.prepare(
    `update jobs set location=?,url=?,description=?,company_key=?,title_key=?,description_fingerprint=?,opportunity_key=?,
      opportunity_grouping_version=2,source_tier=?,source_status=?,source_checked_at=?,source_resolution_json=?,updated_at=? where job_id=?`,
  ).bind(
    updated.location, updated.url, updated.description, identity.companyKey, identity.titleKey, identity.descriptionFingerprint,
    opportunityKey, sourceTier, sourceStatus, "url" in changes ? null : updated.source_checked_at,
    "url" in changes ? null : updated.source_resolution_json, nowIso(), jobId,
  ).run();
  return getJob(db, jobId);
}

export async function setJobStatus(db: D1Database, jobId: string, status: string, source = "manual") {
  if (!JOB_STATUSES.has(status)) throw new Error(`Unknown status: ${status}`);
  const current = await first(db, "select status,applied_at from jobs where job_id = ?", [jobId]);
  if (!current) return null;
  if (current.status === status && !(status === "applied" && !current.applied_at)) {
    return { status, applied_at: current.applied_at ?? null };
  }
  const stamp = nowIso();
  const appliedAt = current.applied_at || (status === "applied" ? stamp : null);
  const appliedDate = status === "applied" ? todayIso() : null;
  await db.batch([
    db.prepare("update jobs set status=?,applied_at=?,updated_at=? where job_id=?").bind(status, appliedAt, stamp, jobId),
    db.prepare("update applications set status=?,applied_date=coalesce(applied_date,?),updated_at=? where job_id=?")
      .bind(status, appliedDate, stamp, jobId),
    db.prepare("insert into job_status_events(job_id,previous_status,status,source,changed_at) values(?,?,?,?,?)")
      .bind(jobId, current.status, status, source, stamp),
  ]);
  return { status, applied_at: appliedAt };
}

function companyStatus(paused: boolean, contacts: Row[]) {
  if (paused) return "paused";
  if (contacts.some((contact) => contact.referral)) return "referral_received";
  if (contacts.some((contact) => contact.responded || contact.coffee_chat)) return "conversation_active";
  if (contacts.length) return "outreach_active";
  return "not_started";
}

export async function listNetworkingCompanies(db: D1Database, includeInactive = false, preview = true) {
  const [jobRows, savedRows, contactRows, eventRows, roleResearchRows] = await Promise.all([
    rows(
      db,
      `select j.job_id,j.title,j.company,j.company_key,j.location,j.url,j.status,j.description,
        j.opportunity_key,j.description_fingerprint,j.found_date,j.created_at,a.fit_tier,a.decision
      from jobs j left join analyses a on a.job_id=j.job_id order by j.found_date desc,j.created_at desc`,
    ),
    rows(db, "select * from networking_companies"),
    rows(db, "select * from networking_contacts order by created_at,contact_id"),
    rows(
      db,
      `select e.*,c.name as contact_name from networking_events e
      left join networking_contacts c on c.contact_id=e.contact_id
      order by e.occurred_at desc,e.event_id desc`,
    ),
    rows(db, "select * from networking_role_research"),
  ]);

  const eligibleByCompany = new Map<string, Row[]>();
  const displayNames = new Map<string, string[]>();
  for (const job of jobRows) {
    const key = String(job.company_key || normalizedCompany(job.company));
    if (!key || !ELIGIBLE_JOB_STATUSES.has(String(job.status))) continue;
    if (!eligibleByCompany.has(key)) eligibleByCompany.set(key, []);
    eligibleByCompany.get(key)!.push(job);
    if (!displayNames.has(key)) displayNames.set(key, []);
    displayNames.get(key)!.push(String(job.company || key));
  }
  const savedByCompany = new Map(savedRows.map((row) => [String(row.company_key), row]));
  const contactsByCompany = new Map<string, Row[]>();
  for (const rawContact of contactRows) {
    const contact = boolRow(rawContact);
    const key = String(contact.company_key);
    if (!contactsByCompany.has(key)) contactsByCompany.set(key, []);
    contactsByCompany.get(key)!.push(contact);
  }
  const eventsByCompany = new Map<string, Row[]>();
  for (const rawEvent of eventRows) {
    const event: Row = { ...rawEvent, label: EVENT_LABELS[String(rawEvent.event_type)] || String(rawEvent.event_type).replace(/_/g, " ") };
    const key = String(event.company_key);
    if (!eventsByCompany.has(key)) eventsByCompany.set(key, []);
    eventsByCompany.get(key)!.push(event);
  }
  const roleResearch = new Map(roleResearchRows.map((row) => [`${row.company_key}:${row.opportunity_key}`, row]));
  const companyKeys = new Set(eligibleByCompany.keys());
  if (includeInactive) for (const key of savedByCompany.keys()) companyKeys.add(key);

  const companies: Row[] = [];
  for (const companyKey of companyKeys) {
    const saved = savedByCompany.get(companyKey) || {};
    const names = displayNames.get(companyKey) || [];
    const frequencies = new Map<string, number>();
    for (const name of names) frequencies.set(name, (frequencies.get(name) || 0) + 1);
    const displayName = String(saved.display_name || [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || companyKey);
    const seen = new Set<string>();
    const roles: Row[] = [];
    for (const job of eligibleByCompany.get(companyKey) || []) {
      const opportunityKey = String(job.opportunity_key || job.job_id);
      if (seen.has(opportunityKey)) continue;
      seen.add(opportunityKey);
      const stored = roleResearch.get(`${companyKey}:${opportunityKey}`);
      const role: Row = {
        job_id: job.job_id,
        opportunity_key: opportunityKey,
        title: job.title,
        location: job.location,
        url: job.url,
        status: job.status,
        fit_tier: job.fit_tier,
        decision: job.decision,
        description_fingerprint: job.description_fingerprint,
        research: stored ? parseJson(stored.research_json, null) : null,
        researched_at: stored?.researched_at ?? null,
        research_stale: stored
          ? String(stored.jd_fingerprint) !== String(job.description_fingerprint || "")
            || String(stored.company_researched_at || "") !== String(saved.researched_at || "")
          : false,
      };
      roles.push(role);
    }
    const contacts = contactsByCompany.get(companyKey) || [];
    const research = parseJson(saved.research_json, null);
    const company: Row = {
      company_key: companyKey,
      display_name: displayName,
      active: roles.length > 0,
      status: companyStatus(Boolean(saved.paused), contacts),
      paused: Boolean(saved.paused),
      roles,
      contacts,
      events: eventsByCompany.get(companyKey) || [],
      research,
      researched_at: saved.researched_at ?? null,
    };
    if (preview && company.research) {
      const allowed = new Set(["schema_version", "official_name", "website", "careers_url", "industry", "headquarters", "size_and_stage", "executive_summary", "editorial", "description"]);
      company.research = Object.fromEntries(Object.entries(company.research).filter(([key]) => allowed.has(key)));
      company.roles = roles.map(({ research: _research, ...role }) => role);
    }
    companies.push(company);
  }
  const statusRank: Record<string, number> = { referral_received: 0, conversation_active: 1, outreach_active: 2, not_started: 3, paused: 4 };
  return companies.sort((left, right) =>
    Number(!left.active) - Number(!right.active)
    || statusRank[left.status] - statusRank[right.status]
    || String(left.display_name).localeCompare(String(right.display_name)),
  );
}

export async function getNetworkingCompany(db: D1Database, companyKey: string) {
  return (await listNetworkingCompanies(db, true, false)).find((company) => company.company_key === companyKey) ?? null;
}

async function ensureCompany(db: D1Database, companyKey: string, displayName: string) {
  const stamp = nowIso();
  await db.prepare(
    `insert into networking_companies(company_key,display_name,created_at,updated_at) values(?,?,?,?)
    on conflict(company_key) do update set display_name=excluded.display_name,updated_at=excluded.updated_at`,
  ).bind(companyKey, displayName, stamp, stamp).run();
}

export async function addNetworkingContacts(db: D1Database, companyKey: string, displayName: string, contacts: Row[]) {
  await ensureCompany(db, companyKey, displayName);
  const ids: number[] = [];
  for (const contact of contacts) {
    const name = String(contact.name ?? "").trim();
    if (!name) throw new Error("Every LinkedIn request needs a name.");
    if (await first(db, "select 1 as found from networking_contacts where company_key=? and lower(name)=lower(?)", [companyKey, name])) {
      throw new Error(`${name} is already tracked for ${displayName}.`);
    }
    const stamp = nowIso();
    const result = await db.prepare(
      "insert into networking_contacts(company_key,name,linkedin_url,created_at,updated_at) values(?,?,?,?,?)",
    ).bind(companyKey, name, String(contact.linkedin_url ?? "").trim(), stamp, stamp).run();
    const contactId = Number(result.meta.last_row_id);
    ids.push(contactId);
    await db.prepare(
      "insert into networking_events(company_key,contact_id,event_type,occurred_at) values(?,?,?,?)",
    ).bind(companyKey, contactId, "linkedin_request", stamp).run();
  }
  return ids;
}

export async function updateNetworkingContact(db: D1Database, contactId: number, changes: Row) {
  const contact = await first(db, "select * from networking_contacts where contact_id=?", [contactId]);
  if (!contact) return false;
  const updates: Row = {};
  for (const field of ["name", "linkedin_url"]) {
    if (!(field in changes)) continue;
    const value = String(changes[field] ?? "").trim();
    if (field === "name" && !value) throw new Error("Contact name cannot be blank.");
    updates[field] = value;
  }
  for (const field of ["request_accepted", "responded", "coffee_chat", "referral"]) {
    if (!(field in changes)) continue;
    const value = Boolean(changes[field]);
    updates[field] = Number(value);
    const previous = Boolean(contact[field]);
    if (value && !previous) {
      await db.prepare(
        "insert into networking_events(company_key,contact_id,event_type,occurred_at) values(?,?,?,?)",
      ).bind(contact.company_key, contactId, field, nowIso()).run();
    } else if (!value && previous) {
      await db.prepare(
        `delete from networking_events where event_id=(
          select event_id from networking_events where contact_id=? and event_type=? order by occurred_at desc,event_id desc limit 1
        )`,
      ).bind(contactId, field).run();
    }
  }
  const fields = Object.keys(updates);
  if (!fields.length) return true;
  updates.updated_at = nowIso();
  fields.push("updated_at");
  await db.prepare(`update networking_contacts set ${fields.map((field) => `${field}=?`).join(",")} where contact_id=?`)
    .bind(...fields.map((field) => updates[field]), contactId).run();
  return true;
}

export async function deleteNetworkingContact(db: D1Database, contactId: number) {
  if (!(await first(db, "select 1 as found from networking_contacts where contact_id=?", [contactId]))) return false;
  await db.batch([
    db.prepare("delete from networking_events where contact_id=?").bind(contactId),
    db.prepare("delete from networking_contacts where contact_id=?").bind(contactId),
  ]);
  return true;
}

export async function setNetworkingPaused(db: D1Database, companyKey: string, displayName: string, paused: boolean) {
  await ensureCompany(db, companyKey, displayName);
  const current = await first(db, "select paused from networking_companies where company_key=?", [companyKey]);
  const changed = Boolean(current?.paused) !== paused;
  await db.prepare("update networking_companies set paused=?,updated_at=? where company_key=?")
    .bind(Number(paused), nowIso(), companyKey).run();
  if (changed) {
    await db.prepare("insert into networking_events(company_key,event_type,occurred_at) values(?,?,?)")
      .bind(companyKey, paused ? "paused" : "resumed", nowIso()).run();
  }
}

export async function getOperation(db: D1Database, operationId: string) {
  await expireWorkerOperations(db);
  const operation = await first(db, "select * from operations where operation_id=?", [operationId]);
  return operation ? publicOperation(operation) : null;
}

export async function listOperations(db: D1Database, limit: number, status?: string | null, operationType?: string | null) {
  await expireWorkerOperations(db);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push("status=?");
    params.push(status);
  }
  if (operationType) {
    conditions.push("operation_type=?");
    params.push(operationType);
  }
  params.push(Math.max(1, Math.min(200, limit)));
  return (
    await rows(
      db,
      `select * from operations ${conditions.length ? `where ${conditions.join(" and ")}` : ""} order by created_at desc limit ?`,
      params,
    )
  ).map(publicOperation);
}

export async function createOperation(
  db: D1Database,
  operationType: string,
  resourceKey: string,
  payload: Row,
  executionTarget: "site" | "workstation",
  status = "starting",
) {
  const stamp = nowIso();
  await expireWorkerOperations(db);
  const active = await first(
    db,
    "select * from operations where operation_type=? and resource_key=? and status in ('starting','queued','running') order by created_at desc limit 1",
    [operationType, resourceKey],
  );
  if (active) return { operation: publicOperation(active), created: false };
  const operationId = crypto.randomUUID();
  const insert = db.prepare(
    `insert into operations(operation_id,operation_type,resource_key,execution_target,payload_json,status,created_at,updated_at)
    values(?,?,?,?,?,?,?,?)`,
  ).bind(operationId, operationType, resourceKey, executionTarget, JSON.stringify(payload), status, stamp, stamp);
  if (executionTarget === "workstation") await db.batch([insert, workerLeaseStatement(db, operationId)]);
  else await insert.run();
  return { operation: await getOperation(db, operationId), created: true };
}

export async function finishOperation(db: D1Database, operationId: string, status: string, result: unknown, error = "") {
  const stamp = nowIso();
  await db.prepare(
    "update operations set status=?,result_json=?,error=?,completed_at=?,updated_at=? where operation_id=? and status in ('starting','queued','running')",
  ).bind(status, result == null ? null : JSON.stringify(result), error, stamp, stamp, operationId).run();
  return getOperation(db, operationId);
}

export async function markOperationRunning(db: D1Database, operationId: string) {
  const stamp = nowIso();
  await db.prepare(
    "update operations set status='running',started_at=?,updated_at=? where operation_id=? and status='starting'",
  ).bind(stamp, stamp, operationId).run();
  return getOperation(db, operationId);
}

export type JobDeletion = { job_id: string; scope: "listing" | "opportunity"; expected_count: number };

// Validate the entire selection before deleting anything; one batch removes all job-owned records.
export async function deleteJobs(db: D1Database, requests: JobDeletion[]) {
  const jobs = await rows(db, "select job_id,opportunity_key,company_key from jobs");
  const targets = new Map<string, Row>();
  for (const request of requests) {
    const job = jobs.find((row) => String(row.job_id) === request.job_id);
    if (!job) throw new Error("A selected job no longer exists. Refresh the jobs and confirm deletion again.");
    const group = request.scope === "opportunity" && job.opportunity_key
      ? jobs.filter((row) => row.opportunity_key === job.opportunity_key)
      : [job];
    if (group.length !== request.expected_count) throw new Error("The saved listings changed. Refresh the jobs and confirm deletion again.");
    group.forEach((row) => targets.set(String(row.job_id), row));
  }
  const ids = [...targets.keys()];
  const active = await rows(db, "select operation_type,resource_key,payload_json from operations where status in ('starting','queued','running')");
  if (active.some((operation) => {
    const payload = parseJson(operation.payload_json, {}) as Row;
    return targets.has(String(payload.job_id || ""))
      || [...targets.values()].some((target) => operation.operation_type === "research_role"
        && String(operation.resource_key) === `${target.company_key}:${target.opportunity_key}`);
  })) throw new Error("Work is still running for a selected job. Wait for it to finish, then try deleting again.");
  const statements: D1PreparedStatement[] = [];
  // Bound each statement's parameter count while retaining a single atomic D1 batch.
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90);
    const parameters = placeholders(chunk.length);
    statements.push(
      db.prepare(`delete from networking_role_research where job_id in (${parameters})`).bind(...chunk),
      db.prepare(`delete from stored_objects where category='application' and owner_key in (${parameters})`).bind(...chunk),
      db.prepare(`delete from jobs where job_id in (${parameters})`).bind(...chunk),
    );
  }
  await db.batch(statements);
  return { deleted: true, deleted_job_ids: ids };
}

export async function deleteJob(db: D1Database, jobId: string, scope: "listing" | "opportunity", expectedCount: number) {
  if (!(await first(db, "select job_id from jobs where job_id=?", [jobId]))) return null;
  return { job_id: jobId, ...await deleteJobs(db, [{ job_id: jobId, scope, expected_count: expectedCount }]) };
}

export async function applicationMetadata(db: D1Database, jobId: string) {
  const job = await getJob(db, jobId);
  if (!job || !job.application) return null;
  const objects = await rows(
    db,
    "select logical_name,filename from stored_objects where category='application' and owner_key=? order by logical_name",
    [jobId],
  );
  return {
    job,
    files: Object.fromEntries(objects.map((object) => [
      String(object.logical_name),
      {
        url: `/api/applications/${encodeURIComponent(jobId)}/artifact/${encodeURIComponent(String(object.logical_name))}`,
        exists: true,
      },
    ])),
  };
}

export async function applicationObject(db: D1Database, jobId: string, logicalName: string) {
  return first(
    db,
    "select * from stored_objects where category='application' and owner_key=? and logical_name=?",
    [jobId, logicalName],
  );
}

export async function reportObject(db: D1Database, reportDate: string) {
  return first(
    db,
    `select o.* from daily_reports r join stored_objects o on o.object_key=r.object_key where r.report_date=?`,
    [reportDate],
  );
}
