from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from .paths import ensure_runtime_dirs


_operation_candidate_context: ContextVar[dict[str, str] | None] = ContextVar("operation_candidate_context", default=None)

_operation_resume_text: ContextVar[str | None] = ContextVar("operation_resume_text", default=None)


def read_repo_file(relative: str, max_chars: int | None = None) -> str:
    path = ensure_runtime_dirs().repo_root / relative
    text = path.read_text(encoding="utf-8")
    return text[:max_chars] if max_chars else text


def load_candidate_context() -> dict[str, str]:
    paths = ensure_runtime_dirs()
    resume_text_path = paths.profile_dir / "resume_text.md"
    scoped_resume_text = _operation_resume_text.get()
    if scoped_resume_text is not None:
        resume_text = scoped_resume_text
    else:
        resume_text = resume_text_path.read_text(encoding="utf-8") if resume_text_path.exists() else ""
    supplied = _operation_candidate_context.get() or {}
    return {
        "resume_text": resume_text,
        "background": supplied.get("background", ""),
        "preferences": supplied.get("preferences", ""),
        "lanes": read_repo_file("config/lanes.yaml"),
        "resume_rules": read_repo_file("config/resume_rules.md"),
        "cover_letter_rules": read_repo_file("config/cover_letter_rules.md"),
    }


@contextmanager
def operation_resume_context(resume_text: str, candidate_context: dict[str, str] | None = None) -> Iterator[None]:
    token = _operation_resume_text.set(resume_text)
    context_token = _operation_candidate_context.set(candidate_context)
    try:
        yield
    finally:
        _operation_resume_text.reset(token)
        _operation_candidate_context.reset(context_token)


def section(title: str, body: str) -> str:
    return f"\n\n---\n\n## {title}\n\n{body.strip()}\n"


def safe_packet_slug(company: str, title: str) -> str:
    from .jobs import slugify

    return slugify(f"{company}-{title}")[:120]
