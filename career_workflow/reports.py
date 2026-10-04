from __future__ import annotations

import json
from datetime import date

from .codex_runner import run_codex
from .context import read_repo_file, section
from .paths import ensure_runtime_dirs
from .tracker import connect, list_jobs, record_run


def build_daily_prompt(report_date: str | None = None) -> str:
    report_date = report_date or date.today().isoformat()
    with connect() as conn:
        jobs = list_jobs(conn, {"date": report_date})
    prompt = read_repo_file("prompts/daily_report.md")
    return "\n".join([prompt, section("Report Date", report_date), section("Jobs And Analyses", json.dumps(jobs, indent=2))])


def daily_report(report_date: str | None = None) -> dict:
    paths = ensure_runtime_dirs()
    report_date = report_date or date.today().isoformat()
    prompt = build_daily_prompt(report_date)
    result = run_codex(prompt, run_type="daily_report", job_id=report_date)
    with connect() as conn:
        record_run(conn, None, "daily_report", result.prompt_path, result.output_path, result.status, result.error)
    if result.status != "success":
        raise RuntimeError(result.error or "Daily report generation failed.")
    report_path = paths.reports_dir / f"{report_date}.md"
    report_path.write_text(result.text, encoding="utf-8")
    return {"date": report_date, "report_path": str(report_path), "content": result.text}
