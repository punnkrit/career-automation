# Set up your own private dashboard

**Status: agent-guided setup, with hosted onboarding implemented.** The demo is live; a complete fresh-user installation across Windows and macOS is still a release gate. Do not tell a new user setup is complete until their own acceptance checks below pass.

## What you need

- Access to this repository while it is private.
- Codex with the Sites plugin and permission to create a private Site in your account. Check account availability; a ChatGPT subscription alone does not finish provisioning.
- Node.js 22.12+ or a newer supported LTS for building the dashboard. Development tests also use `node:sqlite`.
- Python 3.11+ only for command-line ingestion or the optional worker.

Start from a native Windows, macOS, or Linux checkout. WSL is a development preference, not a tracker requirement. Keep the checkout after an editable Python installation because prompts and schemas are loaded relative to it.

The dashboard does not ask for an OpenAI API key. Optional worker execution uses your own Codex login and account limits. Sites/storage/tunnel availability and any separate costs depend on your accounts; optional SerpAPI uses its own plan.

## Start with the tracker

The first useful result is a private dashboard where the owner can add a job, change its decision, and see the same record on their phone. It does not require a resume, an AI worker, SerpAPI, or an OpenAI API key.

Before provisioning, check whether the user's Codex session has the Sites plugin and account access needed to create a Site. Authentication to Codex, access to Sites, Site browser sign-in, trusted Site API access, and Cloudflare tunnel authentication are different connections. Do not assume that completing one configures the others.

1. Inspect this checkout and any existing ignored `.openai/hosting.json`. Reuse a confirmed installation belonging to this user. Never use a project ID from another installation or from sample text.
2. Follow the installed Sites skill and native tools to register a new owner-private Site when needed. Record the exact returned project ID in the ignored hosting manifest. Start from `.openai/hosting.template.json` for the `DB` and `BUCKET` binding names.
3. Keep the Site private. Configure D1/R2 through Sites; use the reviewed schema migrations in `drizzle/`. The first tracker deployment needs no AI/search runtime secrets.
4. Build and publish through the supported Sites source workflow. The GitHub remote is not automatically the Site's source remote. Never push to an unrelated Site or reuse an existing private app's credentials.
5. Sign into the new Site and verify that a job can be created, updated, and read after refresh and from a second device. Verify unauthorized access does not expose the dashboard or API.

Do not provision a tunnel or ask for SerpAPI while completing this milestone.

## Continue inside your private dashboard

Open **Setup**. The tracker is first; candidate context, agent ingestion, AI worker, and optional search have separate readiness indicators. You can skip AI and search entirely. The status endpoint returns capabilities, never secret values.

Paste your resume text, verified background, and target preferences, then choose **Save my context**. Review the text yourself; do not let an agent invent achievements. The Site saves versioned context to R2 and selects the active version in D1. Worker operations receive that cloud version rather than relying on personal files in the checkout. This form accepts text; the separate CLI `init-profile` flow supports a DOCX source.

## Connect Codex ingestion separately

Use supported private-Site service access for the new Site. Store its URL and authorization credential only in the ignored local `.env` or a supported secret store. Never paste credentials into a chat or README.

Install the Python tools in a virtual environment as described in WORKSTATION_WORKER.md. `python -m career_workflow.cli` and the editable-install `career` command work without the Bash wrapper. See PROGRAMMATIC_JOB_INGESTION.md for payload semantics.

Verify ingestion with analysis explicitly skipped first. Confirm the job is stored in D1 and visible in the browser. Ingestion must work without a persistent AI worker.

## Connect an AI worker later

Use the portable foreground command in [WORKSTATION_WORKER.md](WORKSTATION_WORKER.md). It starts the API and tunnel together and stops both with Ctrl+C. Real native Windows/macOS account authentication is not yet verified; the legacy `scripts/worker` service installer remains Linux/WSL-only.

The architecture uses a Python/FastAPI process plus an authenticated Cloudflare Tunnel route. Codex must help configure your own route, matching Site/worker secrets, callback access, and Codex login. Generate fresh installation credentials securely and preserve them across retries. Do not reuse the author's credentials or copy Codex auth between users.

Relevant setting names are listed in `.env.example`; Site-side settings include the worker URL, proxy/callback secrets, and Cloudflare Access client settings. This is a configuration inventory, not a substitute for verified provisioning instructions.

The worker should retrieve cloud candidate context for each operation and return user-visible results to D1/R2. Local SQLite and output files are disposable scratch or audit diagnostics.

Acceptance checks: worker online, first real analysis completes, result survives worker shutdown, dashboard still works when offline, and retry works after reconnect. Do not claim an offline execution queue exists.

## Optional SerpAPI

Skip this entire section unless the user wants integrated search. Set `SERPAPI_API_KEY` only in the new Site's server-side environment using supported secret tooling, then deploy the configuration. Never expose it in the browser or require it for a worker.

Review query/request estimates before a live search. Without a key, **Add / search** explains the optional integration and leaves manual job creation available. **Setup** also offers selected-link ingestion. Missing SerpAPI does not mean tracker setup failed.

## Updates and troubleshooting

- **Repository access denied:** obtain access from its owner before cloning; the public demo is available separately.
- **Sites unavailable:** enable/connect the Sites plugin if your account supports it. Do not silently replace cloud storage with local SQLite.
- **Blank tracker after deployment:** inspect migrations and `/api/setup`; confirm `DB` and `BUCKET` bindings before changing the UI.
- **Browser works, ingestion returns 401/403:** browser login and service authorization are separate. Repair the private Site API credential, not the job payload.
- **Tracker works, Codex is offline:** connect the optional worker or keep using saved data; no offline AI work is queued.
- **Resume/context missing:** save a profile in Setup before trying analysis. An empty template is deliberate.
- **Update an existing installation:** pull reviewed changes, reuse the Site identity/storage/secrets, follow the Sites source workflow, apply migrations, and verify a saved job remains. Do not create a replacement Site as a shortcut.

For a friend trial, record the OS, time to the first saved job, sign-in steps that needed help, and errors with secrets removed. Complete a second-device check before calling cloud tracking ready.

## Developer checks

Install the Node version supported by package.json's dependencies (the existing tests use `node:sqlite`) and Python 3.11 or later in an isolated environment. In WSL development, the current commands are:

```sh
npm ci
npm run build
node --test tests/*.test.mjs
uv run --with-requirements requirements.txt pytest tests -q
```

Run mock tests without production credentials. A passing build and mocked regression tests do not establish real deployment, native platform support, or successful user authentication.
