# Tracker-first release plan

## Progress on October 4, 2026

- Live: public fictional-data dashboard demo, editable sample jobs/networking, research and packet examples, mobile preview, and hosted setup preview. See DEMO.md.
- Implemented in the private application source: hosted Setup, cloud resume/background/preferences, capability checks, tracker empty state, optional search UI.
- Implemented: editable-install CLI and portable foreground worker; platform temp paths and no cross-user auth borrowing. WSL regression suite and six Windows portability unit tests pass.
- Documented: agent-guided tracker provisioning, native commands, authentication boundaries, selected-link ingestion, troubleshooting, screenshots, architecture and sequence diagrams.
- Still requires real account/device evidence: fresh owner-private deployment and second-device tracking, native Windows/macOS Codex/tunnel end-to-end checks, and friend trials.
- Dependency follow-up: high-severity findings removed through compatible Cloudflare tooling upgrades; four moderate development-tool findings remain. GitHub stays private.

## Agreed product direction

Audience: MBA classmates and friends with ChatGPT subscriptions who can ask Codex to help them set up an application. Their first result must be a private, Sites-hosted job tracker usable from a phone. A worker, resume, and SerpAPI are not prerequisites for that result.

Every user owns their private Site, D1/R2 data, candidate profile, and optional worker. The public Sites demo is a separate fictional-data experience. This release is not a shared multi-tenant SaaS service.

Normal workflow: scheduled ChatGPT discovery or ordinary browsing, deliberate human selection, Codex/API ingestion, optional analysis, decisions and tracking. Do not automatically fill a dashboard with all discovered roles.

## Phase 1: clean private repository

- [x] Start fresh Git history and copy tracked application source only.
- [x] Remove personal context, live Site identity, installation URLs, and the private database-import surface.
- [x] Replace personal prompt/UI/mock references with generic language or synthetic examples.
- [x] Remove the personal-data cleanup migration and historical backfill; retain schema-only initialization.
- [x] Record architecture, workflow, release scope, and honest readiness labels.
- [x] Pass the initial build and regression checks (see VALIDATION.md).
- [ ] Resolve dependency audit findings and complete independent privacy review before public release.

GitHub stays private until the owner requests publication. A demo deployment does not change repository visibility.

## Phase 2: public Sites demo

Use the shared dashboard components and a clearly separated demo data adapter. Create a new Site and fictional candidate/jobs, decisions, analysis evidence, sponsorship uncertainty, company research, networking contacts, and packet examples. Do not copy production records or call a private worker.

Open directly in the Jobs dashboard and link to GitHub for the project story and setup guide. Let visitors inspect jobs, change local sample decisions, preview research/packets, try a sample ingestion, and reset. Explain that generated results are prepared samples. Do not accept real resumes or execute live AI/search in the demo.

Acceptance: anonymous desktop/mobile visitor understands the app without installing anything; state is isolated per visitor; browser/network inspection finds no private endpoints or credentials; every action is honest about sample behavior.

## Phase 3: private tracker provisioning and hosted onboarding

Build a resumable, agent-guided Sites provisioning contract. Detect existing installation state, register exactly once when needed, configure storage, initialize schema, build, deploy privately, and return the new dashboard URL. Check actual Sites availability in the user's account rather than assuming a subscription guarantees it.

Add hosted setup and empty states. Tracker/storage ready is the first milestone. Independent next steps: add a job, personalize, connect Codex ingestion, connect AI worker, optionally add SerpAPI. No worker/key/profile requirement may block basic tracking.

Add capability/status APIs returning booleans and actionable errors, never credentials. Move all durable candidate context into cloud-owned storage and pass a consistent version to workers. Require review of extracted personal facts and do not invent missing details.

Acceptance: a fresh owner-private Site saves and edits a job, survives refresh, and shows the same record on the user's phone without a local process. Unauthorized requests cannot read or write data. Re-running provisioning reuses the installation.

## Phase 4: agent ingestion

Provide a stable cross-platform CLI entry point, a versioned JSON contract, structured results/errors, and a concise agent guide linked from AGENTS.md. Preserve deduplication, complete descriptions, separate user decisions, and asynchronous analysis acceptance reporting.

Document inaccessible links, pasted-description fallback, correcting an existing job, and selected-link batches. Authenticate only to the user's own Site. Ingestion never requires the persistent worker, SerpAPI, or a local database as source of truth.

Acceptance: selected links become cloud jobs; missing listing content is requested rather than fabricated; duplicate ingestion does not create extra records; offline workers do not prevent saving or imply later queued execution.

## Phase 5: optional native Windows/macOS worker

Replace the mandatory Bash/systemd lifecycle with a portable Python control layer and thin platform launchers. Provide setup, start, stop, status, and doctor commands with structured output. Preserve optional WSL/Linux support and make autostart optional.

Fix Unix-only temp paths, auth fallback assumptions, executable resolution, virtual-environment layout, local data/config locations, process cleanup, and reconnect behavior. Configure each user's authenticated tunnel route and matching secrets without printing them. Separate Codex sign-in from Site service access and tunnel authentication.

Acceptance: fresh native Windows and macOS installations each run a real Codex analysis and persist results to cloud storage. Test paths with spaces, expired login, sleep/restart, disconnects, callback recovery, and no-worker controls. Mocked CI is not evidence of real authentication or native end-to-end success.

## Phase 6: optional SerpAPI and personalization UX

Skip SerpAPI entirely in default setup. Show an optional integration state, retain selected-link ingestion as the primary onboarding path, and explain server-side search credentials and request estimates. Search remains cloud-executed and available with the worker off when configured.

Verify that omitting/removing its key never breaks tracking, ingestion, analysis, research, or packets. Make generic lanes/preferences editable as appropriate without requiring personal information in tracked files.

## Phase 7: friend trials and portfolio finish

Run the setup with one Windows friend and one Mac friend. Record completion, time to first saved job, time to first useful analysis, errors, and assistance needed. Improve the flow based on observed friction.

Finish the casual README, screenshots, guided demo, architecture explanation, cost/prerequisite inventory, troubleshooting, updates, and a short case study. Do not claim time savings, retention, accuracy, or paid adoption without evidence. Explain that research has had less personal use than tracking/evaluation.

## Release gates

1. Privacy review covers source, fresh history, configs, fixtures, build output, Site metadata, and screenshots.
2. New private tracker works before any worker or API key is configured.
3. Personalization is cloud-owned and does not leak across installations.
4. Native Windows and macOS paths have real evidence or are explicitly labeled unverified.
5. Demo uses only synthetic data and does not perform hidden live work.
6. Missing/expired authentication is explained and setup can resume.
7. Core Python/Node tests, TypeScript build, mobile/browser checks, and fresh schema initialization pass.
8. User explicitly requests GitHub public visibility before changing it.

## Deliberately outside the first release

Shared multi-user hosting, billing, automatic applications, automatic ingestion of every discovered job, a new orchestration framework, and a guarantee that every ChatGPT account has identical Sites/Codex access. Preserve a small, useful personal application.
