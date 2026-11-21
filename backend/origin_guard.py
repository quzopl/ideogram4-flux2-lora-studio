"""Request-origin guard for the local API (CSRF and DNS rebinding).

The server listens on loopback only, but any website open in the user's browser
can still reach it: a cross-site `fetch(..., {mode: "no-cors"})` POST needs no
preflight, and FastAPI parses an untyped body as JSON. DNS rebinding goes
further: the foreign page makes same-origin requests, with a foreign `Host`.

For every `/api/*` request this pure ASGI middleware (no response buffering, so
streamed downloads are unaffected) enforces:
  1. `Host` must be loopback (or listed in `extra_hosts`) -> blocks rebinding.
  2. For state-changing methods, a present `Origin` must be loopback (any port,
     so a Vite dev server works); `Origin: null` is rejected.
  3. For state-changing methods, `Sec-Fetch-Site: cross-site` is rejected.
Requests without `Origin` (curl, scripts, tests) pass if `Host` is fine.
Static frontend files are not guarded.
"""
from __future__ import annotations

import json
from urllib.parse import urlsplit

_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _bare_host(value: str) -> str:
    """Lowercase host without port; brackets around IPv6 removed."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[1:].split("]", 1)[0]
    if value.count(":") == 1:  # host:port (a bare IPv6 has several colons)
        return value.split(":", 1)[0]
    return value


def is_loopback_host(host: str) -> bool:
    """True for 127.0.0.1 / localhost / ::1 (with or without port), else False."""
    return _bare_host(host) in _LOOPBACK


class OriginGuard:
    def __init__(self, app, extra_hosts=()):
        self.app = app
        self.extra_hosts = {_bare_host(h) for h in extra_hosts if h.strip()}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
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
                cross = cross or origin.strip().lower() == "null" or not is_loopback_host(
                    urlsplit(origin).netloc.rpartition("@")[2])
            if cross:
                await self._deny(send, "Cross-origin request blocked.")
                return
        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(send, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
