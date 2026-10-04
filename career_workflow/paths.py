from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = Path("~/.local/share/career-automation")
DEFAULT_OUTPUT_DIR = Path("~/.local/state/career-automation")
DEFAULT_RESUME_PATH = DEFAULT_DATA_DIR / "resume.docx"


def load_dotenv(path: Path | None = None) -> None:
    env_path = path or REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class RuntimePaths:
    repo_root: Path
    data_dir: Path
    output_dir: Path
    db_path: Path
    profile_dir: Path
    jobs_dir: Path
    applications_dir: Path
    reports_dir: Path
    runs_dir: Path
    logs_dir: Path
    search_runs_dir: Path


def runtime_paths() -> RuntimePaths:
    load_dotenv()
    data_dir = Path(os.environ.get("DATA_DIR", str(DEFAULT_DATA_DIR))).expanduser()
    output_dir = Path(os.environ.get("OUTPUT_DIR", str(DEFAULT_OUTPUT_DIR))).expanduser()
    return RuntimePaths(
        repo_root=REPO_ROOT,
        data_dir=data_dir,
        output_dir=output_dir,
        db_path=output_dir / "career_tracker.sqlite",
        profile_dir=output_dir / "profile",
        jobs_dir=output_dir / "jobs",
        applications_dir=output_dir / "applications",
        reports_dir=output_dir / "daily_reports",
        runs_dir=output_dir / "codex_runs",
        logs_dir=output_dir / "logs",
        search_runs_dir=output_dir / "search_runs",
    )


def resume_path() -> Path:
    load_dotenv()
    return Path(os.environ.get("RESUME_PATH", str(DEFAULT_RESUME_PATH))).expanduser()


def ensure_runtime_dirs() -> RuntimePaths:
    paths = runtime_paths()
    for path in (
        paths.data_dir,
        paths.output_dir,
        paths.profile_dir,
        paths.jobs_dir / "raw",
        paths.jobs_dir / "normalized",
        paths.applications_dir,
        paths.reports_dir,
        paths.runs_dir,
        paths.logs_dir,
        paths.search_runs_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)
    return paths
