from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from .paths import load_dotenv


REQUIRED_ENV = (
    "CAREER_PROXY_SECRET",
    "CAREER_SITE_URL",
    "CAREER_SITE_BYPASS_TOKEN",
    "CAREER_WORKER_CALLBACK_SECRET",
)
RUNNING_CHECK_ATTEMPTS = 8
RUNNING_CHECK_INTERVAL_SECONDS = 2


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str
    required: bool = True


def _expanded_path(value: str) -> Path:
    return Path(value).expanduser()


def _resolve_command(value: str) -> str | None:
    if os.sep in value or (os.altsep and os.altsep in value):
        candidate = _expanded_path(value)
        return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    return shutil.which(value)


def check_environment() -> list[Check]:
    checks = [
        Check(
            key,
            bool(os.environ.get(key, "").strip()),
            "configured" if os.environ.get(key, "").strip() else "missing",
        )
        for key in REQUIRED_ENV
    ]
    site_url = os.environ.get("CAREER_SITE_URL", "").strip()
    if site_url:
        parsed = urlparse(site_url)
        valid = parsed.scheme in {"http", "https"} and bool(parsed.netloc)
        checks.append(
            Check(
                "CAREER_SITE_URL format",
                valid,
                "valid HTTP(S) URL" if valid else "must be an absolute HTTP(S) URL",
            )
        )
    return checks


def check_codex() -> list[Check]:
    configured = os.environ.get("CODEX_COMMAND", "codex").strip() or "codex"
    executable = _resolve_command(configured)
    if not executable:
        return [Check("Codex CLI", False, "command not found")]
    try:
        completed = subprocess.run(
            [executable, "login", "status"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return [
            Check("Codex CLI", True, "installed"),
            Check("Codex subscription login", False, "status check failed"),
        ]
    return [
        Check("Codex CLI", True, "installed"),
        Check(
            "Codex subscription login",
            completed.returncode == 0,
            "authenticated"
            if completed.returncode == 0
            else "not authenticated; run codex login --device-auth",
        ),
    ]


def _tunnel_configuration() -> Check:
    token_file = os.environ.get("TUNNEL_TOKEN_FILE", "").strip()
    if token_file:
        path = _expanded_path(token_file)
        readable = path.is_file() and os.access(path, os.R_OK)
        return Check(
            "Cloudflare tunnel credentials",
            readable,
            "token file is readable" if readable else "TUNNEL_TOKEN_FILE is not readable",
        )
    if os.environ.get("TUNNEL_TOKEN", "").strip():
        return Check("Cloudflare tunnel credentials", True, "token is configured")

    tunnel_id = os.environ.get("CAREER_TUNNEL_ID", "").strip()
    credential_file = os.environ.get("TUNNEL_CRED_FILE", "").strip()
    if tunnel_id or credential_file:
        if not tunnel_id or not credential_file:
            return Check(
                "Cloudflare tunnel credentials",
                False,
                "CAREER_TUNNEL_ID and TUNNEL_CRED_FILE must be set together",
            )
        path = _expanded_path(credential_file)
        readable = path.is_file() and os.access(path, os.R_OK)
        return Check(
            "Cloudflare tunnel credentials",
            readable,
            "credential file is readable" if readable else "TUNNEL_CRED_FILE is not readable",
        )

    config_value = os.environ.get("CAREER_TUNNEL_CONFIG", "").strip()
    config_path = (
        _expanded_path(config_value)
        if config_value
        else Path.home() / ".cloudflared" / "career-automation.yml"
    )
    readable = config_path.is_file() and os.access(config_path, os.R_OK)
    return Check(
        "Cloudflare tunnel credentials",
        readable,
        "config file is readable"
        if readable
        else "no readable tunnel configuration was found",
    )


def check_cloudflared() -> list[Check]:
    configured = (
        os.environ.get("CAREER_CLOUDFLARED_COMMAND", "cloudflared").strip()
        or "cloudflared"
    )
    executable = _resolve_command(configured)
    return [
        Check(
            "cloudflared",
            bool(executable),
            "installed" if executable else "command not found",
        ),
        _tunnel_configuration(),
    ]


def _json_health(url: str, headers: dict[str, str]) -> dict[str, object]:
    request = Request(url, headers={"Accept": "application/json", **headers})
    with urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("response is not an object")
    return value


def check_running(*, required: bool) -> list[Check]:
    checks: list[Check] = []
    proxy_secret = os.environ.get("CAREER_PROXY_SECRET", "")
    try:
        local = _json_health(
            "http://127.0.0.1:8010/api/worker/health",
            {"X-Career-Proxy-Secret": proxy_secret},
        )
        local_ok = bool(local.get("ok") or local.get("online"))
        checks.append(
            Check(
                "Local worker API",
                local_ok,
                "online" if local_ok else "returned unavailable",
                required,
            )
        )
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
    ):
        checks.append(Check("Local worker API", False, "offline or unreachable", required))

    site_url = os.environ.get("CAREER_SITE_URL", "").strip()
    bypass = os.environ.get("CAREER_SITE_BYPASS_TOKEN", "")
    if not site_url:
        checks.append(
            Check(
                "Site-to-worker connection",
                False,
                "CAREER_SITE_URL is missing",
                required,
            )
        )
        return checks
    target = urljoin(f"{site_url.rstrip('/')}/", "api/worker/status")
    try:
        site = _json_health(
            target,
            {"OAI-Sites-Authorization": f"Bearer {bypass}"},
        )
        site_ok = bool(site.get("ok"))
        checks.append(
            Check(
                "Site-to-worker connection",
                site_ok,
                "online" if site_ok else "Site reports worker offline",
                required,
            )
        )
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
    ):
        checks.append(
            Check(
                "Site-to-worker connection",
                False,
                "unreachable or unauthorized",
                required,
            )
        )
    return checks


def run_checks(*, config_only: bool, require_running: bool) -> list[Check]:
    load_dotenv()
    checks = [*check_environment(), *check_codex(), *check_cloudflared()]
    if config_only:
        return checks
    running_checks: list[Check] = []
    attempts = RUNNING_CHECK_ATTEMPTS if require_running else 1
    for attempt in range(attempts):
        running_checks = check_running(required=require_running)
        if all(check.ok for check in running_checks):
            break
        if attempt + 1 < attempts:
            time.sleep(RUNNING_CHECK_INTERVAL_SECONDS)
    checks.extend(running_checks)
    return checks


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate the optional workstation worker without running a paid Codex request."
        )
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--config-only",
        action="store_true",
        help="Skip local and Site health requests.",
    )
    mode.add_argument(
        "--require-running",
        action="store_true",
        help="Fail when the local API or Site connection is offline.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    checks = run_checks(
        config_only=args.config_only,
        require_running=args.require_running,
    )
    failed = False
    for check in checks:
        if check.ok:
            marker = "OK"
        elif check.required:
            marker = "FAIL"
            failed = True
        else:
            marker = "WARN"
        print(f"[{marker}] {check.name}: {check.detail}")
    if failed:
        print("Worker doctor found required setup issues.", file=sys.stderr)
        return 1
    print(
        "Worker configuration is ready."
        if args.config_only
        else "Worker checks completed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
