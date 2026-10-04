from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from .codex_runner import run_codex
from .context import load_candidate_context, read_repo_file, safe_packet_slug, section
from .docx_export import markdown_to_docx
from .paths import ensure_runtime_dirs
from .tracker import connect, get_job, record_run, save_application


def split_packet(text: str) -> dict[str, str]:
    markers = {
        "tailored_resume.md": "=== tailored_resume.md ===",
        "cover_letter.md": "=== cover_letter.md ===",
        "application_answers.md": "=== application_answers.md ===",
    }
    positions = {name: text.find(marker) for name, marker in markers.items()}
    if any(pos < 0 for pos in positions.values()):
        raise ValueError("Codex packet output is missing one or more required section markers.")
    ordered = sorted(positions.items(), key=lambda item: item[1])
    sections: dict[str, str] = {}
    for index, (name, start) in enumerate(ordered):
        content_start = start + len(markers[name])
        content_end = ordered[index + 1][1] if index + 1 < len(ordered) else len(text)
        sections[name] = text[content_start:content_end].strip() + "\n"
    return sections


def build_packet_prompt(job: dict) -> str:
    context = load_candidate_context()
    prompt = read_repo_file("prompts/build_packet.md")
    analysis = job.get("analysis") or {}
    parts = [prompt]
    parts.append(section("Job Metadata", json.dumps({k: job.get(k) for k in ("job_id", "title", "company", "location", "url", "source")}, indent=2)))
    parts.append(section("Decision Memo", json.dumps(analysis.get("decision_memo") or {}, indent=2)))
    parts.append(section("Job Description", job.get("description") or ""))
    parts.append(section("Resume Text", context["resume_text"]))
    parts.append(section("Verified Background", context["background"]))
    parts.append(section("Preferences", context["preferences"]))
    parts.append(section("Resume Rules", context["resume_rules"]))
    parts.append(section("Cover Letter Rules", context["cover_letter_rules"]))
    return "\n".join(parts)


def build_packet(job_id: str) -> dict:
    paths = ensure_runtime_dirs()
    with connect() as conn:
        job = get_job(conn, job_id)
        if not job:
            raise ValueError(f"Job not found: {job_id}")
        if not job.get("analysis"):
            raise ValueError("Analyze the job before building a packet.")
    prompt = build_packet_prompt(job)
    result = run_codex(prompt, run_type="build_packet", job_id=job_id)
    with connect() as conn:
        record_run(conn, job_id, "build_packet", result.prompt_path, result.output_path, result.status, result.error)
    if result.status != "success":
        raise RuntimeError(result.error or f"Codex packet generation failed. See {result.output_path}")
    sections = split_packet(result.text)
    packet_dir = paths.applications_dir / date.today().isoformat() / safe_packet_slug(job["company"], job["title"])
    packet_dir.mkdir(parents=True, exist_ok=True)
    (packet_dir / "job_description.md").write_text(job.get("description") or "", encoding="utf-8")
    (packet_dir / "decision_memo.json").write_text(json.dumps(job["analysis"]["decision_memo"], indent=2), encoding="utf-8")
    for filename, content in sections.items():
        (packet_dir / filename).write_text(content, encoding="utf-8")
    markdown_to_docx(packet_dir / "tailored_resume.md", packet_dir / "tailored_resume.docx")
    audit = {
        "job_id": job_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "codex_prompt_path": str(result.prompt_path),
        "codex_output_path": str(result.output_path),
        "resume_strategy": job["analysis"]["resume_strategy"],
        "source_url": job.get("url"),
    }
    (packet_dir / "audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    with connect() as conn:
        save_application(conn, job_id, packet_dir, job["analysis"]["resume_strategy"])
    return {"job_id": job_id, "packet_path": str(packet_dir), "files": sorted(path.name for path in packet_dir.iterdir())}


def application_artifacts(job_id: str) -> dict:
    with connect() as conn:
        job = get_job(conn, job_id)
    if not job or not job.get("application"):
        raise ValueError(f"Application packet not found for job: {job_id}")
    packet_path = Path(job["application"]["packet_path"])
    files = {
        "tailored_resume_md": packet_path / "tailored_resume.md",
        "tailored_resume_docx": packet_path / "tailored_resume.docx",
        "cover_letter": packet_path / "cover_letter.md",
        "application_answers": packet_path / "application_answers.md",
        "decision_memo": packet_path / "decision_memo.json",
        "audit": packet_path / "audit.json",
        "job_description": packet_path / "job_description.md",
    }
    return {"job": job, "packet_path": packet_path, "files": files}
