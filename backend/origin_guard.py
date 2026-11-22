"""Request-origin guard for the local API (CSRF and DNS rebinding).

The server listens on loopback only, but any website open in the user's browser
can still reach it: a cross-site `fetch(..., {mode: "no-cors"})` POST needs no
preflight, and FastAPI parses an untyped body as JSON. DNS rebinding goes
further: the foreign page makes same-origin requests, with a foreign `Host`.

For every `/api/*` request this pure ASGI middleware (no response buffering, so
streamed downloads are unaffected) enforces:
  1. `Host` must be loopback (or listed in `extra_hosts`) -> blocks rebinding.
  2. For state-changing methods, a present `Origin` must be loopback AND carry
     the same port as the `Host` header (no port means 80 for http, 443 for
     https), or match exactly an entry of `FLUX_PREP_DEV_ORIGINS` (comma
     separated, empty by default: the Vite dev server proxies with
     `changeOrigin: false`, so its Host and Origin share port 5173 and pass
     the same-port rule). Another loopback port is rejected; so is
     `Origin: null`.
  3. For state-changing methods, `Sec-Fetch-Site: cross-site` is rejected.
Requests without `Origin` (curl, scripts, tests) pass if `Host` is fine.
Static frontend files are not guarded.
"""
from __future__ import annotations

import json
import os
import re
from urllib.parse import urlsplit

_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _port(netloc: str, scheme: str) -> int | None:
    """Explicit port of a host[:port] value, else the scheme default; None if malformed."""
    try:
        port = urlsplit(f"//{netloc}").port
    except ValueError:
        return None
    return port or (443 if scheme == "https" else 80)


# host[:port] with a bracketed IPv6 or a plain name; no userinfo, no junk.
_HOST_RE = re.compile(r"^(\[[^\]@\[]+\]|[^:\[\]@]+)(:\d{1,5})?$")


def _bare_host(value: str) -> str:
    """Lowercase host without port, brackets removed; "" if malformed."""
    value = value.strip().lower()
    if value == "::1":  # bare unbracketed IPv6 literal
        return value
    m = _HOST_RE.match(value)
    if not m:
        return ""
    return m.group(1).strip("[]")


def is_loopback_host(host: str) -> bool:
    """True for 127.0.0.1 / localhost / ::1 (with or without port), else False."""
    return _bare_host(host) in _LOOPBACK


def _route_path(scope) -> str:
    """Path as the router sees it: scope["path"] minus root_path (uvicorn --root-path)."""
    path, root = scope["path"], scope.get("root_path", "")
    if root and path.startswith(root):
        if path == root:
            return ""
        if path[len(root)] == "/":
            return path[len(root):]
    return path


class OriginGuard:
    def __init__(self, app, extra_hosts=(), dev_origins=None):
        self.app = app
        if dev_origins is None:
            dev_origins = os.environ.get("FLUX_PREP_DEV_ORIGINS", "").split(",")
        self.dev_origins = {o.strip().rstrip("/").lower() for o in dev_origins if o.strip()}
        self.extra_hosts = {_bare_host(h) for h in extra_hosts if h.strip()}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not _route_path(scope).startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                   for k, v in scope["headers"]}
        host = headers.get("host", "")
        if not (is_loopback_host(host) or _bare_host(host) in self.extra_hosts):
            await self._deny(send, "Forbidden host.")
            return
        if scope["method"] not in _SAFE_METHODS:
            origin = headers.get("origin")
            cross = headers.get("sec-fetch-site", "").lower() == "cross-site"
            if origin is not None:
                cross = cross or not self._origin_ok(origin, host)
            if cross:
                await self._deny(send, "Cross-origin request blocked.")
                return
        await self.app(scope, receive, send)

    def _origin_ok(self, origin: str, host: str) -> bool:
        origin = origin.strip().lower()
        if origin in self.dev_origins:
            return True
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not is_loopback_host(parts.netloc):
            return False
        port = _port(parts.netloc, parts.scheme)
        return port is not None and port == _port(host, parts.scheme)

    @staticmethod
    async def _deny(send, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
