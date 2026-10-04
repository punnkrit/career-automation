# Connect an optional worker

Get your private tracker working first with [SETUP.md](SETUP.md). Nothing here is needed just to save jobs, track decisions, or view saved results. SerpAPI is not a worker prerequisite.

The portable foreground launcher uses Python on Windows, macOS, and Linux, without Bash or systemd. Real native Windows/macOS Codex login and tunnel setup still require acceptance testing. Keep that distinction when helping a friend.

## Install the Python tools

Run these from the cloned repository. Use Python 3.11 or newer.

Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m career_workflow.cli --help
```

macOS/Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m career_workflow.cli --help
```

Activating the environment is optional when using the explicit executable path. After activation, `career` is the CLI and `career-worker` is the worker launcher. The equivalent module commands work without activation. Keep the checkout because prompts and schemas live there.

## Configure your own connections

Ask Codex to use your tooling and accounts. There are three separate sign-ins: Codex access, trusted access to the private Site API, and the Cloudflare tunnel. Completing one does not finish the other two.

1. Install Codex CLI and cloudflared for your OS. If they are not on PATH, set their absolute executable paths in `.env`. Paths may contain spaces; do not add shell commands or flags to executable settings.
2. Run `codex login` yourself and check `codex login status`. Authenticate on the machine running the worker. It does not borrow another user's Windows auth cache.
3. Create a protected `.env` from `.env.example`. Configure your private Site URL and its supported service access credential. Keep credentials out of chat, tracked files, and screenshots.
4. Generate fresh proxy and callback secrets. Set matching values on the worker and Site through supported secret tooling. Preserve working values on retries.
5. Configure a named Cloudflare tunnel to `http://127.0.0.1:8010`. Choose one supported mode below and configure the Site to reach your authenticated route.
6. Save your profile in the Site's **Setup** page. Leave `RESUME_PATH`, `DATA_DIR`, and `OUTPUT_DIR` unset unless there is a specific need to override them.

| Connection | Worker settings | Site settings |
| --- | --- | --- |
| Site service access | `CAREER_SITE_URL`, `CAREER_SITE_BYPASS_TOKEN` | Supported private Sites access policy |
| Site to worker | `CAREER_PROXY_SECRET` | `CAREER_API_URL`, matching `CAREER_PROXY_SECRET` |
| Completion callback | `CAREER_WORKER_CALLBACK_SECRET` | Matching `CAREER_WORKER_CALLBACK_SECRET` |
| Cloudflare Access, if used | Your tunnel/Access configuration | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |
| Headless execution | `CODEX_COMMAND`, optional model/reasoning settings | None |

Supported tunnel modes, in precedence order:

- `TUNNEL_TOKEN_FILE`: absolute path to a protected token file. A simultaneous `TUNNEL_TOKEN` is removed from the child environment.
- `TUNNEL_TOKEN`: cloudflared reads it from its environment; it never appears in process arguments.
- `CAREER_TUNNEL_ID` with `TUNNEL_CRED_FILE`: your locally managed tunnel ID and absolute credential path.
- `CAREER_TUNNEL_CONFIG`: absolute path to an existing YAML file; default is `~/.cloudflared/career-automation.yml`.

The launcher does not create a tunnel, rotate secrets, or create an Access policy. These account-dependent steps are agent-guided. Do not expose an unauthenticated workstation origin to make a check pass.

## Run and stop

Using your virtual environment's Python:

```sh
python -m career_workflow.worker doctor --config-only
python -m career_workflow.worker run
```

The second command stays in the foreground and owns both API and tunnel processes. Keep the terminal open. **Ctrl+C stops both.** If either exits, the other is stopped too. Starting twice on the same port is an error, not a second worker installation.

In another terminal using the same Python environment:

```sh
python -m career_workflow.worker status
```

Doctor checks configuration and login status without running a paid analysis. Reachability does not establish that a real Codex task will succeed.

## Prove the connection

1. Verify the Site's Codex badge becomes online.
2. Analyze one fictional test job and inspect the saved result.
3. Stop the worker. Refresh from another device: the job and result must remain visible, and new AI controls must be unavailable.
4. Restart and retry an AI action. Check expired login and callback errors rather than assuming eventual execution.

There is no durable offline AI queue. Local SQLite, output files, and recovery files are diagnostics/scratch, never the authoritative tracker. Do not share an `OUTPUT_DIR` between running workers.

Autostart is optional and outside this foreground path. Existing `scripts/worker` and `scripts/install_worker_services` remain available for WSL/Linux users who explicitly choose systemd; they are not native Windows/macOS instructions.
