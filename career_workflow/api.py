from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .codex_runner import check_codex_status
from .cloud_worker import cloud_execution_service
from .generation import application_artifacts
from .jobs import expand_location_filter, ingest_manual_job_payload, recover_abandoned_search_runs, search_metadata
from .logging_config import configure_logging
from .networking import add_contacts, delete_contact, get_networking_company, list_networking_companies, set_company_paused, update_contact
from .operations import operation_worker, queue_operation, queue_operations
from .paths import ensure_runtime_dirs
from .resume import init_profile
from .security import safe_error_message
from .tracker import connect, get_job, get_operation, list_days, list_jobs, list_operations, update_job, update_status


configure_logging()


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker_enabled = os.environ.get("CAREER_DISABLE_OPERATION_WORKER", "").strip().lower() not in {"1", "true", "yes"}
    cloud_execution_service.start()
    if worker_enabled:
        operation_worker.start()
    try:
        yield
    finally:
        cloud_execution_service.stop()
        if worker_enabled:
            operation_worker.stop()


app = FastAPI(title="CareerAutomation API", lifespan=lifespan)


@app.middleware("http")
async def require_proxy_secret(request: Request, call_next):
    expected = os.environ.get("CAREER_PROXY_SECRET", "")
    if expected and request.url.path.startswith("/api/"):
        provided = request.headers.get("x-career-proxy-secret", "")
        if not hmac.compare_digest(provided, expected):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5174", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class IngestJobRequest(BaseModel):
    title: str = "Untitled role"
    company: str = "Unknown company"
    location: str = ""
    url: str | None = None
    description: str
    lane_hint: str
    status: Literal["new", "needs_review", "ready_to_apply", "applied", "skipped"] = "needs_review"
    analyze: bool = False


class SearchRequest(BaseModel):
    lane: str | None = None
    lanes: list[str] | None = None
    location: str | None = None
    locations: list[str] | None = None
    metro_ids: list[str] | None = None
    limit: int = Field(default=20, ge=1, le=30)
    include_edge_check: bool = False


class FailedSearchRequest(BaseModel):
    lane: str
    query: str
    location: str
    location_source: str = "manual"
    page: int = 1
    next_page_token: str | None = None


class RetrySearchRequest(BaseModel):
    requests: list[FailedSearchRequest]
    limit: int = Field(default=20, ge=1, le=30)


class StatusRequest(BaseModel):
    status: str


class UpdateJobRequest(BaseModel):
    location: str | None = None
    url: str | None = None
    description: str | None = None


class AnalyzeJobsRequest(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=200)


class DailyReportRequest(BaseModel):
    date: str | None = None


class NetworkingContactInput(BaseModel):
    name: str
    linkedin_url: str = ""


class AddNetworkingContactsRequest(BaseModel):
    display_name: str
    contacts: list[NetworkingContactInput]


class UpdateNetworkingContactRequest(BaseModel):
    name: str | None = None
    linkedin_url: str | None = None
    request_accepted: bool | None = None
    responded: bool | None = None
    coffee_chat: bool | None = None
    referral: bool | None = None


class NetworkingPauseRequest(BaseModel):
    display_name: str
    paused: bool


NETWORKING_RESEARCH_PREVIEW_FIELDS = {
    "schema_version",
    "official_name",
    "website",
    "careers_url",
    "industry",
    "headquarters",
    "size_and_stage",
    "executive_summary",
    "editorial",
    "description",
}


def networking_company_preview(company: dict[str, Any]) -> dict[str, Any]:
    preview = {**company}
    research = company.get("research")
    preview["research"] = (
        {
            field: research[field]
            for field in NETWORKING_RESEARCH_PREVIEW_FIELDS
            if field in research
        }
        if research
        else None
    )
    preview["roles"] = [
        {field: value for field, value in role.items() if field != "research"}
        for role in company.get("roles", [])
    ]
    return preview


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    public = {**job}
    packet_path = public.pop("packet_path", None)
    if packet_path is not None:
        public["packet_available"] = bool(packet_path)
    application = public.get("application")
    if isinstance(application, dict):
        public["application"] = {key: value for key, value in application.items() if key != "packet_path"}
    variants = public.get("opportunity_variants")
    if isinstance(variants, list):
        public["opportunity_variants"] = [public_job(variant) for variant in variants]
    return public


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "operation_worker_running": operation_worker.is_running,
        "analysis_concurrency": operation_worker.analysis_concurrency,
    }


@app.get("/api/worker/health")
def api_worker_health() -> dict[str, Any]:
    """Cheap availability check for Sites; this never starts a Codex process."""
    return cloud_execution_service.status()


@app.post("/api/worker/execute", status_code=202)
def api_worker_execute(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        created, state = cloud_execution_service.submit(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=safe_error_message(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {
        "operation_id": str(payload.get("operation_id") or ""),
        "accepted": True,
        "created": created,
        "state": state,
    }


@app.get("/api/codex/status")
def api_codex_status() -> dict[str, Any]:
    return check_codex_status()


@app.post("/api/profile/init")
def api_init_profile() -> dict[str, Any]:
    profile = init_profile()
    return {
        "resume_parser": profile["resume_parser"],
        "created_at": profile["created_at"],
        "resume_strategies": profile["resume_strategies"],
    }


@app.get("/api/days")
def api_days() -> dict[str, Any]:
    with connect() as conn:
        return {"days": list_days(conn)}


@app.get("/api/networking/companies")
def api_networking_companies(include_inactive: bool = False) -> dict[str, Any]:
    with connect() as conn:
        companies = list_networking_companies(conn, include_inactive=include_inactive)
    return {"companies": [networking_company_preview(company) for company in companies]}


@app.get("/api/networking/companies/{company_key}")
def api_networking_company(company_key: str) -> dict[str, Any]:
    with connect() as conn:
        company = get_networking_company(conn, company_key, include_inactive=True)
    if company is None:
        raise HTTPException(status_code=404, detail="Networking company not found.")
    return company


@app.post("/api/networking/companies/{company_key}/contacts")
def api_add_networking_contacts(company_key: str, payload: AddNetworkingContactsRequest) -> dict[str, Any]:
    try:
        with connect() as conn:
            contact_ids = add_contacts(conn, company_key, payload.display_name, [contact.model_dump() for contact in payload.contacts])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"company_key": company_key, "contact_ids": contact_ids}


@app.patch("/api/networking/contacts/{contact_id}")
def api_update_networking_contact(contact_id: int, payload: UpdateNetworkingContactRequest) -> dict[str, Any]:
    try:
        changes = payload.model_dump(exclude_unset=True)
        with connect() as conn:
            update_contact(conn, contact_id, changes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"contact_id": contact_id, "updated": True}


@app.delete("/api/networking/contacts/{contact_id}")
def api_delete_networking_contact(contact_id: int) -> dict[str, Any]:
    try:
        with connect() as conn:
            delete_contact(conn, contact_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"contact_id": contact_id, "deleted": True}


@app.patch("/api/networking/companies/{company_key}/pause")
def api_pause_networking_company(company_key: str, payload: NetworkingPauseRequest) -> dict[str, Any]:
    try:
        with connect() as conn:
            set_company_paused(conn, company_key, payload.display_name, payload.paused)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"company_key": company_key, "paused": payload.paused}


@app.post("/api/networking/companies/{company_key}/research", status_code=202)
def api_research_networking_company(company_key: str) -> dict[str, Any]:
    try:
        operation, created = queue_operation("research_company", {"company_key": company_key})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.post("/api/networking/companies/{company_key}/roles/{opportunity_key}/research", status_code=202)
def api_research_networking_role(company_key: str, opportunity_key: str) -> dict[str, Any]:
    try:
        operation, created = queue_operation(
            "research_role",
            {"company_key": company_key, "opportunity_key": opportunity_key},
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.get("/api/jobs")
def api_jobs(
    ids: str | None = None,
    date: str | None = None,
    query: str | None = None,
    analyzed: str | None = None,
    status: str | None = None,
    lane: str | None = None,
    location: str | None = None,
    decision: str | None = None,
    sponsorship: str | None = None,
    fit: str | None = None,
    confidence: str | None = None,
) -> dict[str, Any]:
    with connect() as conn:
        jobs = list_jobs(
            conn,
            {
                "ids": ids,
                "date": date,
                "query": query,
                "analyzed": analyzed,
                "status": status,
                "lane": lane,
                "location_terms": expand_location_filter(location.split(",") if location else None),
                "decision": decision,
                "sponsorship": sponsorship,
                "fit": fit,
                "confidence": confidence,
            },
        )
    return {"jobs": [public_job(job) for job in jobs]}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict[str, Any]:
    with connect() as conn:
        job = get_job(conn, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return public_job(job)


@app.patch("/api/jobs/{job_id}")
def api_update_job(job_id: str, payload: UpdateJobRequest) -> dict[str, Any]:
    try:
        changes = payload.model_dump(exclude_unset=True)
        with connect() as conn:
            return update_job(conn, job_id, changes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc


@app.post("/api/jobs/ingest")
def api_ingest_job(payload: IngestJobRequest) -> dict[str, Any]:
    try:
        result = ingest_manual_job_payload(payload.model_dump(exclude={"analyze"}))
        operation = None
        analysis_created = False
        if payload.analyze:
            operation, analysis_created = queue_operation("analyze_job", {"job_id": result["job_id"]})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {
        **result,
        "job": public_job(result["job"]),
        "analysis_operation": operation,
        "analysis_created": analysis_created,
    }


@app.post("/api/search", status_code=202)
def api_search(payload: SearchRequest) -> dict[str, Any]:
    try:
        lanes = payload.lanes or ([payload.lane] if payload.lane else [])
        locations = payload.locations or ([payload.location] if payload.location else [])
        operation, created = queue_operation(
            "search",
            {
                "lanes": lanes,
                "locations": locations,
                "limit": payload.limit,
                "metro_ids": payload.metro_ids or [],
                "include_edge_check": payload.include_edge_check,
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.get("/api/search/options")
def api_search_options() -> dict[str, Any]:
    recover_abandoned_search_runs()
    return search_metadata()


@app.post("/api/search/retry", status_code=202)
def api_retry_search(payload: RetrySearchRequest) -> dict[str, Any]:
    try:
        if not payload.requests:
            raise ValueError("At least one failed request is required.")
        request_plan = [item.model_dump() for item in payload.requests]
        operation, created = queue_operation(
            "search_retry",
            {"requests": request_plan, "limit": payload.limit},
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.post("/api/jobs/{job_id}/analyze", status_code=202)
def api_analyze(job_id: str) -> dict[str, Any]:
    try:
        operation, created = queue_operation("analyze_job", {"job_id": job_id})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.post("/api/jobs/analyze-batch", status_code=202)
def api_analyze_batch(payload: AnalyzeJobsRequest) -> dict[str, Any]:
    job_ids = list(dict.fromkeys(payload.job_ids))
    with connect() as conn:
        missing_job_ids = [job_id for job_id in job_ids if get_job(conn, job_id) is None]
    if missing_job_ids:
        count = len(missing_job_ids)
        raise HTTPException(
            status_code=404,
            detail=f"{count} selected {'job was' if count == 1 else 'jobs were'} not found.",
        )
    try:
        queued = queue_operations(
            "analyze_job",
            [{"job_id": job_id} for job_id in job_ids],
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    operations = [operation for operation, _ in queued]
    created_count = sum(1 for _, created in queued if created)
    return {
        "operations": operations,
        "created_count": created_count,
        "existing_count": len(operations) - created_count,
    }


@app.post("/api/jobs/{job_id}/build-packet", status_code=202)
def api_build_packet(job_id: str) -> dict[str, Any]:
    try:
        operation, created = queue_operation("build_packet", {"job_id": job_id})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}


@app.get("/api/operations")
def api_operations(
    limit: int = Query(default=50, ge=1, le=200),
    status: str | None = None,
    operation_type: str | None = None,
) -> dict[str, Any]:
    with connect() as conn:
        operations = list_operations(conn, limit=limit, status=status, operation_type=operation_type)
    return {"operations": operations}


@app.get("/api/operations/{operation_id}")
def api_operation(operation_id: str) -> dict[str, Any]:
    with connect() as conn:
        operation = get_operation(conn, operation_id)
    if operation is None:
        raise HTTPException(status_code=404, detail="Operation not found.")
    return operation


@app.post("/api/jobs/{job_id}/status")
def api_status(job_id: str, payload: StatusRequest) -> dict[str, Any]:
    try:
        with connect() as conn:
            update_status(conn, job_id, payload.status)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"job_id": job_id, "status": payload.status}


@app.get("/api/applications/{job_id}")
def api_application(job_id: str) -> dict[str, Any]:
    try:
        artifacts = application_artifacts(job_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=safe_error_message(exc)) from exc
    return {
        "job": {
            **public_job(artifacts["job"]),
        },
        "files": {
            name: {
                "url": f"/api/applications/{job_id}/artifact/{name}",
                "exists": path.exists(),
            }
            for name, path in artifacts["files"].items()
        },
    }


@app.get("/api/applications/{job_id}/artifact/{name}")
def api_artifact(job_id: str, name: str):
    try:
        artifacts = application_artifacts(job_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=safe_error_message(exc)) from exc
    path = artifacts["files"].get(name)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="Artifact not found.")
    return FileResponse(path)


@app.get("/api/reports/{report_date}")
def api_report(report_date: str) -> PlainTextResponse:
    path = ensure_runtime_dirs().reports_dir / f"{report_date}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Report not found.")
    return PlainTextResponse(path.read_text(encoding="utf-8"))


@app.post("/api/daily-report", status_code=202)
def api_daily_report(payload: DailyReportRequest) -> dict[str, Any]:
    try:
        operation, created = queue_operation("daily_report", {"date": payload.date})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=safe_error_message(exc)) from exc
    return {"operation": operation, "created": created}
