from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
import os
from pathlib import Path

from docx import Document

from .paths import ensure_runtime_dirs, resume_path as configured_resume_path


class ResumeParseError(ValueError):
    pass


def pandoc_command() -> str | None:
    configured = os.getenv("PANDOC_COMMAND")
    if configured:
        return configured

    return shutil.which("pandoc")


def clean_markdown(markdown: str) -> str:
    lines = [line.rstrip() for line in markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    cleaned: list[str] = []
    blank_count = 0
    for line in lines:
        if not line.strip():
            blank_count += 1
            if blank_count <= 1:
                cleaned.append("")
            continue
        blank_count = 0
        cleaned.append(line)
    return "\n".join(cleaned).strip()


def parse_docx_with_pandoc(path: Path) -> str:
    pandoc = pandoc_command()
    if not pandoc:
        raise ResumeParseError("Pandoc is not installed.")

    result = subprocess.run(
        [
            pandoc,
            str(path),
            "--from",
            "docx",
            "--to",
            "gfm",
            "--wrap",
            "none",
            "--markdown-headings=atx",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ResumeParseError(f"Pandoc could not parse DOCX resume: {result.stderr.strip()}")
    text = clean_markdown(result.stdout)
    if not text:
        raise ResumeParseError("Resume text is empty after Pandoc parsing.")
    return text


def parse_docx_plain(path: Path) -> str:
    if not path.exists():
        raise ResumeParseError(f"Resume not found: {path}")
    try:
        document = Document(path)
    except Exception as exc:
        raise ResumeParseError(f"Could not parse DOCX resume: {path}") from exc
    lines = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    text = "\n".join(lines).strip()
    if not text:
        raise ResumeParseError("Resume text is empty after parsing.")
    return text


def parse_docx(path: Path) -> tuple[str, str]:
    if not path.exists():
        raise ResumeParseError(f"Resume not found: {path}")

    try:
        return parse_docx_with_pandoc(path), "pandoc"
    except ResumeParseError:
        return parse_docx_plain(path), "python-docx"


def init_profile(resume_path: Path | None = None) -> dict:
    paths = ensure_runtime_dirs()
    resume_path = resume_path or configured_resume_path()
    resume_text, parser = parse_docx(resume_path)
    profile = {
        "resume_path": str(resume_path),
        "resume_text_path": str(paths.profile_dir / "resume_text.md"),
        "resume_parser": parser,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "resume_strategies": [
            "ai_solutions",
            "product_ops",
            "bizops",
            "tpm_epm",
            "ai_product",
            "pmm_gtm_ai",
        ],
    }
    (paths.profile_dir / "resume_text.md").write_text(resume_text + "\n", encoding="utf-8")
    (paths.profile_dir / "profile_snapshot.json").write_text(json.dumps(profile, indent=2), encoding="utf-8")
    return profile
