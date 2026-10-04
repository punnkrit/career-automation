# CareerAutomation Starter

This repository is the reusable edition of a personal job-search application. Read README.md and docs/RELEASE_PLAN.md before changing its architecture or describing release readiness.

## Product contract

- Deliver a private, Sites-hosted job tracker first. The browser must support adding jobs, decisions, application tracking, and networking without a local worker, resume, OpenAI API key, or SerpAPI key.
- Hosted onboarding belongs inside that private dashboard. Provisioning the user's Site is a separate Codex-guided step.
- D1 owns structured application state; R2 owns documents and candidate context. Local files and SQLite are scratch/diagnostics only.
- Codex ingestion uses the private Site API. Read docs/PROGRAMMATIC_JOB_INGESTION.md; preserve explicit user selection rather than auto-importing every discovered job.
- A reachable optional Python/FastAPI worker performs ChatGPT-authenticated Codex analysis, research, and packet/report tasks. No offline AI queue.
- SerpAPI is strictly optional, server-side, and never a prerequisite for tracker or analysis setup.
- Target native Windows and macOS; keep WSL/Linux optional. Do not claim native support until tested.
- The public demo must use fictional fixtures, clearly labeled sample analyses, and isolated visitor state. It must never call a private installation's API or worker.

## Setup and privacy

- This is currently a private preparation repository, not a verified friend-ready release. Preserve honest readiness labels.
- Never reuse another installation's Site project ID, URLs, tokens, tunnel, storage, or candidate context. Each installation owns its resources.
- .openai/hosting.template.json contains binding defaults only. Create a fresh ignored .openai/hosting.json after the Sites tool returns the new ID. GitHub and the Site source repository are separate deployment destinations; verify both before pushing.
- Never print, commit, or embed secrets in commands, screenshots, generated reports, browser bundles, or agent prompts. Local .env files are ignored.
- Do not write a candidate's personal facts into tracked templates. Public fixture data must be explicitly fictional.
- Setup must be resumable and idempotent. Check existing resources before creating or rotating anything; report missing authentication clearly.
- Development may run in WSL. User-facing setup must not require it once native support is implemented.

## Verification

Use the existing Python and Node regression suites and the TypeScript/Vite build. Test meaningful changed behavior; do not claim that mocked tests prove native Codex authentication or cross-platform deployment.

Before the first public release, complete the privacy review, real fresh-install checks, and release gates in docs/RELEASE_PLAN.md. Do not publish the repository merely because a demo is published.
