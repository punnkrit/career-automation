import socket
from types import SimpleNamespace

import pytest

from career_workflow import visual_assets as assets


PNG = b"\x89PNG\r\n\x1a\nfixture"


def test_picture_alt_and_optimizer_urls_survive_discovery():
    parser = assets.ImageAssets("https://example.com/product")
    parser.feed('<picture><source srcset="/_image?href=%2Fpipeline.png&amp;w=900 900w"><img src="/pipeline.png" alt="Product architecture"></picture><img data-src="./interface.png" alt="Dashboard">')
    candidate = parser.assets["https://example.com/_image?href=%2Fpipeline.png&w=900"]
    assert candidate["alt"] == "Product architecture"
    assert "https://example.com/interface.png" in parser.assets
    assert assets.asset_identity(candidate["url"]) == "https://example.com/pipeline.png"


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])
def test_private_or_mixed_dns_answers_are_rejected(monkeypatch, address):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(0, 0, 0, "", ("8.8.8.8", 443)), (0, 0, 0, "", (address, 443))])
    with pytest.raises(ValueError, match="public addresses"):
        assets.public_address("https://example.com/image")


def test_redirect_is_revalidated_before_connecting(monkeypatch):
    requested = []
    def resolve(url):
        requested.append(url)
        if "127.0.0.1" in url:
            raise ValueError("private redirect")
        return "example.com", "8.8.8.8"
    monkeypatch.setattr(assets, "public_address", resolve)
    response = SimpleNamespace(status=302, getheader=lambda key: "https://127.0.0.1/secret")
    monkeypatch.setattr(assets, "_PinnedHTTPS", lambda *a: SimpleNamespace(request=lambda *a, **kw: None, getresponse=lambda: response, close=lambda: None))
    with pytest.raises(ValueError, match="private redirect"):
        assets.fetch_public("https://example.com/image")
    assert requested == ["https://example.com/image", "https://127.0.0.1/secret"]


def test_current_diagram_is_attached_before_decorative_images(monkeypatch, tmp_path):
    page = "https://example.com/"
    diagram = page + "_image?href=%2Farchitecture.png&w=1200"
    html = '<img src="/hero.webp"><img src="/_image?href=%2Farchitecture.png&w=1200"><img src="/_image?href=%2Farchitecture.png&w=600">'
    monkeypatch.setattr(assets, "fetch_public", lambda url, **kw: (url, "text/html", html.encode()) if url == page else (url, "image/png", PNG))
    result, paths = assets.prepare_visual_inputs({"website": page}, tmp_path)
    attached = [x for x in result["image_candidates"] if "attachment" in x]
    assert attached[0]["url"] == diagram
    assert len(attached) == 2  # responsive sizes share one attachment
    assert paths[0].read_bytes() == PNG


@pytest.mark.parametrize("failure", ["404", "html", "fake_image"])
def test_selected_images_must_still_serve_image_bytes(monkeypatch, failure):
    def fetch(url, **kw):
        if failure == "404":
            raise ValueError("Source returned HTTP 404.")
        return url, "text/html" if failure == "html" else "image/png", b"<html>Not found</html>"
    monkeypatch.setattr(assets, "fetch_public", fetch)
    with pytest.raises(ValueError, match="not currently usable"):
        assets.verify_selected_images({"media": [{"kind": "image", "url": "https://example.com/stale.png"}]})


def test_codex_receives_image_attachments(monkeypatch, tmp_path):
    from career_workflow import codex_runner
    monkeypatch.delenv("CAREER_MOCK_CODEX", raising=False)
    monkeypatch.setattr(codex_runner, "ensure_runtime_dirs", lambda: SimpleNamespace(repo_root=tmp_path, runs_dir=tmp_path))
    calls = []
    monkeypatch.setattr(codex_runner.subprocess, "run", lambda args, **kw: calls.append(args))
    image = tmp_path / "current-image.png"
    image.write_bytes(PNG)
    codex_runner.run_codex("Inspect this", "company_research_visuals", input_images=[image])
    assert calls[0][calls[0].index("--image") + 1] == str(image)
    assert calls[0][-1] == "-"


def test_broken_selection_gets_one_corrective_retry(monkeypatch, tmp_path):
    import json
    from career_workflow import networking
    from test_research_visuals import reviewed_image
    monkeypatch.delenv("CAREER_MOCK_CODEX", raising=False)
    monkeypatch.setattr(networking, "ensure_runtime_dirs", lambda: SimpleNamespace(repo_root=tmp_path))
    monkeypatch.setattr(networking, "prepare_visual_inputs", lambda *a: ({"current": True}, []))
    monkeypatch.setattr(networking, "apply_visual_research", lambda evidence, visual: visual)
    prompts, recorded = [], []
    def run(prompt, **kw):
        prompts.append(prompt)
        return SimpleNamespace(status="success", text=json.dumps(reviewed_image()), prompt_path=tmp_path / "prompt", output_path=tmp_path / "output", error="")
    def verify(visual):
        if len(prompts) == 1:
            raise ValueError("Selected image is not currently usable: stale URL")
    monkeypatch.setattr(networking, "run_codex", run)
    monkeypatch.setattr(networking, "verify_selected_images", verify)
    monkeypatch.setattr(networking, "record_run", lambda *args: recorded.append(args[-2]))
    result = networking.research_company_visuals(None, "Example", "example", {})
    assert result["media"]
    assert len(prompts) == 2 and "stale URL" in prompts[1]
    assert recorded == ["failed", "success"]
