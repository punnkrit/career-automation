from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
import requests

import career_workflow.analysis as analysis_module
import career_workflow.cloud_worker as cloud_worker_module
import career_workflow.jobs as jobs_module
import career_workflow.sources as sources_module
from career_workflow.analysis import analyze_job, blocked_source_memo, unavailable_memo, validate_decision_memo, validate_web_resolution
from career_workflow.cloud_worker import CloudExecutionService, sync_cloud_input
from career_workflow.codex_runner import codex_exec_args, extract_json, isolated_codex_env, summarize_codex_error
from career_workflow.context import load_candidate_context, operation_resume_context
from career_workflow.generation import build_packet_prompt, split_packet
from career_workflow.jobs import backfill_serpapi_posted_dates, canonical_serpapi_location, dedupe_key, expand_location_filter, expand_search_locations, fetch_serpapi_async, ingest_manual_job_payload, make_job, normalize_serpapi_job, recover_abandoned_search_runs, recover_serpapi_raw_files, search_metadata, search_serpapi, serpapi_posted_at
from career_workflow.networking import _company_context_for_role, add_contacts, build_company_editorial_prompt, build_company_research_prompt, delete_contact, list_networking_companies, research_company, research_role, set_company_paused, update_contact
from career_workflow.paths import runtime_paths
from career_workflow.security import safe_error_message
from career_workflow.sources import choose_existing_preferred_match, classify_source, inspect_preferred_page
from career_workflow.operations import OperationWorker, queue_operations
from career_workflow.tracker import add_job, claim_next_operation, connect, description_similarity, enqueue_operation, finish_operation, get_job, get_operation, interrupt_running_operations, list_jobs, list_operations, normalized_company, save_analysis, update_job, update_status


@pytest.fixture(autouse=True)
def runtime_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "outputs"))
    monkeypatch.setenv("CAREER_MOCK_CODEX", "1")
    monkeypatch.setenv("CAREER_DISABLE_OPERATION_WORKER", "1")
    monkeypatch.setenv("CAREER_PROXY_SECRET", "")


def sample_memo() -> dict:
    return {
        "decision": "apply",
        "fit_tier": "plausible",
        "sponsorship_tier": "plausible",
        "lane": "ai_solutions",
        "resume_strategy": "ai_solutions",
        "confidence": "medium",
        "interview_chance_reasoning": "Aligned enough to test.",
        "why_apply": ["Relevant workflow automation."],
        "risks": ["Needs real Codex review."],
        "jd_evidence": ["JD evidence."],
        "profile_evidence": ["Profile evidence."],
        "recommended_next_step": "build_packet",
    }


def test_cloud_init_profile_publishes_content_without_local_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    import career_workflow.cli as cli_module

    generated_resume = tmp_path / "private-output" / "resume_text.md"
    generated_resume.parent.mkdir()
    generated_resume.write_text("# Resume\n\nExperience\n", encoding="utf-8")
    source_resume = tmp_path / "private-source" / "Candidate Resume.docx"
    source_resume.parent.mkdir()
    source_resume.write_bytes(b"PK\x03\x04test-docx")
    captured: dict = {}

    monkeypatch.setattr(cli_module, "site_api_configured", lambda: True)
    monkeypatch.setattr(
        cli_module,
        "init_profile",
        lambda: {
            "resume_path": str(source_resume),
            "resume_text_path": str(generated_resume),
            "resume_parser": "pandoc",
            "resume_strategies": ["ai_product", "ai_solutions"],
        },
    )
    monkeypatch.setattr(cli_module, "configured_resume_path", lambda: source_resume)

    def fake_site_json(method, path, *, payload):
        captured.update({"method": method, "path": path, "payload": payload})
        return {
            "context_version": "profile-test",
            "resume_parser": "pandoc",
            "resume_strategies": ["ai_product", "ai_solutions"],
            "resume_text": {"size_bytes": 21, "sha256": "text-hash"},
            "resume_docx": {"size_bytes": len(source_resume.read_bytes()), "sha256": "docx-hash"},
        }

    monkeypatch.setattr(cli_module, "site_json", fake_site_json)
    monkeypatch.setattr(sys, "argv", ["career", "init-profile"])
    cli_module.main()

    assert captured["method"] == "POST"
    assert captured["path"] == "/api/profile/init"
    payload = captured["payload"]
    assert payload["resume_text"] == "# Resume\n\nExperience\n"
    assert payload["resume_parser"] == "pandoc"
    assert payload["resume_strategies"] == ["ai_product", "ai_solutions"]
    assert base64.b64decode(payload["resume_docx_base64"]) == source_resume.read_bytes()
    serialized_payload = json.dumps(payload)
    assert str(tmp_path) not in serialized_payload
    assert not any("path" in key.lower() for key in payload)
    output = capsys.readouterr().out
    assert "profile-test" in output
    assert str(tmp_path) not in output


def test_api_error_messages_redact_local_paths():
    message = safe_error_message("Resume not found: /mnt/c/Users/Candidate/OneDrive/private/resume.docx")
    assert message == "Resume not found: <local path>"
    assert "/mnt/" not in message


def test_dedupe_key_is_stable():
    assert dedupe_key("PM", "Acme", "NYC", "https://x") == dedupe_key(" pm ", " acme ", "nyc", "https://x")


def test_tracker_adds_and_dedupes_job():
    job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "manual", "https://example.com")
    with connect() as conn:
        first_id, first_created = add_job(conn, job)
        second_id, second_created = add_job(conn, job)
        jobs = list_jobs(conn)
    assert first_created is True
    assert second_created is False
    assert first_id == second_id
    assert len(jobs) == 1


def test_manual_ingest_saves_lane_and_decision_and_updates_a_duplicate():
    payload = {
        "title": "AI Product Manager",
        "company": "Northstar",
        "location": "Seattle, WA",
        "url": "https://northstar.example/jobs/ai-pm",
        "description": "Lead AI product discovery, delivery, and adoption across enterprise workflows.",
        "lane": "ai_product",
        "status": "needs_review",
    }

    first = ingest_manual_job_payload(payload)
    second = ingest_manual_job_payload({**payload, "lane": "product_ops", "status": "applied"})

    assert first["created"] is True
    assert second["created"] is False
    assert second["job_id"] == first["job_id"]
    assert second["job"]["lane_hint"] == "product_ops"
    assert second["job"]["status"] == "applied"


def test_manual_ingest_requires_a_known_lane():
    with pytest.raises(ValueError, match="Unknown lane"):
        ingest_manual_job_payload(
            {
                "title": "AI Product Manager",
                "company": "Northstar",
                "description": "Lead AI products.",
                "lane": "made_up_lane",
            }
        )


def test_opportunity_grouping_normalizes_legal_suffixes_but_preserves_listings():
    description = " ".join(["This role leads enterprise AI solution discovery and customer delivery"] * 8)
    first = make_job("AI Solutions Consultant", "Redolent", "San Francisco, CA", description, "serpapi", "https://lensa.com/one")
    second = make_job("AI Solutions Consultant", "Redolent, Inc.", "San Francisco, CA", description, "serpapi", "https://ziprecruiter.com/two")
    different_company = make_job("AI Solutions Consultant", "Redolent Labs", "San Francisco, CA", description, "serpapi", "https://example.com/three")
    with connect() as conn:
        first_id, _ = add_job(conn, first)
        second_id, _ = add_job(conn, second)
        add_job(conn, different_company)
        jobs = list_jobs(conn)
        detail = get_job(conn, first_id)
    assert normalized_company("Redolent, Inc.") == "redolent"
    assert len(jobs) == 3
    grouped_keys = {job["opportunity_key"] for job in jobs if job["job_id"] in {first_id, second_id}}
    assert len(grouped_keys) == 1
    assert next(job for job in jobs if job["job_id"] == first_id)["opportunity_listing_count"] == 2
    assert detail is not None
    assert len(detail["opportunity_variants"]) == 2
    assert next(job for job in jobs if job["company"] == "Redolent Labs")["opportunity_key"] not in grouped_keys


def test_identical_job_description_groups_location_variants():
    description = " ".join(["Build an enterprise AI value strategy with client leadership teams"] * 8)
    with connect() as conn:
        add_job(conn, make_job("Enterprise AI Value Strategy Consultant", "Accenture", "Mountain View, CA", description, "serpapi", "https://example.com/one"))
        add_job(conn, make_job("Enterprise AI Value Strategy Consultant", "Accenture", "Scottsdale, AZ", description, "serpapi", "https://example.com/two"))
        jobs = list_jobs(conn)
    assert len({job["opportunity_key"] for job in jobs}) == 1
    assert jobs[0]["opportunity_location_count"] == 2


def test_near_identical_board_descriptions_group_automatically():
    shared = " ".join(f"responsibility{index} capability{index} outcome{index}" for index in range(80))
    indeed_description = f"{shared} Benefits learn more about benefits at Google. Responsibilities identify daily operational needs."
    linkedin_description = f"{shared} Benefits responsibilities learn more about benefits at Google. Identify daily operational needs."
    first = make_job("Product Operations Manager, AI and Analytics, Communications", "Google", "Mountain View, CA", indeed_description, "serpapi", "https://indeed.com/one")
    second = make_job("Product Operations Manager, AI and Analytics, Communications", "Google", "Mountain View, CA", linkedin_description, "serpapi", "https://linkedin.com/two")
    with connect() as conn:
        add_job(conn, first)
        add_job(conn, second)
        jobs = list_jobs(conn)
    jaccard, containment, _ = description_similarity(indeed_description, linkedin_description)
    assert jaccard > 0.92
    assert containment > 0.95
    assert len({job["opportunity_key"] for job in jobs}) == 1
    assert jobs[0]["opportunity_listing_count"] == 2


def test_tracker_stores_posted_at():
    job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "serpapi", posted_at="3 days ago")
    with connect() as conn:
        add_job(conn, job)
        jobs = list_jobs(conn)
    assert jobs[0]["posted_at"] == "3 days ago"


def test_normalize_serpapi_job_uses_detected_posted_at():
    job = normalize_serpapi_job(
        {
            "title": "AI Product Manager",
            "company_name": "Acme",
            "location": "San Francisco, CA",
            "description": "Role text",
            "detected_extensions": {"posted_at": "25 days ago"},
        },
        "ai_product",
    )
    assert job["posted_at"] == "25 days ago"


def test_source_tiers_and_serpapi_selection_prefer_ats_then_linkedin():
    assert classify_source("https://jobs.acme.com/role", "Acme") == "employer"
    assert classify_source("https://jobs.ashbyhq.com/acme/123", "Acme") == "ats"
    assert classify_source("https://www.linkedin.com/jobs/view/123", "Acme") == "linkedin"
    assert classify_source("https://bebee.com/us/jobs/123", "Acme") == "aggregator"
    job = normalize_serpapi_job(
        {
            "title": "Product Manager",
            "company_name": "Acme",
            "location": "Seattle, WA",
            "description": "Role description",
            "apply_options": [
                {"title": "BeBee", "link": "https://bebee.com/jobs/123?utm_source=google"},
                {"title": "LinkedIn", "link": "https://linkedin.com/jobs/view/123?utm_source=google"},
                {"title": "Ashby", "link": "https://jobs.ashbyhq.com/acme/123?utm_source=google"},
            ],
        },
        "ai_product",
    )
    assert job["url"] == "https://jobs.ashbyhq.com/acme/123"
    assert job["source_tier"] == "ats"
    assert job["source_status"] == "preferred"
    assert len(job["source_candidates"]) == 3


def test_google_careers_is_employer_but_google_search_is_discovery():
    careers_url = "https://www.google.com/about/careers/applications/jobs/results/123-product-manager"
    assert classify_source(careers_url, "Google") == "employer"
    assert classify_source("https://www.google.com/search?q=product+manager", "Google") == "discovery"


def test_aggregator_resolution_allows_evidence_backed_company_correction():
    description = " ".join(["Own a global SaaS product portfolio, roadmap, pricing, go-to-market execution, and customer outcomes."] * 10)
    resolved_url = "https://careers.clinisys.com/jobs/123-product-manager"
    payload = {
        "resolution": {
            "status": "replaced",
            "source_tier": "employer",
            "confidence": "high",
            "reason": "The aggregator mislabeled the employer; the description matches the Clinisys role.",
            "evidence_urls": [resolved_url],
            "resolved_job": {
                "title": "Product Manager, Food and Beverage Safety",
                "company": "Clinisys",
                "location": "USA Remote",
                "url": resolved_url,
                "description": description,
            },
        },
        "decision_memo": sample_memo(),
    }
    resolution, _ = validate_web_resolution(
        {"company": "Jobgether", "url": "https://bebee.com/jobs/incorrect-listing"},
        payload,
    )
    assert resolution["resolved_job"]["company"] == "Clinisys"


def test_preferred_source_resolution_still_rejects_company_change():
    description = " ".join(["Own product discovery, delivery, metrics, and stakeholder outcomes for a data platform."] * 12)
    payload = {
        "resolution": {
            "status": "replaced",
            "source_tier": "employer",
            "confidence": "high",
            "reason": "Wrong company.",
            "evidence_urls": ["https://careers.other.com/jobs/123"],
            "resolved_job": {
                "title": "Product Manager",
                "company": "Other",
                "location": "Remote",
                "url": "https://careers.other.com/jobs/123",
                "description": description,
            },
        },
        "decision_memo": sample_memo(),
    }
    with pytest.raises(ValueError, match="did not match the original company"):
        validate_web_resolution({"company": "Acme", "url": "https://careers.acme.com/jobs/123"}, payload)


def test_job_source_candidates_are_persisted():
    job = make_job(
        "Product Manager",
        "Acme",
        "Seattle, WA",
        "Role text",
        "serpapi",
        "https://linkedin.com/jobs/view/123",
        source_candidates=[
            {"label": "LinkedIn", "url": "https://linkedin.com/jobs/view/123", "source_tier": "linkedin", "position": 0},
            {"label": "BeBee", "url": "https://bebee.com/jobs/123", "source_tier": "aggregator", "position": 1},
        ],
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        saved = get_job(conn, job_id)
    assert saved is not None
    assert [candidate["source_tier"] for candidate in saved["source_candidates"]] == ["linkedin", "aggregator"]


def test_cloud_input_syncs_resume_job_sources_and_opportunity_variants(tmp_path: Path):
    description = " ".join(["Own AI product discovery delivery and measurable customer outcomes"] * 8)
    variant = make_job(
        "AI Product Manager",
        "Acme",
        "Portland, OR",
        description,
        "serpapi",
        "https://linkedin.com/jobs/view/456",
    )
    primary = make_job(
        "AI Product Manager",
        "Acme",
        "Seattle, WA",
        description,
        "serpapi",
        "https://jobs.acme.com/123",
        source_candidates=[
            {"label": "Acme", "url": "https://jobs.acme.com/123", "source_tier": "employer", "position": 0},
            {"label": "LinkedIn", "url": "https://linkedin.com/jobs/view/123", "source_tier": "linkedin", "position": 1},
        ],
    )
    for job in (primary, variant):
        job.update(
            {
                "company_key": "acme",
                "title_key": "ai product manager",
                "description_fingerprint": "shared-fingerprint",
                "opportunity_key": "opportunity-shared",
                "opportunity_grouping_version": 2,
            }
        )
    primary["opportunity_variants"] = [primary.copy(), variant]

    sync_cloud_input(
        "analyze_job",
        {"job": primary, "candidate_context": {"context_version": "profile-v1", "resume_text": "# Candidate\n\nCloud resume"}},
    )

    assert (tmp_path / "outputs" / "profile" / "resume_text.md").read_text(encoding="utf-8") == "# Candidate\n\nCloud resume"
    with connect() as conn:
        saved = get_job(conn, primary["job_id"])
    assert saved is not None
    assert [candidate["source_tier"] for candidate in saved["source_candidates"]] == ["employer", "linkedin"]
    assert {job["job_id"] for job in saved["opportunity_variants"]} == {primary["job_id"], variant["job_id"]}


def test_cloud_input_without_context_uses_existing_resume_cache(tmp_path: Path):
    profile_dir = tmp_path / "outputs" / "profile"
    profile_dir.mkdir(parents=True)
    resume_path = profile_dir / "resume_text.md"
    resume_path.write_text("existing resume", encoding="utf-8")

    operation_resume_text = sync_cloud_input("daily_report", {})

    assert operation_resume_text == "existing resume"
    assert resume_path.read_text(encoding="utf-8") == "existing resume"


def test_cloud_input_fails_clearly_without_cloud_or_cached_resume():
    with pytest.raises(ValueError, match="no local resume cache"):
        sync_cloud_input("daily_report", {})


def test_cloud_resume_cache_replacement_is_atomic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    profile_dir = tmp_path / "outputs" / "profile"
    profile_dir.mkdir(parents=True)
    resume_path = profile_dir / "resume_text.md"
    resume_path.write_text("previous resume", encoding="utf-8")

    def fail_replace(*_args):
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(cloud_worker_module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replacement failure"):
        sync_cloud_input("daily_report", {"candidate_context": {"resume_text": "new resume"}})

    assert resume_path.read_text(encoding="utf-8") == "previous resume"
    assert list(profile_dir.glob(".resume_text.md.*.tmp")) == []


def test_concurrent_cloud_operations_use_resume_from_their_own_envelope(monkeypatch: pytest.MonkeyPatch):
    service = CloudExecutionService()
    first_operation_entered = threading.Event()
    both_operations_entered = threading.Barrier(2)
    observed_resumes: dict[str, str] = {}

    def execute_with_overlap(_operation_type: str, payload: dict[str, str]) -> dict[str, str]:
        operation_name = payload["date"]
        if operation_name == "first":
            first_operation_entered.set()
        both_operations_entered.wait(timeout=5)
        observed_resumes[operation_name] = load_candidate_context()["resume_text"]
        return {"operation": operation_name}

    monkeypatch.setattr(cloud_worker_module, "execute_operation", execute_with_overlap)
    monkeypatch.setattr(cloud_worker_module, "_post_callback", lambda *_args: None)

    def envelope(operation_id: str, resume_text: str) -> dict[str, object]:
        return {
            "schema_version": 1,
            "operation_id": operation_id,
            "operation_type": "daily_report",
            "input_hash": operation_id,
            "input": {
                "date": operation_id,
                "candidate_context": {"context_version": operation_id, "resume_text": resume_text},
            },
        }

    first_thread = threading.Thread(target=service._run, args=(envelope("first", "first resume"),))
    first_thread.start()
    assert first_operation_entered.wait(timeout=5)

    second_thread = threading.Thread(target=service._run, args=(envelope("second", "second resume"),))
    second_thread.start()
    first_thread.join(timeout=5)
    second_thread.join(timeout=5)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert observed_resumes == {"first": "first resume", "second": "second resume"}


def test_preferred_page_inspection_extracts_job_posting_json_ld(monkeypatch: pytest.MonkeyPatch):
    class PageResponse:
        status_code = 200
        url = "https://careers.acme.com/jobs/product-manager?utm_source=test"
        text = """
        <html><script type="application/ld+json">
        {"@type":"JobPosting","title":"Product Manager","description":"<p>Own product discovery and delivery with the engineering team.</p>","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Seattle","addressRegion":"WA","addressCountry":"US"}}}
        </script></html>
        """

    monkeypatch.setattr(sources_module.requests, "get", lambda *args, **kwargs: PageResponse())
    inspected = inspect_preferred_page("https://careers.acme.com/jobs/product-manager")
    assert inspected["status"] == "active"
    assert inspected["title"] == "Product Manager"
    assert inspected["company"] == "Acme"
    assert inspected["location"] == "Seattle, WA, US"
    assert "Own product discovery" in inspected["description"]
    assert inspected["url"] == "https://careers.acme.com/jobs/product-manager"


def test_existing_preferred_match_handles_aggregator_rewritten_title():
    summary = "Fluidstack product manager owns ontology data products, models operational domains, prioritizes engineers, and measures workflow leverage with stakeholders. " * 4
    full_description = summary + ("Business operations product discovery specifications technical tradeoffs launch iteration metrics. " * 20)
    aggregator = make_job(
        "Product Manager: Ontology & Data Platforms (Equity)",
        "FluidStack",
        "Seattle, WA",
        summary,
        "serpapi",
        "https://bebee.com/jobs/fluidstack-ontology",
    )
    preferred = make_job(
        "Product Manager, Business Operations",
        "Fluidstack",
        "Seattle, WA",
        full_description,
        "serpapi",
        "https://fluidstack.com/jobs/official-role",
    )
    assert choose_existing_preferred_match(aggregator, [preferred]) == preferred


def test_saved_preferred_match_is_reused_with_live_availability_and_preserves_decision(monkeypatch: pytest.MonkeyPatch):
    summary = "Fluidstack product manager owns ontology data products, models operational domains, prioritizes engineers, and measures workflow leverage with stakeholders. " * 4
    full_description = summary + ("Business operations product discovery specifications technical tradeoffs launch iteration metrics. " * 20)
    aggregator = make_job(
        "Product Manager: Ontology & Data Platforms (Equity)",
        "FluidStack",
        "Seattle, WA",
        summary,
        "serpapi",
        "https://bebee.com/jobs/fluidstack-ontology",
        lane_hint="ai_product",
    )
    preferred = make_job(
        "Product Manager, Business Operations",
        "Fluidstack",
        "Seattle, WA",
        full_description,
        "serpapi",
        "https://fluidstack.com/jobs/official-role",
        lane_hint="ai_product",
    )
    with connect() as conn:
        aggregator_id, _ = add_job(conn, aggregator)
        add_job(conn, preferred)
        update_status(conn, aggregator_id, "skipped")
    calls: list[bool] = []
    original_run_codex = analysis_module.run_codex

    def recording_run_codex(*args, **kwargs):
        calls.append(bool(kwargs.get("web_search")))
        return original_run_codex(*args, **kwargs)

    monkeypatch.setattr(analysis_module, "run_codex", recording_run_codex)
    analyze_job(aggregator_id)
    with connect() as conn:
        saved = get_job(conn, aggregator_id)
    assert calls == [True]
    assert saved is not None
    assert saved["status"] == "skipped"
    assert saved["source_status"] == "reused"
    assert saved["title"] == "Product Manager, Business Operations"
    assert saved["url"] == "https://fluidstack.com/jobs/official-role"


def test_complete_preferred_source_analysis_checks_live_availability(monkeypatch: pytest.MonkeyPatch):
    description = " ".join(["Own product discovery delivery metrics with customers and engineers"] * 20)
    job = make_job(
        "Product Manager",
        "Acme",
        "Seattle, WA",
        description,
        "serpapi",
        "https://careers.acme.com/product-manager",
        lane_hint="ai_product",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
    calls: list[bool] = []
    original_run_codex = analysis_module.run_codex

    def recording_run_codex(*args, **kwargs):
        calls.append(bool(kwargs.get("web_search")))
        return original_run_codex(*args, **kwargs)

    monkeypatch.setattr(analysis_module, "run_codex", recording_run_codex)
    analyze_job(job_id)
    assert calls == [True]


def test_aggregator_resolution_and_analysis_share_one_web_enabled_call(monkeypatch: pytest.MonkeyPatch):
    job = make_job(
        "Product Manager",
        "Acme",
        "Seattle, WA",
        "Short aggregator summary",
        "serpapi",
        "https://bebee.com/jobs/acme-product-manager",
        lane_hint="ai_product",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
    calls: list[bool] = []
    original_run_codex = analysis_module.run_codex

    def recording_run_codex(*args, **kwargs):
        calls.append(bool(kwargs.get("web_search")))
        return original_run_codex(*args, **kwargs)

    monkeypatch.setattr(analysis_module, "run_codex", recording_run_codex)
    analyze_job(job_id)
    with connect() as conn:
        saved = get_job(conn, job_id)
    assert calls == [True]
    assert saved is not None
    assert saved["source_status"] == "replaced"
    assert saved["source_tier"] == "employer"
    assert saved["analysis"]["decision"] == "apply"


def test_unavailable_analysis_sets_ai_fields_without_changing_decision(monkeypatch: pytest.MonkeyPatch):
    job = make_job(
        "Product Manager",
        "Acme",
        "Seattle, WA",
        "Short aggregator summary",
        "serpapi",
        "https://bebee.com/jobs/missing-role",
        lane_hint="ai_product",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "needs_review")
    resolution = {
        "status": "unavailable",
        "source_tier": "unverified",
        "confidence": "high",
        "reason": "The employer careers site confirms that the role is closed.",
        "evidence_urls": ["https://careers.acme.com/jobs"],
        "resolved_job": {"title": "", "company": "", "location": "", "url": "", "description": ""},
    }
    monkeypatch.setattr(
        analysis_module,
        "_run_web_resolution_analysis",
        lambda current: (resolution, unavailable_memo(current, resolution)),
    )
    analyze_job(job_id)
    with connect() as conn:
        saved = get_job(conn, job_id)
    assert saved is not None
    assert saved["status"] == "needs_review"
    assert saved["analysis"]["decision"] == "skip"
    assert saved["analysis"]["fit_tier"] == "blocked"
    assert saved["source_status"] == "unavailable"


def test_ambiguous_analysis_is_terminal_without_changing_decision(monkeypatch: pytest.MonkeyPatch):
    job = make_job(
        "Senior Product Manager",
        "Incorrect Aggregator Company",
        "United States",
        "Short aggregator summary",
        "serpapi",
        "https://bebee.com/jobs/ambiguous-role",
        lane_hint="product_ops",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "needs_review")
    resolution = {
        "status": "ambiguous",
        "source_tier": "ats",
        "confidence": "medium",
        "reason": "Several active European variants exist, but no matching United States posting exists.",
        "evidence_urls": ["https://jobs.lever.co/example"],
        "resolved_job": {
            "title": "Senior Product Manager",
            "company": "Example",
            "location": "Multiple European locations",
            "url": "https://jobs.lever.co/example",
            "description": "",
        },
    }
    monkeypatch.setattr(
        analysis_module,
        "_run_web_resolution_analysis",
        lambda current: (resolution, sample_memo()),
    )
    memo = analyze_job(job_id)
    with connect() as conn:
        saved = get_job(conn, job_id)
    assert memo["decision"] == "skip"
    assert memo["fit_tier"] == "blocked"
    assert saved is not None
    assert saved["status"] == "needs_review"
    assert saved["analysis"]["decision"] == "skip"
    assert saved["source_status"] == "ambiguous"
    assert saved["source_tier"] == "aggregator"


def test_serpapi_posted_at_falls_back_to_extensions():
    assert serpapi_posted_at({"extensions": ["3 days ago", "Full-time"]}) == "3 days ago"
    assert serpapi_posted_at({"extensions": ["Full-time", "Dental insurance"]}) is None


def test_backfill_posted_dates_only_updates_existing_jobs(tmp_path: Path):
    existing_raw = {
        "title": "AI Product Manager",
        "company_name": "Acme",
        "location": "Seattle, WA",
        "description": "Role text",
        "share_link": "https://example.com/existing",
        "detected_extensions": {"posted_at": "4 days ago"},
    }
    missing_raw = {
        "title": "AI Consultant",
        "company_name": "Missing Company",
        "location": "Seattle, WA",
        "description": "Role text",
        "share_link": "https://example.com/missing",
        "extensions": ["2 days ago"],
    }
    existing_job = normalize_serpapi_job(existing_raw, "ai_product")
    existing_job["posted_at"] = None
    with connect() as conn:
        add_job(conn, existing_job)
    raw_path = tmp_path / "raw.json"
    raw_path.write_text(json.dumps({"jobs_results": [existing_raw, missing_raw]}), encoding="utf-8")

    result = backfill_serpapi_posted_dates([raw_path])

    assert result["updated"] == 1
    assert result["not_found"] == 1
    with connect() as conn:
        jobs = list_jobs(conn)
    assert len(jobs) == 1
    assert jobs[0]["posted_at"] == "4 days ago"


def test_search_metadata_includes_lanes_and_metros():
    metadata = search_metadata()
    lane_ids = {lane["id"] for lane in metadata["lanes"]}
    metro_ids = {metro["id"] for metro in metadata["metros"]}
    assert "ai_solutions" in lane_ids
    assert "bay_area" in metro_ids
    assert metadata["serpapi"]["engine"] == "google_jobs"


def test_expand_search_locations_dedupes_manual_locations():
    locations = expand_search_locations(["nyc"], ["Jersey City, New Jersey, United States", "Remote"])
    expanded = [item["location"] for item in locations]
    assert "New York, New York, United States" in expanded
    assert "Jersey City, New Jersey, United States" in expanded
    assert "Remote" in expanded
    assert expanded.count("Jersey City, New Jersey, United States") == 1


def test_metro_search_uses_primary_origin_and_optional_rotating_edge():
    primary = expand_search_locations(["seattle_tacoma"])
    with_edge = expand_search_locations(["seattle_tacoma"], include_edge_check=True)

    assert primary == [{"source": "seattle_tacoma", "location": "Seattle, Washington, United States"}]
    assert with_edge[0] == primary[0]
    assert len(with_edge) == 2
    assert with_edge[1]["source"] == "seattle_tacoma:edge"
    assert with_edge[1]["location"] in {"Tacoma, Washington, United States", "Everett, Washington, United States"}


class FakeSerpApiResponse:
    status_code = 200

    def __init__(self, jobs: list[dict] | None = None, payload: dict | None = None):
        self.jobs = jobs or []
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload if self.payload is not None else {"jobs_results": self.jobs}


def serpapi_row() -> dict:
    return {
        "title": "AI Solutions Consultant",
        "company_name": "Acme",
        "location": "Seattle, WA",
        "description": "Role text",
        "share_link": "https://example.com/job",
    }


def one_query_lane() -> dict:
    return {"lanes": {"ai_solutions": {"queries": ["AI Solutions Consultant"]}}}


def serpapi_rows(prefix: str, count: int) -> list[dict]:
    return [
        {
            "title": f"{prefix} Role {index}",
            "company_name": f"{prefix} Company {index}",
            "location": "Seattle, WA",
            "description": f"{prefix} distinct role description {index}",
            "share_link": f"https://example.com/{prefix.lower()}-{index}",
        }
        for index in range(count)
    ]


def test_canonical_serpapi_location_removes_comma_spacing():
    assert canonical_serpapi_location("Bellevue, Washington, United States") == "Bellevue,Washington,United States"


def test_serpapi_async_submission_polls_archive(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_POLL_INTERVAL_SECONDS", "0")
    responses = [
        FakeSerpApiResponse(payload={"search_metadata": {"id": "search-123", "status": "Processing"}}),
        FakeSerpApiResponse(payload={"search_metadata": {"id": "search-123", "status": "Success"}, "jobs_results": [serpapi_row()]}),
    ]
    calls: list[tuple[str, dict]] = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return responses.pop(0)

    monkeypatch.setattr(jobs_module.requests, "get", fake_get)
    data, search_id, poll_count = fetch_serpapi_async(
        {"engine": "google_jobs", "q": "AI Solutions Consultant", "location": "Bellevue,Washington,United States"},
        "test-key",
    )

    assert len(data["jobs_results"]) == 1
    assert search_id == "search-123"
    assert poll_count == 1
    assert calls[0][1]["params"]["async"] == "true"
    assert calls[1][0].endswith("/searches/search-123.json")


def test_targeted_retry_only_runs_failed_query(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    calls: list[dict] = []

    def fake_get(*args, **kwargs):
        calls.append(kwargs["params"])
        return FakeSerpApiResponse([serpapi_row()])

    monkeypatch.setattr(jobs_module.requests, "get", fake_get)
    result = search_serpapi(
        ["ai_solutions"],
        ["Bellevue, Washington, United States"],
        limit=4,
        request_plan=[
            {
                "lane": "ai_solutions",
                "query": "AI Solutions Consultant",
                "location": "Bellevue, Washington, United States",
                "location_source": "seattle_tacoma",
            }
        ],
    )

    assert result["status"] == "complete"
    assert len(calls) == 1
    assert calls[0]["q"] == "AI Solutions Consultant"
    assert calls[0]["location"] == "Bellevue,Washington,United States"
    assert calls[0]["async"] == "true"


def test_search_runs_all_first_pages_before_paginating(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setattr(
        jobs_module,
        "load_lanes",
        lambda: {"lanes": {"ai_solutions": {"queries": ["First Query", "Second Query"]}}},
    )
    calls: list[dict] = []

    def fake_get(*args, **kwargs):
        params = kwargs["params"]
        calls.append(params.copy())
        token = params.get("next_page_token")
        if token:
            return FakeSerpApiResponse(payload={"jobs_results": serpapi_rows(f"{params['q']} page 2", 3)})
        return FakeSerpApiResponse(
            payload={
                "jobs_results": serpapi_rows(f"{params['q']} page 1", 10),
                "serpapi_pagination": {"next_page_token": f"{params['q']}-page-2"},
            }
        )

    monkeypatch.setattr(jobs_module.requests, "get", fake_get)
    result = search_serpapi("ai_solutions", ["Seattle"], limit=20)

    assert [call["q"] for call in calls] == ["First Query", "Second Query", "First Query", "Second Query"]
    assert [call.get("next_page_token") for call in calls] == [None, None, "First Query-page-2", "Second Query-page-2"]
    assert result["fetched"] == 26
    assert result["successful_requests"] == 4
    assert result["pagination_requests"] == 2
    assert result["max_pages"] == 2


def test_page_three_requires_new_page_two_opportunities(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    calls: list[dict] = []
    first_page = serpapi_rows("Repeated", 10)

    def fake_get(*args, **kwargs):
        params = kwargs["params"]
        calls.append(params.copy())
        token = params.get("next_page_token")
        if token == "page-2":
            return FakeSerpApiResponse(
                payload={
                    "jobs_results": first_page,
                    "serpapi_pagination": {"next_page_token": "page-3"},
                }
            )
        if token == "page-3":
            pytest.fail("Page 3 should not run when page 2 adds no unseen opportunities")
        return FakeSerpApiResponse(
            payload={
                "jobs_results": first_page,
                "serpapi_pagination": {"next_page_token": "page-2"},
            }
        )

    monkeypatch.setattr(jobs_module.requests, "get", fake_get)
    result = search_serpapi("ai_solutions", ["Seattle"], limit=30)

    assert len(calls) == 2
    assert result["pagination_requests"] == 1
    assert result["fetched"] == 20


def test_search_saves_every_submit_and_poll_response_without_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "never-write-this-key")
    monkeypatch.setenv("SERPAPI_POLL_INTERVAL_SECONDS", "0")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    responses = [
        FakeSerpApiResponse(payload={"search_metadata": {"id": "search-456", "status": "Processing"}}),
        FakeSerpApiResponse(
            payload={
                "search_metadata": {"id": "search-456", "status": "Success", "total_time_taken": 1.25},
                "jobs_results": [serpapi_row()],
                "filters": [{"name": "Date posted", "options": ["Past day"]}],
                "api_key": "never-write-this-key",
                "debug_url": "https://example.test/?api_key=never-write-this-key",
            }
        ),
    ]
    monkeypatch.setattr(jobs_module.requests, "get", lambda *args, **kwargs: responses.pop(0))

    result = search_serpapi("ai_solutions", ["Bellevue, Washington, United States"], limit=1)

    assert result["api_call_count"] == 2
    call_paths = sorted(Path(result["api_calls_path"]).glob("*.json"))
    assert len(call_paths) == 2
    submit = json.loads(call_paths[0].read_text(encoding="utf-8"))
    final_poll = json.loads(call_paths[1].read_text(encoding="utf-8"))
    assert submit["response"]["body"]["search_metadata"]["status"] == "Processing"
    assert final_poll["response"]["body"]["search_metadata"]["total_time_taken"] == 1.25
    assert final_poll["response"]["body"]["filters"][0]["name"] == "Date posted"
    assert final_poll["response"]["body"]["api_key"] == "<redacted>"
    saved_text = "\n".join(path.read_text(encoding="utf-8") for path in call_paths)
    assert "never-write-this-key" not in saved_text


def test_search_persists_success_before_later_timeout(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-secret-key")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    responses: list[FakeSerpApiResponse | Exception] = [
        FakeSerpApiResponse([serpapi_row()]),
        requests.ReadTimeout("read timed out"),
    ]

    def fake_get(*args, **kwargs):
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(jobs_module.requests, "get", fake_get)
    result = search_serpapi("ai_solutions", ["Seattle", "Everett"], limit=1)

    assert result["status"] == "partial"
    assert result["fetched"] == 1
    assert result["created"] == 1
    assert result["successful_requests"] == 1
    assert result["failed_requests"] == 1
    assert result["errors"][0]["type"] == "timeout"
    with connect() as conn:
        assert len(list_jobs(conn)) == 1
    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["status"] == "partial"
    assert manifest["fetched"] == 1
    assert Path(result["normalized_path"]).exists()
    log_text = (runtime_paths().logs_dir / "api.log").read_text(encoding="utf-8")
    assert "serpapi_request_failed" in log_text
    assert "test-secret-key" not in log_text


def test_search_dedupes_across_committed_batches(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    monkeypatch.setattr(jobs_module.requests, "get", lambda *args, **kwargs: FakeSerpApiResponse([serpapi_row()]))

    result = search_serpapi("ai_solutions", ["Seattle", "Bellevue"], limit=1)

    assert result["status"] == "complete"
    assert result["fetched"] == 2
    assert result["created"] == 1
    with connect() as conn:
        assert len(list_jobs(conn)) == 1


def test_search_reports_unique_matches_and_cached_requests(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)
    cached_payload = {
        "search_metadata": {"id": "cached-search", "status": "Success", "created_at": "2020-01-01 00:00:00 UTC"},
        "jobs_results": [serpapi_row()],
    }
    monkeypatch.setattr(jobs_module.requests, "get", lambda *args, **kwargs: FakeSerpApiResponse(payload=cached_payload))

    result = search_serpapi("ai_solutions", ["Seattle", "Bellevue"], limit=1)

    assert result["fetched"] == 2
    assert result["unique_jobs"] == 1
    assert result["unique_opportunities"] == 1
    assert result["created"] == 1
    assert result["existing_jobs"] == 0
    assert result["cached_requests"] == 2
    assert len(result["matched_job_ids"]) == 1
    assert result["matched_job_ids"] == result["created_job_ids"]


def test_recover_abandoned_search_runs_marks_stale_manifest(tmp_path: Path):
    manifest_path = runtime_paths().search_runs_dir / "stale-run.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps({"run_id": "stale-run", "status": "running", "started_at": "2020-01-01T00:00:00+00:00"}),
        encoding="utf-8",
    )
    manifest_path.with_suffix(".json.tmp").write_text("temporary", encoding="utf-8")

    recovered = recover_abandoned_search_runs(max_age_seconds=0)

    saved = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert recovered == ["stale-run"]
    assert saved["status"] == "abandoned"
    assert saved["finished_at"]
    assert not manifest_path.with_suffix(".json.tmp").exists()


def test_search_http_error_does_not_expose_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "do-not-log-this")
    monkeypatch.setattr(jobs_module, "load_lanes", one_query_lane)

    class HttpErrorResponse(FakeSerpApiResponse):
        status_code = 429

        def raise_for_status(self) -> None:
            error = requests.HTTPError("https://serpapi.com/search.json?api_key=do-not-log-this")
            error.response = self
            raise error

    monkeypatch.setattr(jobs_module.requests, "get", lambda *args, **kwargs: HttpErrorResponse())
    result = search_serpapi("ai_solutions", ["Seattle"], limit=1)

    assert result["status"] == "failed"
    assert result["errors"][0]["message"] == "SerpAPI returned HTTP 429."
    log_text = (runtime_paths().logs_dir / "api.log").read_text(encoding="utf-8")
    assert "do-not-log-this" not in log_text


def test_recover_serpapi_raw_files_imports_without_api_call(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    raw_path = tmp_path / "saved-response.json"
    raw_path.write_text(json.dumps({"jobs_results": [serpapi_row()]}), encoding="utf-8")
    monkeypatch.setattr(jobs_module.requests, "get", lambda *args, **kwargs: pytest.fail("recovery made an API call"))

    result = recover_serpapi_raw_files([raw_path], "ai_solutions")

    assert result["status"] == "recovered"
    assert result["fetched"] == 1
    assert result["created"] == 1
    with connect() as conn:
        assert len(list_jobs(conn)) == 1


def test_expand_location_filter_matches_serpapi_display_shapes():
    terms = expand_location_filter("bay_area")
    assert "San Francisco, CA" in terms
    assert "San Francisco" in terms
    assert "Mountain View, CA" in terms


def test_decision_memo_validation_blocks_explicit_sponsorship():
    memo = sample_memo()
    memo["sponsorship_tier"] = "blocked_explicit"
    validated = validate_decision_memo(memo)
    assert validated["decision"] == "blocked"
    assert validated["recommended_next_step"] == "skip"


def test_extract_json_from_markdown_fence():
    data = extract_json('```json\n{"decision":"apply"}\n```')
    assert data["decision"] == "apply"


def test_isolated_codex_env_removes_desktop_thread_context(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CODEX_THREAD_ID", "thread")
    monkeypatch.setenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "Codex Desktop")
    monkeypatch.setenv("CODEX_HOME", "/tmp/codex-home")
    monkeypatch.setenv("WSLENV", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE:TEMP/p:CODEX_HOME/p")
    monkeypatch.setenv("TEMP", "/mnt/c/Users/Candidate/AppData/Local/Temp")
    env = isolated_codex_env()
    assert "CODEX_THREAD_ID" not in env
    assert "CODEX_INTERNAL_ORIGINATOR_OVERRIDE" not in env
    assert env["CODEX_HOME"] == "/tmp/codex-home"
    assert "CODEX_INTERNAL_ORIGINATOR_OVERRIDE" not in env["WSLENV"]
    assert env["TEMP"] == "/tmp"


def test_codex_exec_args_accepts_model_and_reasoning_effort(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("CODEX_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("CODEX_REASONING_EFFORT", "medium")
    args = codex_exec_args("codex", tmp_path, tmp_path / "output.md")
    assert args[args.index("--model") + 1] == "gpt-5.6-sol"
    assert "-c" in args
    assert 'model_reasoning_effort="medium"' in args
    assert "--output-last-message" in args


def test_codex_exec_args_can_enable_web_search(tmp_path: Path):
    args = codex_exec_args("codex", tmp_path, web_search=True)
    assert args[:3] == ["codex", "--search", "exec"]


def test_codex_exec_args_uses_project_model_defaults(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.delenv("CODEX_MODEL", raising=False)
    monkeypatch.delenv("CODEX_REASONING_EFFORT", raising=False)
    args = codex_exec_args("codex", tmp_path)
    assert args[args.index("--model") + 1] == "gpt-5.6-sol"
    assert 'model_reasoning_effort="high"' in args


def test_codex_exec_args_rejects_invalid_reasoning_effort(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("CODEX_REASONING_EFFORT", "maximum")
    with pytest.raises(ValueError, match="Invalid CODEX_REASONING_EFFORT"):
        codex_exec_args("codex", tmp_path)


def test_summarize_codex_auth_error():
    message = summarize_codex_error("ERROR: Your access token could not be refreshed because your refresh token was already used.", "")
    assert "codex login" in message


def test_summarize_codex_missing_bearer_error():
    message = summarize_codex_error(
        "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        "",
    )
    assert "Codex headless auth" in message
    assert "codex login --device-auth" in message


def test_split_packet_requires_expected_sections():
    packet = """=== tailored_resume.md ===
# Resume
=== cover_letter.md ===
Letter
=== application_answers.md ===
Answers
"""
    sections = split_packet(packet)
    assert set(sections) == {"tailored_resume.md", "cover_letter.md", "application_answers.md"}


def test_networking_groups_eligible_roles_by_normalized_company():
    first = make_job("AI Product Manager", "Northstar, Inc.", "Seattle, WA", "First role", "manual", "https://example.com/one")
    second = make_job("Product Operations Lead", "Northstar", "Remote", "Second role", "manual", "https://example.com/two")
    ignored = make_job("Strategy Manager", "Quiet Harbor", "Remote", "Ignored role", "manual", "https://example.com/three")
    with connect() as conn:
        first_id, _ = add_job(conn, first)
        second_id, _ = add_job(conn, second)
        add_job(conn, ignored)
        update_status(conn, first_id, "needs_review")
        update_status(conn, second_id, "applied")
        companies = list_networking_companies(conn)
    assert len(companies) == 1
    assert companies[0]["company_key"] == "northstar"
    assert {role["title"] for role in companies[0]["roles"]} == {"AI Product Manager", "Product Operations Lead"}
    assert companies[0]["status"] == "not_started"


def test_networking_status_and_timeline_are_derived_from_milestones():
    job = make_job("AI Partnerships Manager", "Redwood Systems", "San Francisco, CA", "Role", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "ready_to_apply")
        contact_ids = add_contacts(
            conn,
            "redwood systems",
            "Redwood Systems",
            [
                {"name": "Maya Patel", "linkedin_url": "https://linkedin.com/in/maya"},
                {"name": "Daniel Kim", "linkedin_url": ""},
                {"name": "Luis Romero", "linkedin_url": ""},
            ],
        )
        company = list_networking_companies(conn)[0]
        assert company["status"] == "outreach_active"
        assert len(company["events"]) == 3
        assert company["contacts"][0]["request_accepted"] is False

        update_contact(conn, contact_ids[0], {"request_accepted": True})
        company = list_networking_companies(conn)[0]
        assert company["status"] == "outreach_active"
        assert company["contacts"][0]["request_accepted"] is True
        assert "request_accepted" in {event["event_type"] for event in company["events"]}

        update_contact(conn, contact_ids[0], {"responded": True, "coffee_chat": True})
        company = list_networking_companies(conn)[0]
        assert company["status"] == "conversation_active"

        update_contact(conn, contact_ids[0], {"referral": True})
        company = list_networking_companies(conn)[0]
        assert company["status"] == "referral_received"
        assert {event["event_type"] for event in company["events"]} >= {"linkedin_request", "request_accepted", "responded", "coffee_chat", "referral"}

        set_company_paused(conn, "redwood systems", "Redwood Systems", True)
        assert list_networking_companies(conn)[0]["status"] == "paused"
        set_company_paused(conn, "redwood systems", "Redwood Systems", False)
        assert list_networking_companies(conn)[0]["status"] == "referral_received"


def test_networking_corrections_remove_milestone_event_and_contact_history():
    job = make_job("BizOps Lead", "Bluebird", "Remote", "Role", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "applied")
        contact_id = add_contacts(conn, "bluebird", "Bluebird", [{"name": "Avery Chen", "linkedin_url": ""}])[0]
        update_contact(conn, contact_id, {"request_accepted": True})
        update_contact(conn, contact_id, {"request_accepted": False})
        update_contact(conn, contact_id, {"responded": True})
        update_contact(conn, contact_id, {"responded": False})
        company = list_networking_companies(conn)[0]
        assert company["status"] == "outreach_active"
        assert "request_accepted" not in {event["event_type"] for event in company["events"]}
        assert "responded" not in {event["event_type"] for event in company["events"]}
        delete_contact(conn, contact_id)
        company = list_networking_companies(conn)[0]
        assert company["status"] == "not_started"
        assert company["events"] == []


def test_networking_migration_backfills_acceptance_for_existing_progress():
    job = make_job("AI Customer Lead", "Signal Path", "Remote", "Role", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "ready_to_apply")
        contact_id = add_contacts(conn, "signal path", "Signal Path", [{"name": "Jordan Lee", "linkedin_url": ""}])[0]
        update_contact(conn, contact_id, {"responded": True})
        assert list_networking_companies(conn)[0]["contacts"][0]["request_accepted"] is False

    with connect() as conn:
        company = list_networking_companies(conn)[0]
        assert company["contacts"][0]["request_accepted"] is True
        assert company["status"] == "conversation_active"


def test_networking_preserves_inactive_company_and_mock_research():
    job = make_job("Technical Program Manager", "Solstice", "Remote", "Role", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "needs_review")
        add_contacts(conn, "solstice", "Solstice", [{"name": "Nina Shah", "linkedin_url": ""}])
        result = research_company(conn, "solstice")
        update_status(conn, job_id, "skipped")
        assert list_networking_companies(conn) == []
        inactive = list_networking_companies(conn, include_inactive=True)
    assert result["research"]["official_name"] == "Solstice"
    assert result["research"]["schema_version"] == 5
    assert result["research"]["editorial"]["sections"]
    assert len(result["research"]["editorial"]["executive_takeaways"]) == 4
    assert result["research"]["editorial"]["business_at_a_glance"]["strategic_question"]
    assert result["research"]["explainer"]["products"][0]["example"]
    assert len(result["research"]["explainer"]["workflow"]["steps"]) == 3
    assert result["research"]["explainer"]["media"] == []
    assert result["research"]["visual_review"]["outcome"] == "sources_unavailable"
    assert len(inactive) == 1
    assert inactive[0]["active"] is False
    assert inactive[0]["research"] is not None
    assert inactive[0]["research"]["explainer"] == result["research"]["explainer"]


def test_company_research_prompt_is_independent_of_tracked_roles():
    prompt = build_company_research_prompt("Northstar")
    assert "Company: Northstar" in prompt
    assert "tracked jobs" in prompt
    assert "role titles" in prompt
    assert "Enterprise AI Adoption Lead" not in prompt


def test_company_visual_review_is_required_before_editorial_and_preserves_saved_report_on_failure(monkeypatch):
    import career_workflow.networking as networking

    job = make_job("Product Manager", "Visual Example", "Remote", "Role", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "needs_review")
        first = research_company(conn, "visual example")
        real_run = networking.run_codex
        calls = []

        def incomplete_visual_run(*args, **kwargs):
            calls.append((kwargs["run_type"], kwargs["web_search"]))
            result = real_run(*args, **kwargs)
            if kwargs["run_type"] == "company_research_visuals":
                result.text = '{"media": [], "sources": [], "review": {}}'
            return result

        monkeypatch.setattr(networking, "run_codex", incomplete_visual_run)
        with pytest.raises(ValueError, match="Visual research incomplete"):
            research_company(conn, "visual example")
        assert calls == [("company_research", True), ("company_research_visuals", True), ("company_research_visuals", True)]
        saved = networking.get_networking_company(conn, "visual example")
        assert saved["research"] == first["research"]


def test_company_editorial_prompt_uses_only_company_evidence():
    evidence = {
        "official_name": "Northstar",
        "executive_summary": "Northstar sells workflow software.",
        "sources": [{"url": "https://northstar.example/about"}],
    }
    prompt = build_company_editorial_prompt("Northstar", evidence)
    assert "Company: Northstar" in prompt
    assert "https://northstar.example/about" in prompt
    assert "Do not mention tracked jobs" in prompt
    assert "candidate context" not in prompt
    assert "what the company is becoming" in prompt
    assert "company-specific section headings" in prompt
    assert "one coherent paragraph" in prompt


def test_role_context_keeps_editorial_brief_without_raw_company_findings():
    context = _company_context_for_role(
        {
            "official_name": "Northstar",
            "explainer": {"plain_english": "Northstar sells workflow software."},
            "editorial": {"headline": "Northstar profile", "business_at_a_glance": {"customer": "Enterprises"}},
            "sections": {"products_and_services": [{"detail": "Large raw evidence block"}]},
            "sources": [{"url": "https://northstar.example"}],
        }
    )
    assert context["editorial"]["headline"] == "Northstar profile"
    assert context["sources"]
    assert context["explainer"]["plain_english"] == "Northstar sells workflow software."
    assert "sections" not in context


@pytest.mark.parametrize("builder", [analysis_module.build_analysis_prompt, analysis_module.build_resolution_analysis_prompt, build_packet_prompt])
def test_prompts_use_cloud_profile_once_without_legacy_files(builder):
    with operation_resume_context("UNIQUE_RESUME_TEXT", {"background": "UNIQUE_BACKGROUND_TEXT", "preferences": "UNIQUE_PREFERENCES_TEXT"}):
        prompt = builder({"title": "Test role", "company": "Example", "description": "Test description"})
    for marker in ("UNIQUE_RESUME_TEXT", "UNIQUE_BACKGROUND_TEXT", "UNIQUE_PREFERENCES_TEXT"):
        assert prompt.count(marker) == 1
    assert "Master Story" not in prompt
    assert "Evidence Bank" not in prompt


def test_networking_role_research_is_keyed_to_opportunity_and_tracks_freshness(monkeypatch):
    from career_workflow import networking
    original_run = networking.run_codex
    captured = []
    def recording_run(prompt, *args, **kwargs):
        captured.append(prompt)
        return original_run(prompt, *args, **kwargs)
    monkeypatch.setattr(networking, "run_codex", recording_run)
    description = " ".join(["Lead enterprise AI adoption across customers, product, sales, and delivery teams"] * 8)
    job = make_job("Enterprise AI Adoption Lead", "Northstar", "Seattle, WA", description, "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "ready_to_apply")
        research_company(conn, "northstar")
        company = list_networking_companies(conn)[0]
        opportunity_key = company["roles"][0]["opportunity_key"]
        with operation_resume_context("UNIQUE_RESUME_TEXT", {"background": "UNIQUE_BACKGROUND_TEXT", "preferences": "UNIQUE_PREFERENCES_TEXT"}):
            result = research_role(conn, "northstar", opportunity_key)
        for marker in ("UNIQUE_RESUME_TEXT", "UNIQUE_BACKGROUND_TEXT", "UNIQUE_PREFERENCES_TEXT"):
            assert captured[-1].count(marker) == 1
        researched = list_networking_companies(conn)[0]["roles"][0]
        assert result["research"]["role_thesis"]
        assert len(result["research"]["responsibilities"]) == 4
        assert len(result["research"]["success_outcomes"]) == 4
        assert len(result["research"]["proof_points"]) == 3
        assert len(result["research"]["gaps"]) == 2
        assert len(result["research"]["interview_preparation"]) == 5
        assert researched["research"]["fit_thesis"]
        assert researched["research_stale"] is False

        research_company(conn, "northstar")
        refreshed = list_networking_companies(conn)[0]["roles"][0]
        assert refreshed["research_stale"] is True


def test_save_analysis_preserves_manual_decision():
    job = make_job("AI Implementation Manager", "Acme", "Remote", "Role text", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        save_analysis(conn, job_id, sample_memo())
        saved = get_job(conn, job_id)
    assert saved is not None
    assert saved["status"] == "new"
    assert saved["analysis"]["decision"] == "apply"


def test_save_analysis_replaces_previous_analysis():
    job = make_job("AI Implementation Manager", "Acme", "Remote", "Role text", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        save_analysis(conn, job_id, sample_memo())
        replacement = sample_memo()
        replacement.update(
            {
                "decision": "maybe",
                "fit_tier": "stretch",
                "confidence": "high",
                "interview_chance_reasoning": "The corrected description changes the fit.",
            }
        )
        save_analysis(conn, job_id, replacement)
        saved = get_job(conn, job_id)
    assert saved is not None
    assert saved["analysis"]["decision"] == "maybe"
    assert saved["analysis"]["fit_tier"] == "stretch"
    assert saved["analysis"]["decision_memo"]["interview_chance_reasoning"] == "The corrected description changes the fit."


def test_reanalysis_preserves_manual_application_progress():
    job = make_job("AI Implementation Manager", "Acme", "Remote", "Role text", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        save_analysis(conn, job_id, sample_memo())
        update_status(conn, job_id, "ready_to_apply")
        replacement = sample_memo()
        replacement["decision"] = "maybe"
        save_analysis(conn, job_id, replacement)
        saved = get_job(conn, job_id)
    assert saved is not None
    assert saved["status"] == "ready_to_apply"
    assert saved["analysis"]["decision"] == "maybe"


def test_update_job_edits_description_link_and_location_without_discarding_analysis():
    original_description = " ".join(["Original aggregated role description"] * 32)
    corrected_description = " ".join(["Correct direct employer role description"] * 32)
    job = make_job(
        "AI Implementation Manager",
        "Acme",
        "Remote",
        original_description,
        "google_jobs",
        url="https://aggregator.example/jobs/123",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        save_analysis(conn, job_id, sample_memo())
        original = get_job(conn, job_id)
        saved = update_job(
            conn,
            job_id,
            {
                "location": "San Francisco, CA",
                "url": "https://acme.example/careers/ai-implementation-manager",
                "description": corrected_description,
            },
        )
    assert original is not None
    assert saved["location"] == "San Francisco, CA"
    assert saved["url"] == "https://acme.example/careers/ai-implementation-manager"
    assert saved["description"] == corrected_description
    assert saved["opportunity_key"] != original["opportunity_key"]
    assert saved["analysis"]["decision"] == "apply"


def test_list_jobs_filters_by_metro_location_terms():
    sf_job = make_job("AI Solutions Consultant", "Acme", "San Francisco, CA (+41 others)", "Role text", "manual")
    chicago_job = make_job("AI Product Manager", "Beta", "Chicago, IL", "Role text", "manual")
    with connect() as conn:
        add_job(conn, sf_job)
        add_job(conn, chicago_job)
        bay_area_jobs = list_jobs(conn, {"location_terms": expand_location_filter("bay_area")})
    assert len(bay_area_jobs) == 1
    assert bay_area_jobs[0]["company"] == "Acme"


def test_list_jobs_filters_by_role_company_fit_and_confidence():
    acme_job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "manual")
    beta_job = make_job("Product Manager", "Beta", "Remote", "Role text", "manual")
    with connect() as conn:
        acme_id, _ = add_job(conn, acme_job)
        add_job(conn, beta_job)
        memo = sample_memo()
        memo["fit_tier"] = "stretch"
        memo["confidence"] = "high"
        save_analysis(conn, acme_id, memo)
        query_jobs = list_jobs(conn, {"query": "solutions"})
        company_jobs = list_jobs(conn, {"query": "acme"})
        fit_jobs = list_jobs(conn, {"fit": "stretch"})
        confidence_jobs = list_jobs(conn, {"confidence": "high"})
    assert [job["company"] for job in query_jobs] == ["Acme"]
    assert [job["company"] for job in company_jobs] == ["Acme"]
    assert [job["company"] for job in fit_jobs] == ["Acme"]
    assert [job["company"] for job in confidence_jobs] == ["Acme"]


def test_list_jobs_filters_by_analyzed_state():
    analyzed_job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "manual")
    unanalyzed_job = make_job("Product Manager", "Beta", "Remote", "Role text", "manual")
    with connect() as conn:
        analyzed_id, _ = add_job(conn, analyzed_job)
        add_job(conn, unanalyzed_job)
        save_analysis(conn, analyzed_id, sample_memo())
        analyzed_jobs = list_jobs(conn, {"analyzed": "yes"})
        unanalyzed_jobs = list_jobs(conn, {"analyzed": "no"})
    assert [job["company"] for job in analyzed_jobs] == ["Acme"]
    assert [job["company"] for job in unanalyzed_jobs] == ["Beta"]


def test_list_jobs_filters_by_multiple_statuses():
    review_job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "manual")
    applied_job = make_job("Product Manager", "Beta", "Remote", "Role text", "manual")
    skipped_job = make_job("Data Scientist", "Gamma", "Remote", "Role text", "manual")
    undecided_job = make_job("Operations Lead", "Delta", "Remote", "Role text", "manual")
    with connect() as conn:
        review_id, _ = add_job(conn, review_job)
        applied_id, _ = add_job(conn, applied_job)
        skipped_id, _ = add_job(conn, skipped_job)
        add_job(conn, undecided_job)
        update_status(conn, review_id, "needs_review")
        update_status(conn, applied_id, "applied")
        update_status(conn, skipped_id, "skipped")
        decision_jobs = list_jobs(conn, {"status": "needs_review,applied"})
        blank_jobs = list_jobs(conn, {"status": "needs_review,__blank__"})
    assert {job["company"] for job in decision_jobs} == {"Acme", "Beta"}
    assert {job["company"] for job in blank_jobs} == {"Acme", "Delta"}


def test_list_jobs_filters_by_multiple_analysis_values_and_dates():
    acme_job = make_job("AI Solutions Consultant", "Acme", "Remote", "Role text", "manual")
    beta_job = make_job("Product Manager", "Beta", "Remote", "Role text", "manual")
    acme_job["found_date"] = "2026-07-12"
    beta_job["found_date"] = "2026-07-13"
    with connect() as conn:
        acme_id, _ = add_job(conn, acme_job)
        beta_id, _ = add_job(conn, beta_job)
        acme_memo = sample_memo()
        beta_memo = sample_memo()
        beta_memo.update({"decision": "maybe", "fit_tier": "plausible", "lane": "product_ops", "confidence": "medium"})
        save_analysis(conn, acme_id, acme_memo)
        save_analysis(conn, beta_id, beta_memo)
        jobs = list_jobs(
            conn,
            {
                "date": "2026-07-12,2026-07-13",
                "decision": "apply,maybe",
                "fit": "stretch,plausible",
                "lane": "ai_solutions,product_ops",
                "confidence": "high,medium",
            },
        )
    assert {job["company"] for job in jobs} == {"Acme", "Beta"}


def test_expand_location_filter_accepts_multiple_metros():
    terms = expand_location_filter(["bay_area", "nyc"])
    assert any("san francisco" in term.lower() for term in terms)
    assert any("new york" in term.lower() for term in terms)


def test_api_health_and_jobs_endpoint():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    client = TestClient(app)
    assert client.get("/api/health").json()["ok"] is True
    response = client.get("/api/jobs")
    assert response.status_code == 200
    assert response.json()["jobs"] == []


def test_api_jobs_can_filter_latest_search_matches():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    first = make_job("AI Solutions Consultant", "Redolent", "Seattle, WA", "First role description", "manual")
    second = make_job("AI Product Manager", "Contoso", "Bellevue, WA", "Second role description", "manual")
    with connect() as conn:
        first_id, _ = add_job(conn, first)
        add_job(conn, second)
    response = TestClient(app).get("/api/jobs", params={"ids": first_id})
    assert response.status_code == 200
    assert [job["job_id"] for job in response.json()["jobs"]] == [first_id]


def test_api_job_patch_updates_editable_fields():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    job = make_job(
        "AI Solutions Consultant",
        "Redolent",
        "Seattle, WA",
        "Aggregated description",
        "google_jobs",
        url="https://aggregator.example/jobs/123",
    )
    with connect() as conn:
        job_id, _ = add_job(conn, job)
    response = TestClient(app).patch(
        f"/api/jobs/{job_id}",
        json={
            "location": "San Francisco, CA",
            "url": "https://redolent.example/careers/ai-solutions-consultant",
            "description": "Corrected employer description",
        },
    )
    assert response.status_code == 200
    assert response.json()["location"] == "San Francisco, CA"
    assert response.json()["url"] == "https://redolent.example/careers/ai-solutions-consultant"
    assert response.json()["description"] == "Corrected employer description"


def test_networking_list_returns_research_preview_and_detail_returns_full_report():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    job = make_job("AI Adoption Lead", "Northstar", "Seattle, WA", "Role description", "manual")
    with connect() as conn:
        job_id, _ = add_job(conn, job)
        update_status(conn, job_id, "ready_to_apply")
        research_company(conn, "northstar")

    client = TestClient(app)
    summary_response = client.get("/api/networking/companies")
    detail_response = client.get("/api/networking/companies/northstar")

    assert summary_response.status_code == 200
    summary = summary_response.json()["companies"][0]
    assert summary["research"]["executive_summary"]
    assert summary["research"]["editorial"]["headline"]
    assert "sections" not in summary["research"]
    assert "research" not in summary["roles"][0]

    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["research"]["sections"]["products_and_services"]
    assert detail["company_key"] == "northstar"


def test_networking_company_detail_endpoint_returns_404_for_unknown_company():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    response = TestClient(app).get("/api/networking/companies/missing-company")
    assert response.status_code == 404


def test_api_codex_status_mock_endpoint():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    client = TestClient(app)
    response = client.get("/api/codex/status")
    assert response.status_code == 200
    assert "ok" in response.json()


def test_api_search_options_endpoint():
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    client = TestClient(app)
    response = client.get("/api/search/options")
    assert response.status_code == 200
    data = response.json()
    assert data["serpapi"]["engine"] == "google_jobs"
    assert any(lane["id"] == "ai_solutions" for lane in data["lanes"])
    assert any(metro["id"] == "nyc" for metro in data["metros"])


def test_api_manual_ingest_can_set_decision_and_queue_analysis(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    import career_workflow.api as api_module

    captured: dict = {}

    def fake_queue(operation_type, payload):
        captured.update({"operation_type": operation_type, "payload": payload})
        return (
            {
                "operation_id": "manual-analysis",
                "operation_type": operation_type,
                "payload": payload,
                "status": "queued",
                "result": None,
                "error": "",
            },
            True,
        )

    monkeypatch.setattr(api_module, "queue_operation", fake_queue)
    response = TestClient(api_module.app).post(
        "/api/jobs/ingest",
        json={
            "title": "AI Implementation Lead",
            "company": "Northstar",
            "location": "Remote",
            "url": "https://northstar.example/jobs/implementation-lead",
            "description": "Own enterprise AI implementation from discovery through adoption.",
            "lane_hint": "ai_solutions",
            "status": "ready_to_apply",
            "analyze": True,
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["job"]["lane_hint"] == "ai_solutions"
    assert data["job"]["status"] == "ready_to_apply"
    assert data["analysis_created"] is True
    assert data["analysis_operation"]["operation_id"] == "manual-analysis"
    assert captured == {"operation_type": "analyze_job", "payload": {"job_id": data["job_id"]}}


def test_cli_manual_ingest_can_queue_analysis_without_waiting(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    import io
    import sys

    import career_workflow.cli as cli_module

    captured: dict = {}

    def fake_queue(operation_type, payload):
        captured.update({"operation_type": operation_type, "payload": payload})
        return ({"operation_id": "queued-analysis", "status": "queued"}, True)

    def fail_if_synchronous_analysis_runs(job_id):
        raise AssertionError(f"Synchronous analysis should not run for {job_id}")

    payload = {
        "title": "AI Implementation Lead",
        "company": "Northstar",
        "location": "Remote",
        "url": "https://northstar.example/jobs/implementation-lead",
        "description": "Own enterprise AI implementation from discovery through adoption.",
        "lane": "ai_solutions",
        "status": "applied",
        "analyze": True,
    }
    monkeypatch.setattr(cli_module, "queue_operation", fake_queue)
    monkeypatch.setattr(cli_module, "analyze_job", fail_if_synchronous_analysis_runs)
    monkeypatch.setattr(cli_module, "site_api_configured", lambda: False)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(sys, "argv", ["career", "ingest-job", "--json", "-", "--queue-analysis"])

    cli_module.main()

    data = json.loads(capsys.readouterr().out)
    assert data["job"]["status"] == "applied"
    assert data["analysis_created"] is True
    assert data["analysis_operation"]["operation_id"] == "queued-analysis"
    assert captured == {"operation_type": "analyze_job", "payload": {"job_id": data["job_id"]}}


def test_cli_manual_ingest_uses_site_as_source_of_truth(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    import io
    import sys

    import career_workflow.cli as cli_module

    calls: list[tuple[str, str, dict]] = []

    def fake_site_json(method, path, *, payload=None, **_kwargs):
        calls.append((method, path, payload or {}))
        return {
            "job_id": "cloud-job",
            "created": True,
            "job": {"job_id": "cloud-job", "status": "needs_review"},
            "analysis_operation": {"operation_id": "cloud-analysis", "status": "running"},
            "analysis_created": True,
        }

    def fail_local(*_args, **_kwargs):
        raise AssertionError("Cloud-mode ingestion must not write workstation SQLite.")

    payload = {
        "title": "AI Implementation Lead",
        "company": "Northstar",
        "location": "Remote",
        "url": "https://northstar.example/jobs/implementation-lead",
        "description": "Own enterprise AI implementation from discovery through adoption.",
        "lane": "ai_solutions",
        "status": "needs_review",
        "analyze": False,
    }
    monkeypatch.setattr(cli_module, "site_api_configured", lambda: True)
    monkeypatch.setattr(cli_module, "site_json", fake_site_json)
    monkeypatch.setattr(cli_module, "ingest_manual_job_payload", fail_local)
    monkeypatch.setattr(cli_module, "queue_operation", fail_local)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(sys, "argv", ["career", "ingest-job", "--json", "-", "--queue-analysis"])

    cli_module.main()

    data = json.loads(capsys.readouterr().out)
    assert data["job_id"] == "cloud-job"
    assert calls == [
        (
            "POST",
            "/api/jobs/ingest",
            {
                "title": "AI Implementation Lead",
                "company": "Northstar",
                "location": "Remote",
                "url": "https://northstar.example/jobs/implementation-lead",
                "description": "Own enterprise AI implementation from discovery through adoption.",
                "status": "needs_review",
                "analyze": True,
                "lane_hint": "ai_solutions",
            },
        )
    ]


def test_api_retry_search_enqueues_only_failed_requests(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    import career_workflow.api as api_module

    captured: dict = {}

    def fake_queue(operation_type, payload):
        captured.update({"operation_type": operation_type, "payload": payload})
        return ({"operation_id": "test-operation", "status": "queued"}, True)

    monkeypatch.setattr(api_module, "queue_operation", fake_queue)
    client = TestClient(api_module.app)
    response = client.post(
        "/api/search/retry",
        json={
            "limit": 4,
            "requests": [
                {
                    "lane": "ai_solutions",
                    "query": "AI Solutions Consultant",
                    "location": "Bellevue, Washington, United States",
                    "location_source": "seattle_tacoma",
                }
            ],
        },
    )

    assert response.status_code == 202
    assert response.json()["operation"]["operation_id"] == "test-operation"
    assert captured["operation_type"] == "search_retry"
    assert captured["payload"]["limit"] == 4
    assert captured["payload"]["requests"] == [
        {
            "lane": "ai_solutions",
            "query": "AI Solutions Consultant",
            "location": "Bellevue, Washington, United States",
            "location_source": "seattle_tacoma",
            "page": 1,
            "next_page_token": None,
        }
    ]


def test_api_analyze_batch_queues_every_selected_job(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    import career_workflow.api as api_module

    with connect() as conn:
        first_id, _ = add_job(conn, make_job("AI Lead", "Acme", "Remote", "First role", "manual"))
        second_id, _ = add_job(conn, make_job("AI PM", "Northstar", "Seattle", "Second role", "manual"))

    captured: list[dict] = []

    def fake_queue_many(operation_type, payloads):
        assert operation_type == "analyze_job"
        captured.extend(payloads)
        return [
            (
                {
                    "operation_id": f"operation-{index}",
                    "operation_type": operation_type,
                    "payload": item,
                    "status": "queued",
                    "result": None,
                    "error": "",
                },
                True,
            )
            for index, item in enumerate(payloads)
        ]

    monkeypatch.setattr(api_module, "queue_operations", fake_queue_many)
    response = TestClient(api_module.app).post(
        "/api/jobs/analyze-batch",
        json={"job_ids": [first_id, second_id, first_id]},
    )

    assert response.status_code == 202
    assert captured == [{"job_id": first_id}, {"job_id": second_id}]
    assert response.json()["created_count"] == 2
    assert response.json()["existing_count"] == 0
    assert [item["payload"]["job_id"] for item in response.json()["operations"]] == [first_id, second_id]


def test_api_analyze_batch_rejects_missing_jobs_without_queuing(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    import career_workflow.api as api_module

    called = False

    def fake_queue_many(operation_type, payloads):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(api_module, "queue_operations", fake_queue_many)
    response = TestClient(api_module.app).post(
        "/api/jobs/analyze-batch",
        json={"job_ids": ["missing-job"]},
    )

    assert response.status_code == 404
    assert called is False


def test_queue_operations_persists_an_entire_batch_before_returning():
    queued = queue_operations(
        "analyze_job",
        [{"job_id": "job-one"}, {"job_id": "job-two"}, {"job_id": "job-three"}],
    )

    assert len(queued) == 3
    assert all(created for _, created in queued)
    with connect() as conn:
        saved = list_operations(conn, limit=10, status="queued")
    assert {operation["payload"]["job_id"] for operation in saved} == {"job-one", "job-two", "job-three"}


def test_list_operations_can_filter_analysis_work():
    with connect() as conn:
        enqueue_operation(conn, "analyze_job", "job-one", {"job_id": "job-one"})
        enqueue_operation(conn, "daily_report", "today", {"date": None})
        saved = list_operations(conn, limit=10, operation_type="analyze_job")

    assert len(saved) == 1
    assert saved[0]["operation_type"] == "analyze_job"


def test_operation_claims_can_separate_analysis_and_general_lanes():
    with connect() as conn:
        enqueue_operation(conn, "daily_report", "today", {"date": None})
        enqueue_operation(conn, "analyze_job", "job-one", {"job_id": "job-one"})
    with connect() as conn:
        analysis = claim_next_operation(conn, include_operation_types={"analyze_job"})
    with connect() as conn:
        general = claim_next_operation(conn, exclude_operation_types={"analyze_job"})

    assert analysis is not None
    assert analysis["operation_type"] == "analyze_job"
    assert general is not None
    assert general["operation_type"] == "daily_report"


def test_analysis_worker_runs_independent_jobs_concurrently():
    job_ids = [f"job-{index}" for index in range(4)]
    with connect() as conn:
        for job_id in job_ids:
            enqueue_operation(conn, "analyze_job", job_id, {"job_id": job_id})

    release = threading.Event()
    condition = threading.Condition()
    started: list[str] = []
    active = 0
    maximum_active = 0

    def executor(operation_type: str, payload: dict) -> dict:
        nonlocal active, maximum_active
        assert operation_type == "analyze_job"
        with condition:
            started.append(payload["job_id"])
            active += 1
            maximum_active = max(maximum_active, active)
            condition.notify_all()
        assert release.wait(timeout=5)
        with condition:
            active -= 1
            condition.notify_all()
        return {"job_id": payload["job_id"]}

    worker = OperationWorker(executor=executor, analysis_concurrency=3)
    worker.start()
    try:
        with condition:
            assert condition.wait_for(lambda: len(started) == 3, timeout=5)
        assert maximum_active == 3
        release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with connect() as conn:
                completed = list_operations(conn, limit=10, status="succeeded", operation_type="analyze_job")
            if len(completed) == len(job_ids):
                break
            time.sleep(0.05)
        assert len(completed) == len(job_ids)
        assert sorted(started) == job_ids
    finally:
        release.set()
        worker.stop()


def test_operations_are_persistent_and_dedupe_active_work():
    payload = {"job_id": "job-123"}
    with connect() as conn:
        first, first_created = enqueue_operation(conn, "analyze_job", "job-123", payload)
        duplicate, duplicate_created = enqueue_operation(conn, "analyze_job", "job-123", payload)
    assert first_created is True
    assert duplicate_created is False
    assert duplicate["operation_id"] == first["operation_id"]

    with connect() as conn:
        claimed = claim_next_operation(conn)
    assert claimed is not None
    assert claimed["status"] == "running"

    with connect() as conn:
        finish_operation(conn, claimed["operation_id"], "succeeded", result={"ok": True})
    with connect() as conn:
        saved = get_operation(conn, claimed["operation_id"])
    assert saved is not None
    assert saved["status"] == "succeeded"
    assert saved["result"] == {"ok": True}


def test_running_operations_are_marked_interrupted_after_restart():
    with connect() as conn:
        queued, _ = enqueue_operation(conn, "daily_report", "today", {"date": None})
    with connect() as conn:
        claimed = claim_next_operation(conn)
    assert claimed is not None
    with connect() as conn:
        count = interrupt_running_operations(conn)
        saved = get_operation(conn, queued["operation_id"])
    assert count == 1
    assert saved is not None
    assert saved["status"] == "interrupted"


def test_api_proxy_secret_blocks_unknown_callers(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    from career_workflow.api import app

    monkeypatch.setenv("CAREER_PROXY_SECRET", "test-secret")
    client = TestClient(app)
    assert client.get("/api/health").status_code == 401
    authorized = client.get("/api/health", headers={"X-Career-Proxy-Secret": "test-secret"})
    assert authorized.status_code == 200
    assert authorized.json() == {
        "ok": True,
        "operation_worker_running": False,
        "analysis_concurrency": 20,
    }
