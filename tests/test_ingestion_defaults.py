import io
import json
import sys

import pytest

from career_workflow import cli


@pytest.mark.parametrize(
    "analysis_value,flags,dispatch,wait",
    [
        (None, [], True, False),
        (False, [], False, False),
        (True, [], True, True),
        (False, ["--queue-analysis"], True, False),
        (True, ["--queue-analysis"], True, False),
        (None, ["--no-analyze"], False, False),
        (True, ["--no-analyze"], False, False),
        (None, ["--analyze"], True, True),
    ],
)
def test_ingestion_analysis_modes(monkeypatch, capsys, analysis_value, flags, dispatch, wait):
    payload = {"title": "Role", "company": "Company", "description": "Full posting", "lane": "ai_solutions"}
    if analysis_value is not None:
        payload["analyze"] = analysis_value
    calls = []
    waits = []

    def site_json(method, path, *, payload=None):
        calls.append((method, path, payload))
        if method == "GET":
            return {"analysis": {"decision": "apply"}}
        return {"job_id": "saved-job", "created": True, "job": {},
                "analysis_operation": {"operation_id": "accepted"}, "analysis_created": True}

    monkeypatch.setattr(cli, "site_api_configured", lambda: True)
    monkeypatch.setattr(cli, "site_json", site_json)
    monkeypatch.setattr(cli, "wait_for_site_operation", lambda operation: waits.append(operation))
    monkeypatch.setattr(cli, "ingest_manual_job_payload", lambda *_: pytest.fail("Unexpected local write"))
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(sys, "argv", ["career", "ingest-job", "--json", "-", *flags])
    cli.main()
    assert calls[0][2]["analyze"] is dispatch
    assert bool(waits) is wait
    assert json.loads(capsys.readouterr().out)["job_id"] == "saved-job"


def test_default_ingestion_returns_when_worker_does_not_accept(monkeypatch, capsys):
    monkeypatch.setattr(cli, "site_api_configured", lambda: True)
    monkeypatch.setattr(cli, "site_json", lambda *a, **kw: {
        "job_id": "saved-offline", "created": True, "job": {},
        "analysis_operation": None, "analysis_created": False,
    })
    monkeypatch.setattr(cli, "wait_for_site_operation", lambda *_: pytest.fail("Must not wait"))
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"description": "Full posting", "lane": "ai_solutions"})))
    monkeypatch.setattr(sys, "argv", ["career", "ingest-job", "--json", "-"])
    cli.main()
    result = json.loads(capsys.readouterr().out)
    assert result["job_id"] == "saved-offline"
    assert result["analysis_created"] is False
