from __future__ import annotations

import html
import json
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests


PREFERRED_SOURCE_TIERS = {"employer", "ats", "linkedin", "manual"}

ATS_DOMAINS = {
    "adp.com",
    "applytojob.com",
    "ashbyhq.com",
    "bamboohr.com",
    "dayforcehcm.com",
    "eightfold.ai",
    "greenhouse.io",
    "icims.com",
    "jobvite.com",
    "lever.co",
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "oraclecloud.com",
    "phenompeople.com",
    "recruitee.com",
    "successfactors.com",
    "smartrecruiters.com",
    "teamtailor.com",
    "ultipro.com",
    "workable.com",
}

AGGREGATOR_DOMAINS = {
    "bandana.com",
    "bebee.com",
    "builtin.com",
    "builtinsf.com",
    "career.io",
    "careerbuilder.com",
    "dice.com",
    "experteer.com",
    "glassdoor.com",
    "indeed.com",
    "jobilize.com",
    "jobleads.com",
    "jobrapido.com",
    "jobright.ai",
    "jobs2careers.com",
    "jobzmall.com",
    "jooble.org",
    "learn4good.com",
    "lensa.com",
    "localjobs.com",
    "monster.com",
    "salutemyjob.com",
    "simplyhired.com",
    "startup.jobs",
    "studysmarter.co.uk",
    "tealhq.com",
    "theladders.com",
    "trabajo.org",
    "upwork.com",
    "vaia.com",
    "whatjobs.com",
    "ziprecruiter.com",
}

TRACKING_QUERY_KEYS = {
    "gh_src",
    "ref",
    "referrer",
    "source",
    "trk",
}

SOURCE_TIER_RANK = {
    "employer": 0,
    "ats": 1,
    "linkedin": 2,
    "manual": 3,
    "unverified": 4,
    "aggregator": 5,
    "discovery": 6,
}

LEGAL_SUFFIXES = {
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

CLOSED_PAGE_MARKERS = (
    "job is no longer available",
    "job listing is no longer available",
    "job has expired",
    "job expired",
    "no longer accepting applications",
    "position has been filled",
    "position is no longer available",
    "role is no longer available",
)

MATCH_STOP_WORDS = {
    "about",
    "against",
    "also",
    "and",
    "are",
    "but",
    "can",
    "for",
    "from",
    "has",
    "have",
    "into",
    "our",
    "that",
    "the",
    "their",
    "this",
    "through",
    "with",
    "will",
    "you",
    "your",
}


def normalized_host(url: str | None) -> str:
    if not url:
        return ""
    try:
        return (urlsplit(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def domain_matches(host: str, domains: set[str]) -> bool:
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def company_domain_tokens(company: str | None) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+", str(company or "").lower())
    while len(tokens) > 1 and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    return [token for token in tokens if len(token) >= 4]


def classify_source(url: str | None, company: str | None = None, label: str | None = None) -> str:
    host = normalized_host(url)
    if not host:
        return "unverified"
    try:
        path = urlsplit(str(url)).path.lower()
    except ValueError:
        path = ""
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        return "linkedin"
    if domain_matches(host, ATS_DOMAINS):
        return "ats"
    if domain_matches(host, AGGREGATOR_DOMAINS):
        return "aggregator"
    if host == "google.com" or host.endswith(".google.com"):
        if normalized_company_name(company) == "google" and path.startswith("/about/careers/"):
            return "employer"
        return "discovery"
    compact_host = re.sub(r"[^a-z0-9]", "", host)
    tokens = company_domain_tokens(company)
    compact_company = "".join(tokens)
    if compact_company and compact_company in compact_host:
        return "employer"
    if any(token in compact_host for token in tokens):
        return "employer"
    label_text = str(label or "").lower()
    if "company website" in label_text or "employer website" in label_text:
        return "employer"
    return "unverified"


def normalized_company_name(company: str | None) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(company or "").lower()))


def is_preferred_source(url: str | None, company: str | None = None, label: str | None = None) -> bool:
    return classify_source(url, company, label) in PREFERRED_SOURCE_TIERS


def clean_job_url(url: str | None) -> str | None:
    value = str(url or "").strip()
    if not value:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    kept_query = []
    for key, item in parse_qsl(parts.query, keep_blank_values=True):
        lower = key.lower()
        if lower.startswith("utm_") or lower in TRACKING_QUERY_KEYS:
            continue
        kept_query.append((key, item))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept_query), parts.fragment))


def normalize_source_candidates(raw_candidates: list[Any], company: str | None) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for position, raw in enumerate(raw_candidates):
        if not isinstance(raw, dict):
            continue
        url = clean_job_url(raw.get("link") or raw.get("url"))
        if not url or url in seen:
            continue
        seen.add(url)
        label = str(raw.get("title") or raw.get("label") or "").strip()
        candidates.append(
            {
                "label": label,
                "url": url,
                "source_tier": classify_source(url, company, label),
                "position": position,
            }
        )
    return candidates


def choose_preferred_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda candidate: (
            SOURCE_TIER_RANK.get(str(candidate.get("source_tier") or "unverified"), 99),
            int(candidate.get("position") or 0),
        ),
    )


def _identity_words(value: str | None) -> set[str]:
    return {
        word
        for word in re.findall(r"[a-z0-9]+", str(value or "").lower())
        if len(word) >= 3 and word not in MATCH_STOP_WORDS
    }


def _normalized_company(value: str | None) -> str:
    tokens = re.findall(r"[a-z0-9]+", str(value or "").lower())
    while len(tokens) > 1 and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def _location_city(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").split(",", 1)[0].lower())


def existing_match_score(job: dict[str, Any], candidate: dict[str, Any]) -> float:
    """Score only conservative, same-company matches suitable for avoiding a web lookup."""
    if _normalized_company(job.get("company")) != _normalized_company(candidate.get("company")):
        return 0.0
    if not is_preferred_source(candidate.get("url"), candidate.get("company")):
        return 0.0
    left_city = _location_city(job.get("location"))
    right_city = _location_city(candidate.get("location"))
    if left_city and right_city and left_city != right_city:
        return 0.0
    left_title = _identity_words(job.get("title"))
    right_title = _identity_words(candidate.get("title"))
    left_description = _identity_words(job.get("description"))
    right_description = _identity_words(candidate.get("description"))
    if not left_title or not right_title or not left_description or not right_description:
        return 0.0
    title_shared = len(left_title & right_title)
    description_shared = len(left_description & right_description)
    title_containment = title_shared / min(len(left_title), len(right_title))
    description_containment = description_shared / min(len(left_description), len(right_description))
    if title_containment < 0.45 or description_containment < 0.60 or description_shared < 12:
        return 0.0
    location_score = 1.0 if left_city and left_city == right_city else 0.5
    return (title_containment * 0.35) + (description_containment * 0.50) + (location_score * 0.15)


def choose_existing_preferred_match(
    job: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    scored = sorted(
        (
            (existing_match_score(job, candidate), candidate)
            for candidate in candidates
            if candidate.get("job_id") != job.get("job_id")
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    scored = [item for item in scored if item[0] >= 0.65]
    if not scored:
        return None
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.08:
        return None
    return scored[0][1]


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = " ".join(data.split())
        if cleaned:
            self.parts.append(cleaned)


def plain_text(value: str | None) -> str:
    parser = _TextExtractor()
    parser.feed(html.unescape(str(value or "")))
    return "\n".join(parser.parts).strip()


def _job_posting_from_json(value: Any) -> dict[str, Any] | None:
    if isinstance(value, list):
        for item in value:
            found = _job_posting_from_json(item)
            if found:
                return found
        return None
    if not isinstance(value, dict):
        return None
    item_type = value.get("@type")
    types = item_type if isinstance(item_type, list) else [item_type]
    if any(str(candidate).lower() == "jobposting" for candidate in types):
        return value
    for key in ("@graph", "mainEntity", "itemListElement"):
        found = _job_posting_from_json(value.get(key))
        if found:
            return found
    return None


def _job_location(posting: dict[str, Any]) -> str:
    locations = posting.get("jobLocation") or posting.get("applicantLocationRequirements") or []
    if not isinstance(locations, list):
        locations = [locations]
    labels: list[str] = []
    for location in locations:
        if not isinstance(location, dict):
            continue
        address = location.get("address") or location
        if not isinstance(address, dict):
            continue
        parts = [
            address.get("addressLocality"),
            address.get("addressRegion"),
            address.get("addressCountry"),
        ]
        label = ", ".join(str(part).strip() for part in parts if str(part or "").strip())
        if label and label not in labels:
            labels.append(label)
    return " · ".join(labels)


def inspect_preferred_page(url: str, timeout: tuple[float, float] = (5, 20)) -> dict[str, Any]:
    """Fetch a preferred listing without using a model and extract JobPosting JSON-LD when available."""
    try:
        response = requests.get(
            url,
            timeout=timeout,
            allow_redirects=True,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "User-Agent": "Mozilla/5.0 (compatible; CareerAutomation/1.0; +local-job-verification)",
            },
        )
    except requests.RequestException as exc:
        return {"status": "inconclusive", "reason": str(exc), "url": url}
    final_url = clean_job_url(response.url) or url
    if response.status_code in {404, 410}:
        return {"status": "closed", "reason": f"Authoritative page returned HTTP {response.status_code}.", "url": final_url}
    if response.status_code >= 400:
        return {
            "status": "inconclusive",
            "reason": f"Authoritative page returned HTTP {response.status_code}.",
            "url": final_url,
        }
    body = response.text or ""
    page_text = plain_text(body)
    lowered = page_text[:12000].lower()
    marker = next((candidate for candidate in CLOSED_PAGE_MARKERS if candidate in lowered), None)
    if marker:
        return {"status": "closed", "reason": f"Authoritative page says: {marker}.", "url": final_url}
    scripts = re.findall(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        body,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for script in scripts:
        try:
            posting = _job_posting_from_json(json.loads(html.unescape(script).strip()))
        except (json.JSONDecodeError, TypeError):
            continue
        if not posting:
            continue
        organization = posting.get("hiringOrganization") or {}
        company = organization.get("name") if isinstance(organization, dict) else ""
        description = plain_text(posting.get("description"))
        return {
            "status": "active",
            "reason": "Found active JobPosting data on the preferred source.",
            "url": final_url,
            "title": plain_text(posting.get("title")),
            "company": plain_text(company),
            "location": _job_location(posting),
            "description": description,
        }
    return {
        "status": "inconclusive",
        "reason": "The page loaded but did not expose structured JobPosting data.",
        "url": final_url,
    }
