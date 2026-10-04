from __future__ import annotations

import json
import hashlib
import re
import sqlite3
import threading
from uuid import uuid4
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .paths import ensure_runtime_dirs
from .sources import PREFERRED_SOURCE_TIERS, classify_source, clean_job_url


JOB_STATUSES = {
    "new",
    "analyzed",
    "packet_created",
    "needs_review",
    "ready_to_apply",
    "applied",
    "skipped",
    "blocked",
}

MANUAL_DECISION_STATUSES = {
    "new",
    "needs_review",
    "ready_to_apply",
    "applied",
    "skipped",
}

COMPANY_LEGAL_SUFFIXES = {
    "corp",
    "corporation",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "llp",
    "ltd",
    "plc",
}
OPPORTUNITY_GROUPING_VERSION = 2
DESCRIPTION_SHINGLE_SIZE = 5
DESCRIPTION_JACCARD_THRESHOLD = 0.92
DESCRIPTION_CONTAINMENT_THRESHOLD = 0.97
DESCRIPTION_MIN_LENGTH_RATIO = 0.70
_DB_INIT_LOCK = threading.Lock()


def normalized_identity_text(value: str | None) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").lower()))


def normalized_company(value: str | None) -> str:
    tokens = normalized_identity_text(value).split()
    while len(tokens) > 1 and tokens[-1] in COMPANY_LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def normalized_title(value: str | None) -> str:
    return normalized_identity_text(value)


def normalized_description(value: str | None) -> str:
    return normalized_identity_text(value)


def description_similarity(left: str | None, right: str | None) -> tuple[float, float, float]:
    left_words = normalized_description(left).split()
    right_words = normalized_description(right).split()
    if len(left_words) < 30 or len(right_words) < 30:
        return 0.0, 0.0, 0.0
    shingle_size = DESCRIPTION_SHINGLE_SIZE
    left_shingles = {tuple(left_words[index:index + shingle_size]) for index in range(len(left_words) - shingle_size + 1)}
    right_shingles = {tuple(right_words[index:index + shingle_size]) for index in range(len(right_words) - shingle_size + 1)}
    shared = len(left_shingles & right_shingles)
    union = len(left_shingles | right_shingles)
    smaller = min(len(left_shingles), len(right_shingles))
    jaccard = shared / union if union else 0.0
    containment = shared / smaller if smaller else 0.0
    length_ratio = min(len(left_words), len(right_words)) / max(len(left_words), len(right_words))
    return jaccard, containment, length_ratio


def descriptions_are_high_confidence_matches(left: str | None, right: str | None) -> bool:
    if normalized_description(left) == normalized_description(right) and len(normalized_description(left).split()) >= 30:
        return True
    jaccard, containment, length_ratio = description_similarity(left, right)
    return jaccard >= DESCRIPTION_JACCARD_THRESHOLD or (
        containment >= DESCRIPTION_CONTAINMENT_THRESHOLD and length_ratio >= DESCRIPTION_MIN_LENGTH_RATIO
    )


def opportunity_identity(job: dict[str, Any]) -> tuple[str, str, str, str]:
    """Return conservative grouping fields without treating normalization as identity by itself."""
    company_key = normalized_company(job.get("company"))
    title_key = normalized_title(job.get("title"))
    description = normalized_description(job.get("description"))
    description_fingerprint = ""
    if len(description.split()) >= 30:
        description_fingerprint = hashlib.sha256(description.encode("utf-8")).hexdigest()
    if company_key and title_key and description_fingerprint:
        basis = f"{company_key}|{title_key}|{description_fingerprint}"
        opportunity_key = "opportunity-" + hashlib.sha256(basis.encode("utf-8")).hexdigest()
    else:
        opportunity_key = "listing-" + str(job.get("dedupe_key") or job.get("job_id") or "")
    return company_key, title_key, description_fingerprint, opportunity_key


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    return date.today().isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    paths = ensure_runtime_dirs()
    conn = sqlite3.connect(paths.db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        # Schema checks include DDL and must not race when analysis workers open
        # their job-specific connections at the same time.
        with _DB_INIT_LOCK:
            init_db(conn)
            conn.commit()
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        create table if not exists jobs (
            job_id text primary key,
            title text not null,
            company text not null,
            location text not null default '',
            source text not null default 'manual',
            url text,
            description text not null default '',
            found_date text not null,
            posted_at text,
            created_at text not null,
            updated_at text not null,
            lane_hint text,
            status text not null default 'new',
            dedupe_key text not null unique,
            company_key text,
            title_key text,
            description_fingerprint text,
            opportunity_key text,
            opportunity_grouping_version integer,
            discovery_url text,
            source_tier text not null default 'unverified',
            source_status text not null default 'unresolved',
            source_checked_at text,
            source_resolution_json text
        );

        create table if not exists job_sources (
            job_id text not null references jobs(job_id) on delete cascade,
            label text not null default '',
            url text not null,
            source_tier text not null,
            candidate_order integer not null default 0,
            created_at text not null,
            primary key (job_id, url)
        );

        create table if not exists job_source_resolution_events (
            resolution_id integer primary key autoincrement,
            job_id text not null references jobs(job_id) on delete cascade,
            resolution_status text not null,
            source_tier text not null,
            payload_json text not null,
            created_at text not null
        );

        create table if not exists analyses (
            job_id text primary key references jobs(job_id) on delete cascade,
            decision_memo_json text not null,
            decision text not null,
            fit_tier text not null,
            sponsorship_tier text not null,
            lane text not null,
            resume_strategy text not null,
            confidence text not null,
            created_at text not null
        );

        create table if not exists applications (
            job_id text primary key references jobs(job_id) on delete cascade,
            packet_path text not null,
            resume_strategy text not null,
            status text not null,
            packet_date text not null,
            applied_date text,
            notes text not null default '',
            updated_at text not null
        );

        create table if not exists runs (
            run_id integer primary key autoincrement,
            job_id text,
            run_type text not null,
            prompt_path text not null,
            output_path text not null,
            status text not null,
            error text not null default '',
            created_at text not null
        );

        create table if not exists operations (
            operation_id text primary key,
            operation_type text not null,
            resource_key text not null,
            payload_json text not null,
            status text not null,
            result_json text,
            error text not null default '',
            created_at text not null,
            started_at text,
            completed_at text,
            updated_at text not null
        );

        create table if not exists networking_companies (
            company_key text primary key,
            display_name text not null,
            paused integer not null default 0,
            research_json text,
            researched_at text,
            created_at text not null,
            updated_at text not null
        );

        create table if not exists networking_contacts (
            contact_id integer primary key autoincrement,
            company_key text not null,
            name text not null,
            linkedin_url text not null default '',
            request_accepted integer not null default 0,
            responded integer not null default 0,
            coffee_chat integer not null default 0,
            referral integer not null default 0,
            created_at text not null,
            updated_at text not null,
            unique(company_key, name)
        );

        create table if not exists networking_events (
            event_id integer primary key autoincrement,
            company_key text not null,
            contact_id integer,
            event_type text not null,
            occurred_at text not null
        );

        create table if not exists networking_role_research (
            company_key text not null,
            opportunity_key text not null,
            job_id text not null,
            title text not null,
            location text not null default '',
            jd_fingerprint text not null,
            company_researched_at text not null default '',
            research_json text not null,
            researched_at text not null,
            primary key (company_key, opportunity_key)
        );
        """
    )
    ensure_column(conn, "jobs", "posted_at", "text")
    ensure_column(conn, "jobs", "company_key", "text")
    ensure_column(conn, "jobs", "title_key", "text")
    ensure_column(conn, "jobs", "description_fingerprint", "text")
    ensure_column(conn, "jobs", "opportunity_key", "text")
    ensure_column(conn, "jobs", "opportunity_grouping_version", "integer")
    ensure_column(conn, "jobs", "discovery_url", "text")
    ensure_column(conn, "jobs", "source_tier", "text not null default 'unverified'")
    ensure_column(conn, "jobs", "source_status", "text not null default 'unresolved'")
    ensure_column(conn, "jobs", "source_checked_at", "text")
    ensure_column(conn, "jobs", "source_resolution_json", "text")
    ensure_column(conn, "networking_contacts", "request_accepted", "integer not null default 0")
    conn.execute(
        """
        update networking_contacts
        set request_accepted = 1
        where request_accepted = 0 and (responded = 1 or coffee_chat = 1 or referral = 1)
        """
    )
    backfill_opportunity_identities(conn)
    conn.execute("create index if not exists idx_jobs_opportunity_key on jobs(opportunity_key)")
    conn.execute("create index if not exists idx_job_sources_job on job_sources(job_id, candidate_order)")
    conn.execute("create index if not exists idx_job_source_events_job on job_source_resolution_events(job_id, created_at desc)")
    conn.execute("create index if not exists idx_networking_contacts_company on networking_contacts(company_key)")
    conn.execute("create index if not exists idx_networking_events_company on networking_events(company_key, occurred_at desc)")
    conn.execute("create index if not exists idx_networking_role_research_company on networking_role_research(company_key)")
    conn.execute("create index if not exists idx_operations_status_created on operations(status, created_at)")
    conn.execute(
        """
        create unique index if not exists idx_operations_active_resource
        on operations(operation_type, resource_key)
        where status in ('queued', 'running')
        """
    )


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"alter table {table} add column {column} {definition}")


def backfill_opportunity_identities(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        select job_id, title, company, description, dedupe_key, created_at
        from jobs
        where opportunity_grouping_version is null or opportunity_grouping_version < ?
        order by created_at, job_id
        """
        ,
        (OPPORTUNITY_GROUPING_VERSION,),
    ).fetchall()
    if not rows:
        return
    candidates: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for row in rows:
        company_key, title_key, description_fingerprint, opportunity_key = opportunity_identity(dict(row))
        candidate_key = (company_key, title_key)
        if description_fingerprint:
            for candidate_opportunity_key, candidate_description in candidates.get(candidate_key, []):
                if descriptions_are_high_confidence_matches(row["description"], candidate_description):
                    opportunity_key = candidate_opportunity_key
                    break
        conn.execute(
            """
            update jobs
            set company_key = ?, title_key = ?, description_fingerprint = ?, opportunity_key = ?, opportunity_grouping_version = ?
            where job_id = ?
            """,
            (company_key, title_key, description_fingerprint, opportunity_key, OPPORTUNITY_GROUPING_VERSION, row["job_id"]),
        )
        if description_fingerprint:
            candidates.setdefault(candidate_key, []).append((opportunity_key, str(row["description"] or "")))


def matched_opportunity_key(
    conn: sqlite3.Connection,
    company_key: str,
    title_key: str,
    description: str | None,
    fallback_key: str,
) -> str:
    if not company_key or not title_key or len(normalized_description(description).split()) < 30:
        return fallback_key
    candidates = conn.execute(
        """
        select opportunity_key, description
        from jobs
        where company_key = ? and title_key = ? and opportunity_grouping_version = ?
        """,
        (company_key, title_key, OPPORTUNITY_GROUPING_VERSION),
    ).fetchall()
    matches: list[tuple[float, float, str]] = []
    for candidate in candidates:
        if descriptions_are_high_confidence_matches(description, candidate["description"]):
            jaccard, containment, _ = description_similarity(description, candidate["description"])
            matches.append((jaccard, containment, str(candidate["opportunity_key"])))
    if not matches:
        return fallback_key
    matches.sort(reverse=True)
    selected_key = matches[0][2]
    other_keys = sorted({match[2] for match in matches if match[2] != selected_key})
    if other_keys:
        placeholders = ", ".join("?" for _ in other_keys)
        conn.execute(
            f"update jobs set opportunity_key = ? where opportunity_key in ({placeholders})",
            [selected_key, *other_keys],
        )
    return selected_key


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def hydrate_job_source_fields(job: dict[str, Any]) -> dict[str, Any]:
    raw_resolution = job.pop("source_resolution_json", None)
    if raw_resolution:
        try:
            job["source_resolution"] = json.loads(raw_resolution)
        except (TypeError, json.JSONDecodeError):
            job["source_resolution"] = None
    else:
        job["source_resolution"] = None
    if not str(job.get("source_tier") or "").strip() or job.get("source_tier") == "unverified":
        inferred = "manual" if job.get("source") == "manual" else classify_source(job.get("url"), job.get("company"))
        if inferred != "unverified":
            job["source_tier"] = inferred
    if job.get("source_status") == "unresolved" and job.get("source_tier") in PREFERRED_SOURCE_TIERS:
        job["source_status"] = "preferred"
    return job


def save_job_sources(conn: sqlite3.Connection, job_id: str, candidates: list[dict[str, Any]]) -> None:
    for candidate in candidates:
        url = str(candidate.get("url") or "").strip()
        if not url:
            continue
        conn.execute(
            """
            insert into job_sources (job_id, label, url, source_tier, candidate_order, created_at)
            values (?, ?, ?, ?, ?, ?)
            on conflict(job_id, url) do update set
                label=excluded.label,
                source_tier=excluded.source_tier,
                candidate_order=excluded.candidate_order
            """,
            (
                job_id,
                str(candidate.get("label") or ""),
                url,
                str(candidate.get("source_tier") or "unverified"),
                int(candidate.get("position") or 0),
                now_iso(),
            ),
        )


def list_job_sources(conn: sqlite3.Connection, job_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        select label, url, source_tier, candidate_order as position
        from job_sources
        where job_id = ?
        order by candidate_order, url
        """,
        (job_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def add_job(conn: sqlite3.Connection, job: dict[str, Any]) -> tuple[str, bool]:
    created_at = now_iso()
    found_date = job.get("found_date") or today_iso()
    company_key, title_key, description_fingerprint, fallback_opportunity_key = opportunity_identity(job)
    opportunity_key = matched_opportunity_key(
        conn,
        company_key,
        title_key,
        job.get("description"),
        fallback_opportunity_key,
    )
    job["opportunity_key"] = opportunity_key
    try:
        conn.execute(
            """
            insert into jobs (
                job_id, title, company, location, source, url, description,
                found_date, posted_at, created_at, updated_at, lane_hint, status, dedupe_key,
                company_key, title_key, description_fingerprint, opportunity_key, opportunity_grouping_version,
                discovery_url, source_tier, source_status, source_checked_at, source_resolution_json
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job["job_id"],
                job.get("title") or "Untitled role",
                job.get("company") or "Unknown company",
                job.get("location") or "",
                job.get("source") or "manual",
                job.get("url"),
                job.get("description") or "",
                found_date,
                job.get("posted_at"),
                created_at,
                created_at,
                job.get("lane_hint"),
                job.get("status") or "new",
                job["dedupe_key"],
                company_key,
                title_key,
                description_fingerprint,
                opportunity_key,
                OPPORTUNITY_GROUPING_VERSION,
                job.get("discovery_url") or job.get("url"),
                job.get("source_tier") or classify_source(job.get("url"), job.get("company")),
                job.get("source_status") or "unresolved",
                job.get("source_checked_at"),
                json.dumps(job.get("source_resolution")) if job.get("source_resolution") else None,
            ),
        )
        save_job_sources(conn, job["job_id"], job.get("source_candidates") or [])
        return job["job_id"], True
    except sqlite3.IntegrityError:
        existing = conn.execute("select job_id from jobs where dedupe_key = ?", (job["dedupe_key"],)).fetchone()
        if existing and job.get("posted_at"):
            conn.execute(
                "update jobs set posted_at = coalesce(posted_at, ?), updated_at = ? where job_id = ?",
                (job.get("posted_at"), now_iso(), existing["job_id"]),
            )
        if existing:
            save_job_sources(conn, str(existing["job_id"]), job.get("source_candidates") or [])
        return str(existing["job_id"]), False


def backfill_job_posted_at(conn: sqlite3.Connection, job_dedupe_key: str, posted_at: str) -> str:
    row = conn.execute("select posted_at from jobs where dedupe_key = ?", (job_dedupe_key,)).fetchone()
    if row is None:
        return "not_found"
    if str(row["posted_at"] or "").strip():
        return "already_set"
    conn.execute(
        "update jobs set posted_at = ?, updated_at = ? where dedupe_key = ?",
        (posted_at, now_iso(), job_dedupe_key),
    )
    return "updated"


def list_days(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("select distinct found_date from jobs order by found_date desc").fetchall()
    return [row["found_date"] for row in rows]


def list_jobs(conn: sqlite3.Connection, filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    filters = filters or {}
    where: list[str] = []
    params: list[Any] = []

    def selected_values(field: str) -> list[str]:
        return [value.strip() for value in str(filters.get(field) or "").split(",") if value.strip()]

    if filters.get("date"):
        dates = selected_values("date")
        where.append("j.found_date in (" + ", ".join("?" for _ in dates) + ")")
        params.extend(dates)
    if filters.get("ids"):
        job_ids = selected_values("ids")
        where.append("j.job_id in (" + ", ".join("?" for _ in job_ids) + ")")
        params.extend(job_ids)
    if filters.get("status"):
        statuses = [status.strip() for status in str(filters["status"]).split(",") if status.strip()]
        include_blank = "__blank__" in statuses
        statuses = [status for status in statuses if status != "__blank__"]
        status_clauses: list[str] = []
        if statuses:
            status_clauses.append("j.status in (" + ", ".join("?" for _ in statuses) + ")")
            params.extend(statuses)
        if include_blank:
            manual_statuses = ["needs_review", "ready_to_apply", "applied", "skipped"]
            status_clauses.append("j.status not in (" + ", ".join("?" for _ in manual_statuses) + ")")
            params.extend(manual_statuses)
        if status_clauses:
            where.append("(" + " or ".join(status_clauses) + ")")
    if filters.get("analyzed") == "yes":
        where.append("a.job_id is not null")
    if filters.get("analyzed") == "no":
        where.append("a.job_id is null")
    if filters.get("lane"):
        lanes = selected_values("lane")
        placeholders = ", ".join("?" for _ in lanes)
        where.append(f"(a.lane in ({placeholders}) or j.lane_hint in ({placeholders}))")
        params.extend(lanes + lanes)
    if filters.get("query"):
        where.append("(lower(j.title) like ? or lower(j.company) like ?)")
        query = f"%{str(filters['query']).lower()}%"
        params.extend([query, query])
    if filters.get("location_terms"):
        location_terms = [str(term).lower() for term in filters["location_terms"] if str(term).strip()]
        if location_terms:
            where.append("(" + " or ".join("lower(j.location) like ?" for _ in location_terms) + ")")
            params.extend([f"%{term}%" for term in location_terms])
    if filters.get("decision"):
        decisions = selected_values("decision")
        where.append("a.decision in (" + ", ".join("?" for _ in decisions) + ")")
        params.extend(decisions)
    if filters.get("sponsorship"):
        sponsorship_tiers = selected_values("sponsorship")
        where.append("a.sponsorship_tier in (" + ", ".join("?" for _ in sponsorship_tiers) + ")")
        params.extend(sponsorship_tiers)
    if filters.get("fit"):
        fit_tiers = selected_values("fit")
        where.append("a.fit_tier in (" + ", ".join("?" for _ in fit_tiers) + ")")
        params.extend(fit_tiers)
    if filters.get("confidence"):
        confidence_levels = selected_values("confidence")
        where.append("a.confidence in (" + ", ".join("?" for _ in confidence_levels) + ")")
        params.extend(confidence_levels)
    where_sql = "where " + " and ".join(where) if where else ""
    rows = conn.execute(
        f"""
        select
            j.*,
            a.decision,
            a.fit_tier,
            a.sponsorship_tier,
            a.lane,
            a.resume_strategy,
            a.confidence,
            ap.packet_path,
            ap.status as application_status,
            (select count(*) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_listing_count,
            (select count(distinct lower(siblings.source)) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_source_count,
            (select count(distinct lower(siblings.location)) from jobs siblings where siblings.opportunity_key = j.opportunity_key) as opportunity_location_count
        from jobs j
        left join analyses a on a.job_id = j.job_id
        left join applications ap on ap.job_id = j.job_id
        {where_sql}
        order by j.found_date desc, j.created_at desc
        """,
        params,
    ).fetchall()
    return [hydrate_job_source_fields(dict(row)) for row in rows]


def get_job(conn: sqlite3.Connection, job_id: str) -> dict[str, Any] | None:
    job = row_to_dict(conn.execute("select * from jobs where job_id = ?", (job_id,)).fetchone())
    if not job:
        return None
    hydrate_job_source_fields(job)
    analysis = row_to_dict(conn.execute("select * from analyses where job_id = ?", (job_id,)).fetchone())
    if analysis:
        analysis["decision_memo"] = json.loads(analysis.pop("decision_memo_json"))
    application = row_to_dict(conn.execute("select * from applications where job_id = ?", (job_id,)).fetchone())
    job["analysis"] = analysis
    job["application"] = application
    variants = conn.execute(
        """
        select
            j.*,
            a.decision,
            a.fit_tier,
            a.sponsorship_tier,
            a.lane,
            a.confidence,
            ap.status as application_status
        from jobs j
        left join analyses a on a.job_id = j.job_id
        left join applications ap on ap.job_id = j.job_id
        where j.opportunity_key = ?
        order by j.found_date desc, j.created_at desc
        """,
        (job.get("opportunity_key"),),
    ).fetchall()
    job["opportunity_variants"] = [hydrate_job_source_fields(dict(row)) for row in variants]
    job["source_candidates"] = list_job_sources(conn, job_id)
    return job


def apply_source_resolution(
    conn: sqlite3.Connection,
    job_id: str,
    resolution: dict[str, Any],
    resolved_job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = row_to_dict(conn.execute("select * from jobs where job_id = ?", (job_id,)).fetchone())
    if current is None:
        raise ValueError(f"Job not found: {job_id}")
    resolved_job = resolved_job or {}
    stamp = now_iso()
    status = str(resolution.get("status") or "ambiguous")
    resolved_url = clean_job_url(resolved_job.get("url") or current.get("url"))
    if resolved_job:
        source_tier = str(
            resolution.get("source_tier")
            or classify_source(resolved_url, resolved_job.get("company") or current.get("company"))
        )
    else:
        current_tier = str(current.get("source_tier") or "")
        source_tier = current_tier if current_tier == "manual" else classify_source(current.get("url"), current.get("company"))
    original_snapshot = {
        "title": current.get("title"),
        "company": current.get("company"),
        "location": current.get("location"),
        "url": current.get("url"),
        "description": current.get("description"),
    }
    resolved_snapshot = {
        "title": resolved_job.get("title") or current.get("title"),
        "company": resolved_job.get("company") or current.get("company"),
        "location": resolved_job.get("location") or current.get("location"),
        "url": resolved_url,
        "description": resolved_job.get("description") or current.get("description"),
    }
    event_payload = {
        **resolution,
        "source_tier": source_tier,
        "original": original_snapshot,
        "resolved": resolved_snapshot,
        "checked_at": stamp,
    }
    conn.execute(
        """
        insert into job_source_resolution_events (
            job_id, resolution_status, source_tier, payload_json, created_at
        ) values (?, ?, ?, ?, ?)
        """,
        (job_id, status, source_tier, json.dumps(event_payload), stamp),
    )
    updated = {**current, **resolved_snapshot}
    company_key, title_key, description_fingerprint, fallback_opportunity_key = opportunity_identity(updated)
    opportunity_key = matched_opportunity_key(
        conn,
        company_key,
        title_key,
        updated.get("description"),
        fallback_opportunity_key,
    )
    public_resolution = {
        "status": status,
        "source_tier": source_tier,
        "reason": str(resolution.get("reason") or ""),
        "confidence": str(resolution.get("confidence") or ""),
        "evidence_urls": list(resolution.get("evidence_urls") or []),
        "original_title": original_snapshot["title"],
        "original_url": original_snapshot["url"],
        "resolved_title": resolved_snapshot["title"],
        "resolved_url": resolved_snapshot["url"],
        "checked_at": stamp,
    }
    conn.execute(
        """
        update jobs
        set title = ?, company = ?, location = ?, url = ?, description = ?,
            company_key = ?, title_key = ?, description_fingerprint = ?, opportunity_key = ?,
            opportunity_grouping_version = ?, source_tier = ?, source_status = ?,
            source_checked_at = ?, source_resolution_json = ?, updated_at = ?
        where job_id = ?
        """,
        (
            updated.get("title") or "Untitled role",
            updated.get("company") or "Unknown company",
            updated.get("location") or "",
            updated.get("url"),
            updated.get("description") or "",
            company_key,
            title_key,
            description_fingerprint,
            opportunity_key,
            OPPORTUNITY_GROUPING_VERSION,
            source_tier,
            status,
            stamp,
            json.dumps(public_resolution),
            stamp,
            job_id,
        ),
    )
    saved = get_job(conn, job_id)
    if saved is None:
        raise ValueError(f"Job not found after source resolution: {job_id}")
    return saved


def update_job(
    conn: sqlite3.Connection,
    job_id: str,
    changes: dict[str, Any],
) -> dict[str, Any]:
    allowed_fields = {"location", "url", "description"}
    unexpected_fields = set(changes) - allowed_fields
    if unexpected_fields:
        raise ValueError(f"Unsupported job fields: {', '.join(sorted(unexpected_fields))}")
    if not changes:
        raise ValueError("At least one job field is required.")

    current = row_to_dict(conn.execute("select * from jobs where job_id = ?", (job_id,)).fetchone())
    if current is None:
        raise ValueError(f"Job not found: {job_id}")

    normalized_changes: dict[str, Any] = {}
    if "location" in changes:
        normalized_changes["location"] = str(changes["location"] or "").strip()
    if "url" in changes:
        normalized_changes["url"] = clean_job_url(changes["url"])
    if "description" in changes:
        if changes["description"] is None:
            raise ValueError("Job description cannot be null.")
        normalized_changes["description"] = str(changes["description"]).strip()

    updated = {**current, **normalized_changes}
    if "url" in normalized_changes:
        source_tier = classify_source(updated.get("url"), updated.get("company"))
        normalized_changes.update(
            {
                "source_tier": source_tier,
                "source_status": "preferred" if source_tier in PREFERRED_SOURCE_TIERS else "unresolved",
                "source_checked_at": None,
                "source_resolution_json": None,
            }
        )
    company_key, title_key, description_fingerprint, fallback_opportunity_key = opportunity_identity(updated)
    opportunity_key = matched_opportunity_key(
        conn,
        company_key,
        title_key,
        updated.get("description"),
        fallback_opportunity_key,
    )
    normalized_changes.update(
        {
            "company_key": company_key,
            "title_key": title_key,
            "description_fingerprint": description_fingerprint,
            "opportunity_key": opportunity_key,
            "opportunity_grouping_version": OPPORTUNITY_GROUPING_VERSION,
            "updated_at": now_iso(),
        }
    )
    assignments = ", ".join(f"{field} = ?" for field in normalized_changes)
    conn.execute(
        f"update jobs set {assignments} where job_id = ?",
        [*normalized_changes.values(), job_id],
    )
    saved = get_job(conn, job_id)
    if saved is None:
        raise ValueError(f"Job not found after update: {job_id}")
    return saved


def save_analysis(conn: sqlite3.Connection, job_id: str, memo: dict[str, Any]) -> None:
    created_at = now_iso()
    conn.execute(
        """
        insert into analyses (
            job_id, decision_memo_json, decision, fit_tier, sponsorship_tier,
            lane, resume_strategy, confidence, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(job_id) do update set
            decision_memo_json=excluded.decision_memo_json,
            decision=excluded.decision,
            fit_tier=excluded.fit_tier,
            sponsorship_tier=excluded.sponsorship_tier,
            lane=excluded.lane,
            resume_strategy=excluded.resume_strategy,
            confidence=excluded.confidence,
            created_at=excluded.created_at
        """,
        (
            job_id,
            json.dumps(memo, indent=2),
            memo["decision"],
            memo["fit_tier"],
            memo["sponsorship_tier"],
            memo["lane"],
            memo["resume_strategy"],
            memo["confidence"],
            created_at,
        ),
    )


def save_application(conn: sqlite3.Connection, job_id: str, packet_path: Path, resume_strategy: str) -> None:
    packet_date = today_iso()
    updated_at = now_iso()
    conn.execute(
        """
        insert into applications (job_id, packet_path, resume_strategy, status, packet_date, updated_at)
        values (?, ?, ?, 'packet_created', ?, ?)
        on conflict(job_id) do update set
            packet_path=excluded.packet_path,
            resume_strategy=excluded.resume_strategy,
            status=excluded.status,
            packet_date=excluded.packet_date,
            updated_at=excluded.updated_at
        """,
        (job_id, str(packet_path), resume_strategy, packet_date, updated_at),
    )
    update_status(conn, job_id, "packet_created")


def update_status(conn: sqlite3.Connection, job_id: str, status: str) -> None:
    if status not in JOB_STATUSES:
        raise ValueError(f"Unknown status: {status}")
    conn.execute("update jobs set status = ?, updated_at = ? where job_id = ?", (status, now_iso(), job_id))
    conn.execute("update applications set status = ?, updated_at = ? where job_id = ?", (status, now_iso(), job_id))


def update_manual_intake(
    conn: sqlite3.Connection,
    job_id: str,
    lane_hint: str,
    status: str,
) -> None:
    """Apply user-owned intake fields even when the listing was already saved."""
    if status not in MANUAL_DECISION_STATUSES:
        raise ValueError(f"Unknown manual decision: {status}")
    cursor = conn.execute(
        "update jobs set lane_hint = ?, status = ?, updated_at = ? where job_id = ?",
        (lane_hint, status, now_iso(), job_id),
    )
    if cursor.rowcount == 0:
        raise ValueError(f"Job not found: {job_id}")
    conn.execute("update applications set status = ?, updated_at = ? where job_id = ?", (status, now_iso(), job_id))


def record_run(conn: sqlite3.Connection, job_id: str | None, run_type: str, prompt_path: Path, output_path: Path, status: str, error: str = "") -> None:
    conn.execute(
        "insert into runs (job_id, run_type, prompt_path, output_path, status, error, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        (job_id, run_type, str(prompt_path), str(output_path), status, error, now_iso()),
    )


def operation_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    operation = dict(row)
    operation["payload"] = json.loads(operation.pop("payload_json") or "{}")
    result_json = operation.pop("result_json")
    operation["result"] = json.loads(result_json) if result_json else None
    return operation


def enqueue_operation(
    conn: sqlite3.Connection,
    operation_type: str,
    resource_key: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    active = conn.execute(
        """
        select * from operations
        where operation_type = ? and resource_key = ? and status in ('queued', 'running')
        order by created_at desc
        limit 1
        """,
        (operation_type, resource_key),
    ).fetchone()
    if active is not None:
        operation = operation_to_dict(active)
        assert operation is not None
        return operation, False
    operation_id = str(uuid4())
    timestamp = now_iso()
    try:
        conn.execute(
            """
            insert into operations (
                operation_id, operation_type, resource_key, payload_json, status, created_at, updated_at
            ) values (?, ?, ?, ?, 'queued', ?, ?)
            """,
            (operation_id, operation_type, resource_key, json.dumps(payload), timestamp, timestamp),
        )
    except sqlite3.IntegrityError:
        active = conn.execute(
            """
            select * from operations
            where operation_type = ? and resource_key = ? and status in ('queued', 'running')
            order by created_at desc
            limit 1
            """,
            (operation_type, resource_key),
        ).fetchone()
        if active is None:
            raise
        operation = operation_to_dict(active)
        assert operation is not None
        return operation, False
    operation = get_operation(conn, operation_id)
    assert operation is not None
    return operation, True


def get_operation(conn: sqlite3.Connection, operation_id: str) -> dict[str, Any] | None:
    return operation_to_dict(
        conn.execute("select * from operations where operation_id = ?", (operation_id,)).fetchone()
    )


def list_operations(
    conn: sqlite3.Connection,
    limit: int = 50,
    status: str | None = None,
    operation_type: str | None = None,
) -> list[dict[str, Any]]:
    conditions: list[str] = []
    params: list[Any] = []
    if status:
        conditions.append("status = ?")
        params.append(status)
    if operation_type:
        conditions.append("operation_type = ?")
        params.append(operation_type)
    where_sql = f" where {' and '.join(conditions)}" if conditions else ""
    rows = conn.execute(
        f"select * from operations{where_sql} order by created_at desc limit ?",
        (*params, limit),
    ).fetchall()
    return [operation for row in rows if (operation := operation_to_dict(row)) is not None]


def claim_next_operation(
    conn: sqlite3.Connection,
    include_operation_types: set[str] | None = None,
    exclude_operation_types: set[str] | None = None,
) -> dict[str, Any] | None:
    conditions = ["status = 'queued'"]
    params: list[Any] = []
    if include_operation_types:
        conditions.append("operation_type in (" + ", ".join("?" for _ in include_operation_types) + ")")
        params.extend(sorted(include_operation_types))
    if exclude_operation_types:
        conditions.append("operation_type not in (" + ", ".join("?" for _ in exclude_operation_types) + ")")
        params.extend(sorted(exclude_operation_types))
    timestamp = now_iso()
    row = conn.execute(
        f"""
        update operations
        set status = 'running', started_at = ?, updated_at = ?
        where operation_id = (
            select operation_id
            from operations
            where {' and '.join(conditions)}
            order by created_at, operation_id
            limit 1
        ) and status = 'queued'
        returning *
        """,
        (timestamp, timestamp, *params),
    ).fetchone()
    if row is None:
        return None
    return operation_to_dict(row)


def finish_operation(
    conn: sqlite3.Connection,
    operation_id: str,
    status: str,
    result: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    if status not in {"succeeded", "failed", "interrupted"}:
        raise ValueError(f"Invalid terminal operation status: {status}")
    timestamp = now_iso()
    conn.execute(
        """
        update operations
        set status = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ?
        where operation_id = ?
        """,
        (status, json.dumps(result) if result is not None else None, error, timestamp, timestamp, operation_id),
    )


def interrupt_running_operations(conn: sqlite3.Connection) -> int:
    timestamp = now_iso()
    updated = conn.execute(
        """
        update operations
        set status = 'interrupted',
            error = 'The workstation service restarted while this operation was running. Retry the action.',
            completed_at = ?,
            updated_at = ?
        where status = 'running'
        """,
        (timestamp, timestamp),
    )
    return updated.rowcount
