from types import SimpleNamespace
import tempfile

from career_workflow import context, worker, codex_runner


def test_token_does_not_appear_in_process_arguments(monkeypatch):
    monkeypatch.setattr(worker, "_resolve_command", lambda _: "cloudflared")
    args, env = worker.tunnel_command({"TUNNEL_TOKEN": "not-a-real-token"})
    assert "not-a-real-token" not in " ".join(args)
    assert env["TUNNEL_TOKEN"] == "not-a-real-token"


def test_token_file_takes_precedence(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "_resolve_command", lambda _: "cloudflared")
    token = tmp_path / "token"; token.write_text("test")
    args, env = worker.tunnel_command({"TUNNEL_TOKEN_FILE": str(token), "TUNNEL_TOKEN": "unused"})
    assert args[-2:] == ["--token-file", str(token)]
    assert "TUNNEL_TOKEN" not in env


def test_context_is_scoped_and_restored(tmp_path, monkeypatch):
    monkeypatch.setattr(context, "ensure_runtime_dirs", lambda: SimpleNamespace(profile_dir=tmp_path))
    def read_generic_config(name):
        assert name in {"config/lanes.yaml", "config/resume_rules.md", "config/cover_letter_rules.md"}
        return "local:" + name
    monkeypatch.setattr(context, "read_repo_file", read_generic_config)
    with context.operation_resume_context("outer resume", {"background": "outer", "preferences": "remote"}):
        assert context.load_candidate_context()["background"] == "outer"
        with context.operation_resume_context("inner resume", {"background": "inner", "preferences": "onsite"}):
            value = context.load_candidate_context()
            assert value["resume_text"] == "inner resume"
            assert value["background"] == "inner"
            assert value["preferences"] == "onsite"
        assert context.load_candidate_context()["background"] == "outer"
        assert context.load_candidate_context()["preferences"] == "remote"
    assert context.load_candidate_context()["background"] == ""
    assert context.load_candidate_context()["preferences"] == ""
    assert context.load_candidate_context()["resume_text"] == ""


def test_codex_uses_platform_temp_and_does_not_borrow_auth(monkeypatch):
    monkeypatch.delenv("CODEX_HOME", raising=False)
    env = codex_runner.isolated_codex_env()
    assert env["TEMP"] == tempfile.gettempdir()
    assert "CODEX_HOME" not in env


def test_worker_stops_both_children_when_interrupted(monkeypatch):
    children = []
    class Child:
        stopped = False
        def poll(self): return 0 if self.stopped else None
        def terminate(self): self.stopped = True
        def wait(self, timeout=None): return 0
    def start(*args, **kwargs):
        child = Child(); children.append(child); return child
    def interrupt(_): raise KeyboardInterrupt
    monkeypatch.setattr(worker, "load_dotenv", lambda: None)
    monkeypatch.setattr(worker, "doctor_main", lambda _: 0)
    monkeypatch.setattr(worker, "tunnel_command", lambda _: (["cloudflared"], {}))
    monkeypatch.setattr(worker.subprocess, "Popen", start)
    monkeypatch.setattr(worker.time, "sleep", interrupt)
    assert worker.main(["run"]) == 0
    assert len(children) == 2 and all(child.stopped for child in children)


def test_failed_tunnel_launch_stops_api(monkeypatch):
    children = []
    class Child:
        stopped = False
        def poll(self): return 0 if self.stopped else None
        def terminate(self): self.stopped = True
        def wait(self, timeout=None): return 0
    def start(*args, **kwargs):
        if children: raise OSError("missing executable")
        child = Child(); children.append(child); return child
    monkeypatch.setattr(worker, "load_dotenv", lambda: None)
    monkeypatch.setattr(worker, "doctor_main", lambda _: 0)
    monkeypatch.setattr(worker, "tunnel_command", lambda _: (["cloudflared"], {}))
    monkeypatch.setattr(worker.subprocess, "Popen", start)
    assert worker.main(["run"]) == 1
    assert children[0].stopped
