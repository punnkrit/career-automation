from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import ensure_runtime_dirs


VALID_CODEX_REASONING_EFFORTS = {"minimal", "low", "medium", "high", "xhigh"}
DEFAULT_CODEX_MODEL = "gpt-5.6-sol"
DEFAULT_CODEX_REASONING_EFFORT = "high"


@dataclass
class CodexRunResult:
    prompt_path: Path
    output_path: Path
    text: str
    status: str
    error: str = ""


def run_codex(
    prompt: str,
    run_type: str,
    job_id: str | None = None,
    output_schema: Path | None = None,
    web_search: bool = False,
    input_images: list[Path] | None = None,
) -> CodexRunResult:
    paths = ensure_runtime_dirs()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    run_dir = paths.runs_dir / f"{stamp}-{run_type}-{job_id or 'general'}"
    run_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = run_dir / "prompt.md"
    output_path = run_dir / "output.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    if os.environ.get("CAREER_MOCK_CODEX") == "1":
        text = mock_response(run_type, prompt)
        output_path.write_text(text, encoding="utf-8")
        return CodexRunResult(prompt_path, output_path, text, "success")
    command = os.environ.get("CODEX_COMMAND", "codex")
    args = codex_exec_args(command, paths.repo_root, output_path, web_search=web_search)
    if output_schema:
        args.extend(["--output-schema", str(output_schema)])
    for image_path in input_images or []:
        args.extend(["--image", str(image_path)])
    args.append("-")
    env = isolated_codex_env()
    try:
        subprocess.run(args, input=prompt, text=True, capture_output=True, timeout=900, check=True, env=env)
    except subprocess.CalledProcessError as exc:
        output = output_path.read_text(encoding="utf-8") if output_path.exists() and output_path.stat().st_size else (exc.stderr or exc.stdout or "")
        output_path.write_text(output, encoding="utf-8")
        return CodexRunResult(prompt_path, output_path, output, "failed", summarize_codex_error(output, exc.stderr or str(exc)))
    except Exception as exc:
        output_path.write_text(str(exc), encoding="utf-8")
        return CodexRunResult(prompt_path, output_path, str(exc), "failed", str(exc))
    text = output_path.read_text(encoding="utf-8") if output_path.exists() else ""
    return CodexRunResult(prompt_path, output_path, text, "success")


def codex_exec_args(command: str, repo_root: Path, output_path: Path | None = None, web_search: bool = False) -> list[str]:
    args = [command]
    if web_search:
        args.append("--search")
    args.extend(["exec", "--ephemeral", "--cd", str(repo_root)])
    model = os.environ.get("CODEX_MODEL", DEFAULT_CODEX_MODEL).strip()
    if model:
        args.extend(["--model", model])
    reasoning_effort = os.environ.get("CODEX_REASONING_EFFORT", DEFAULT_CODEX_REASONING_EFFORT).strip()
    if reasoning_effort:
        if reasoning_effort not in VALID_CODEX_REASONING_EFFORTS:
            valid = ", ".join(sorted(VALID_CODEX_REASONING_EFFORTS))
            raise ValueError(f"Invalid CODEX_REASONING_EFFORT={reasoning_effort!r}. Use one of: {valid}.")
        args.extend(["-c", f'model_reasoning_effort="{reasoning_effort}"'])
    if output_path:
        args.extend(["--output-last-message", str(output_path)])
    return args


def isolated_codex_env() -> dict[str, str]:
    """Keep Codex auth/config but detach child exec from this desktop thread.

    Codex Desktop injects thread and originator environment variables. If a
    backend-launched `codex exec` inherits them, it can try to reuse current
    thread attachments such as temporary clipboard images that no longer exist.
    """
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("CODEX_THREAD") or key.startswith("CODEX_INTERNAL"):
            env.pop(key, None)
    if "WSLENV" in env:
        env["WSLENV"] = ":".join(
            part
            for part in env["WSLENV"].split(":")
            if not part.startswith("CODEX_THREAD") and not part.startswith("CODEX_INTERNAL")
        )
    env["TEMP"] = tempfile.gettempdir()
    env["TMP"] = tempfile.gettempdir()
    command = os.environ.get("CODEX_COMMAND", "")
    if "/" in command or "\\" in command:
        command_dir = str(Path(command).expanduser().parent)
        env["PATH"] = f"{command_dir}{os.pathsep}{env.get('PATH', '')}"
    return env


def summarize_codex_error(output: str, fallback: str) -> str:
    lower = output.lower()
    if (
        "401 unauthorized" in lower
        or "missing bearer or basic authentication" in lower
        or "missing bearer" in lower
    ):
        return (
            "Codex headless auth is missing or expired on this computer. Run "
            "`codex login --device-auth` in the workstation project, then retry Analyze."
        )
    if "refresh token" in lower or "access token could not be refreshed" in lower or "provided authentication token is expired" in lower:
        return "Codex auth expired. Run `codex login` on this computer, then retry Analyze."
    if "invalid_json_schema" in lower:
        return "Codex rejected the output JSON schema. Update `schemas/decision_memo.schema.json` and retry."
    if "could not read the local image" in lower or "codex-clipboard" in lower:
        return "Codex inherited a stale Desktop clipboard attachment. Restart the API so the isolated headless environment patch is active, then retry."
    return fallback


def check_codex_status() -> dict[str, Any]:
    if os.environ.get("CAREER_MOCK_CODEX") == "1":
        return {"ok": True, "mode": "mock", "message": "CAREER_MOCK_CODEX=1"}
    command = os.environ.get("CODEX_COMMAND", "codex")
    env = isolated_codex_env()
    try:
        args = codex_exec_args(command, ensure_runtime_dirs().repo_root)
    except ValueError as exc:
        return {"ok": False, "mode": "live", "error": str(exc)}
    args.append("-")
    try:
        result = subprocess.run(
            args,
            input="Reply with exactly: OK",
            text=True,
            capture_output=True,
            timeout=120,
            check=True,
            env=env,
        )
    except subprocess.CalledProcessError as exc:
        output = "\n".join(part for part in (exc.stdout, exc.stderr) if part)
        return {
            "ok": False,
            "mode": "live",
            "error": summarize_codex_error(output, exc.stderr or str(exc)),
        }
    except Exception as exc:
        return {"ok": False, "mode": "live", "error": str(exc)}
    return {"ok": True, "mode": "live", "message": (result.stdout or "").strip()[-500:]}


def extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def mock_response(run_type: str, prompt: str) -> str:
    if run_type == "resolve_analyze":
        metadata_match = re.search(r"## Untrusted Job Metadata\s+(\{.*?\})\s+---", prompt, re.DOTALL)
        try:
            metadata = json.loads(metadata_match.group(1)) if metadata_match else {}
        except json.JSONDecodeError:
            metadata = {}
        company = str(metadata.get("company") or "Mock Company")
        title = str(metadata.get("title") or "Mock Role")
        location = str(metadata.get("location") or "")
        slug = re.sub(r"[^a-z0-9]+", "", company.lower()) or "example"
        description = " ".join(
            [
                "Mock authoritative job description covering product discovery, requirements, engineering collaboration, delivery, measurement, and stakeholder outcomes."
            ]
            * 8
        )
        return json.dumps(
            {
                "resolution": {
                    "status": "replaced",
                    "source_tier": "employer",
                    "confidence": "high",
                    "reason": "Mock mode selected a preferred employer listing.",
                    "evidence_urls": [f"https://careers.{slug}.com/mock-role"],
                    "resolved_job": {
                        "title": title,
                        "company": company,
                        "location": location,
                        "url": f"https://careers.{slug}.com/mock-role",
                        "description": description,
                    },
                },
                "decision_memo": {
                    "decision": "apply",
                    "fit_tier": "plausible",
                    "sponsorship_tier": "unknown",
                    "lane": "ai_solutions",
                    "resume_strategy": "ai_solutions",
                    "confidence": "medium",
                    "interview_chance_reasoning": "Mock resolved analysis: the role is directionally aligned.",
                    "why_apply": ["Mock: relevant product and workflow ownership."],
                    "risks": ["Mock mode was used; run live Codex for real judgment."],
                    "jd_evidence": ["Mock authoritative description."],
                    "profile_evidence": ["Example Media, Example Travel, and Example Automation experience."],
                    "recommended_next_step": "build_packet",
                },
            },
            indent=2,
        )
    if run_type == "analyze":
        lower = prompt.lower()
        blocked = any(term in lower for term in ("no sponsorship", "must be us citizen", "security clearance", "green card only"))
        memo = {
            "decision": "blocked" if blocked else "apply",
            "fit_tier": "plausible",
            "sponsorship_tier": "blocked_explicit" if blocked else "plausible",
            "lane": "ai_solutions",
            "resume_strategy": "ai_solutions",
            "confidence": "medium",
            "interview_chance_reasoning": "Mock analysis: role appears directionally aligned with AI/product/operations evidence.",
            "why_apply": ["Mock: relevant to AI workflow implementation and product operations."],
            "risks": ["Mock mode was used; run live Codex for real judgment."],
            "jd_evidence": ["Mock evidence placeholder."],
            "profile_evidence": ["Example Media/Example Travel analytics and Example Automation workflow automation."],
            "recommended_next_step": "skip" if blocked else "build_packet",
        }
        return json.dumps(memo, indent=2)
    if run_type == "build_packet":
        return """=== tailored_resume.md ===
# Alex Morgan

## Summary
Example University MBA candidate with Example Media, Example Travel, and Example Automation experience across analytics, product-quality systems, forecasting, and AI workflow automation.

## Selected Experience
- Fictional example: documented requirements for an internal request tracker.
- Fictional example: reviewed test cases for a sample support workflow.
- Fictional example: summarized a synthetic dataset for a practice project.

=== cover_letter.md ===
Dear Hiring Team,

I am interested in this role because it connects closely to my experience improving product-quality systems, operational workflows, and AI-enabled decision tools. At Example Media and Example Travel, I used analytics to improve search quality, recommendations, forecasting, and service planning. This is fictional test content and must not be submitted as an application.

I would welcome the opportunity to discuss how this background could support your team.

=== application_answers.md ===
# Application Answers

## Work Authorization
REQUIRES HUMAN REVIEW

## Why this role
This role appears aligned with my background in analytics, product operations, and AI workflow implementation.
"""
    if run_type == "company_research":
        match = re.search(r"^Company:\s*(.+)$", prompt, re.MULTILINE)
        company = match.group(1).strip() if match else "Company"
        slug = re.sub(r"[^a-z0-9]+", "", company.lower()) or "company"
        return json.dumps(
            {
                "schema_version": 3,
                "official_name": company,
                "website": f"https://www.{slug}.com",
                "careers_url": f"https://www.{slug}.com/careers",
                "industry": "",
                "headquarters": "",
                "size_and_stage": "Mock mode",
                "ownership": "Unknown in mock mode",
                "business_model": "Mock company research for interface testing",
                "executive_summary": "This is a structured mock company report for interface testing. Run live Codex to retrieve verified public information and citations.",
                "explainer": {
                    "plain_english": "This mock company sells workflow software. Live research explains the actual products and customer tasks.",
                    "source_urls": [f"https://www.{slug}.com"],
                    "products": [{"name": "Mock product", "does": "Organizes work", "user": "Operations teams", "example": "Tracks a request from intake to completion", "source_urls": [f"https://www.{slug}.com"]}],
                    "workflow": {"title": "A request from start to finish", "steps": [{"label": "Receive a request", "detail": "A user submits a task.", "provider": "Customer"}, {"label": "Organize the work", "detail": "The software routes the request.", "provider": company}, {"label": "Complete the task", "detail": "The team delivers the result.", "provider": "Customer"}], "caption": "Illustrative mock workflow; not an actual deployment.", "source_urls": [f"https://www.{slug}.com"]},
                    "customer_examples": [],
                    "media": [],
                },
                "sections": {
                    "products_and_services": [{"headline": "Primary offering", "detail": "Mock product detail.", "as_of": "", "confidence": "unknown", "evidence_type": "unknown", "source_urls": [f"https://www.{slug}.com"]}],
                    "customers_and_use_cases": [],
                    "traction_and_strategy": [],
                    "market_and_competitors": [],
                    "recent_developments": [],
                    "culture_and_hiring": [],
                    "risks_and_unknowns": [{"headline": "Mock data", "detail": "Run live Codex before using this report for a decision.", "as_of": "", "confidence": "unknown", "evidence_type": "unknown", "source_urls": []}],
                },
                "sources": [{"url": f"https://www.{slug}.com", "title": f"{company} website", "publisher": company, "published_at": ""}],
            },
            indent=2,
        )
    if run_type == "company_research_visuals":
        match = re.search(r"^Company:\s*(.+)$", prompt, re.MULTILINE)
        company = match.group(1).strip() if match else "Company"
        slug = re.sub(r"[^a-z0-9]+", "", company.lower()) or "company"
        url = f"https://www.{slug}.com"
        return json.dumps({
            "media": [],
            "sources": [{"url": url, "title": f"{company} website", "publisher": company, "published_at": ""}],
            "review": {
                "outcome": "sources_unavailable",
                "summary": "Mock mode does not browse or inspect images. Run live research for a visual review.",
                "pages_checked": [{"url": url, "status": "unavailable", "notes": "Mock mode: no network access attempted."}],
                "candidates": [],
            },
        })
    if run_type == "company_research_editorial":
        match = re.search(r"^Company:\s*(.+)$", prompt, re.MULTILINE)
        company = match.group(1).strip() if match else "Company"
        slug = re.sub(r"[^a-z0-9]+", "", company.lower()) or "company"
        source_url = f"https://www.{slug}.com"
        return json.dumps(
            {
                "schema_version": 2,
                "headline": f"Inside {company}'s business",
                "dek": "A concise company profile generated from the saved source-backed evidence.",
                "lede": f"{company} is presented here as a mock company profile for interface testing. Live research replaces this text with a sourced account of what the company sells, who buys it, and the forces shaping its position.",
                "executive_takeaways": [
                    {"label": f"What {company} is becoming", "detail": "A broader platform for repeatable, governed work."},
                    {"label": "Why customers buy it", "detail": "The product connects specialized tools into one operating workflow."},
                    {"label": "Where its advantage may come from", "detail": "Integrated workflow design and control may reduce adoption friction."},
                    {"label": "What remains uncertain", "detail": "Live research is required to test adoption, economics, and competitive durability."},
                ],
                "business_at_a_glance": {
                    "customer": "Enterprise organizations",
                    "buyer": "Business and technology leaders",
                    "problem": "Mock mode does not verify the core customer problem",
                    "product": "A source-backed description is generated in live mode",
                    "value": "Repeatable work rather than isolated assistance",
                    "growth_path": "Initial use case to broader team adoption",
                    "strategic_question": "Can the company prove durable value at scale?",
                },
                "sections": [
                    {
                        "heading": "From point solution to operating platform",
                        "paragraphs": ["The live editorial pass turns verified product, customer, and business-model evidence into a connected narrative instead of a list of findings."],
                        "source_urls": [source_url],
                    },
                    {
                        "heading": "How customers put the platform to work",
                        "paragraphs": ["Strategy and market evidence are synthesized with uncertainty intact, keeping unsupported claims out of the company profile."],
                        "source_urls": [source_url],
                    },
                    {
                        "heading": "The strategic challenge",
                        "paragraphs": ["Recent developments, hiring signals, and unresolved questions become a short forward-looking section when the evidence supports them."],
                        "source_urls": [source_url],
                    },
                ],
                "closing": "Run live Codex research to replace this mock narrative with current, source-backed reporting.",
            },
            indent=2,
        )
    if run_type == "role_research":
        title_match = re.search(r"^Role title:\s*(.+)$", prompt, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else "Role"
        return json.dumps(
            {
                "schema_version": 2,
                "role_thesis": f"{title} connects customer needs to a credible solution and earns confidence across business and technical stakeholders. Live research replaces this mock thesis with company- and JD-specific analysis.",
                "responsibilities": [
                    {"responsibility": "Conduct customer discovery", "detail": "Clarify business goals, users, systems, and constraints.", "stakeholders": [{"group": "Customer sponsor", "relationship": "Defines the business outcome."}], "source_urls": []},
                    {"responsibility": "Design the solution", "detail": "Translate requirements into a secure integrated approach.", "stakeholders": [{"group": "Customer technology team", "relationship": "Validates feasibility and controls."}], "source_urls": []},
                    {"responsibility": "Lead technical validation", "detail": "Use demonstrations and proofs of concept to test value.", "stakeholders": [{"group": "Evaluation team", "relationship": "Tests the proposed solution."}], "source_urls": []},
                    {"responsibility": "Align the account team", "detail": "Coordinate sales, product, engineering, and customer decisions.", "stakeholders": [{"group": "Account team", "relationship": "Owns commercial and technical progress."}], "source_urls": []},
                ],
                "success_outcomes": [
                    {"outcome": "Customer requirements are accurately understood", "basis": "Discovery produces a shared definition of the problem."},
                    {"outcome": "Proposed solutions are technically credible", "basis": "Architecture choices address stated constraints."},
                    {"outcome": "Technical validation demonstrates measurable value", "basis": "The evaluation tests agreed success criteria."},
                    {"outcome": "Evaluations progress toward production and purchase", "basis": "Business and technical stakeholders can make a confident decision."},
                ],
                "fit_thesis": "Candidate is an adjacent candidate whose strongest evidence combines customer discovery, AI evaluation, and quantitative operating systems; live research is needed to calibrate the principal role-specific gap.",
                "proof_points": [
                    {"label": "Fictional tracker project", "evidence": "Requirements gathering for a sample request tracker.", "role_connection": "Shows end-to-end ownership from need to deployed solution."},
                    {"label": "Example Media", "evidence": "Structured AI quality evaluation.", "role_connection": "Shows disciplined technical validation."},
                    {"label": "Example Travel", "evidence": "Quantitative problem solving and stakeholder communication.", "role_connection": "Shows analytical decision support in a complex organization."},
                ],
                "gaps": [
                    {"gap": "No established enterprise pre-sales tenure", "implication": "Must prove transferable discovery and customer-facing judgment."},
                    {"gap": "Limited repeated architecture ownership", "implication": "Must prepare concrete security, integration, and design reasoning."},
                ],
                "interview_preparation": [
                    {"theme": "Discovery", "likely_question": "How do you uncover the real customer problem?", "story_to_use": "Fictional tracker requirements exercise.", "question_to_ask": "How does this team define successful discovery?"},
                    {"theme": "Solution architecture", "likely_question": "How would you design around enterprise constraints?", "story_to_use": "Discuss the fictional tracker design and its constraints.", "question_to_ask": "Which architecture decisions most often determine evaluation success?"},
                    {"theme": "Proof-of-concept design", "likely_question": "How do you define and measure a useful proof of concept?", "story_to_use": "Example Media evaluation methodology.", "question_to_ask": "What separates a strong proof of concept from a stalled one here?"},
                    {"theme": "Enterprise governance", "likely_question": "How do you balance speed with control?", "story_to_use": "Use verified quality and operating-system controls from Example Media or Example Travel.", "question_to_ask": "Which governance concerns surface most often with customers?"},
                    {"theme": "Executive communication", "likely_question": "How do you explain a technical recommendation to senior stakeholders?", "story_to_use": "Example Travel forecasting and stakeholder communication.", "question_to_ask": "Who must be convinced for an evaluation to reach production?"},
                ],
                "networking_targets": [{"target": "Role-adjacent team member", "function": "Hiring function", "reason": "Can explain the team's operating context and priorities."}],
                "sources": [],
            },
            indent=2,
        )
    return "# Daily Report\n\nMock mode was used. Run live Codex for real prioritization.\n"
