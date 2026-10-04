from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from typing import Any, Callable

from .paths import load_dotenv
from .security import safe_error_message
from .tracker import (
    claim_next_operation,
    connect,
    enqueue_operation,
    finish_operation,
    interrupt_running_operations,
)


logger = logging.getLogger(__name__)

ANALYSIS_OPERATION_TYPE = "analyze_job"
DEFAULT_ANALYSIS_CONCURRENCY = 20
MAX_ANALYSIS_CONCURRENCY = 20

OPERATION_TYPES = {
    ANALYSIS_OPERATION_TYPE,
    "build_packet",
    "daily_report",
    "research_company",
    "research_role",
    "search",
    "search_retry",
}


def configured_analysis_concurrency() -> int:
    load_dotenv()
    raw_value = os.environ.get("CAREER_ANALYSIS_CONCURRENCY", str(DEFAULT_ANALYSIS_CONCURRENCY)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError("CAREER_ANALYSIS_CONCURRENCY must be an integer between 1 and 20.") from exc
    if not 1 <= value <= MAX_ANALYSIS_CONCURRENCY:
        raise ValueError("CAREER_ANALYSIS_CONCURRENCY must be between 1 and 20.")
    return value


def operation_resource_key(operation_type: str, payload: dict[str, Any]) -> str:
    if operation_type in {"analyze_job", "build_packet"}:
        return str(payload["job_id"])
    if operation_type == "research_company":
        return str(payload["company_key"])
    if operation_type == "research_role":
        return f"{payload['company_key']}:{payload['opportunity_key']}"
    if operation_type == "daily_report":
        return str(payload.get("date") or "today")
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def queue_operation(operation_type: str, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if operation_type not in OPERATION_TYPES:
        raise ValueError(f"Unknown operation type: {operation_type}")
    resource_key = operation_resource_key(operation_type, payload)
    with connect() as conn:
        operation, created = enqueue_operation(conn, operation_type, resource_key, payload)
    operation_worker.wake()
    return operation, created


def queue_operations(
    operation_type: str,
    payloads: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], bool]]:
    """Persist a batch atomically, then wake the workstation worker once."""
    if operation_type not in OPERATION_TYPES:
        raise ValueError(f"Unknown operation type: {operation_type}")
    queued: list[tuple[dict[str, Any], bool]] = []
    with connect() as conn:
        for payload in payloads:
            resource_key = operation_resource_key(operation_type, payload)
            queued.append(enqueue_operation(conn, operation_type, resource_key, payload))
    operation_worker.wake()
    return queued


def _without_local_paths(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_local_paths(item)
            for key, item in value.items()
            if "path" not in key.lower()
        }
    if isinstance(value, list):
        return [_without_local_paths(item) for item in value]
    return value


def execute_operation(operation_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if operation_type == "search":
        from .jobs import search_serpapi

        result = search_serpapi(
            payload.get("lanes") or [],
            payload.get("locations") or [],
            int(payload.get("limit") or 20),
            payload.get("metro_ids"),
            include_edge_check=bool(payload.get("include_edge_check")),
        )
    elif operation_type == "search_retry":
        from .jobs import search_serpapi

        requests = payload.get("requests") or []
        result = search_serpapi(
            [item["lane"] for item in requests],
            [item["location"] for item in requests],
            int(payload.get("limit") or 20),
            request_plan=requests,
        )
    elif operation_type == "analyze_job":
        from .analysis import analyze_job

        result = analyze_job(str(payload["job_id"]))
    elif operation_type == "build_packet":
        from .generation import build_packet

        result = build_packet(str(payload["job_id"]))
    elif operation_type == "research_company":
        from .networking import research_company

        with connect() as conn:
            result = research_company(conn, str(payload["company_key"]))
    elif operation_type == "research_role":
        from .networking import research_role

        with connect() as conn:
            result = research_role(
                conn,
                str(payload["company_key"]),
                str(payload["opportunity_key"]),
            )
    elif operation_type == "daily_report":
        from .reports import daily_report

        result = daily_report(payload.get("date"))
    else:
        raise ValueError(f"Unknown operation type: {operation_type}")
    return _without_local_paths(result)


class OperationWorker:
    def __init__(
        self,
        executor: Callable[[str, dict[str, Any]], dict[str, Any]] = execute_operation,
        analysis_concurrency: int | None = None,
    ) -> None:
        self._executor = executor
        self._analysis_concurrency = configured_analysis_concurrency() if analysis_concurrency is None else analysis_concurrency
        if not 1 <= self._analysis_concurrency <= MAX_ANALYSIS_CONCURRENCY:
            raise ValueError(f"analysis_concurrency must be between 1 and {MAX_ANALYSIS_CONCURRENCY}.")
        self._stop_event = threading.Event()
        self._wake_condition = threading.Condition()
        self._wake_generation = 0
        self._threads: list[threading.Thread] = []

    @property
    def is_running(self) -> bool:
        expected_workers = self._analysis_concurrency + 1
        return len(self._threads) == expected_workers and all(thread.is_alive() for thread in self._threads)

    @property
    def analysis_concurrency(self) -> int:
        return self._analysis_concurrency

    def start(self) -> None:
        if any(thread.is_alive() for thread in self._threads):
            return
        self._stop_event.clear()
        with connect() as conn:
            interrupted = interrupt_running_operations(conn)
        if interrupted:
            logger.warning("operations_interrupted_after_restart count=%d", interrupted)
        self._threads = [
            threading.Thread(
                target=self._run_lane,
                kwargs={"exclude_operation_types": {ANALYSIS_OPERATION_TYPE}},
                name="career-operation-worker-general",
                daemon=True,
            ),
            *[
                threading.Thread(
                    target=self._run_lane,
                    kwargs={"include_operation_types": {ANALYSIS_OPERATION_TYPE}},
                    name=f"career-operation-worker-analysis-{index + 1}",
                    daemon=True,
                )
                for index in range(self._analysis_concurrency)
            ],
        ]
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self.wake()
        deadline = time.monotonic() + 5
        for thread in self._threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        self._threads = [thread for thread in self._threads if thread.is_alive()]

    def wake(self) -> None:
        with self._wake_condition:
            self._wake_generation += 1
            self._wake_condition.notify_all()

    def run_once(
        self,
        include_operation_types: set[str] | None = None,
        exclude_operation_types: set[str] | None = None,
    ) -> bool:
        with connect() as conn:
            operation = claim_next_operation(
                conn,
                include_operation_types=include_operation_types,
                exclude_operation_types=exclude_operation_types,
            )
        if operation is None:
            return False
        operation_id = str(operation["operation_id"])
        try:
            result = self._executor(str(operation["operation_type"]), operation["payload"])
        except Exception as exc:
            logger.exception(
                "operation_failed operation_id=%s operation_type=%s",
                operation_id,
                operation["operation_type"],
            )
            with connect() as conn:
                finish_operation(conn, operation_id, "failed", error=safe_error_message(exc))
        else:
            with connect() as conn:
                finish_operation(conn, operation_id, "succeeded", result=result)
        return True

    def _run_lane(
        self,
        include_operation_types: set[str] | None = None,
        exclude_operation_types: set[str] | None = None,
    ) -> None:
        while not self._stop_event.is_set():
            with self._wake_condition:
                observed_generation = self._wake_generation
            iteration_failed = False
            try:
                completed_work = self.run_once(include_operation_types, exclude_operation_types)
            except Exception:
                logger.exception("operation_worker_iteration_failed")
                completed_work = False
                iteration_failed = True
            if not completed_work:
                with self._wake_condition:
                    self._wake_condition.wait_for(
                        lambda: self._stop_event.is_set() or self._wake_generation != observed_generation,
                        timeout=1 if iteration_failed else 30,
                    )


operation_worker = OperationWorker()
