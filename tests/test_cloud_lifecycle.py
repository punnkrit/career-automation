import json
import threading
from pathlib import Path

import pytest
import requests

import career_workflow.cloud_worker as worker
from career_workflow.cloud_worker import CloudExecutionService
from career_workflow.worker_identity import worker_id


@pytest.fixture(autouse=True)
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "scratch"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CAREER_SITE_URL", "https://site.invalid")
    monkeypatch.setenv("CAREER_WORKER_CALLBACK_SECRET", "test-secret")
    monkeypatch.setenv("CAREER_SITE_BYPASS_TOKEN", "test-bypass")


def envelope():
    return {"schema_version": 1, "operation_id": "attempt-1", "operation_type": "daily_report",
            "lease_required": True, "input_hash": "input-hash", "input": {"date": "2026-10-02"}}


def test_identity_is_durable_and_instance_changes(tmp_path):
    identity = tmp_path / "identity"
    first = CloudExecutionService(identity)
    second = CloudExecutionService(identity)
    assert first.worker_id == second.worker_id == worker_id(identity)
    assert first.instance_id != second.instance_id
    assert (identity / "worker-id").stat().st_mode & 0o777 == 0o600


def test_rejected_admission_does_not_execute_or_consume_capacity(tmp_path, monkeypatch):
    service = CloudExecutionService(tmp_path / "identity")
    monkeypatch.setattr(worker, "_renew_lease", lambda *_: False)
    monkeypatch.setattr(service, "_run", lambda *_: pytest.fail("Executed after rejected ownership"))
    with pytest.raises(RuntimeError, match="rejected operation ownership"):
        service.submit(envelope())
    assert service.status()["available_slots"] == service.capacity


def test_claim_happens_before_execution_and_callback_has_owner(tmp_path, monkeypatch):
    service = CloudExecutionService(tmp_path / "identity")
    claimed = threading.Event()
    delivered = threading.Event()
    callbacks = []
    def renew(op, identity):
        assert op == "attempt-1"
        assert identity["instance_id"] == service.instance_id
        claimed.set()
        return True
    def execute(*_):
        assert claimed.is_set()
        return {"content": "Finished report"}
    def callback(op, payload):
        callbacks.append(payload)
        delivered.set()
    monkeypatch.setattr(worker, "_renew_lease", renew)
    monkeypatch.setattr(worker, "sync_cloud_input", lambda *_: "resume")
    monkeypatch.setattr(worker, "execute_operation", execute)
    monkeypatch.setattr(worker, "_post_callback", callback)
    assert service.submit(envelope()) == (True, "accepted")
    assert delivered.wait(3)
    assert callbacks[0]["instance_id"] == service.instance_id
    assert callbacks[0]["worker_id"] == service.worker_id


def test_completion_saved_before_delivery_and_replayed_after_restart(tmp_path, monkeypatch):
    payload = {"schema_version": 1, "instance_id": "old-instance", "status": "succeeded", "result": {"content": "Done"}}
    monkeypatch.setattr(worker.time, "sleep", lambda *_: None)
    def unavailable(op, body):
        assert json.loads((worker._recovery_dir() / f"{op}.json").read_text()) == payload
        raise requests.ConnectionError("Disconnected")
    monkeypatch.setattr(worker, "_send_callback", unavailable)
    with pytest.raises(RuntimeError, match="automatic recovery"):
        worker._post_callback("attempt-1", payload)
    delivered = []
    monkeypatch.setattr(worker, "_send_callback", lambda op, body: delivered.append((op, body)) or True)
    restarted = CloudExecutionService(tmp_path / "identity")
    restarted.recover_callbacks()
    assert delivered == [("attempt-1", payload)]
    assert not (worker._recovery_dir() / "attempt-1.json").exists()


def test_expired_result_is_retained_as_diagnostic_and_not_replayed(tmp_path, monkeypatch):
    payload = {"status": "succeeded", "instance_id": "old-instance"}
    path = worker._persist_callback("attempt-1", payload)
    monkeypatch.setattr(worker.requests, "post", lambda *_args, **_kwargs: type("Response", (), {"status_code": 409})())
    assert worker._send_callback("attempt-1", payload) is False
    assert not path.exists()
    assert json.loads((path.parent / "rejected" / path.name).read_text()) == payload
    monkeypatch.setattr(worker, "_send_callback", lambda *_: pytest.fail("Replayed a rejected result"))
    CloudExecutionService(tmp_path / "identity").recover_callbacks()


def test_heartbeat_retries_network_errors_and_detects_lost_ownership(tmp_path, monkeypatch):
    service = CloudExecutionService(tmp_path / "identity")
    class ImmediateWait:
        def wait(self, _seconds):
            return False
    lost = threading.Event()
    calls = []
    def renew(*_):
        calls.append(1)
        if len(calls) == 1:
            raise requests.ConnectionError("Transient")
        return False
    monkeypatch.setattr(worker, "_renew_lease", renew)
    service._heartbeat_loop("attempt-1", {}, ImmediateWait(), lost)
    assert len(calls) == 2
    assert lost.is_set()
