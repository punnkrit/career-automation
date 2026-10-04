"""Bounded, public-only image retrieval for the optional workstation worker.

Images are temporary Codex inputs, never an application source of truth.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlsplit


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str):
        super().__init__(hostname, timeout=12, context=ssl.create_default_context())
        self.address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def public_address(url: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Only public HTTPS sources on port 443 are supported.")
    addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("Source does not resolve exclusively to public addresses.")
    return host, sorted(addresses)[0]


def fetch_public(url: str, limit: int = 2_000_000) -> tuple[str, str, bytes]:
    for _ in range(4):
        host, address = public_address(url)
        parsed = urlsplit(url)
        # Pin the validated IP and verify TLS against the original hostname.
        # No cookies, application credentials, environment proxies or auth headers.
        conn = _PinnedHTTPS(host, address)
        try:
            conn.request("GET", (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""),
                         headers={"User-Agent": "CareerAutomation-Research/1", "Accept-Encoding": "identity"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                target = response.getheader("Location")
                if not target:
                    raise ValueError("Redirect omitted its destination.")
                url = urljoin(url, target)
                continue
            if response.status != 200:
                raise ValueError(f"Source returned HTTP {response.status}.")
            body = response.read(limit + 1)
            if len(body) > limit:
                raise ValueError("Source exceeds the research download limit.")
            return url, response.getheader("Content-Type", "").split(";")[0].lower(), body
        finally:
            conn.close()
    raise ValueError("Too many source redirects.")


class ImageAssets(HTMLParser):
    def __init__(self, page_url: str):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.assets: dict[str, dict[str, str]] = {}
        self.picture_urls: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = dict(attrs)
        if tag == "picture":
            self.picture_urls = []
        values = []
        if tag in {"img", "source"}:
            values.extend(data.get(key) or "" for key in ("src", "data-src", "data-lazy-src"))
            for key in ("srcset", "data-srcset"):
                values.extend(part.strip().split()[0] for part in (data.get(key) or "").split(",") if part.strip())
        if tag == "a" and any((data.get("href") or "").lower().split("?")[0].endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp")):
            values.append(data["href"] or "")
        for value in values:
            url = urljoin(self.page_url, value)
            if value and url.startswith("https://"):
                item = self.assets.setdefault(url, {"url": url, "source_url": self.page_url, "alt": ""})
                if data.get("alt"):
                    item["alt"] = data["alt"]
                if self.picture_urls is not None:
                    self.picture_urls.append(url)
        if tag == "img" and data.get("alt") and self.picture_urls is not None:
            for url in self.picture_urls:
                self.assets[url]["alt"] = data["alt"]

    def handle_endtag(self, tag: str) -> None:
        if tag == "picture":
            self.picture_urls = None


def asset_identity(url: str) -> str:
    """Group optimizer sizes without changing the exact source URL."""
    parsed = urlsplit(url)
    query = parse_qs(parsed.query)
    for key in ("href", "url", "src"):
        if query.get(key):
            return urljoin(url, query[key][0])
    return f"{parsed.netloc}{parsed.path}"


def raster_suffix(content_type: str, body: bytes) -> str:
    if content_type not in {"image/png", "image/jpeg", "image/webp", "application/octet-stream"}:
        raise ValueError("Source did not serve a supported raster image.")
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if body.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        return ".webp"
    raise ValueError("Source body is not a PNG, JPEG or WebP image.")


def prepare_visual_inputs(evidence: dict, directory: Path) -> tuple[dict, list[Path]]:
    urls = [evidence.get("website", "")]
    for product in evidence.get("explainer", {}).get("products", []):
        urls.extend(product.get("source_urls", []))
    pages, candidates = [], {}
    for url in list(dict.fromkeys(filter(None, urls)))[:6]:
        try:
            final_url, content_type, body = fetch_public(url)
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise ValueError("Source was not an HTML page.")
            parser = ImageAssets(final_url)
            parser.feed(body.decode("utf-8", errors="replace"))
            candidates.update(parser.assets)
            pages.append({"url": final_url, "status": "fetched", "image_count": len(parser.assets)})
        except (OSError, ValueError, http.client.HTTPException) as exc:
            pages.append({"url": url, "status": "unavailable", "reason": str(exc)[:160]})

    def relevance(item: dict) -> int:
        text = (item["alt"] + " " + unquote(item["url"])).lower()
        return sum(word in text for word in ("diagram", "architecture", "pipeline", "interface", "screenshot", "dashboard", "product")) - 3 * sum(word in text for word in ("logo", "badge", "avatar", "icon", "background"))

    ordered = sorted(candidates.values(), key=relevance, reverse=True)[:40]
    paths = []
    attached_assets: set[str] = set()
    # Attach a small set of promising current images so Codex can inspect pixels
    # even when its web tool only exposes URLs or a stale cached image.
    attempts = 0
    for item in ordered:
        if len(paths) == 4:
            break
        identity = asset_identity(item["url"])
        if relevance(item) < 0 or identity in attached_assets:
            continue
        if attempts == 8:
            break
        attempts += 1
        try:
            _, mime, body = fetch_public(item["url"], limit=8_000_000)
            suffix = raster_suffix(mime, body)
            path = directory / f"visual-{len(paths) + 1}{suffix}"
            path.write_bytes(body)
            paths.append(path)
            attached_assets.add(identity)
            item["attachment"] = f"Image {len(paths)}: {path.name}"
        except (OSError, ValueError, http.client.HTTPException) as exc:
            item["retrieval_error"] = str(exc)[:160]
    return {"pages_fetched_now": pages, "image_candidates": ordered}, paths


def verify_selected_images(result: dict) -> None:
    for media in result.get("media", []):
        if media.get("kind") == "image":
            try:
                _, mime, body = fetch_public(media["url"], limit=8_000_000)
                raster_suffix(mime, body)
            except (OSError, ValueError, http.client.HTTPException) as exc:
                raise ValueError(f"Selected image is not currently usable: {media['url']} ({exc})") from exc
