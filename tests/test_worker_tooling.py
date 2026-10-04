from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from career_workflow import worker_doctor


REPO_ROOT = Path(__file__).resolve().parents[1]


def _executable(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


def test_doctor_never_prints_secret_values(
    monkeypatch,
    capsys,
):
    secret_values = {
        "CAREER_PROXY_SECRET": "proxy-secret-do-not-print",
        "CAREER_SITE_URL": "https://dashboard.example.test",
        "CAREER_SITE_BYPASS_TOKEN": "bypass-secret-do-not-print",
        "CAREER_WORKER_CALLBACK_SECRET": "callback-secret-do-not-print",
        "TUNNEL_TOKEN": "tunnel-secret-do-not-print",
    }
    for key, value in secret_values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(
        worker_doctor,
        "check_codex",
        lambda: [worker_doctor.Check("Codex subscription login", True, "authenticated")],
    )
    monkeypatch.setattr(
        worker_doctor,
        "check_cloudflared",
        lambda: [worker_doctor.Check("Cloudflare tunnel credentials", True, "configured")],
    )

    assert worker_doctor.main(["--config-only"]) == 0
    output = capsys.readouterr().out
    assert "configured" in output
    assert secret_values["CAREER_PROXY_SECRET"] not in output
    assert secret_values["CAREER_SITE_BYPASS_TOKEN"] not in output
    assert secret_values["CAREER_WORKER_CALLBACK_SECRET"] not in output
    assert secret_values["TUNNEL_TOKEN"] not in output


def test_codex_check_only_runs_login_status(tmp_path: Path, monkeypatch):
    args_path = tmp_path / "codex-args.txt"
    fake_codex = _executable(
        tmp_path / "codex",
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$DOCTOR_ARGS_PATH"\n',
    )
    monkeypatch.setenv("CODEX_COMMAND", str(fake_codex))
    monkeypatch.setenv("DOCTOR_ARGS_PATH", str(args_path))

    checks = worker_doctor.check_codex()

    assert all(check.ok for check in checks)
    assert args_path.read_text(encoding="utf-8").strip() == "login status"


def test_service_renderer_uses_its_own_repo_path_with_spaces(tmp_path: Path):
    portable_root = tmp_path / "portable worker repo"
    scripts_dir = portable_root / "scripts"
    venv_bin = portable_root / ".venv" / "bin"
    scripts_dir.mkdir(parents=True)
    venv_bin.mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "scripts" / "install_worker_services", scripts_dir)
    shutil.copy2(REPO_ROOT / "scripts" / "run_worker_tunnel", scripts_dir)
    _executable(venv_bin / "python", "#!/usr/bin/env bash\nexit 0\n")
    output_dir = tmp_path / "rendered units"

    completed = subprocess.run(
        [
            "bash",
            str(scripts_dir / "install_worker_services"),
            "--render-only",
            str(output_dir),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    api_unit = (output_dir / "career-automation-api.service").read_text(
        encoding="utf-8"
    )
    tunnel_unit = (output_dir / "career-automation-tunnel.service").read_text(
        encoding="utf-8"
    )
    escaped_root = str(portable_root).replace(" ", r"\x20")
    assert f"WorkingDirectory={escaped_root}" in api_unit
    assert f'ExecStart="{portable_root}/.venv/bin/python"' in api_unit
    assert f"WorkingDirectory={escaped_root}" in tunnel_unit
    assert f'ExecStart="{portable_root}/scripts/run_worker_tunnel"' in tunnel_unit


def test_tunnel_token_stays_out_of_process_arguments(tmp_path: Path):
    args_path = tmp_path / "cloudflared-args.txt"
    fake_cloudflared = _executable(
        tmp_path / "cloudflared",
        '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CLOUDFLARED_ARGS_PATH"\n',
    )
    secret = "tunnel-secret-do-not-put-in-argv"
    env = os.environ.copy()
    for key in (
        "TUNNEL_TOKEN_FILE",
        "CAREER_TUNNEL_ID",
        "TUNNEL_CRED_FILE",
        "CAREER_TUNNEL_CONFIG",
    ):
        env.pop(key, None)
    env.update(
        {
            "CAREER_CLOUDFLARED_COMMAND": str(fake_cloudflared),
            "CLOUDFLARED_ARGS_PATH": str(args_path),
            "TUNNEL_TOKEN": secret,
        }
    )

    completed = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / "run_worker_tunnel")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    arguments = args_path.read_text(encoding="utf-8")
    assert arguments.splitlines() == ["tunnel", "run"]
    assert secret not in arguments


def test_require_running_retries_transient_startup(monkeypatch):
    attempts = 0

    monkeypatch.setattr(worker_doctor, "check_environment", lambda: [])
    monkeypatch.setattr(worker_doctor, "check_codex", lambda: [])
    monkeypatch.setattr(worker_doctor, "check_cloudflared", lambda: [])
    monkeypatch.setattr(worker_doctor.time, "sleep", lambda _seconds: None)

    def transient_checks(*, required):
        nonlocal attempts
        attempts += 1
        return [
            worker_doctor.Check(
                "Local worker API",
                attempts >= 2,
                "online" if attempts >= 2 else "offline or unreachable",
                required,
            )
        ]

    monkeypatch.setattr(worker_doctor, "check_running", transient_checks)

    checks = worker_doctor.run_checks(config_only=False, require_running=True)

    assert attempts == 2
    assert all(check.ok for check in checks)
