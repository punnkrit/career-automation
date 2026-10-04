from __future__ import annotations

import base64
import hashlib
import json
import logging
import mimetypes
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import requests

from .context import operation_resume_context
from .generation import application_artifacts
from .operations import execute_operation
from .paths import ensure_runtime_dirs, load_dotenv
from .security import safe_error_message
from .worker_identity import worker_id
from .tracker import connect, get_job, now_iso, save_job_sources


logger = logging.getLogger(__name__)
CLOUD_OPERATION_TYPES = {"analyze_job", "build_packet", "daily_report", "research_company", "research_role"}
MAX_CANDIDATE_RESUME_BYTES = 2 * 1024 * 1024


def _sync_analysis(conn, job_id: str, analysis: dict[str, Any] | None) -> None:
    if not analysis:
        return
    memo = analysis.get("decision_memo") or {}
    required = ("decision", "fit_tier", "sponsorship_tier", "lane", "resume_strategy", "confidence")
    if not all(str(analysis.get(field) or memo.get(field) or "").strip() for field in required):
        return
    values = {field: analysis.get(field) or memo.get(field) for field in required}
    conn.execute(
        """
        insert into analyses (
            job_id, decision_memo_json, decision, fit_tier, sponsorship_tier,
            lane, resume_strategy, confidence, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(job_id) do update set
            decision_memo_json=excluded.decision_memo_json,
            decision=excluded.decision,
            fit_tier=excluded.fit_tier,
            sponsorship_tier=excluded.sponsorship_tier,
            lane=excluded.lane,
            resume_strategy=excluded.resume_strategy,
            confidence=excluded.confidence,
            created_at=excluded.created_at
        """,
        (
            job_id,
            json.dumps(memo),
            values["decision"],
            values["fit_tier"],
            values["sponsorship_tier"],
            values["lane"],
            values["resume_strategy"],
            values["confidence"],
            analysis.get("created_at") or now_iso(),
        ),
    )


def _sync_job(conn, job: dict[str, Any], seen_job_ids: set[str] | None = None) -> None:
    job_id = str(job.get("job_id") or "").strip()
    if not job_id:
        raise ValueError("A cloud job is missing its job_id.")
    seen_job_ids = seen_job_ids if seen_job_ids is not None else set()
    if job_id in seen_job_ids:
        return
    seen_job_ids.add(job_id)
    columns = (
        "job_id", "title", "company", "location", "source", "url", "description", "found_date",
        "posted_at", "created_at", "updated_at", "lane_hint", "status", "dedupe_key", "company_key",
        "title_key", "description_fingerprint", "opportunity_key", "opportunity_grouping_version",
        "discovery_url", "source_tier", "source_status", "source_checked_at", "source_resolution_json",
    )
    stamp = now_iso()
    prepared = {
        **job,
        "created_at": job.get("created_at") or stamp,
        "updated_at": job.get("updated_at") or stamp,
        "source_resolution_json": json.dumps(job.get("source_resolution")) if job.get("source_resolution") else None,
    }
    update_columns = [column for column in columns if column not in {"job_id", "dedupe_key"}]
    conn.execute(
        f"""
        insert into jobs ({", ".join(columns)})
        values ({", ".join("?" for _ in columns)})
        on conflict(job_id) do update set
          {", ".join(f"{column}=excluded.{column}" for column in update_columns)}
        """,
        [prepared.get(column) for column in columns],
    )
    source_candidates = job.get("source_candidates")
    if isinstance(source_candidates, list):
        save_job_sources(conn, job_id, [candidate for candidate in source_candidates if isinstance(candidate, dict)])
    _sync_analysis(conn, job_id, job.get("analysis"))
    opportunity_variants = job.get("opportunity_variants")
    if isinstance(opportunity_variants, list):
        for variant in opportunity_variants:
            if isinstance(variant, dict):
                _sync_job(conn, variant, seen_job_ids)


def _sync_company(conn, company: dict[str, Any]) -> None:
    stamp = now_iso()
    conn.execute(
        """
        insert into networking_companies (
            company_key, display_name, paused, research_json, researched_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(company_key) do update set
            display_name=excluded.display_name,
            paused=excluded.paused,
            research_json=excluded.research_json,
            researched_at=excluded.researched_at,
            updated_at=excluded.updated_at
        """,
        (
            company["company_key"],
            company.get("display_name") or company["company_key"],
            int(bool(company.get("paused"))),
            json.dumps(company.get("research")) if company.get("research") else None,
            company.get("researched_at"),
            stamp,
            stamp,
        ),
    )


def _resume_cache_path() -> Path:
    return ensure_runtime_dirs().profile_dir / "resume_text.md"


def _read_cached_resume(path: Path) -> str | None:
    if not path.exists():
        return None
    if path.stat().st_size > MAX_CANDIDATE_RESUME_BYTES:
        raise ValueError("The local candidate resume cache exceeds the 2 MB worker limit.")
    resume_text = path.read_text(encoding="utf-8")
    return resume_text if resume_text.strip() else None


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _sync_candidate_context(cloud_input: dict[str, Any]) -> str:
    cache_path = _resume_cache_path()
    if "candidate_context" not in cloud_input:
        cached_resume = _read_cached_resume(cache_path)
        if cached_resume is not None:
            return cached_resume
        raise ValueError(
            "Cloud execution input did not include candidate resume text, and no local resume cache is available."
        )
    candidate_context = cloud_input.get("candidate_context")
    if not isinstance(candidate_context, dict):
        raise ValueError("Cloud candidate context must be an object containing resume_text.")
    resume_text = candidate_context.get("resume_text")
    if not isinstance(resume_text, str) or not resume_text.strip():
        raise ValueError("Cloud candidate resume text is missing or empty. Publish the profile again.")
    if len(resume_text.encode("utf-8")) > MAX_CANDIDATE_RESUME_BYTES:
        raise ValueError("Cloud candidate resume text exceeds the 2 MB worker limit.")
    _atomic_write_text(cache_path, resume_text)
    return resume_text


def sync_cloud_input(operation_type: str, cloud_input: dict[str, Any]) -> str:
    operation_resume_text = _sync_candidate_context(cloud_input)
    jobs: list[dict[str, Any]] = []
    if isinstance(cloud_input.get("job"), dict):
        jobs.append(cloud_input["job"])
    if isinstance(cloud_input.get("jobs"), list):
        jobs.extend(job for job in cloud_input["jobs"] if isinstance(job, dict))
    seen_job_ids: set[str] = set()
    with connect() as conn:
        for job in jobs:
            _sync_job(conn, job, seen_job_ids)
        company = cloud_input.get("company")
        if isinstance(company, dict):
            _sync_company(conn, company)
    return operation_resume_text


def _artifact_content_payload(name: str, filename: str, content: bytes) -> dict[str, Any]:
    return {
        "name": name,
        "filename": filename,
        "content_type": mimetypes.guess_type(filename)[0] or "application/octet-stream",
        "sha256": hashlib.sha256(content).hexdigest(),
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


def _artifact_payload(name: str, path: Path) -> dict[str, Any]:
    return _artifact_content_payload(name, path.name, path.read_bytes())


def _without_path_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_path_fields(item)
            for key, item in value.items()
            if "path" not in str(key).lower()
        }
    if isinstance(value, list):
        return [_without_path_fields(item) for item in value]
    return value


def _packet_artifacts(job_id: str) -> list[dict[str, Any]]:
    artifacts = application_artifacts(job_id)
    result: list[dict[str, Any]] = []
    for logical_name, path in artifacts["files"].items():
        candidate = path
        if not candidate.exists() and logical_name == "tailored_resume_md":
            legacy = next(candidate.parent.glob("*_tailored_resume.md"), None)
            if legacy is not None:
                candidate = legacy
        if candidate.exists():
            if logical_name == "audit":
                audit = json.loads(candidate.read_text(encoding="utf-8"))
                content = json.dumps(_without_path_fields(audit), indent=2).encode("utf-8")
                result.append(_artifact_content_payload(logical_name, candidate.name, content))
            else:
                result.append(_artifact_payload(logical_name, candidate))
    return result


def _callback_headers() -> dict[str, str]:
    load_dotenv()
    headers = {
        "Content-Type": "application/json",
        "X-Career-Worker-Secret": os.environ.get("CAREER_WORKER_CALLBACK_SECRET", ""),
    }
    bypass = os.environ.get("CAREER_SITE_BYPASS_TOKEN", "")
    if bypass:
        headers["OAI-Sites-Authorization"] = f"Bearer {bypass}"
    return headers


def _recovery_dir() -> Path:
    directory = ensure_runtime_dirs().output_dir / "cloud_callback_recovery"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _persist_callback(operation_id: str, payload: dict[str, Any]) -> Path:
    target = _recovery_dir() / f"{operation_id}.json"
    descriptor, temporary = tempfile.mkstemp(prefix=".callback-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return target


def _send_callback(operation_id: str, payload: dict[str, Any]) -> bool:
    load_dotenv()
    site_url = os.environ.get("CAREER_SITE_URL", "").rstrip("/")
    if not site_url or not os.environ.get("CAREER_WORKER_CALLBACK_SECRET"):
        raise RuntimeError("Site callback configuration is missing.")
    response = requests.post(f"{site_url}/api/worker/complete/{operation_id}",
        headers=_callback_headers(), json=payload, timeout=(5, 15))
    if response.status_code == 200:
        return True
    if response.status_code in {400, 404, 409, 410}:
        # Preserve rejected deliveries as diagnostics, but never replay them.
        source = _recovery_dir() / f"{operation_id}.json"
        rejected = _recovery_dir() / "rejected"
        rejected.mkdir(exist_ok=True)
        if source.exists():
            os.replace(source, rejected / source.name)
        logger.warning("cloud_callback_rejected operation_id=%s http_status=%s", operation_id, response.status_code)
        return False
    raise RuntimeError(f"Cloud callback returned HTTP {response.status_code}.")


def _post_callback(operation_id: str, payload: dict[str, Any]) -> None:
    recovery_path = _persist_callback(operation_id, payload)
    for attempt in range(3):
        try:
            if _send_callback(operation_id, payload):
                recovery_path.unlink(missing_ok=True)
            return
        except (requests.RequestException, RuntimeError):
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError("Could not deliver cloud callback; retained the completion for automatic recovery.")


def _renew_lease(operation_id: str, identity: dict[str, Any]) -> bool:
    load_dotenv()
    site_url = os.environ.get("CAREER_SITE_URL", "").rstrip("/")
    response = requests.post(f"{site_url}/api/worker/heartbeat/{operation_id}",
        headers=_callback_headers(), json={"schema_version": 1, **identity}, timeout=(3, 8))
    if response.status_code in {400, 401, 403, 404, 409, 410}:
        return False
    response.raise_for_status()
    return bool(response.json().get("accepted"))


class CloudExecutionService:
    def __init__(self, identity_dir: Path | None = None) -> None:
        self._lock = threading.Lock()
        self._identity_dir = identity_dir
        self._worker_id: str | None = None
        self.instance_id = str(uuid4())
        self._stop = threading.Event()
        self._recovery_lock = threading.Lock()
        self._recovery_thread: threading.Thread | None = None
        self._active: set[str] = set()
        self._completed: set[str] = set()

    @property
    def worker_id(self) -> str:
        if self._worker_id is None:
            self._worker_id = worker_id(self._identity_dir)
        return self._worker_id

    def start(self) -> None:
        if self._recovery_thread and self._recovery_thread.is_alive():
            return
        self._stop.clear()
        self._recovery_thread = threading.Thread(target=self._recover_loop, name="cloud-callback-recovery", daemon=True)
        self._recovery_thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._recovery_thread:
            self._recovery_thread.join(timeout=2)

    def recover_callbacks(self) -> None:
        if not self._recovery_lock.acquire(blocking=False):
            return
        try:
            with self._lock:
                active = set(self._active)
            for path in sorted(_recovery_dir().glob("*.json"))[:100]:
                if path.stem in active:
                    continue
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    if _send_callback(path.stem, payload):
                        path.unlink(missing_ok=True)
                except (OSError, ValueError, requests.RequestException, RuntimeError) as exc:
                    logger.warning("cloud_callback_recovery_pending operation_id=%s error=%s", path.stem, safe_error_message(exc))
        finally:
            self._recovery_lock.release()

    def _recover_loop(self) -> None:
        while not self._stop.is_set():
            self.recover_callbacks()
            self._stop.wait(30)

    def _heartbeat_loop(self, operation_id: str, identity: dict[str, Any], finished: threading.Event, lost: threading.Event) -> None:
        # The synchronous admission heartbeat already claimed this operation.
        while not finished.wait(30):
            if self._stop.is_set():
                return
            try:
                if not _renew_lease(operation_id, identity):
                    lost.set()
                    logger.warning("cloud_operation_lease_lost operation_id=%s", operation_id)
                    return
            except requests.RequestException:
                logger.warning("cloud_operation_heartbeat_unreachable operation_id=%s", operation_id)

    @property
    def capacity(self) -> int:
        load_dotenv()
        try:
            return max(1, min(20, int(os.environ.get("CAREER_CLOUD_WORKER_CONCURRENCY", "4"))))
        except ValueError:
            return 4

    def status(self) -> dict[str, Any]:
        with self._lock:
            active = sorted(self._active)
        return {
            "ok": True,
            "online": True,
            "version": 1,
            "protocol_version": 2,
            "worker_id": self.worker_id,
            "instance_id": self.instance_id,
            "capabilities": sorted(CLOUD_OPERATION_TYPES),
            "active_operation_ids": active,
            "capacity": self.capacity,
            "available_slots": max(0, self.capacity - len(active)),
        }

    def submit(self, envelope: dict[str, Any]) -> tuple[bool, str]:
        operation_id = str(envelope.get("operation_id") or "")
        operation_type = str(envelope.get("operation_type") or "")
        cloud_input = envelope.get("input")
        if envelope.get("schema_version") != 1 or not operation_id:
            raise ValueError("Invalid cloud execution envelope.")
        if operation_type not in CLOUD_OPERATION_TYPES:
            raise ValueError("Unsupported cloud operation type.")
        if not isinstance(cloud_input, dict):
            raise ValueError("Cloud execution input must be an object.")
        with self._lock:
            if operation_id in self._active or operation_id in self._completed:
                return False, "already accepted"
            if len(self._active) >= self.capacity:
                raise RuntimeError("Workstation worker is busy.")
            self._active.add(operation_id)
        if envelope.get("lease_required"):
            try:
                if not _renew_lease(operation_id, {"worker_id": self.worker_id, "instance_id": self.instance_id,
                    "input_hash": str(envelope.get("input_hash") or "")}):
                    raise RuntimeError("The Site rejected operation ownership. Retry the action.")
            except Exception:
                with self._lock:
                    self._active.discard(operation_id)
                raise
        thread = threading.Thread(target=self._run, args=(envelope,), name=f"cloud-worker-{operation_id[:8]}", daemon=True)
        thread.start()
        return True, "accepted"

    def _run(self, envelope: dict[str, Any]) -> None:
        operation_id = str(envelope["operation_id"])
        operation_type = str(envelope["operation_type"])
        callback: dict[str, Any] = {
            "schema_version": 1,
            "operation_type": operation_type,
            "input_hash": str(envelope.get("input_hash") or ""),
        }
        identity = {"worker_id": self.worker_id, "instance_id": self.instance_id,
            "input_hash": str(envelope.get("input_hash") or "")}
        callback.update({"worker_id": self.worker_id, "instance_id": self.instance_id})
        finished = threading.Event()
        lost = threading.Event()
        heartbeat = None
        if envelope.get("lease_required"):
            heartbeat = threading.Thread(target=self._heartbeat_loop, args=(operation_id, identity, finished, lost), daemon=True)
            heartbeat.start()
        try:
            operation_resume_text = sync_cloud_input(operation_type, envelope["input"])
            payload: dict[str, Any]
            if operation_type in {"analyze_job", "build_packet"}:
                payload = {"job_id": envelope["input"]["job"]["job_id"]}
            elif operation_type == "research_company":
                payload = {"company_key": envelope["input"]["company"]["company_key"]}
            elif operation_type == "research_role":
                payload = {
                    "company_key": envelope["input"]["company"]["company_key"],
                    "opportunity_key": envelope["input"]["opportunity_key"],
                }
            else:
                payload = {"date": envelope["input"].get("date")}
            with operation_resume_context(operation_resume_text, envelope["input"].get("candidate_context")):
                result = execute_operation(operation_type, payload)
            if operation_type == "analyze_job":
                with connect() as conn:
                    refreshed_job = get_job(conn, str(payload["job_id"]))
                result = {"decision_memo": result, "job": refreshed_job}
            elif operation_type == "build_packet":
                with connect() as conn:
                    refreshed_job = get_job(conn, str(payload["job_id"]))
                result = {
                    **result,
                    "resume_strategy": ((refreshed_job or {}).get("analysis") or {}).get("resume_strategy"),
                }
            callback.update({"status": "succeeded", "result": result})
            if operation_type == "build_packet":
                callback["artifacts"] = _packet_artifacts(str(payload["job_id"]))
        except Exception as exc:
            logger.exception("cloud_operation_failed operation_id=%s operation_type=%s", operation_id, operation_type)
            callback.update({"status": "failed", "result": None, "error": safe_error_message(exc)})
        try:
            if not lost.is_set():
                _post_callback(operation_id, callback)
        except Exception:
            logger.exception("cloud_callback_failed operation_id=%s", operation_id)
        finally:
            finished.set()
            if heartbeat:
                heartbeat.join(timeout=1)
            with self._lock:
                self._active.discard(operation_id)
                self._completed.add(operation_id)


cloud_execution_service = CloudExecutionService()
