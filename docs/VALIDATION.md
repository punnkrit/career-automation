# Validation record

## Fresh repository — October 4, 2026

Created this repository from the reviewed current source files with a single new initial commit and GitHub noreply attribution. No previous Git history, deleted files, local credentials, or deployment state were imported. The demo source link, setup prompt, and setup screenshot point to this repository.

The private application and demo builds pass, as do all 47 Node tests. The earlier Python and native portability results below apply to the same unchanged Python source. Real account/device acceptance work remains outstanding.

## Repository cleanup — October 4, 2026

Traced imports, prompt builders, script references, and the hosted profile flow. Removed four inherited candidate templates (`master_story.md`, facts, evidence bank, answer bank) and their fallback reads. Candidate background and preferences now come from the operation's cloud profile, with each included once in analysis, packet, and role-research prompts. Missing background remains empty; sensitive answers still require explicitly approved text.

Also removed three undocumented workstation setup helpers, an unused cross-user auth lookup, two unused Python helpers, unused imports, duplicate demo packet text, and an obsolete migration-secret example. Replaced residual original-resume details in Python mocks with fictional exercises. This repository was subsequently created from the reviewed current files with a new initial commit. Prior repository history and deleted files were not imported.

Kept the shared Python engine and scratch database, prompt/schema files, generic configuration, optional Linux service helpers, requirements, and lockfiles because they serve current execution, development, or documented setup paths. Updated the Python lockfile's root package from virtual to editable to match the existing package configuration; dependency versions are unchanged.

- WSL Python: **148 passed**, including profile isolation and prompt-context regressions.
- Node: **47 passed**.
- Windows portability unit tests: **6 passed**; real native authentication remains unverified.
- TypeScript unused-local/parameter check, private app build, and static demo build: passed.
- Python lockfile freshness check: passed.
- Rebuilt static demo is byte-for-byte identical to the previous deployment output; no demo deployment was needed.

## Demo and onboarding milestone — October 4, 2026

- Private application TypeScript/Vite production build: passed.
- Static demo TypeScript/Vite build: passed; no application Worker or D1/R2 bindings are included in the deployed archive.
- Node suite: **47 passed**, including cloud-profile round trips, active-version selection, malformed/oversized input, failed-storage preservation, and demo CRUD with network calls forbidden.
- Python suite in WSL: **146 passed**, including scoped cloud context and portable worker process cleanup.
- Native Windows Python: **6 portability tests passed** from a checkout path accessed through UNC. These exercise temp paths, token handling, context isolation, and mocked child-process cleanup; they do not prove a real Codex/tunnel connection.
- Browser checks: landing page, job detail, decision update, networking milestone, company report, setup preview, desktop layout, and 390px mobile layout. Actual screenshots are in `docs/images/`.
- Published demo checks: landing page, adding a fictional job, resetting samples, and direct `/research/northstar` navigation passed.
- Reviewed tracked/untracked source for original installation URLs, account identifiers, home paths, Site IDs, and common key signatures: no matches in the release candidates. The Site identity and credential-handling checkout stay in ignored local build state.
- GitHub remains private. The original personal application was not changed.

Remaining acceptance work: a fresh owner-private installation with second-device tracking, real Windows/macOS Codex authentication and tunnel operation, and friend trials. Hosted profile behavior has database/storage tests and builds, but has not yet been exercised in a newly provisioned private Site. Do not describe these as completed.

## Dependency audit

Compatible Cloudflare tooling updates removed the high-severity findings: `@cloudflare/vite-plugin` 1.62.5, `wrangler` 4.147.0, and matching Workers types. Both production builds and the Node suite pass with that lockfile.

`npm audit --omit=dev` reports **zero findings**. The complete development dependency tree has **four moderate findings** in the Drizzle/esbuild tooling chain. The suggested forced fix is a breaking Drizzle downgrade, so it was not applied. Resolve this tooling dependency before the public repository release.

## Initial foundation

Checked in WSL on 2026-10-04, after copying and sanitizing the application into a new repository:

- TypeScript and Vite production build: passed.
- Node regression suite: 41 passed.
- Python regression suite: 140 passed, using mock Codex behavior and the existing development Python environment.
- Fresh schema application is exercised by the Node operation-lifecycle tests; the private-record deletion migration is excluded.
- A local build creates a binding-only ignored hosting manifest when absent. It does not register a Site, invent an ID, or overwrite an existing manifest.

These checks do not establish native Windows/macOS support, new-user authentication, real analysis, hosted onboarding, a deployed demo, or complete public-release privacy review.

The inherited baseline had nine dependency findings (five high, four moderate); the current status is recorded above. This verification record is not a claim of production hardening.
