# Programmatic job ingestion

This is the authoritative guide for adding a manually sourced job through Codex, the CLI, or the HTTP API. D1 on the private Site is the source of truth; the CLI uses that same API whenever `CAREER_SITE_URL` is configured. Do not write directly to the workstation SQLite database.

For PC/laptop prerequisites, secrets, tunnel setup, and lifecycle commands, see [Workstation worker setup](WORKSTATION_WORKER.md). A worker is not required for ingestion itself; it is required only if an AI analysis is accepted at the same time.

## Windows and macOS commands

After installing this repository with `python -m pip install -e .` in a virtual environment, use `career` or `python -m career_workflow.cli` wherever this guide shows `scripts/career`. The Bash wrapper is optional. Configure `CAREER_SITE_URL` and trusted Site access before ingestion; do not proceed with a missing Site URL or silently use a local database.

For example, with a UTF-8 payload file:

```sh
python -m career_workflow.cli ingest-job --json selected-job.json --no-analyze
```

Delete temporary payload files containing personal notes when no longer needed, and keep them outside tracked source. For everyday selected-link ingestion, an authenticated Codex session can prepare the JSON and use stdin instead.

## Standing user preferences for pasted job links

These preferences apply to Codex-assisted ingestion unless the user says otherwise. The CLI defaults to asynchronous analysis when `analyze` is omitted; the HTTP API remains opt-in.

- Treat a message containing one or more job links as a request to ingest every linked job and request analysis. No repeated confirmation is needed. Retrieve the complete description, capture the exact compensation when the posting provides it, use `analyze: false` with `--queue-analysis`, and report whether an online worker accepted analysis without waiting for the result.
- Begin every saved `description` with exactly these two lines, followed by a blank line and the complete posting. Keep the structured `title` and `company` fields too:

  ```text
  Job Title: <exact listing title>
  Company: <listed company>
  ```
- Preserve compensation in the saved `description`, preferably in a clearly labeled `Compensation:` section. Capture base salary or range, OTE, bonus, equity, and other stated cash-compensation details verbatim; never infer or calculate missing compensation. Mention the captured compensation in the confirmation when available, or say it was not listed.
- Remove tracking parameters before saving or returning a job URL. This includes all `utm_*` parameters (especially `utm_source=chatgpt.com`), `gh_src`, `trk`, and referral/source parameters such as `src=LinkedIn` when they only record attribution. Use the clean URL in the ingestion payload rather than relying solely on backend normalization.
- Prefer the employer's direct, canonical job-detail URL when it can be matched confidently to a LinkedIn or aggregator listing. Preserve the exact role and location variant.
- Save the substantive posting, not navigation, related-job cards, saved-job controls, or accessibility announcements. Do not invent a `Listing status:` line from flattened page text. Uber's Save job toggle includes a screen-reader-only `Job removed` message for removal from saved jobs; this is not a vacancy closure notice. If closure wording conflicts with an Apply link, inspect the matching official ATS application page before reporting the role unavailable. A failed fetch or sign-in requirement alone does not establish closure.
- Do not blindly drop every query parameter. Preserve parameters needed to identify or open the intended job, such as `ashby_jid` or `gh_jid` when the job ID is not already in the path. Remove presentation or board-filter parameters such as `embed`, `departmentId`, or `locationId` only when a verified canonical URL still identifies the same listing and location variant.
- Keep the confirmation concise: role/company, new versus existing record, saved Decision, job ID, and whether analysis was accepted. For several jobs, use a compact table. Mention unavailable postings or unaccepted analysis explicitly.

For example, save `https://jobs.ashbyhq.com/example/JOB_ID?utm_source=chatgpt.com` as `https://jobs.ashbyhq.com/example/JOB_ID`.

## Recommended Codex workflow

Paste the complete job description and apply link into a Codex task. You can also specify the lane, initial Decision, and whether analysis should be dispatched to a worker that is online now.

For example:

> Add this job as AI product, mark it ready to apply, and dispatch analysis if a worker is online.

Codex should:

1. Extract the title, company, location, apply URL, complete description, and exact stated compensation without inventing missing facts. Start the saved description with `Job Title: <exact listing title>` and `Company: <listed company>`, then a blank line and the complete posting. Preserve compensation in the saved description under a `Compensation:` label.
2. Choose a configured lane, or use `other` when none fits safely.
3. Preserve the requested initial Decision. If none is supplied, use `needs_review` for a job the user appears interested in applying to.
4. Request asynchronous analysis by default: use `analyze: false` with `--queue-analysis` so an online worker can accept it without waiting. If the user explicitly says to skip analysis, pass `--no-analyze` instead.
5. Send one JSON object through `scripts/career ingest-job --json -`, adding `--queue-analysis` by default or `--no-analyze` when explicitly requested.
6. Report the job id, whether the record was newly created, the saved Decision, and whether analysis was accepted. Do not wait for or poll AI Rec and Fit.

Only use synchronous `analyze: true` or `--analyze` when the user explicitly asks Codex to return the analysis result in the same task. Ask a question only when a required value cannot be inferred safely. Do not run optional environment, path, dependency, or dashboard health checks before ingestion. Never fabricate title, company, location, or job-description content.

## Canonical JSON contract

Use this shape for CLI ingestion:

```json
{
  "title": "Senior AI Product Manager",
  "company": "Example Company",
  "location": "Seattle, WA",
  "url": "https://example.com/jobs/123",
  "description": "Job Title: Senior AI Product Manager\nCompany: Example Company\n\nComplete, unabridged job description…",
  "lane": "ai_product",
  "status": "needs_review",
  "analyze": false
}
```

| Field | CLI requirement | API requirement | Meaning |
| --- | --- | --- | --- |
| `title` | Recommended; defaults to `Untitled role` | Optional; same default | Exact role title from the listing |
| `company` | Recommended; defaults to `Unknown company` | Optional; same default | Employer named by the listing |
| `location` | Optional; defaults to an empty string | Optional; same default | Listing location, including `Remote` when stated |
| `url` | Optional; defaults to `null` | Optional; same default | Direct apply or job-detail URL |
| `description` | Required and nonblank | Required and nonblank | Complete pasted job description |
| `lane` | Required unless `lane_hint` is used | Not accepted | User-selected search lane |
| `lane_hint` | Accepted as an alias for `lane` | Required | API name for the user-selected lane |
| `status` | Optional; defaults to `needs_review` | Optional; same default | Initial user-controlled Decision |
| `analyze` | Optional boolean; omission requests async analysis | Optional boolean; defaults to `false` | With the CLI, run AI Rec and Fit synchronously; with the API, request live asynchronous dispatch |

The dashboard applies stricter client-side requirements: title, company, description, and lane must be present before its submit button is enabled.

Compensation is not a separate job-record field in the current ingestion schema. When available, include it in the complete `description` under a `Compensation:` label so it is preserved with the posting. If the listing does not state compensation, do not add a placeholder or estimate.

### Valid lanes

The source of truth is [`config/lanes.yaml`](../config/lanes.yaml). The currently accepted ids are:

| Id | Label |
| --- | --- |
| `ai_solutions` | AI Solutions / AI Implementation |
| `product_ops` | Product Operations / Product Strategy / Product Analytics |
| `bizops` | Strategy & Operations / BizOps |
| `tpm_epm` | TPM / EPM / AI Program Manager |
| `ai_product` | AI Product Manager / Product Manager |
| `pmm_gtm_ai` | PMM / GTM AI |
| `other` | None of the configured lanes |

An unknown or blank lane is rejected.

### Valid initial Decisions

| Value | Dashboard label | Use when |
| --- | --- | --- |
| `new` | No decision yet | The job is being saved without an application decision |
| `needs_review` | Needs review | The job should be reviewed before applying; this is the default |
| `ready_to_apply` | Ready to apply | The user has already decided to prepare or submit an application |
| `applied` | Applied | The application has already been submitted |
| `skipped` | Skipped | The user has decided not to apply |

The job's Decision is stored separately from the model's recommendation. Analysis populates **AI Rec** and **Fit**, but does not overwrite the user-controlled Decision.

## CLI usage

Run CLI commands from the repository root in WSL2.

### JSON through stdin

This is the preferred path for Codex and other programmatic callers because it does not require a durable intermediate file:

```bash
scripts/career ingest-job --json - --queue-analysis <<'JSON'
{
  "title": "Senior AI Product Manager",
  "company": "Example Company",
  "location": "Seattle, WA",
  "url": "https://example.com/jobs/123",
  "description": "Job Title: Senior AI Product Manager\nCompany: Example Company\n\nComplete, unabridged job description…",
  "lane": "ai_product",
  "status": "ready_to_apply",
  "analyze": false
}
JSON
```

By default, omitting JSON `analyze` requests asynchronous analysis. Explicit JSON `analyze: false` skips analysis, while `analyze: true` requests synchronous analysis. `--no-analyze` skips analysis regardless of the JSON value. For Codex ingestion, use `analyze: false` with `--queue-analysis` to explicitly select asynchronous dispatch.

`--queue-analysis` asks the currently online workstation worker to accept analysis and returns immediately. It does not create an offline queue. The dashboard displays progress and the result; when the workstation is unavailable, the job still remains saved in D1 and `analysis_created` is false.

When JSON `analyze` is `true` or `--analyze` is passed without `--queue-analysis`, the CLI instead runs analysis synchronously. The command does not finish until analysis succeeds or fails, and the returned JSON includes a top-level `analysis` object containing fields such as `decision` (AI Rec), `fit_tier`, `sponsorship_tier`, `lane`, and `confidence`. Reserve this mode for explicit requests to return analysis in the same task.

### JSON file

```bash
scripts/career ingest-job --json /path/to/job.json
```

The JSON file uses the canonical contract above.

### Markdown or plain-text file

The legacy file path remains supported:

```text
Title: Senior AI Product Manager
Company: Example Company
Location: Seattle, WA
URL: https://example.com/jobs/123

Job Title: Senior AI Product Manager
Company: Example Company

Complete job description starts here…
```

```bash
scripts/career ingest-job \
  --file /path/to/job.md \
  --lane ai_product \
  --status needs_review \
  --queue-analysis
```

The four case-insensitive metadata header lines are removed from the saved description. Keep `Job Title: <exact listing title>` and `Company: <listed company>` as the first two lines of the remaining description, followed by a blank line and the full posting; all other file content becomes the description. For file input, `--lane` is required. `--status` defaults to `needs_review`; analysis defaults to asynchronous dispatch.

CLI flags `--title`, `--company`, `--location`, `--url`, `--lane`, and `--status` override values parsed from the selected input. Pass `--queue-analysis` for the fast asynchronous path. Pass `--analyze` only for synchronous analysis. `--analyze`, `--queue-analysis`, and `--no-analyze` are mutually exclusive; `--queue-analysis` also overrides a JSON `analyze: true` value to avoid an accidental wait.

## HTTP API usage

Send `POST /api/jobs/ingest` to the private Site. The HTTP request uses `lane_hint`, not `lane`.

```bash
curl --fail-with-body \
  --request POST \
  --url "$CAREER_SITE_URL/api/jobs/ingest" \
  --header 'Content-Type: application/json' \
  --header "OAI-Sites-Authorization: Bearer $CAREER_SITE_BYPASS_TOKEN" \
  --data '{
    "title": "Senior AI Product Manager",
    "company": "Example Company",
    "location": "Seattle, WA",
    "url": "https://example.com/jobs/123",
    "description": "Job Title: Senior AI Product Manager\nCompany: Example Company\n\nComplete, unabridged job description…",
    "lane_hint": "ai_product",
    "status": "needs_review",
    "analyze": true
  }'
```

The bypass token is for trusted non-browser clients of this owner-private Site. Keep it only in the ignored local `.env`; do not print or commit it. Browser access continues to use Sign in with ChatGPT.

### API response

The response has this abbreviated shape:

```jsonc
{
  "job_id": "example-company-senior-ai-product-manager-seattle-wa-a1b2c3d4",
  "created": true,
  "job": {
    "status": "needs_review",
    "lane_hint": "ai_product",
    "analysis": null
  },
  "analysis_operation": {
    "operation_id": "00000000-0000-0000-0000-000000000000",
    "operation_type": "analyze_job",
    "status": "running",
    "payload": {
      "job_id": "example-company-senior-ai-product-manager-seattle-wa-a1b2c3d4"
    }
  },
  "analysis_created": true
}
```

`job` contains the full public job record. The other fields mean:

- `created: true` — a new job row was inserted.
- `created: false` — the request matched an existing job; see deduplication below.
- `analysis_operation: null` — analysis was not requested.
- `analysis_created: true` — the online workstation accepted a new analysis operation.
- `analysis_created: false` with a non-null operation — an active operation already existed and was reused.
- `analysis_operation: null` with `analysis_created: false` — D1 saved the job, but no workstation worker accepted analysis.

API analysis is asynchronous. It requires the workstation cloud worker endpoint to be online. Poll the returned operation, then reload the job:

```bash
curl --fail-with-body \
  --header "OAI-Sites-Authorization: Bearer $CAREER_SITE_BYPASS_TOKEN" \
  "$CAREER_SITE_URL/api/operations/OPERATION_ID"

curl --fail-with-body \
  --header "OAI-Sites-Authorization: Bearer $CAREER_SITE_BYPASS_TOKEN" \
  "$CAREER_SITE_URL/api/jobs/JOB_ID"
```

Operation status is one of `starting`, `queued` (legacy), `running`, `succeeded`, `failed`, or `interrupted`. After success, `job.analysis.decision` is the AI Rec and `job.analysis.fit_tier` is the Fit shown in the dashboard.

## Normalization, persistence, and deduplication

Every programmatic path calls the same Site ingestion function and stores the job in D1 with:

- `source: manual`
- the selected value in `lane_hint`
- the selected Decision in `status`
- a cleaned URL with common tracking parameters removed, including `utm_*`, `gh_src`, `ref`, `referrer`, `source`, and `trk`
- `source_tier: manual` and a preferred source status

The exact-listing deduplication key is built from lowercased, trimmed `title`, `company`, `location`, and cleaned `url`. When that key already exists:

- the existing `job_id` is returned;
- `created` is `false`;
- the explicit lane and Decision from the new request are applied to the existing record;
- title, company, location, URL, and description are not replaced by the duplicate-ingest path.

This exact-listing deduplication is separate from opportunity grouping, which can group related listings or location variants while preserving individual job rows.

## Validation and failures

The ingestion layer rejects:

- a blank description;
- a blank or unknown lane;
- a Decision outside the supported initial values;
- a non-boolean JSON `analyze` value in the CLI;
- malformed JSON or a JSON value that is not an object.

CLI validation failures exit nonzero and print a diagnostic. The API returns:

- `401` or the Site sign-in response when a trusted client omits valid private-Site authorization;
- `422` when required request fields are missing or have incompatible types;
- `400` for domain validation errors;
- `503` from direct AI-dispatch endpoints when no worker is reachable; and
- `409` from direct AI-dispatch endpoints when the worker is at capacity.

`POST /api/jobs/ingest` treats requested analysis as optional: if the job is saved but no worker accepts the dispatch, the response still returns the saved job with `analysis_operation: null` and `analysis_created: false`. Start a worker and retry with `POST /api/jobs/{job_id}/analyze` rather than ingesting an altered duplicate.

## Operational checklist

Before live ingestion with analysis:

1. Set `CAREER_SITE_URL` and `CAREER_SITE_BYPASS_TOKEN` in the ignored workstation `.env`.
2. Confirm Codex headless authentication in WSL with `codex login --device-auth`.
3. Keep `CAREER_MOCK_CODEX=0` for live analysis; use `1` only for tests.
4. Keep `CAREER_DISABLE_OPERATION_WORKER=1`; Site requests are accepted by the immediate cloud worker and are not replayed from the old SQLite queue.
5. Never include credentials, application answers, or unrelated private material in the job description.

## Implementation references

- CLI entrypoint: [`career_workflow/cli.py`](../career_workflow/cli.py)
- Trusted Site client: [`career_workflow/site_api.py`](../career_workflow/site_api.py)
- Site HTTP endpoint: [`worker/index.ts`](../worker/index.ts)
- D1 persistence and deduplication: [`worker/store.ts`](../worker/store.ts)
- Lane definitions: [`config/lanes.yaml`](../config/lanes.yaml)
- Analysis logic: [`career_workflow/analysis.py`](../career_workflow/analysis.py)
