from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import requests
import yaml

from .logging_config import configure_logging
from .paths import ensure_runtime_dirs
from .sources import (
    PREFERRED_SOURCE_TIERS,
    choose_preferred_candidate,
    classify_source,
    clean_job_url,
    normalize_source_candidates,
)
from .tracker import (
    MANUAL_DECISION_STATUSES,
    add_job,
    backfill_job_posted_at,
    connect,
    get_job,
    opportunity_identity,
    today_iso,
    update_manual_intake,
)


logger = logging.getLogger(__name__)
SERPAPI_SEARCH_URL = "https://serpapi.com/search.json"
SERPAPI_REQUEST_TIMEOUT = (5, 30)
SERPAPI_POLL_INTERVAL_SECONDS = 2.0
SERPAPI_POLL_TIMEOUT_SECONDS = 120.0
SERPAPI_RESULTS_PER_PAGE = 10
SERPAPI_MAX_PAGES = 3
SERPAPI_PAGE3_MIN_NEW_OPPORTUNITIES = 3


class SerpApiProcessingTimeout(RuntimeError):
    def __init__(self, search_id: str):
        super().__init__("SerpAPI did not finish processing before the polling deadline.")
        self.search_id = search_id


STATE_ABBREVIATIONS = {
    "California": "CA",
    "Colorado": "CO",
    "Illinois": "IL",
    "Massachusetts": "MA",
    "New Jersey": "NJ",
    "New York": "NY",
    "Washington": "WA",
}


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or "item"


def dedupe_key(title: str, company: str, location: str, url: str | None = None) -> str:
    basis = "|".join([title.strip().lower(), company.strip().lower(), location.strip().lower(), (url or "").strip().lower()])
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def job_id_for(title: str, company: str, location: str) -> str:
    base = slugify(f"{company}-{title}-{location}")
    return f"{base}-{uuid4().hex[:8]}"


def parse_manual_job(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    title = "Untitled role"
    company = "Unknown company"
    location = ""
    url = None
    description_lines: list[str] = []
    for line in text.splitlines():
        lower = line.lower().strip()
        if lower.startswith("title:"):
            title = line.split(":", 1)[1].strip() or title
        elif lower.startswith("company:"):
            company = line.split(":", 1)[1].strip() or company
        elif lower.startswith("location:"):
            location = line.split(":", 1)[1].strip()
        elif lower.startswith("url:"):
            url = line.split(":", 1)[1].strip() or None
        else:
            description_lines.append(line)
    description = "\n".join(description_lines).strip() or text
    return make_job(title=title, company=company, location=location, url=url, description=description, source="manual")


def make_job(
    title: str,
    company: str,
    location: str,
    description: str,
    source: str,
    url: str | None = None,
    lane_hint: str | None = None,
    posted_at: str | None = None,
    source_tier: str | None = None,
    source_status: str | None = None,
    source_candidates: list[dict[str, Any]] | None = None,
    discovery_url: str | None = None,
    status: str = "new",
) -> dict[str, Any]:
    selected_url = clean_job_url(url)
    selected_tier = source_tier or ("manual" if source == "manual" else classify_source(selected_url, company))
    return {
        "job_id": job_id_for(title, company, location),
        "title": title or "Untitled role",
        "company": company or "Unknown company",
        "location": location or "",
        "source": source,
        "url": selected_url,
        "description": description or "",
        "found_date": today_iso(),
        "posted_at": posted_at,
        "lane_hint": lane_hint,
        "status": status,
        "dedupe_key": dedupe_key(title or "Untitled role", company or "Unknown company", location or "", selected_url),
        "source_tier": selected_tier,
        "source_status": source_status or ("preferred" if selected_tier in PREFERRED_SOURCE_TIERS else "unresolved"),
        "source_candidates": source_candidates or [],
        "discovery_url": clean_job_url(discovery_url) or selected_url,
    }


def manual_lane_ids() -> set[str]:
    return {*load_lanes().get("lanes", {}).keys(), "other"}


def normalize_manual_job_payload(payload: dict[str, Any]) -> dict[str, Any]:
    lane_hint = str(payload.get("lane_hint") or payload.get("lane") or "").strip()
    if lane_hint not in manual_lane_ids():
        raise ValueError(f"Unknown lane: {lane_hint or '(blank)'}")

    status = str(payload.get("status") or "needs_review").strip()
    if status not in MANUAL_DECISION_STATUSES:
        raise ValueError(f"Unknown manual decision: {status}")

    description = str(payload.get("description") or "").strip()
    if not description:
        raise ValueError("Job description is required.")

    return {
        "title": str(payload.get("title") or "Untitled role").strip() or "Untitled role",
        "company": str(payload.get("company") or "Unknown company").strip() or "Unknown company",
        "location": str(payload.get("location") or "").strip(),
        "url": str(payload.get("url") or "").strip() or None,
        "description": description,
        "lane_hint": lane_hint,
        "status": status,
    }


def ingest_manual_job_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_manual_job_payload(payload)
    job = make_job(source="manual", **normalized)
    with connect() as conn:
        job_id, created = add_job(conn, job)
        # A pasted listing can match a job found earlier. Lane and Decision are
        # explicit user intent, so apply them to both new and existing records.
        update_manual_intake(conn, job_id, normalized["lane_hint"], normalized["status"])
        saved = get_job(conn, job_id)
    if saved is None:
        raise ValueError(f"Job not found after ingest: {job_id}")
    return {"job_id": job_id, "created": created, "job": saved}


def load_lanes() -> dict[str, Any]:
    lanes_path = ensure_runtime_dirs().repo_root / "config" / "lanes.yaml"
    return yaml.safe_load(lanes_path.read_text(encoding="utf-8"))


def load_metros() -> dict[str, Any]:
    metros_path = ensure_runtime_dirs().repo_root / "config" / "metros.yaml"
    return yaml.safe_load(metros_path.read_text(encoding="utf-8"))


def search_metadata() -> dict[str, Any]:
    lanes_config = load_lanes()
    metros_config = load_metros()
    lanes = [
        {
            "id": lane_id,
            "label": lane.get("label", lane_id),
            "priority": lane.get("priority", 999),
            "target_titles": lane.get("target_titles", []),
            "queries": lane.get("queries", []),
            "positioning": lane.get("positioning", ""),
        }
        for lane_id, lane in lanes_config.get("lanes", {}).items()
    ]
    lanes.sort(key=lambda item: (item["priority"], item["label"]))
    metros = [
        {
            "id": metro_id,
            "label": metro.get("label", metro_id),
            "description": metro.get("description", ""),
            "locations": metro.get("locations", []),
            "search_locations": metro.get("search_locations") or metro.get("locations", [])[:1],
            "edge_locations": metro.get("edge_locations", []),
        }
        for metro_id, metro in metros_config.get("metros", {}).items()
    ]
    return {
        "lanes": lanes,
        "metros": metros,
        "serpapi": {
            "engine": "google_jobs",
            "location_guidance": "Normal searches use one city-level origin per metro, then paginate. Optional edge checks add one rotating outer-metro origin.",
            "fixed_params": {"google_domain": "google.com", "gl": "us", "hl": "en"},
            "results_per_page": SERPAPI_RESULTS_PER_PAGE,
            "max_pages": int(os.environ.get("SERPAPI_MAX_PAGES", SERPAPI_MAX_PAGES)),
            "page3_min_new_opportunities": int(
                os.environ.get("SERPAPI_PAGE3_MIN_NEW_OPPORTUNITIES", SERPAPI_PAGE3_MIN_NEW_OPPORTUNITIES)
            ),
        },
    }


def normalize_values(values: list[str] | str | None) -> list[str]:
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    normalized: list[str] = []
    for value in values:
        cleaned = value.strip()
        if cleaned and cleaned not in normalized:
            normalized.append(cleaned)
    return normalized


def expand_search_locations(
    metro_ids: list[str] | str | None = None,
    locations: list[str] | str | None = None,
    include_edge_check: bool = False,
) -> list[dict[str, str]]:
    metros = load_metros().get("metros", {})
    expanded: list[dict[str, str]] = []
    seen: set[str] = set()
    for metro_id in normalize_values(metro_ids):
        if metro_id not in metros:
            raise ValueError(f"Unknown metro: {metro_id}")
        metro = metros[metro_id]
        search_locations = metro.get("search_locations") or metro.get("locations", [])[:1]
        for location in search_locations:
            key = location.lower()
            if key not in seen:
                expanded.append({"source": metro_id, "location": location})
                seen.add(key)
        edge_locations = metro.get("edge_locations", [])
        if include_edge_check and edge_locations:
            week_number = datetime.now(timezone.utc).isocalendar().week
            edge_location = edge_locations[(week_number - 1) % len(edge_locations)]
            key = edge_location.lower()
            if key not in seen:
                expanded.append({"source": f"{metro_id}:edge", "location": edge_location})
                seen.add(key)
    for location in normalize_values(locations):
        key = location.lower()
        if key not in seen:
            expanded.append({"source": "manual", "location": location})
            seen.add(key)
    return expanded


def canonical_serpapi_location(location: str) -> str:
    """Use the canonical comma-separated shape returned by SerpAPI's Locations API."""
    return ",".join(part.strip() for part in location.split(","))


def location_match_terms(location: str) -> list[str]:
    parts = [part.strip() for part in location.split(",")]
    terms = [location.strip()]
    if parts:
        terms.append(parts[0])
    if len(parts) >= 2:
        city = parts[0]
        state = parts[1]
        terms.append(f"{city}, {state}")
        if state in STATE_ABBREVIATIONS:
            terms.append(f"{city}, {STATE_ABBREVIATIONS[state]}")
    return normalize_values(terms)


def expand_location_filter(location_filter: list[str] | str | None) -> list[str]:
    if not location_filter:
        return []
    metros = load_metros().get("metros", {})
    terms: list[str] = []
    for selected_location in normalize_values(location_filter):
        if selected_location in metros:
            for location in metros[selected_location].get("locations", []):
                terms.extend(location_match_terms(location))
        else:
            terms.extend(location_match_terms(selected_location))
    return normalize_values(terms)


def normalize_serpapi_job(raw: dict[str, Any], lane: str) -> dict[str, Any]:
    company = raw.get("company_name") or raw.get("company") or "Unknown company"
    apply_options = raw.get("apply_options") or []
    candidates = normalize_source_candidates(apply_options if isinstance(apply_options, list) else [], company)
    if not candidates:
        related_links = raw.get("related_links") or []
        candidates = normalize_source_candidates(related_links if isinstance(related_links, list) else [], company)
    if not candidates and raw.get("share_link"):
        candidates = normalize_source_candidates(
            [{"title": "Google Jobs", "link": raw.get("share_link")}],
            company,
        )
    selected = choose_preferred_candidate(candidates)
    url = selected.get("url") if selected else None
    source_tier = str(selected.get("source_tier") or "unverified") if selected else "unverified"
    first_apply_url = None
    if isinstance(apply_options, list) and apply_options and isinstance(apply_options[0], dict):
        first_apply_url = apply_options[0].get("link")
    return make_job(
        title=raw.get("title") or "Untitled role",
        company=company,
        location=raw.get("location") or "",
        url=url,
        description=raw.get("description") or "",
        source="serpapi",
        lane_hint=lane,
        posted_at=serpapi_posted_at(raw),
        source_tier=source_tier,
        source_status="preferred" if source_tier in PREFERRED_SOURCE_TIERS else "unresolved",
        source_candidates=candidates,
        discovery_url=first_apply_url or url,
    )


def serpapi_posted_at(raw: dict[str, Any]) -> str | None:
    detected_extensions = raw.get("detected_extensions") or {}
    detected = str(detected_extensions.get("posted_at") or "").strip()
    if detected:
        return detected
    posted_pattern = re.compile(r"^(?:just posted|today|yesterday|\d+\+?\s+(?:minute|hour|day|week|month)s?\s+ago)$", re.IGNORECASE)
    for extension in raw.get("extensions", []) or []:
        value = str(extension).strip()
        if posted_pattern.match(value):
            return value
    return None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json_atomic(path: Path, payload: Any) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary_path.replace(path)


def recover_abandoned_search_runs(max_age_seconds: float | None = None) -> list[str]:
    """Mark stale running manifests as abandoned without touching active searches."""
    paths = ensure_runtime_dirs()
    cutoff_seconds = max_age_seconds if max_age_seconds is not None else float(os.environ.get("SEARCH_RUN_STALE_SECONDS", "300"))
    now = datetime.now(timezone.utc)
    recovered: list[str] = []
    for manifest_path in paths.search_runs_dir.glob("*.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("status") != "running":
                continue
            started_at = datetime.fromisoformat(str(manifest.get("started_at") or "").replace("Z", "+00:00"))
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=timezone.utc)
            if (now - started_at).total_seconds() < cutoff_seconds:
                continue
            manifest.update(
                {
                    "status": "abandoned",
                    "finished_at": utc_now_iso(),
                    "abandoned_reason": "The API process stopped before this search wrote a final result.",
                }
            )
            write_json_atomic(manifest_path, manifest)
            stale_temporary_path = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
            stale_temporary_path.unlink(missing_ok=True)
            recovered.append(str(manifest.get("run_id") or manifest_path.stem))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    if recovered:
        logger.warning("serpapi_search_runs_marked_abandoned run_ids=%s", ",".join(recovered))
    return recovered


def serpapi_response_was_cached(data: dict[str, Any], request_started_at: datetime) -> bool:
    """Infer SerpAPI cache reuse from metadata created before this request began."""
    metadata = data.get("search_metadata") or {}
    if metadata.get("cached") is True:
        return True
    created_at = str(metadata.get("created_at") or "").strip()
    if not created_at:
        return False
    parsed: datetime | None = None
    for format_string in ("%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            parsed = datetime.strptime(created_at, format_string)
            break
        except ValueError:
            continue
    if parsed is None:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (request_started_at - parsed.astimezone(timezone.utc)).total_seconds() > 5


def redact_sensitive_data(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    sensitive_keys = {"api_key", "authorization", "cookie", "proxy_authorization", "set_cookie", "x_api_key"}
    if isinstance(value, dict):
        return {
            str(key): "<redacted>" if str(key).lower().replace("-", "_") in sensitive_keys else redact_sensitive_data(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive_data(item, secrets) for item in value]
    if isinstance(value, str):
        redacted = value
        for secret in secrets:
            if secret:
                redacted = redacted.replace(secret, "<redacted>")
        return redacted
    return value


def serpapi_error_details(exc: Exception, response: requests.Response | None = None) -> tuple[str, str]:
    if isinstance(exc, SerpApiProcessingTimeout):
        return "processing_timeout", "SerpAPI did not finish processing within 120 seconds."
    if isinstance(exc, requests.Timeout):
        return "timeout", "A SerpAPI submit or polling request timed out."
    if isinstance(exc, requests.HTTPError):
        if response is None:
            response = exc.response
        status_code = response.status_code if response is not None else None
        status = f" HTTP {status_code}" if status_code is not None else ""
        return "http_error", f"SerpAPI returned{status}."
    if isinstance(exc, requests.ConnectionError):
        return "connection_error", "Could not connect to SerpAPI."
    if isinstance(exc, requests.RequestException):
        return "request_error", "The SerpAPI request failed."
    return "invalid_response", str(exc)


SerpApiResponseRecorder = Callable[[str, int, requests.Response, Any], None]


def decode_serpapi_response(
    response: requests.Response,
    phase: str,
    poll_count: int,
    response_recorder: SerpApiResponseRecorder | None,
) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError as exc:
        if response_recorder:
            response_recorder(phase, poll_count, response, {"raw_text": str(getattr(response, "text", ""))})
        response.raise_for_status()
        raise ValueError("SerpAPI returned a non-JSON response.") from exc
    if response_recorder:
        response_recorder(phase, poll_count, response, data)
    response.raise_for_status()
    if not isinstance(data, dict):
        raise ValueError("SerpAPI returned a JSON value that was not an object.")
    return data


def fetch_serpapi_async(
    params: dict[str, str],
    api_key: str,
    response_recorder: SerpApiResponseRecorder | None = None,
) -> tuple[dict[str, Any], str | None, int]:
    """Submit without holding a long-lived connection, then poll the search archive."""
    response = requests.get(
        SERPAPI_SEARCH_URL,
        params={**params, "api_key": api_key, "async": "true"},
        timeout=SERPAPI_REQUEST_TIMEOUT,
    )
    data = decode_serpapi_response(response, "submit", 0, response_recorder)
    if data.get("error"):
        raise ValueError("SerpAPI returned an error response.")

    metadata = data.get("search_metadata") or {}
    status = str(metadata.get("status") or "")
    search_id = metadata.get("id")
    if status == "Success" or (not status and "jobs_results" in data):
        return data, search_id, 0
    if not search_id:
        raise ValueError("SerpAPI async response did not include a search ID.")

    poll_interval = float(os.environ.get("SERPAPI_POLL_INTERVAL_SECONDS", SERPAPI_POLL_INTERVAL_SECONDS))
    poll_timeout = float(os.environ.get("SERPAPI_POLL_TIMEOUT_SECONDS", SERPAPI_POLL_TIMEOUT_SECONDS))
    deadline = time.monotonic() + poll_timeout
    poll_count = 0
    while time.monotonic() < deadline:
        time.sleep(poll_interval)
        poll_count += 1
        response = requests.get(
            f"https://serpapi.com/searches/{search_id}.json",
            params={"api_key": api_key},
            timeout=SERPAPI_REQUEST_TIMEOUT,
        )
        data = decode_serpapi_response(response, "poll", poll_count, response_recorder)
        metadata = data.get("search_metadata") or {}
        status = str(metadata.get("status") or "")
        if status == "Success":
            return data, str(search_id), poll_count
        if status == "Error" or data.get("error"):
            raise ValueError("SerpAPI search finished with an error status.")
    raise SerpApiProcessingTimeout(str(search_id))


def update_search_manifest(path: Path, manifest: dict[str, Any], results: list[dict[str, Any]], normalized_path: Path) -> None:
    write_json_atomic(normalized_path, results)
    write_json_atomic(path, manifest)


def search_serpapi(
    lane: str | list[str],
    location: str | list[str] | None = None,
    limit: int = 20,
    metro_ids: list[str] | str | None = None,
    request_plan: list[dict[str, str]] | None = None,
    include_edge_check: bool = False,
) -> dict[str, Any]:
    configure_logging()
    recover_abandoned_search_runs()
    paths = ensure_runtime_dirs()
    api_key = os.environ.get("SERPAPI_API_KEY", "")
    if not api_key:
        raise RuntimeError("SERPAPI_API_KEY is missing. Manual ingestion still works.")
    lanes = load_lanes()["lanes"]
    lane_ids = normalize_values([item.get("lane", "") for item in request_plan] if request_plan is not None else lane)
    if not lane_ids:
        raise ValueError("At least one lane is required.")
    for lane_id in lane_ids:
        if lane_id not in lanes:
            raise ValueError(f"Unknown lane: {lane_id}")
    if limit < 1 or limit > 30:
        raise ValueError("Search limit must be between 1 and 30 jobs per query-origin pair.")
    configured_max_pages = max(1, int(os.environ.get("SERPAPI_MAX_PAGES", SERPAPI_MAX_PAGES)))
    max_pages = min(configured_max_pages, SERPAPI_MAX_PAGES, math.ceil(limit / SERPAPI_RESULTS_PER_PAGE))
    page3_min_new_opportunities = max(
        0,
        int(os.environ.get("SERPAPI_PAGE3_MIN_NEW_OPPORTUNITIES", SERPAPI_PAGE3_MIN_NEW_OPPORTUNITIES)),
    )
    if request_plan is None:
        location_targets = expand_search_locations(metro_ids, location, include_edge_check)
    else:
        location_targets = []
        seen_targets: set[tuple[str, str]] = set()
        for item in request_plan:
            item_location = str(item.get("location") or "").strip()
            item_source = str(item.get("location_source") or "manual").strip()
            if not item_location:
                raise ValueError("Each retry request requires a location.")
            key = (item_location, item_source)
            if key not in seen_targets:
                location_targets.append({"location": item_location, "source": item_source})
                seen_targets.add(key)
    if not location_targets:
        raise ValueError("At least one metro or manual location is required.")

    initial_requests: list[dict[str, Any]] = []
    if request_plan is None:
        for lane_id in lane_ids:
            for target in location_targets:
                for query in lanes[lane_id].get("queries", []):
                    initial_requests.append(
                        {
                            "lane": lane_id,
                            "query": query,
                            "location": target["location"],
                            "location_source": target["source"],
                            "page": 1,
                            "next_page_token": None,
                        }
                    )
    else:
        seen_requests: set[tuple[str, str, str, str, int, str]] = set()
        for item in request_plan:
            lane_id = str(item.get("lane") or "").strip()
            query = str(item.get("query") or "").strip()
            item_location = str(item.get("location") or "").strip()
            item_source = str(item.get("location_source") or "manual").strip()
            page = max(1, int(item.get("page") or 1))
            next_page_token = str(item.get("next_page_token") or "").strip() or None
            if lane_id not in lanes:
                raise ValueError(f"Unknown lane: {lane_id}")
            if query not in lanes[lane_id].get("queries", []):
                raise ValueError(f"Unknown query for lane {lane_id}: {query}")
            if page > 1 and not next_page_token:
                raise ValueError("A pagination retry requires its next_page_token.")
            key = (lane_id, query, item_location, item_source, page, next_page_token or "")
            if key in seen_requests:
                continue
            seen_requests.add(key)
            initial_requests.append(
                {
                    "lane": lane_id,
                    "query": query,
                    "location": item_location,
                    "location_source": item_source,
                    "page": page,
                    "next_page_token": next_page_token,
                }
            )

    started_at = utc_now_iso()
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}"
    manifest_path = paths.search_runs_dir / f"{run_id}.json"
    normalized_path = paths.jobs_dir / "normalized" / f"{run_id}-multi-search.json"
    api_calls_dir = paths.search_runs_dir / run_id / "api_calls"
    api_calls_dir.mkdir(parents=True, exist_ok=True)
    planned_requests = [
        {
            **item,
            "serpapi_location": canonical_serpapi_location(item["location"]),
        }
        for item in initial_requests
    ]
    results: list[dict[str, Any]] = []
    searches: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    api_calls: list[dict[str, Any]] = []
    api_call_count = 0
    created = 0
    successful_requests = 0
    cached_requests = 0
    pagination_requests = 0
    matched_job_ids: set[str] = set()
    created_job_ids: set[str] = set()
    matched_opportunity_keys: set[str] = set()
    manifest: dict[str, Any] = {
        "run_id": run_id,
        "status": "running",
        "started_at": started_at,
        "finished_at": None,
        "request": {
            "lanes": lane_ids,
            "locations": [target["location"] for target in location_targets],
            "limit_per_query_location": limit,
            "max_pages": max_pages,
            "include_edge_check": include_edge_check,
        },
        "planned_requests": planned_requests,
        "searches": searches,
        "errors": errors,
        "api_calls": api_calls,
        "api_calls_path": str(api_calls_dir),
        "api_call_count": 0,
        "successful_requests": 0,
        "failed_requests": 0,
        "fetched": 0,
        "created": 0,
        "unique_jobs": 0,
        "unique_opportunities": 0,
        "existing_jobs": 0,
        "cached_requests": 0,
        "pagination_requests": 0,
        "matched_job_ids": [],
        "created_job_ids": [],
        "normalized_path": str(normalized_path),
    }
    update_search_manifest(manifest_path, manifest, results, normalized_path)
    logger.info(
        "serpapi_search_started run_id=%s lanes=%s origins=%d page_one_requests=%d limit_per_query=%d max_pages=%d",
        run_id,
        ",".join(lane_ids),
        len(location_targets),
        len(planned_requests),
        limit,
        max_pages,
    )

    fetched_by_query_origin: dict[tuple[str, str, str, str], int] = {}
    request_round = initial_requests
    while request_round:
        next_round: list[dict[str, Any]] = []
        for request_spec in request_round:
                lane_id = str(request_spec["lane"])
                query = str(request_spec["query"])
                target = {
                    "location": str(request_spec["location"]),
                    "source": str(request_spec["location_source"]),
                }
                page = int(request_spec.get("page") or 1)
                pagination_token = str(request_spec.get("next_page_token") or "").strip() or None
                query_origin_key = (lane_id, query, target["location"], target["source"])
                already_fetched = fetched_by_query_origin.get(query_origin_key, 0)
                if already_fetched >= limit:
                    continue
                request_started = time.perf_counter()
                request_started_at = datetime.now(timezone.utc)
                search_id: str | None = None
                poll_count = 0
                logger.info(
                    "serpapi_request_started run_id=%s lane=%s query=%r location=%r page=%d",
                    run_id,
                    lane_id,
                    query,
                    target["location"],
                    page,
                )
                request_params = {
                    "engine": "google_jobs",
                    "q": query,
                    "location": canonical_serpapi_location(target["location"]),
                    "google_domain": "google.com",
                    "gl": "us",
                    "hl": "en",
                }
                if pagination_token:
                    request_params["next_page_token"] = pagination_token

                def record_api_response(phase: str, current_poll_count: int, response: requests.Response, body: Any) -> None:
                    nonlocal api_call_count
                    api_call_count += 1
                    response_metadata = body.get("search_metadata") if isinstance(body, dict) else None
                    response_search_id = response_metadata.get("id") if isinstance(response_metadata, dict) else None
                    filename = (
                        f"{api_call_count:04d}-{phase}-{slugify(lane_id)}-"
                        f"{slugify(target['location'])}-{slugify(query)}-page-{page}.json"
                    )
                    call_path = api_calls_dir / filename
                    sensitive_headers = {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"}
                    headers = {
                        str(key): str(value)
                        for key, value in dict(getattr(response, "headers", {}) or {}).items()
                        if str(key).lower() not in sensitive_headers
                    }
                    elapsed = getattr(response, "elapsed", None)
                    envelope = {
                        "captured_at": utc_now_iso(),
                        "phase": phase,
                        "poll_count": current_poll_count,
                        "context": {
                            "run_id": run_id,
                            "lane": lane_id,
                            "query": query,
                            "location": target["location"],
                            "location_source": target["source"],
                            "page": page,
                        },
                        "request": {
                            "method": "GET",
                            "endpoint": SERPAPI_SEARCH_URL if phase == "submit" else "https://serpapi.com/searches/{search_id}.json",
                            "parameters": {**request_params, "async": "true"} if phase == "submit" else {"search_id": response_search_id},
                        },
                        "response": {
                            "status_code": getattr(response, "status_code", None),
                            "reason": str(getattr(response, "reason", "")),
                            "elapsed_seconds": elapsed.total_seconds() if elapsed is not None else None,
                            "headers": headers,
                            "body": redact_sensitive_data(body, (api_key,)),
                        },
                    }
                    write_json_atomic(call_path, envelope)
                    api_calls.append(
                        {
                            "sequence": api_call_count,
                            "phase": phase,
                            "poll_count": current_poll_count,
                            "status_code": getattr(response, "status_code", None),
                            "search_id": response_search_id,
                            "page": page,
                            "path": str(call_path),
                        }
                    )
                    manifest.update({"api_calls": api_calls, "api_call_count": api_call_count})
                    write_json_atomic(manifest_path, manifest)

                try:
                    data, search_id, poll_count = fetch_serpapi_async(
                        request_params,
                        api_key,
                        record_api_response,
                    )
                    raw_rows = data.get("jobs_results", []) or []
                    if not isinstance(raw_rows, list):
                        raise ValueError("SerpAPI jobs_results was not a list.")
                except (requests.RequestException, ValueError, SerpApiProcessingTimeout) as exc:
                    duration_ms = round((time.perf_counter() - request_started) * 1000)
                    error_type, message = serpapi_error_details(exc)
                    if isinstance(exc, SerpApiProcessingTimeout):
                        search_id = exc.search_id
                    error = {
                        "lane": lane_id,
                        "query": query,
                        "location": target["location"],
                        "location_source": target["source"],
                        "page": page,
                        "next_page_token": pagination_token,
                        "type": error_type,
                        "message": message,
                        "duration_ms": duration_ms,
                        "search_id": search_id,
                        "poll_count": poll_count,
                    }
                    errors.append(error)
                    searches.append({**error, "status": "failed", "fetched": 0})
                    manifest.update(
                        {
                            "failed_requests": len(errors),
                            "searches": searches,
                            "errors": errors,
                        }
                    )
                    update_search_manifest(manifest_path, manifest, results, normalized_path)
                    logger.error(
                        "serpapi_request_failed run_id=%s lane=%s query=%r location=%r page=%d error_type=%s duration_ms=%d search_id=%s poll_count=%d message=%r",
                        run_id,
                        lane_id,
                        query,
                        target["location"],
                        page,
                        error_type,
                        duration_ms,
                        search_id,
                        poll_count,
                        message,
                    )
                    continue

                timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
                raw_path = paths.jobs_dir / "raw" / f"{timestamp}-{lane_id}-{slugify(target['location'])}-{slugify(query)}-page-{page}.json"
                write_json_atomic(raw_path, data)
                remaining = limit - already_fetched
                batch = [normalize_serpapi_job(raw, lane_id) for raw in raw_rows[:remaining]]
                batch_opportunity_keys = {opportunity_identity(job)[3] for job in batch}
                page_new_opportunities = len(batch_opportunity_keys - matched_opportunity_keys)
                batch_created = 0
                batch_matched_ids: set[str] = set()
                with connect() as conn:
                    for job in batch:
                        actual_job_id, is_created = add_job(conn, job)
                        batch_matched_ids.add(actual_job_id)
                        matched_job_ids.add(actual_job_id)
                        if is_created:
                            created_job_ids.add(actual_job_id)
                        batch_created += int(is_created)
                results.extend(batch)
                matched_opportunity_keys.update(batch_opportunity_keys)
                created += batch_created
                query_count = len(batch)
                fetched_by_query_origin[query_origin_key] = already_fetched + query_count
                successful_requests += 1
                pagination_requests += int(page > 1)
                cached_response = serpapi_response_was_cached(data, request_started_at)
                cached_requests += int(cached_response)
                duration_ms = round((time.perf_counter() - request_started) * 1000)
                searches.append(
                    {
                        "lane": lane_id,
                        "query": query,
                        "location": target["location"],
                        "location_source": target["source"],
                        "page": page,
                        "status": "success",
                        "fetched": query_count,
                        "created": batch_created,
                        "unique_jobs": len(batch_matched_ids),
                        "new_opportunities_in_run": page_new_opportunities,
                        "cached": cached_response,
                        "duration_ms": duration_ms,
                        "raw_path": str(raw_path),
                        "search_id": search_id,
                        "poll_count": poll_count,
                        "serpapi_location": canonical_serpapi_location(target["location"]),
                        "has_next_page": bool((data.get("serpapi_pagination") or {}).get("next_page_token")),
                    }
                )
                manifest.update(
                    {
                        "successful_requests": successful_requests,
                        "fetched": len(results),
                        "created": created,
                        "unique_jobs": len(matched_job_ids),
                        "unique_opportunities": len(matched_opportunity_keys),
                        "existing_jobs": len(matched_job_ids - created_job_ids),
                        "cached_requests": cached_requests,
                        "pagination_requests": pagination_requests,
                        "matched_job_ids": sorted(matched_job_ids),
                        "created_job_ids": sorted(created_job_ids),
                        "searches": searches,
                    }
                )
                update_search_manifest(manifest_path, manifest, results, normalized_path)
                logger.info(
                    "serpapi_request_succeeded run_id=%s lane=%s query=%r location=%r page=%d fetched=%d created=%d new_opportunities=%d duration_ms=%d search_id=%s poll_count=%d",
                    run_id,
                    lane_id,
                    query,
                    target["location"],
                    page,
                    query_count,
                    batch_created,
                    page_new_opportunities,
                    duration_ms,
                    search_id,
                    poll_count,
                )

                next_page_token = str((data.get("serpapi_pagination") or {}).get("next_page_token") or "").strip()
                remaining_after_page = limit - fetched_by_query_origin[query_origin_key]
                should_paginate = (
                    request_plan is None
                    and bool(next_page_token)
                    and page < max_pages
                    and remaining_after_page > 0
                    and (page == 1 or page_new_opportunities >= page3_min_new_opportunities)
                )
                if should_paginate:
                    next_request = {
                        "lane": lane_id,
                        "query": query,
                        "location": target["location"],
                        "location_source": target["source"],
                        "page": page + 1,
                        "next_page_token": next_page_token,
                    }
                    next_round.append(next_request)
                    planned_requests.append(
                        {
                            **next_request,
                            "serpapi_location": canonical_serpapi_location(target["location"]),
                        }
                    )
                    manifest["planned_requests"] = planned_requests
                    write_json_atomic(manifest_path, manifest)
        request_round = next_round

    status = "complete"
    if errors:
        status = "partial" if successful_requests else "failed"
    result = {
        "run_id": run_id,
        "status": status,
        "lanes": lane_ids,
        "locations": [target["location"] for target in location_targets],
        "limit_per_query_location": limit,
        "limit_per_lane_location": limit,
        "max_pages": max_pages,
        "edge_check_included": include_edge_check,
        "fetched": len(results),
        "created": created,
        "unique_jobs": len(matched_job_ids),
        "unique_opportunities": len(matched_opportunity_keys),
        "existing_jobs": len(matched_job_ids - created_job_ids),
        "cached_requests": cached_requests,
        "pagination_requests": pagination_requests,
        "search_requests": successful_requests + len(errors),
        "matched_job_ids": sorted(matched_job_ids),
        "created_job_ids": sorted(created_job_ids),
        "successful_requests": successful_requests,
        "failed_requests": len(errors),
        "searches": searches,
        "errors": errors,
        "api_calls": api_calls,
        "api_calls_path": str(api_calls_dir),
        "api_call_count": api_call_count,
        "normalized_path": str(normalized_path),
        "manifest_path": str(manifest_path),
    }
    manifest.update(result)
    manifest["finished_at"] = utc_now_iso()
    update_search_manifest(manifest_path, manifest, results, normalized_path)
    logger.info(
        "serpapi_search_finished run_id=%s status=%s fetched=%d created=%d successful_requests=%d pagination_requests=%d failed_requests=%d",
        run_id,
        status,
        len(results),
        created,
        successful_requests,
        pagination_requests,
        len(errors),
    )
    return result


def recover_serpapi_raw_files(raw_paths: list[Path], lane: str) -> dict[str, Any]:
    """Import already-fetched SerpAPI JSON without making any API calls."""
    configure_logging()
    paths = ensure_runtime_dirs()
    if lane not in load_lanes().get("lanes", {}):
        raise ValueError(f"Unknown lane: {lane}")
    recovery_id = f"recovery-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}"
    normalized_path = paths.jobs_dir / "normalized" / f"{recovery_id}.json"
    manifest_path = paths.search_runs_dir / f"{recovery_id}.json"
    results: list[dict[str, Any]] = []
    created = 0
    sources: list[dict[str, Any]] = []
    for raw_path in raw_paths:
        data = json.loads(raw_path.read_text(encoding="utf-8"))
        raw_rows = data.get("jobs_results", []) or []
        if not isinstance(raw_rows, list):
            raise ValueError(f"Invalid jobs_results in {raw_path.name}")
        batch = [normalize_serpapi_job(raw, lane) for raw in raw_rows]
        batch_created = 0
        with connect() as conn:
            for job in batch:
                _, is_created = add_job(conn, job)
                batch_created += int(is_created)
        results.extend(batch)
        created += batch_created
        sources.append({"raw_path": str(raw_path), "fetched": len(batch), "created": batch_created})
    write_json_atomic(normalized_path, results)
    manifest = {
        "run_id": recovery_id,
        "status": "recovered",
        "started_at": utc_now_iso(),
        "finished_at": utc_now_iso(),
        "lane": lane,
        "sources": sources,
        "fetched": len(results),
        "created": created,
        "normalized_path": str(normalized_path),
    }
    write_json_atomic(manifest_path, manifest)
    logger.info(
        "serpapi_recovery_finished run_id=%s lane=%s source_files=%d fetched=%d created=%d",
        recovery_id,
        lane,
        len(raw_paths),
        len(results),
        created,
    )
    return {**manifest, "manifest_path": str(manifest_path)}


def backfill_serpapi_posted_dates(raw_paths: list[Path] | None = None) -> dict[str, Any]:
    """Fill missing Posted values for existing jobs without inserting historical raw jobs."""
    configure_logging()
    paths = ensure_runtime_dirs()
    source_paths = sorted(raw_paths or (paths.jobs_dir / "raw").glob("*.json"))
    backfill_id = f"posted-date-backfill-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}"
    manifest_path = paths.search_runs_dir / f"{backfill_id}.json"
    started_at = utc_now_iso()
    counts = {"updated": 0, "already_set": 0, "not_found": 0, "without_posted_data": 0, "invalid_files": 0}
    seen: set[str] = set()
    with connect() as conn:
        for raw_path in source_paths:
            try:
                data = json.loads(raw_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                counts["invalid_files"] += 1
                logger.warning("serpapi_posted_date_backfill_invalid_file path=%s", raw_path)
                continue
            raw_rows = data.get("jobs_results", []) or []
            if not isinstance(raw_rows, list):
                counts["invalid_files"] += 1
                continue
            for raw in raw_rows:
                posted_at = serpapi_posted_at(raw)
                if not posted_at:
                    counts["without_posted_data"] += 1
                    continue
                job = normalize_serpapi_job(raw, "posted_date_backfill")
                if job["dedupe_key"] in seen:
                    continue
                seen.add(job["dedupe_key"])
                outcome = backfill_job_posted_at(conn, job["dedupe_key"], posted_at)
                counts[outcome] += 1
    manifest = {
        "run_id": backfill_id,
        "status": "complete",
        "started_at": started_at,
        "finished_at": utc_now_iso(),
        "files_scanned": len(source_paths),
        "jobs_with_posted_data": len(seen),
        **counts,
    }
    write_json_atomic(manifest_path, manifest)
    logger.info(
        "serpapi_posted_date_backfill_finished run_id=%s files=%d available=%d updated=%d already_set=%d not_found=%d",
        backfill_id,
        len(source_paths),
        len(seen),
        counts["updated"],
        counts["already_set"],
        counts["not_found"],
    )
    return {**manifest, "manifest_path": str(manifest_path)}
