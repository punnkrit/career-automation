"""Foreground worker lifecycle for Windows, macOS, and Linux.

Uses the current Python environment; no Bash, systemd, or elevated service install.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Mapping, Sequence

from .paths import REPO_ROOT, load_dotenv
from .worker_doctor import main as doctor_main, _resolve_command


def tunnel_command(env: Mapping[str, str]) -> tuple[list[str], dict[str, str]]:
    child_env = dict(env)
    command = _resolve_command(env.get("CAREER_CLOUDFLARED_COMMAND", "cloudflared"))
    if not command:
        raise ValueError("cloudflared is not installed or its configured path is invalid.")
    args = [command, "tunnel"]
    def file(key: str, default: str = "") -> str:
        path = Path(env.get(key, default)).expanduser()
        if not path.is_file():
            raise ValueError(f"{key} does not point to a readable file.")
        return str(path)
    if env.get("TUNNEL_TOKEN_FILE"):
        child_env.pop("TUNNEL_TOKEN", None)
        args += ["run", "--token-file", file("TUNNEL_TOKEN_FILE")]
    elif env.get("TUNNEL_TOKEN"):
        args += ["run"]
    elif env.get("CAREER_TUNNEL_ID"):
        args += ["run", "--credentials-file", file("TUNNEL_CRED_FILE"),
                 "--url", env.get("TUNNEL_URL", "http://127.0.0.1:8010"), env["CAREER_TUNNEL_ID"]]
    elif env.get("TUNNEL_CRED_FILE"):
        raise ValueError("TUNNEL_CRED_FILE also requires CAREER_TUNNEL_ID.")
    else:
        args += ["--config", file("CAREER_TUNNEL_CONFIG", "~/.cloudflared/career-automation.yml"), "run"]
    return args, child_env


def stop_children(children: list[subprocess.Popen]) -> None:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the optional worker without Bash or system services.")
    parser.add_argument("command", choices=["run", "doctor", "status"])
    args, rest = parser.parse_known_args(argv)
    load_dotenv()
    if args.command == "doctor":
        return doctor_main(rest)
    if args.command == "status":
        return doctor_main(["--require-running", *rest])
    if rest:
        parser.error("run does not accept extra options")
    if doctor_main(["--config-only"]):
        return 1
    try:
        tunnel_args, tunnel_env = tunnel_command(os.environ)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    children: list[subprocess.Popen] = []
    child_env = os.environ.copy()
    child_env.setdefault("CAREER_DISABLE_OPERATION_WORKER", "1")
    try:
        children.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "career_workflow.api:app",
                                          "--host", "127.0.0.1", "--port", "8010"], cwd=REPO_ROOT, env=child_env))
        children.append(subprocess.Popen(tunnel_args, cwd=REPO_ROOT, env=tunnel_env))
        print("Worker processes started. Keep this terminal open; Ctrl+C stops both.")
        while all(child.poll() is None for child in children):
            time.sleep(0.5)
        print("A worker process stopped. Both processes are shutting down.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    except OSError:
        print("Could not start a worker process. Check executable paths and configuration.", file=sys.stderr)
        return 1
    finally:
        stop_children(children)


if __name__ == "__main__":
    raise SystemExit(main())
