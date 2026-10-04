from __future__ import annotations

import os
import time
from typing import Any

import requests

from .paths import load_dotenv
from .security import safe_error_message


TERMINAL_OPERATION_STATUSES = {"succeeded", "failed", "interrupted"}


def site_api_configured() -> bool:
    load_dotenv()
    return bool(os.environ.get("CAREER_SITE_URL", "").strip())


def _site_url(path: str) -> str:
    load_dotenv()
    base_url = os.environ.get("CAREER_SITE_URL", "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("CAREER_SITE_URL is not configured.")
    return f"{base_url}/{path.lstrip('/')}"


def _headers(*, json_body: bool = False) -> dict[str, str]:
    load_dotenv()
    headers = {"Accept": "application/json", "User-Agent": "career-automation-cli/1"}
    if json_body:
        headers["Content-Type"] = "application/json"
    bypass = os.environ.get("CAREER_SITE_BYPASS_TOKEN", "").strip()
    if bypass:
        headers["OAI-Sites-Authorization"] = f"Bearer {bypass}"
    return headers


def _detail(response: requests.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            return str(payload.get("detail") or payload.get("error") or response.reason)
    except ValueError:
        pass
    return response.text.strip()[:500] or response.reason or "Unknown Site error"


def site_json(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: tuple[int, int] = (5, 180),
) -> dict[str, Any]:
    try:
        response = requests.request(
            method,
            _site_url(path),
            headers=_headers(json_body=payload is not None),
            json=payload,
            params=params,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Could not reach the CareerAutomation Site: {safe_error_message(exc)}") from exc
    if not response.ok:
        raise RuntimeError(f"CareerAutomation Site returned HTTP {response.status_code}: {_detail(response)}")
    try:
        result = response.json()
    except ValueError as exc:
        raise RuntimeError("CareerAutomation Site returned an invalid JSON response.") from exc
    if not isinstance(result, dict):
        raise RuntimeError("CareerAutomation Site returned an unexpected response.")
    return result


def wait_for_site_operation(operation: dict[str, Any], *, timeout_seconds: int = 1_200) -> dict[str, Any]:
    operation_id = str(operation.get("operation_id") or "")
    if not operation_id:
        raise RuntimeError("The Site did not return an operation id.")
    deadline = time.monotonic() + timeout_seconds
    current = operation
    while str(current.get("status") or "") not in TERMINAL_OPERATION_STATUSES:
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Timed out waiting for Site operation {operation_id}.")
        time.sleep(2)
        current = site_json("GET", f"/api/operations/{operation_id}")
    if current.get("status") != "succeeded":
        detail = str(current.get("error") or f"Operation ended as {current.get('status')}.")
        raise RuntimeError(detail)
    return current
