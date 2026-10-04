from __future__ import annotations

import json
from typing import Any

from .codex_runner import extract_json, run_codex
from .context import load_candidate_context, read_repo_file, section
from .paths import ensure_runtime_dirs
from .sources import (
    PREFERRED_SOURCE_TIERS,
    choose_existing_preferred_match,
    choose_preferred_candidate,
    classify_source,
    inspect_preferred_page,
    normalized_host,
)
from .tracker import (
    apply_source_resolution,
    connect,
    get_job,
    list_jobs,
    normalized_company,
    record_run,
    save_analysis,
)


REQUIRED_MEMO_FIELDS = {
    "decision",
    "fit_tier",
    "sponsorship_tier",
    "lane",
    "resume_strategy",
    "confidence",
    "interview_chance_reasoning",
    "why_apply",
    "risks",
    "jd_evidence",
    "profile_evidence",
    "recommended_next_step",
}

VALID_LANES = {"ai_solutions", "product_ops", "bizops", "tpm_epm", "ai_product", "pmm_gtm_ai", "other"}
VALID_RESUME_STRATEGIES = {"ai_solutions", "product_ops", "bizops", "tpm_epm", "ai_product", "pmm_gtm_ai"}
SUBSTANTIVE_DESCRIPTION_MIN_CHARS = 800
SUBSTANTIVE_DESCRIPTION_MIN_WORDS = 110
RESOLVED_DESCRIPTION_MIN_CHARS = 450
RESOLVED_DESCRIPTION_MIN_WORDS = 65


def validate_decision_memo(memo: dict[str, Any]) -> dict[str, Any]:
    missing = sorted(REQUIRED_MEMO_FIELDS - set(memo))
    if missing:
        raise ValueError(f"Decision memo missing fields: {', '.join(missing)}")
    if memo["sponsorship_tier"] == "blocked_explicit":
        memo["decision"] = "blocked"
        memo["recommended_next_step"] = "skip"
    return memo


def description_is_substantive(description: str | None) -> bool:
    text = str(description or "").strip()
    return len(text) >= SUBSTANTIVE_DESCRIPTION_MIN_CHARS and len(text.split()) >= SUBSTANTIVE_DESCRIPTION_MIN_WORDS


def resolved_description_is_usable(description: str | None) -> bool:
    text = str(description or "").strip()
    return len(text) >= RESOLVED_DESCRIPTION_MIN_CHARS and len(text.split()) >= RESOLVED_DESCRIPTION_MIN_WORDS


def build_analysis_prompt(job: dict[str, Any]) -> str:
    context = load_candidate_context()
    prompt = read_repo_file("prompts/analyze_job.md")
    parts = [prompt, read_repo_file("prompts/verify_job_availability.md")]
    parts.append(section("Job Metadata", json.dumps({k: job.get(k) for k in ("job_id", "title", "company", "location", "url", "source")}, indent=2)))
    parts.append(section("Job Description", job.get("description") or ""))
    parts.append(section("Resume Text", context["resume_text"]))
    parts.append(section("Verified Background", context["background"]))
    parts.append(section("Preferences", context["preferences"]))
    parts.append(section("Lanes", context["lanes"]))
    return "\n".join(parts)


def build_resolution_analysis_prompt(job: dict[str, Any]) -> str:
    context = load_candidate_context()
    prompt = read_repo_file("prompts/resolve_and_analyze_job.md")
    metadata = {
        key: job.get(key)
        for key in (
            "job_id",
            "title",
            "company",
            "location",
            "url",
            "source",
            "source_tier",
            "lane_hint",
            "posted_at",
        )
    }
    metadata["known_source_candidates"] = job.get("source_candidates") or []
    parts = [prompt, read_repo_file("prompts/verify_job_availability.md")]
    parts.append(section("Untrusted Job Metadata", json.dumps(metadata, indent=2)))
    parts.append(section("Untrusted Job Description", job.get("description") or ""))
    parts.append(section("Resume Text", context["resume_text"]))
    parts.append(section("Verified Background", context["background"]))
    parts.append(section("Preferences", context["preferences"]))
    parts.append(section("Lanes", context["lanes"]))
    return "\n".join(parts)


def _same_company(left: str | None, right: str | None) -> bool:
    first = normalized_company(left)
    second = normalized_company(right)
    if not first or not second:
        return False
    return first == second or (len(first) >= 5 and first in second) or (len(second) >= 5 and second in first)


def _source_resolution(
    status: str,
    source_tier: str,
    reason: str,
    evidence_urls: list[str],
    confidence: str = "high",
) -> dict[str, Any]:
    return {
        "status": status,
        "source_tier": source_tier,
        "reason": reason,
        "evidence_urls": list(dict.fromkeys(url for url in evidence_urls if url)),
        "confidence": confidence,
    }


def promote_known_preferred_source(job: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    candidates = [
        candidate
        for candidate in (job.get("source_candidates") or [])
        if str(candidate.get("source_tier") or "") in PREFERRED_SOURCE_TIERS
    ]
    selected = choose_preferred_candidate(candidates)
    if not selected:
        return None
    resolution = _source_resolution(
        "promoted",
        str(selected["source_tier"]),
        "Selected the preferred apply option already returned with the job result.",
        [str(selected["url"])],
    )
    return {**job, "url": selected["url"], "source_tier": selected["source_tier"]}, resolution


def find_existing_preferred_source(job: dict[str, Any]) -> dict[str, Any] | None:
    with connect() as conn:
        candidates = [
            candidate
            for candidate in list_jobs(conn)
            if normalized_company(candidate.get("company")) == normalized_company(job.get("company"))
        ]
    return choose_existing_preferred_match(job, candidates)


def prepare_without_web_resolution(job: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Return an analysis-ready job and optional resolution without consuming a model call."""
    current_tier = str(job.get("source_tier") or "")
    if current_tier != "manual":
        current_tier = classify_source(job.get("url"), job.get("company"))
    local_resolution: dict[str, Any] | None = None
    if current_tier in PREFERRED_SOURCE_TIERS:
        prepared = {**job, "source_tier": current_tier}
    else:
        promoted = promote_known_preferred_source(job)
        if promoted:
            prepared, local_resolution = promoted
        else:
            existing = find_existing_preferred_source(job)
            if not existing:
                return job, None
            tier = classify_source(existing.get("url"), existing.get("company"))
            local_resolution = _source_resolution(
                "reused",
                tier,
                "Matched a preferred listing already saved for the same company and opportunity.",
                [str(existing.get("url") or "")],
            )
            prepared = {
                **job,
                "title": existing.get("title") or job.get("title"),
                "company": existing.get("company") or job.get("company"),
                "location": existing.get("location") or job.get("location"),
                "url": existing.get("url") or job.get("url"),
                "description": existing.get("description") or job.get("description"),
                "source_tier": tier,
            }

    if description_is_substantive(prepared.get("description")):
        return prepared, local_resolution

    inspected = inspect_preferred_page(str(prepared.get("url") or ""))
    if (
        inspected.get("status") == "active"
        and resolved_description_is_usable(inspected.get("description"))
        and (not inspected.get("company") or _same_company(job.get("company"), inspected.get("company")))
    ):
        tier = classify_source(inspected.get("url"), inspected.get("company") or job.get("company"))
        resolution = _source_resolution(
            "refreshed",
            tier,
            str(inspected.get("reason") or "Refreshed the job from its preferred source."),
            [str(inspected.get("url") or "")],
        )
        return {
            **prepared,
            "title": inspected.get("title") or prepared.get("title"),
            "company": inspected.get("company") or prepared.get("company"),
            "location": inspected.get("location") or prepared.get("location"),
            "url": inspected.get("url") or prepared.get("url"),
            "description": inspected.get("description") or prepared.get("description"),
            "source_tier": tier,
        }, resolution
    return job, None


def validate_web_resolution(job: dict[str, Any], payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    resolution = payload.get("resolution")
    memo = payload.get("decision_memo")
    if not isinstance(resolution, dict) or not isinstance(memo, dict):
        raise ValueError("Resolved analysis did not include resolution and decision_memo objects.")
    status = str(resolution.get("status") or "")
    if status not in {"replaced", "unavailable", "ambiguous"}:
        raise ValueError("Resolved analysis returned an unknown source status.")
    resolved_job = resolution.get("resolved_job")
    if not isinstance(resolved_job, dict):
        raise ValueError("Resolved analysis did not include resolved_job.")
    if status == "replaced":
        original_tier = classify_source(job.get("url"), job.get("company"))
        company_changed = not _same_company(job.get("company"), resolved_job.get("company"))
        if company_changed and original_tier not in {"aggregator", "discovery"}:
            raise ValueError("Resolved job did not match the original company.")
        classified_tier = classify_source(resolved_job.get("url"), resolved_job.get("company"))
        declared_tier = str(resolution.get("source_tier") or "unverified")
        if classified_tier in {"aggregator", "discovery"} or declared_tier not in PREFERRED_SOURCE_TIERS:
            raise ValueError("Resolved job did not use an employer, ATS, or LinkedIn source.")
        evidence_hosts = {normalized_host(str(url)) for url in resolution.get("evidence_urls") or []}
        if company_changed and normalized_host(resolved_job.get("url")) not in evidence_hosts:
            raise ValueError("Corrected employer was not supported by authoritative-source evidence.")
        if not str(resolved_job.get("title") or "").strip() or not resolved_description_is_usable(resolved_job.get("description")):
            raise ValueError("Resolved job did not include a usable authoritative title and description.")
    return resolution, validate_decision_memo(memo)


def blocked_source_memo(job: dict[str, Any], resolution: dict[str, Any]) -> dict[str, Any]:
    lane_hint = str(job.get("lane_hint") or "other")
    lane = lane_hint if lane_hint in VALID_LANES else "other"
    strategy = lane if lane in VALID_RESUME_STRATEGIES else "product_ops"
    reason = str(resolution.get("reason") or "No current authoritative posting could be verified.")
    ambiguous = str(resolution.get("status") or "") == "ambiguous"
    evidence_urls = [str(url) for url in resolution.get("evidence_urls") or [] if str(url).strip()]
    evidence = [reason]
    if evidence_urls:
        evidence.append("Authoritative-source checks: " + ", ".join(evidence_urls))
    return {
        "decision": "skip",
        "fit_tier": "blocked",
        "sponsorship_tier": "unknown",
        "lane": lane,
        "resume_strategy": strategy,
        "confidence": str(resolution.get("confidence") or "medium"),
        "interview_chance_reasoning": (
            "Fit cannot be assessed because no single authoritative version of this opportunity could be identified."
            if ambiguous
            else "Fit cannot be assessed because a current authoritative version of this job could not be verified."
        ),
        "why_apply": [],
        "risks": [reason],
        "jd_evidence": evidence,
        "profile_evidence": [],
        "recommended_next_step": "skip",
    }


def unavailable_memo(job: dict[str, Any], resolution: dict[str, Any]) -> dict[str, Any]:
    return blocked_source_memo(job, resolution)


def _run_standard_analysis(job: dict[str, Any]) -> dict[str, Any]:
    paths = ensure_runtime_dirs()
    schema = paths.repo_root / "schemas" / "decision_memo.schema.json"
    result = run_codex(
        build_analysis_prompt(job), run_type="analyze", job_id=job["job_id"],
        output_schema=schema, web_search=True,
    )
    with connect() as conn:
        record_run(conn, job["job_id"], "analyze", result.prompt_path, result.output_path, result.status, result.error)
    if result.status != "success":
        raise RuntimeError(result.error or f"Codex analysis failed. See {result.output_path}")
    return validate_decision_memo(extract_json(result.text))


def _run_web_resolution_analysis(job: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    paths = ensure_runtime_dirs()
    schema = paths.repo_root / "schemas" / "resolved_job_analysis.schema.json"
    result = run_codex(
        build_resolution_analysis_prompt(job),
        run_type="resolve_analyze",
        job_id=job["job_id"],
        output_schema=schema,
        web_search=True,
    )
    with connect() as conn:
        record_run(conn, job["job_id"], "resolve_analyze", result.prompt_path, result.output_path, result.status, result.error)
    if result.status != "success":
        raise RuntimeError(result.error or f"Codex source resolution failed. See {result.output_path}")
    return validate_web_resolution(job, extract_json(result.text))


def analyze_job(job_id: str) -> dict[str, Any]:
    with connect() as conn:
        job = get_job(conn, job_id)
        if not job:
            raise ValueError(f"Job not found: {job_id}")

    prepared_job, local_resolution = prepare_without_web_resolution(job)
    if local_resolution:
        memo = _run_standard_analysis(prepared_job)
        with connect() as conn:
            apply_source_resolution(conn, job_id, local_resolution, prepared_job)
            save_analysis(conn, job_id, memo)
        return memo

    prepared_tier = str(prepared_job.get("source_tier") or "")
    if prepared_tier != "manual":
        prepared_tier = classify_source(prepared_job.get("url"), prepared_job.get("company"))
    if prepared_tier in PREFERRED_SOURCE_TIERS and description_is_substantive(prepared_job.get("description")):
        memo = _run_standard_analysis(prepared_job)
        with connect() as conn:
            conn.execute(
                """
                update jobs
                set source_tier = ?, source_status = case when source_status = 'unresolved' then 'preferred' else source_status end
                where job_id = ?
                """,
                (prepared_tier, job_id),
            )
            save_analysis(conn, job_id, memo)
        return memo

    resolution, memo = _run_web_resolution_analysis(job)
    status = str(resolution["status"])
    if status in {"unavailable", "ambiguous"}:
        memo = blocked_source_memo(job, resolution)
        with connect() as conn:
            apply_source_resolution(conn, job_id, resolution)
            save_analysis(conn, job_id, memo)
        return memo

    resolved_job = dict(resolution["resolved_job"])
    resolved_job["job_id"] = job_id
    with connect() as conn:
        apply_source_resolution(conn, job_id, resolution, resolved_job)
        save_analysis(conn, job_id, memo)
    return memo
