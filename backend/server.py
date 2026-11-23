"""FastAPI app for FLUX LoRA Studio: wires the routers together.

The routes live in the ``api_*`` modules and the shared state in ``core``.
This module creates the app, adds the origin guard and the no-cache
middleware, includes the routers in order and serves the built SPA last.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from starlette.routing import Match

from . import api_models as models_api, api_settings
from . import api_comfy, api_dataset, api_ideogram, api_prompts, api_system, api_upscale
from .origin_guard import OriginGuard
from . import core, hf_auth

WEB_DIST = core.ROOT / "web" / "dist"
_NOT_BUILT = (
    "<!doctype html><title>FLUX LoRA Studio</title>"
    "<h1>The web UI is not built</h1>"
    "<p>Build it once, then reload:</p>"
    "<pre>cd web && pnpm install && pnpm build</pre>")

app = FastAPI(title="Ideogram4 FLUX2 LoRA — dataset & prompt studio")
# Extra allowed Host values (tests set "testserver"); empty in normal use.
app.add_middleware(OriginGuard, extra_hosts=[
    h for h in os.environ.get("FLUX_PREP_EXTRA_HOSTS", "").split(",") if h.strip()])


@app.middleware("http")
async def _no_cache_frontend(request, call_next):
    """No browser caching for the frontend — the UI is always fresh after updates.

    'no-cache' forces revalidation (ETag/Last-Modified), so unchanged files
    still go out as 304 — no cost, no stale app.js. Every HTML response gets it
    (the SPA index under any deep link), so a rebuilt web/dist is
    never paired with a cached index.html that names vanished assets.
    """
    response = await call_next(request)
    path = request.url.path
    if (path == "/" or path.endswith((".html", ".js", ".css"))
            or response.headers.get("content-type", "").startswith("text/html")):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(api_system.router)
app.include_router(api_dataset.router)
app.include_router(api_upscale.router)
app.include_router(api_comfy.router)
app.include_router(api_prompts.router)
app.include_router(api_ideogram.router)


app.include_router(api_settings.router)
models_api.configure(core._model_ctx, lambda: hf_auth.load_token(core.HF_TOKEN_PATH))
app.include_router(models_api.router)


# --------------------------------------------------------------------------- #
# Frontend (mounted last so it doesn't shadow /api routes)
# --------------------------------------------------------------------------- #
@app.get("/legacy", include_in_schema=False)
@app.get("/legacy/{rest:path}", include_in_schema=False)
def legacy_redirect(rest: str = ""):
    """The classic UI is gone; old bookmarks land in the app."""
    return RedirectResponse("/", 307)


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str, request: Request):
    """The v2 SPA: real files from web/dist, index.html for every other route.

    A missing file under assets/ is a 404: a stale page asking for a hashed
    bundle of an older build must not get index.html back as JavaScript.
    """
    if path.startswith("api/"):
        # An API route that exists for another method is a 405, not a 404.
        if any(getattr(r, "path", "") != "/{path:path}"
               and r.matches(request.scope)[0] == Match.PARTIAL
               for r in app.routes):
            raise HTTPException(405, "Method not allowed.")
        raise HTTPException(404, "Not found.")
    root = WEB_DIST.resolve()
    try:
        target = (WEB_DIST / path).resolve()
        found = bool(path) and target.is_file() and target.is_relative_to(root)
    except ValueError:  # e.g. a NUL byte in the path
        found = False
    if found:
        return FileResponse(str(target))
    if path.startswith("assets/"):
        raise HTTPException(404, "Not found.")
    index = WEB_DIST / "index.html"
    if not index.is_file():
        return HTMLResponse(_NOT_BUILT, 503, headers={"Cache-Control": "no-cache"})
    return FileResponse(str(index))
