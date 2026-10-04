from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .analysis import analyze_job
from .generation import build_packet
from .jobs import backfill_serpapi_posted_dates, ingest_manual_job_payload, parse_manual_job, recover_serpapi_raw_files, search_serpapi
from .operations import queue_operation
from .paths import resume_path as configured_resume_path, runtime_paths
from .reports import daily_report
from .resume import init_profile
from .site_api import site_api_configured, site_json, wait_for_site_operation
from .tracker import MANUAL_DECISION_STATUSES, connect, get_job, list_jobs, update_status


def print_json(data: object) -> None:
    print(json.dumps(data, indent=2, default=str))


def read_json_input(source: str) -> dict[str, Any]:
    raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Ingest JSON must be an object.")
    return payload


def publish_profile_to_site() -> dict[str, Any]:
    profile = init_profile()
    resume_text = Path(str(profile["resume_text_path"])).read_text(encoding="utf-8")
    resume_text_size = len(resume_text.encode("utf-8"))
    if not resume_text.strip():
        raise ValueError("Parsed resume text is empty.")
    if resume_text_size > 2 * 1024 * 1024:
        raise ValueError("Parsed resume text exceeds the 2 MB Site limit.")
    resume_docx = configured_resume_path().read_bytes()
    if not resume_docx:
        raise ValueError("Resume DOCX is empty.")
    if len(resume_docx) > 8 * 1024 * 1024:
        raise ValueError("Resume DOCX exceeds the 8 MB Site limit.")
    payload = {
        "resume_text": resume_text,
        "resume_parser": str(profile["resume_parser"]),
        "resume_strategies": list(profile["resume_strategies"]),
        "resume_docx_base64": base64.b64encode(resume_docx).decode("ascii"),
    }
    return site_json("POST", "/api/profile/init", payload=payload)


def main() -> None:
    parser = argparse.ArgumentParser(prog="career")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-profile")

    ingest = sub.add_parser("ingest-job", help="Add a manual job from Markdown or structured JSON")
    ingest_input = ingest.add_mutually_exclusive_group(required=True)
    ingest_input.add_argument("--file", help="Markdown/text file with optional Title, Company, Location, and URL headers")
    ingest_input.add_argument("--json", help="JSON payload path, or - to read JSON from stdin")
    ingest.add_argument("--title", help="Override the parsed title")
    ingest.add_argument("--company", help="Override the parsed company")
    ingest.add_argument("--location", help="Override the parsed location")
    ingest.add_argument("--url", help="Override the parsed apply URL")
    ingest.add_argument("--lane", help="Required lane id, unless lane or lane_hint is present in JSON")
    ingest.add_argument("--status", choices=sorted(MANUAL_DECISION_STATUSES), help="Initial dashboard Decision")
    ingest_analysis = ingest.add_mutually_exclusive_group()
    ingest_analysis.add_argument("--analyze", action="store_true", default=None, help="Analyze synchronously after ingest")
    ingest_analysis.add_argument(
        "--queue-analysis",
        action="store_true",
        help="Dispatch AI Rec and Fit to an online dashboard worker and return immediately",
    )

    ingest_analysis.add_argument("--no-analyze", action="store_true", help="Save without requesting analysis")

    search = sub.add_parser("search")
    search.add_argument("--lane", required=True)
    search.add_argument("--location", required=True)
    search.add_argument("--limit", type=int, default=20)

    recover_search = sub.add_parser("recover-search")
    recover_search.add_argument("--lane", required=True)
    recover_search.add_argument("--prefix", required=True, help="Raw response filename prefix, for example 20260713-13")

    sub.add_parser("backfill-posted-dates")

    analyze = sub.add_parser("analyze")
    analyze.add_argument("--job-id", required=True)

    packet = sub.add_parser("build-packet")
    packet.add_argument("--job-id", required=True)

    report = sub.add_parser("daily-report")
    report.add_argument("--date")

    jobs = sub.add_parser("jobs")
    jobs.add_argument("--date")
    jobs.add_argument("--status")

    status = sub.add_parser("status")
    status.add_argument("--job-id", required=True)
    status.add_argument("--status", required=True)

    args = parser.parse_args()
    use_site = site_api_configured()
    if args.command == "init-profile":
        print_json(publish_profile_to_site() if use_site else init_profile())
    elif args.command == "ingest-job":
        payload = read_json_input(args.json) if args.json else parse_manual_job(Path(args.file))
        if args.file:
            payload.pop("status", None)
        for field in ("title", "company", "location", "url"):
            value = getattr(args, field)
            if value is not None:
                payload[field] = value
        if args.lane is not None:
            payload["lane_hint"] = args.lane
        if args.status is not None:
            payload["status"] = args.status
        if args.analyze is not None:
            payload["analyze"] = args.analyze
        if not payload.get("lane_hint") and not payload.get("lane"):
            parser.error("ingest-job requires --lane, or lane/lane_hint in the JSON payload")
        analysis_value = payload.get("analyze", False)
        if not isinstance(analysis_value, bool):
            parser.error("ingest-job JSON field 'analyze' must be true or false")
        analyze_requested = analysis_value and not (args.queue_analysis or args.no_analyze)
        queue_analysis = not args.no_analyze and (args.queue_analysis or "analyze" not in payload)
        if use_site:
            site_payload = {**payload, "lane_hint": payload.get("lane_hint") or payload.get("lane")}
            site_payload.pop("lane", None)
            site_payload["analyze"] = bool(queue_analysis or analyze_requested)
            result = site_json("POST", "/api/jobs/ingest", payload=site_payload)
            if analyze_requested:
                operation = result.get("analysis_operation")
                if not isinstance(operation, dict):
                    raise RuntimeError(
                        f"Job {result.get('job_id')} was saved to D1, but the workstation worker did not accept analysis."
                    )
                wait_for_site_operation(operation)
                result["job"] = site_json("GET", f"/api/jobs/{quote(str(result['job_id']), safe='')}")
                analysis = result["job"].get("analysis") or {}
                result["analysis"] = analysis.get("decision_memo") or analysis
        else:
            result = ingest_manual_job_payload(payload)
            if queue_analysis:
                operation, analysis_created = queue_operation("analyze_job", {"job_id": result["job_id"]})
                result["analysis_operation"] = operation
                result["analysis_created"] = analysis_created
            elif analyze_requested:
                result["analysis"] = analyze_job(result["job_id"])
                with connect() as conn:
                    result["job"] = get_job(conn, result["job_id"])
        print_json(result)
    elif args.command == "search":
        if use_site:
            response = site_json(
                "POST",
                "/api/search",
                payload={"lanes": [args.lane], "locations": [args.location], "limit": args.limit},
            )
            operation = wait_for_site_operation(response["operation"])
            print_json(operation.get("result") or {})
        else:
            print_json(search_serpapi(args.lane, args.location, args.limit))
    elif args.command == "recover-search":
        if use_site:
            parser.error("recover-search is legacy workstation maintenance and cannot update the D1 source of truth.")
        raw_paths = sorted((runtime_paths().jobs_dir / "raw").glob(f"{args.prefix}*.json"))
        if not raw_paths:
            parser.error(f"No raw SerpAPI responses matched prefix: {args.prefix}")
        print_json(recover_serpapi_raw_files(raw_paths, args.lane))
    elif args.command == "backfill-posted-dates":
        if use_site:
            parser.error("backfill-posted-dates is legacy workstation maintenance and cannot update the D1 source of truth.")
        print_json(backfill_serpapi_posted_dates())
    elif args.command == "analyze":
        if use_site:
            response = site_json("POST", f"/api/jobs/{quote(args.job_id, safe='')}/analyze", payload={})
            wait_for_site_operation(response["operation"])
            job = site_json("GET", f"/api/jobs/{quote(args.job_id, safe='')}")
            analysis = job.get("analysis") or {}
            print_json(analysis.get("decision_memo") or analysis)
        else:
            print_json(analyze_job(args.job_id))
    elif args.command == "build-packet":
        if use_site:
            response = site_json("POST", f"/api/jobs/{quote(args.job_id, safe='')}/build-packet", payload={})
            wait_for_site_operation(response["operation"])
            print_json(site_json("GET", f"/api/applications/{quote(args.job_id, safe='')}"))
        else:
            print_json(build_packet(args.job_id))
    elif args.command == "daily-report":
        if use_site:
            response = site_json("POST", "/api/daily-report", payload={"date": args.date})
            operation = wait_for_site_operation(response["operation"])
            print_json(operation.get("result") or {})
        else:
            print_json(daily_report(args.date))
    elif args.command == "jobs":
        if use_site:
            params = {key: value for key, value in {"date": args.date, "status": args.status}.items() if value}
            print_json(site_json("GET", "/api/jobs", params=params).get("jobs") or [])
        else:
            with connect() as conn:
                print_json(list_jobs(conn, {"date": args.date, "status": args.status}))
    elif args.command == "status":
        if use_site:
            print_json(
                site_json(
                    "POST",
                    f"/api/jobs/{quote(args.job_id, safe='')}/status",
                    payload={"status": args.status},
                )
            )
        else:
            with connect() as conn:
                update_status(conn, args.job_id, args.status)
            print_json({"job_id": args.job_id, "status": args.status})


if __name__ == "__main__":
    main()
