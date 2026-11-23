"""FastAPI backend for the FLUX LoRA dataset preparation tool.

Flow:
  1. /api/scan or /api/upload  -> point the tool at a set of source images
  2. /api/process              -> start a background job (resize + caption)
  3. /api/job/{id}             -> poll progress and review/edit captions
  4. /api/export               -> write the final dataset (images + .txt files)
"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Literal

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from starlette.routing import Match
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import api_models as models_api, api_settings
from . import api_dataset, api_system, api_upscale
from .origin_guard import OriginGuard
from . import (captioner, comfy_client, comfy_workflows, core, florence, hf_auth,
               ideogram_workflow, lmstudio, prompts, v15_lint)

WEB_DIST = core.ROOT / "web" / "dist"
_NOT_BUILT = (
    "<!doctype html><title>FLUX LoRA Studio</title>"
    "<h1>The web UI is not built</h1>"
    "<p>Build it once, then reload:</p>"
    "<pre>cd web && pnpm install && pnpm build</pre>")

# In-memory cache for ComfyUI's /object_info (megabytes of schema — fetched lazily).
_OBJECT_INFO_CACHE: dict = {"url": None, "data": None, "ts": 0.0}
_OBJECT_INFO_TTL = 300.0  # seconds

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


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class PromptJobRequest(BaseModel):
    """The background prompt job's request, strictly validated."""
    text: str
    action: Literal["expand", "refine"] = "expand"
    subject: Literal["auto", "person", "product", "landscape", "architecture"] = "auto"
    model: str = captioner.DEFAULT_MODEL
    quant: Literal["4bit", "none"] = "4bit"
    max_tokens: int = Field(768, ge=64, le=8192)
    caption_format: Literal["flux", "ideogram", "aitoolkit"] = "flux"
    elements_detail: Literal["few", "balanced", "detailed", "maximal"] = "balanced"
    desc_detail: Literal["brief", "balanced", "rich"] = "balanced"


class PromptLintRequest(BaseModel):
    prompt: str = ""


class LibrarySaveRequest(BaseModel):
    category: str            # "flux" | "ideogram"
    prompt: str
    input_text: str = ""
    action: str = "manual"


# --------------------------------------------------------------------------- #
# ComfyUI integration
# --------------------------------------------------------------------------- #
def _load_comfy_config() -> dict:
    if not core.COMFY_CONFIG_PATH.exists():
        return {"url": comfy_client.DEFAULT_URL, "workflow": None, "mapping": None}
    try:
        return json.loads(core.COMFY_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"url": comfy_client.DEFAULT_URL, "workflow": None, "mapping": None}


_COMFY_CONFIG_LOCK = threading.Lock()


def _save_comfy_config(cfg: dict) -> None:
    """Atomic write: temp file in the same folder, fsync, then os.replace."""
    tmp = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=core.COMFY_CONFIG_PATH.parent,
                                      delete=False, suffix=".tmp")
    try:
        with tmp:
            json.dump(cfg, tmp, indent=2)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp.name, core.COMFY_CONFIG_PATH)
    except BaseException:
        Path(tmp.name).unlink(missing_ok=True)
        raise


def _update_comfy_config(fn: Callable[[dict], None]) -> dict:
    """The only write path for comfy_config.json: load, apply ``fn``, save, all
    under one lock so concurrent requests never lose each other's changes. An
    exception from ``fn`` aborts without writing."""
    with _COMFY_CONFIG_LOCK:
        cfg = _load_comfy_config()
        fn(cfg)
        _save_comfy_config(cfg)
        return cfg


class ComfyUrlRequest(BaseModel):
    url: str


class ComfyMappingRequest(BaseModel):
    mapping: dict


@app.get("/api/comfy/config")
def api_comfy_config():
    cfg = _load_comfy_config()
    # Don't ship the (potentially huge) workflow blob on every poll — just flags.
    return {
        "url": cfg.get("url") or comfy_client.DEFAULT_URL,
        "has_workflow": bool(cfg.get("workflow")),
        "workflow_node_count": len(cfg.get("workflow") or {}),
        "mapping": cfg.get("mapping"),
    }


@app.post("/api/comfy/url")
def api_comfy_set_url(req: ComfyUrlRequest):
    url = req.url.strip().rstrip("/")
    _update_comfy_config(lambda cfg: cfg.update(url=url))
    # A new (or the same, restarted) ComfyUI may have other nodes: refetch schemas.
    _OBJECT_INFO_CACHE.update({"url": None, "data": None, "ts": 0.0})
    return {"url": url}


@app.post("/api/comfy/test")
def api_comfy_test():
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    try:
        stats = comfy_client.system_stats(url)
        return {"ok": True, "url": url, "stats": stats}
    except comfy_client.ComfyError as e:
        raise HTTPException(502, str(e))


@app.post("/api/comfy/workflow")
async def api_comfy_workflow(file: UploadFile):
    """Upload a workflow file (JSON or ComfyUI-generated PNG) and auto-detect slots."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        workflow = comfy_workflows.extract_auto(file.filename or "", raw)
        mapping = comfy_workflows.autodetect_mapping(workflow)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Failed to read the workflow: {e}")

    await run_in_threadpool(_update_comfy_config,
                            lambda cfg: cfg.update(workflow=workflow, mapping=mapping))
    return {
        "node_count": len(workflow),
        "mapping": mapping,
        "source": "png" if (file.filename or "").lower().endswith(".png") else "json",
        "current_prompt": comfy_workflows.extract_current_prompt(workflow, mapping),
    }


@app.post("/api/comfy/mapping")
def api_comfy_mapping(req: ComfyMappingRequest):
    """User can manually fix the auto-detected mapping if anything was wrong."""
    def apply(cfg: dict) -> None:
        if not cfg.get("workflow"):
            raise HTTPException(400, "Upload a workflow first.")
        cfg["mapping"] = req.mapping

    return {"mapping": _update_comfy_config(apply)["mapping"]}


@app.get("/api/comfy/loras")
def api_comfy_loras():
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    try:
        return {"loras": comfy_client.list_loras(url)}
    except comfy_client.ComfyError as e:
        raise HTTPException(502, str(e))


class ComfyGenerateRequest(BaseModel):
    prompt: str
    negative: str = ""
    width: int | None = None
    height: int | None = None
    steps: int | None = None
    cfg: float | None = None
    seed: int | None = None        # None → random
    loras: list[str] = []          # one filename per detected LoRA slot
    batch: int = 1


_MODEL_EXTS = (
    ".safetensors", ".ckpt", ".pt", ".pth", ".sft",
    ".gguf", ".bin", ".onnx", ".vae", ".pkl",
)


def _normalize_paths(obj):
    """Recursively convert Windows backslashes to '/' in model-file-looking strings.

    ComfyUI lists loras/checkpoints/etc. with forward slashes (e.g.
    'LORA-flux2/quzopl2500.safetensors'); a workflow saved on Windows may carry
    backslashes, which fail to match ('Lora ... not found, skipping'). Only
    strings that end in a known model extension and contain a backslash are
    touched, so prompts and other text are left alone.
    """
    if isinstance(obj, dict):
        return {k: _normalize_paths(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_paths(v) for v in obj]
    if isinstance(obj, str) and "\\" in obj and obj.lower().endswith(_MODEL_EXTS):
        return obj.replace("\\", "/")
    return obj


def _progress_update(job: dict, value, maxv) -> None:
    """Update job['progress'] and compute sampling speed (it/s) + ETA (seconds).

    Uses an EMA of the *instantaneous* per-step rate (like tqdm), measured
    between consecutive progress events. This tracks the current rate instead
    of a cumulative average — a cumulative average gets dominated by a fast or
    duplicate first event and reads far too high early on. A new sampler phase
    (different `max`) or a value reset re-initialises the tracker; sub-50 ms
    intervals (duplicate/burst events) are skipped so they don't inflate it/s.
    """
    value = value or 0
    maxv = maxv or 0
    now = time.time()
    lv = job.get("_spd_lv")
    lt = job.get("_spd_lt")
    lm = job.get("_spd_lm")

    if lv is None or lm != maxv or value < lv:
        # First event, new phase, or restart — reset the tracker.
        job["_spd_lv"] = value
        job["_spd_lt"] = now
        job["_spd_lm"] = maxv
        job["_spd_ema"] = None
        speed = 0.0
    else:
        dt = now - lt
        dv = value - lv
        if dv > 0 and dt >= 0.05:
            inst = dv / dt
            ema = job.get("_spd_ema")
            job["_spd_ema"] = inst if not ema else (0.3 * inst + 0.7 * ema)
        # Always advance the baseline so skipped bursts aren't double-counted.
        job["_spd_lv"] = value
        job["_spd_lt"] = now
        speed = job.get("_spd_ema") or 0.0

    eta = ((maxv - value) / speed) if (speed > 0 and maxv) else 0.0
    job["progress"] = {
        "value": value,
        "max": maxv,
        "speed": round(speed, 2),
        "eta": round(eta, 1),
    }


def _comfy_prompt_running(url: str, pid: str) -> bool:
    """Whether ComfyUI is executing ``pid`` now (``queue_running`` items are
    [number, prompt_id, ...]). False when the queue cannot be read."""
    try:
        running = comfy_client.queue_info(url).get("queue_running") or []
    except Exception:  # noqa: BLE001 - then only the safe queue delete is sent
        return False
    return any(isinstance(it, list) and len(it) > 1 and it[1] == pid for it in running)


def _comfy_stop(url: str, pid: str, executing: bool) -> None:
    """Interrupt our prompt when it executes, else drop it from the queue.

    ``executing`` comes from the WS events, which can miss the start (the
    socket opens after queueing), so when it is false ComfyUI's queue decides.
    """
    if executing or _comfy_prompt_running(url, pid):
        comfy_client.interrupt(url, pid)
    else:
        comfy_client.delete_queued(url, pid)


def _comfy_stream(job: dict, url: str, client_id: str, pid: str, on_event) -> str | None:
    """Drive ``stream_events`` for a queued prompt, tracking what the cancel
    endpoint needs: ``comfy_url``, ``prompt_id`` and ``executing`` (true only
    while our prompt runs). Returns "error" after a ComfyUI execution error
    (``job["error"]`` holds its text), "cancelled" when the run was cancelled
    or interrupted, else None. WS failures propagate.
    """
    job["comfy_url"] = url  # before prompt_id: the cancel endpoint reads both
    job["prompt_id"] = pid
    job["executing"] = False
    if job.get("cancel"):  # the cancel landed before the prompt id was known
        _comfy_stop(url, pid, False)
        return "cancelled"
    outcome = None

    def handler(kind: str, payload) -> None:
        nonlocal outcome
        if kind == "started":
            job["executing"] = True
        elif kind == "interrupted":
            outcome = "cancelled"
        elif kind == "error":
            outcome = "error"
        on_event(kind, payload)
        if kind == "error":
            job["error"] = str(payload) or "ComfyUI execution error."

    try:
        comfy_client.stream_events(url, client_id, pid, handler,
                                   should_stop=lambda: bool(job.get("cancel")))
    finally:
        job["executing"] = False
    if outcome is None and job.get("cancel"):
        outcome = "cancelled"
    return outcome


def _run_comfy_job(job_id: str, req: ComfyGenerateRequest) -> None:
    """Background worker: queues `batch` prompts, streams progress via WS,
    saves output PNGs to .work/comfy_gallery and updates job state."""
    import random
    import time
    import uuid as _uuid

    job = core.COMFY_JOBS[job_id]
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    workflow = cfg["workflow"]
    mapping = cfg["mapping"]

    batch = max(1, min(req.batch, 8))
    job["total"] = batch
    job["state"] = "running"

    try:
        for i in range(batch):
            if job.get("cancel"):
                job["state"] = "cancelled"
                return
            seed = req.seed if req.seed is not None else random.randint(0, 2**31 - 1)
            if batch > 1 and req.seed is not None:
                seed += i

            patched = comfy_workflows.apply_overrides_multi_lora(
                workflow, mapping, req.loras or [],
                prompt=req.prompt or None,
                negative=req.negative or None,
                seed=seed,
                width=req.width,
                height=req.height,
                steps=req.steps,
                cfg=req.cfg,
            )

            client_id = _uuid.uuid4().hex
            job["current"] = f"Sample {i + 1}/{batch}: queueing…"
            job["progress"] = {"value": 0, "max": req.steps or 0, "speed": 0.0, "eta": 0.0}
            job["_spd_lv"] = None  # re-anchor speed tracker for this sample

            patched = _normalize_paths(patched)  # fix \ -> / paths (lora/ckpt)
            try:
                pid = comfy_client.queue_prompt(url, patched, client_id=client_id)
            except comfy_client.ComfyError as e:
                job["state"] = "error"
                job["error"] = f"Queueing error: {e}"
                return

            # Drive the WS until the prompt is done.
            def on_event(kind: str, payload):
                if kind == "progress":
                    _progress_update(
                        job, payload.get("value"), payload.get("max") or (req.steps or 0)
                    )
                    job["current"] = f"Sample {i + 1}/{batch}: step {payload.get('value')}/{payload.get('max')}"
                elif kind == "executing":
                    if payload.get("node"):
                        job["current_node"] = payload["node"]
                elif kind == "preview":
                    job["preview"] = payload  # raw PNG bytes
                    job["preview_ts"] = time.time()
                elif kind == "error":
                    job["error"] = payload

            try:
                outcome = _comfy_stream(job, url, client_id, pid, on_event)
            except Exception as e:  # noqa: BLE001
                # WS hiccup — fall back to polling /history.
                outcome = None
                job["current"] = f"Sample {i + 1}/{batch}: WS unavailable ({e}), polling history…"
            if outcome:  # "cancelled" | "error"
                job["state"] = outcome
                return

            # Fetch outputs from history (no timeout — wait as long as it takes).
            while True:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    return
                try:
                    hist = comfy_client.history(url, pid)
                except comfy_client.ComfyError as e:
                    job["state"] = "error"
                    job["error"] = f"/history error: {e}"
                    return
                failed = comfy_client.history_failure(hist, pid)
                if failed:  # ("error", text) | ("cancelled", "")
                    job["error"] = failed[1] or job["error"]
                    job["state"] = failed[0]
                    return
                outs = comfy_client.collect_output_images(hist, pid)
                if outs:
                    for o in outs:
                        # Pull bytes once and persist to our gallery dir so the
                        # browser can re-fetch later (and we accumulate history).
                        try:
                            data = comfy_client.fetch_image(
                                url, o["filename"], o["subfolder"], o["type"]
                            )
                        except comfy_client.ComfyError as e:
                            job["error"] = f"/view error: {e}"
                            continue
                        item_id = _uuid.uuid4().hex[:12]
                        out_path = core.COMFY_GALLERY_DIR / f"{item_id}.png"
                        out_path.write_bytes(data)
                        meta = {
                            "id": item_id,
                            "filename": o["filename"],
                            "seed": seed,
                            "prompt": req.prompt,
                            "loras": req.loras,
                            "ts": time.time(),
                            "url": f"/api/comfy/gallery/{item_id}",
                            "source": "lora_test",
                            **_image_size(data),
                        }
                        # Sidecar JSON with metadata (so gallery survives restart).
                        (core.COMFY_GALLERY_DIR / f"{item_id}.json").write_text(
                            json.dumps(meta), encoding="utf-8"
                        )
                        job["images"].append(meta)
                    break
                time.sleep(0.4)

            job["done_count"] = i + 1

        job["preview"] = None
        job["state"] = "done"
        job["current"] = f"Finished ({job['done_count']}/{batch})"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/comfy/generate")
def api_comfy_generate(req: ComfyGenerateRequest):
    cfg = _load_comfy_config()
    if not cfg.get("workflow") or not cfg.get("mapping"):
        raise HTTPException(400, "Upload a workflow first (LoRA test → Workflow).")

    job_id = uuid.uuid4().hex[:12]
    with core.COMFY_JOBS_LOCK:
        core.COMFY_JOBS[job_id] = {
            "id": job_id,
            "state": "pending",
            "total": req.batch,
            "done_count": 0,
            "current": "Starting…",
            "current_node": "",
            "progress": {"value": 0, "max": req.steps or 0},
            "preview": None,
            "preview_ts": 0,
            "images": [],
            "error": "",
            "cancel": False,
        }
    t = threading.Thread(target=_run_comfy_job, args=(job_id, req), daemon=True)
    t.start()
    return {"job_id": job_id}


def _comfy_job_public(job: dict) -> dict:
    return {
        "id": job["id"],
        "state": job["state"],
        "total": job["total"],
        "done_count": job["done_count"],
        "current": job["current"],
        "current_node": job["current_node"],
        "progress": job["progress"],
        "has_preview": job["preview"] is not None,
        "preview_ts": job["preview_ts"],
        "images": job["images"],
        "error": job["error"],
    }


@app.get("/api/comfy/job/{job_id}")
def api_comfy_job(job_id: str):
    job = core.COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    return _comfy_job_public(job)


@app.get("/api/comfy/job/{job_id}/preview")
def api_comfy_job_preview(job_id: str):
    job = core.COMFY_JOBS.get(job_id)
    if not job or job.get("preview") is None:
        raise HTTPException(404, "No preview.")
    return Response(content=job["preview"], media_type="image/png")


@app.post("/api/comfy/job/{job_id}/cancel")
def api_comfy_job_cancel(job_id: str):
    """Stop a render: a queued prompt is deleted from ComfyUI's queue, an
    executing one is interrupted (``/interrupt`` stops whatever runs now, so it
    is sent only while our prompt executes). Before the prompt is queued only
    the flag is set; the runner stops the prompt itself once it gets its id."""
    job = core.COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    if job["state"] in ("done", "error", "cancelled"):
        return {"ok": True}
    # Order matters. `executing` is read before the flag goes up, because the
    # flag ends the stream, which clears it. The prompt id is read after: a
    # runner that records it just before the flag passes its own cancel check,
    # so only this read stops that prompt (a late `executing` is covered by the
    # queue check in _comfy_stop).
    executing = bool(job.get("executing"))
    job["cancel"] = True
    url, pid = job.get("comfy_url"), job.get("prompt_id")
    if url and pid:
        _comfy_stop(url, pid, executing)
    return {"ok": True}


@app.get("/api/comfy/gallery/{item_id}")
def api_comfy_gallery_item(item_id: str):
    p = core.COMFY_GALLERY_DIR / f"{item_id}.png"
    if not p.exists():
        raise HTTPException(404, "No image.")
    return FileResponse(str(p), media_type="image/png")


def _image_size(data: bytes) -> dict:
    """{"width", "height"} of an encoded image; {} when PIL cannot read it."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            return {"width": im.width, "height": im.height}
    except Exception:  # noqa: BLE001
        return {}


def _gallery_order(meta: dict) -> tuple:
    """Newest first, items without a numeric ts last, ties by id."""
    ts = meta.get("ts")
    has_ts = isinstance(ts, (int, float)) and not isinstance(ts, bool)
    return (not has_ts, -ts if has_ts else 0, str(meta.get("id", "")))


@app.get("/api/comfy/gallery")
def api_comfy_gallery_list():
    """Sidecar metadata, newest first. Items written before ``source`` existed
    come from the LoRA test; ``width``/``height`` may be missing on old items."""
    items: list[dict] = []
    for meta_path in core.COMFY_GALLERY_DIR.glob("*.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(meta, dict):
            continue
        meta.setdefault("source", "lora_test")
        items.append(meta)
    items.sort(key=_gallery_order)
    return {"items": items}


@app.delete("/api/comfy/gallery/{item_id}")
def api_comfy_gallery_delete(item_id: str):
    for ext in (".png", ".json"):
        p = core.COMFY_GALLERY_DIR / f"{item_id}{ext}"
        if p.exists():
            p.unlink()
    return {"ok": True}


# ---- Mappings library (named saved mappings) ---- #
class NamedSave(BaseModel):
    name: str
    value: dict | str


def _library_name(raw: str) -> str:
    """A stripped library name; 400 when empty or when it contains "/"."""
    name = raw.strip()
    if not name:
        raise HTTPException(400, "Enter a name.")
    if "/" in name:
        raise HTTPException(400, 'Name must not contain "/".')
    return name


@app.get("/api/comfy/mappings")
def api_comfy_mappings_list():
    return {"items": core._load_named(core.COMFY_MAPPINGS_PATH)}


@app.post("/api/comfy/mappings")
def api_comfy_mappings_save(req: NamedSave):
    name = _library_name(req.name)
    if not isinstance(req.value, dict):
        raise HTTPException(400, "The mapping must be a JSON object.")
    data = core._load_named(core.COMFY_MAPPINGS_PATH)
    data[name] = req.value
    core._save_named(core.COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


@app.delete("/api/comfy/mappings/{name:path}")
def api_comfy_mappings_delete(name: str):
    data = core._load_named(core.COMFY_MAPPINGS_PATH)
    data.pop(name, None)
    core._save_named(core.COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


# ---- Prompt library ---- #
@app.get("/api/comfy/prompts")
def api_comfy_prompts_list():
    return {"items": core._load_named(core.COMFY_PROMPTS_PATH)}


@app.post("/api/comfy/prompts")
def api_comfy_prompts_save(req: NamedSave):
    name = _library_name(req.name)
    data = core._load_named(core.COMFY_PROMPTS_PATH)
    data[name] = req.value if isinstance(req.value, str) else json.dumps(req.value)
    core._save_named(core.COMFY_PROMPTS_PATH, data)
    return {"ok": True, "items": data}


@app.delete("/api/comfy/prompts/{name:path}")
def api_comfy_prompts_delete(name: str):
    data = core._load_named(core.COMFY_PROMPTS_PATH)
    data.pop(name, None)
    core._save_named(core.COMFY_PROMPTS_PATH, data)
    return {"ok": True, "items": data}


# ---- Workflow library (named saved API-format workflows, SQLite-backed) ---- #
def _wf_names() -> list[str]:
    rows = core._db_query("SELECT name FROM workflows ORDER BY name COLLATE NOCASE", many=True)
    return [r[0] for r in rows]


def _wf_upsert(name: str, wf: dict) -> None:
    now = time.time()
    core._db_query(
        """INSERT INTO workflows(name, workflow, node_count, created, updated)
           VALUES (?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
               workflow=excluded.workflow,
               node_count=excluded.node_count,
               updated=excluded.updated""",
        (name, json.dumps(wf), len(wf), now, now),
        write=True,
    )


@app.get("/api/comfy/workflows")
def api_comfy_workflows_list():
    """List saved workflows (metadata only — payloads can be large)."""
    rows = core._db_query(
        "SELECT name, node_count, updated FROM workflows ORDER BY name COLLATE NOCASE",
        many=True,
    )
    items = [
        {"name": r["name"], "node_count": r["node_count"], "updated": r["updated"]}
        for r in rows
    ]
    return {"items": items, "names": [r["name"] for r in rows]}


@app.get("/api/comfy/workflows/{name:path}")
def api_comfy_workflows_get(name: str):
    r = core._db_query("SELECT workflow FROM workflows WHERE name=?", (name,))
    if not r:
        raise HTTPException(404, "Unknown workflow.")
    return {"name": name, "workflow": json.loads(r["workflow"])}


@app.post("/api/comfy/workflows")
def api_comfy_workflows_save(req: NamedSave):
    name = _library_name(req.name)
    if not isinstance(req.value, dict) or not req.value:
        raise HTTPException(400, "The workflow must be a non-empty JSON object.")
    _wf_upsert(name, req.value)
    return {"ok": True, "names": _wf_names()}


@app.post("/api/comfy/workflows/import")
async def api_comfy_workflows_import(file: UploadFile, name: str = Form("")):
    """Import a workflow from an uploaded .json or ComfyUI .png into the library,
    under the typed name (checked as any library name), else the file's."""
    typed = _library_name(name) if name.strip() else ""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        wf = comfy_workflows.extract_auto(file.filename or "", raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Failed to read the workflow: {e}")
    nm = typed or Path(file.filename or "workflow").stem or "workflow"
    _wf_upsert(nm, wf)
    return {
        "ok": True,
        "name": nm,
        "node_count": len(wf),
        "workflow": wf,
        "names": _wf_names(),
    }


@app.delete("/api/comfy/workflows/{name:path}")
def api_comfy_workflows_delete(name: str):
    core._db_query("DELETE FROM workflows WHERE name=?", (name,), write=True)
    return {"ok": True, "names": _wf_names()}


# ---- Editor workflow: surowy workflow + parametry per node ---- #
@app.get("/api/comfy/object_info")
def api_comfy_object_info(refresh: bool = False):
    """Cached passthrough of ComfyUI's /object_info (node schemas);
    ``refresh=1`` skips the cache and stores the fresh copy."""
    import time as _t
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    now = _t.time()
    if (
        not refresh
        and _OBJECT_INFO_CACHE["url"] == url
        and _OBJECT_INFO_CACHE["data"] is not None
        and now - _OBJECT_INFO_CACHE["ts"] < _OBJECT_INFO_TTL
    ):
        return _OBJECT_INFO_CACHE["data"]
    try:
        data = comfy_client.object_info(url)
    except comfy_client.ComfyError as e:
        raise HTTPException(502, str(e))
    _OBJECT_INFO_CACHE.update({"url": url, "data": data, "ts": now})
    return data


@app.post("/api/comfy/editor/load")
async def api_comfy_editor_load(file: UploadFile):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        workflow = comfy_workflows.extract_auto(file.filename or "", raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Failed to read the workflow: {e}")
    await run_in_threadpool(_update_comfy_config,
                            lambda cfg: cfg.update(editor_workflow=workflow))
    return {
        "node_count": len(workflow),
        "workflow": workflow,
        "source": "png" if (file.filename or "").lower().endswith(".png") else "json",
    }


@app.get("/api/comfy/editor/workflow")
def api_comfy_editor_workflow():
    cfg = _load_comfy_config()
    wf = cfg.get("editor_workflow")
    return {"workflow": wf, "node_count": len(wf or {})}


class ComfyEditorGenerate(BaseModel):
    workflow: dict


def _run_comfy_raw_job(job_id: str, workflow: dict, source: str = "editor") -> None:
    """Submit a raw workflow as-is (no mapping/overrides). Used by the editor and
    the Ideogram render; ``source`` labels the gallery items."""
    import time
    import uuid as _uuid

    job = core.COMFY_JOBS[job_id]
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL

    job["total"] = 1
    job["state"] = "running"

    # Pull seed/prompt from the workflow itself for gallery metadata.
    try:
        m = comfy_workflows.autodetect_mapping(workflow)
        gallery_prompt = comfy_workflows.extract_current_prompt(workflow, m)
        gallery_seed = 0
        sn, sf = m.get("seed_node"), m.get("seed_field")
        if sn and sf:
            v = workflow.get(sn, {}).get("inputs", {}).get(sf)
            if isinstance(v, int):
                gallery_seed = v
    except Exception:
        gallery_prompt, gallery_seed = "(editor)", 0

    try:
        client_id = _uuid.uuid4().hex
        job["current"] = "Queueing the workflow…"
        workflow = _normalize_paths(workflow)  # fix \ -> / paths (lora/ckpt)
        try:
            pid = comfy_client.queue_prompt(url, workflow, client_id=client_id)
        except comfy_client.ComfyError as e:
            job["state"] = "error"
            job["error"] = f"Queueing error: {e}"
            return

        def on_event(kind: str, payload):
            if kind == "progress":
                _progress_update(job, payload.get("value"), payload.get("max"))
                job["current"] = f"Step {payload.get('value')}/{payload.get('max')}"
            elif kind == "executing":
                if payload.get("node"):
                    job["current_node"] = payload["node"]
            elif kind == "preview":
                job["preview"] = payload
                job["preview_ts"] = time.time()
            elif kind == "error":
                job["error"] = payload

        try:
            outcome = _comfy_stream(job, url, client_id, pid, on_event)
        except Exception as e:  # noqa: BLE001
            outcome = None
            job["current"] = f"WS unavailable ({e}), polling history…"
        if outcome:  # "cancelled" | "error"
            job["state"] = outcome
            return

        while True:
            if job.get("cancel"):
                job["state"] = "cancelled"
                return
            try:
                hist = comfy_client.history(url, pid)
            except comfy_client.ComfyError as e:
                job["state"] = "error"
                job["error"] = f"/history error: {e}"
                return
            failed = comfy_client.history_failure(hist, pid)
            if failed:  # ("error", text) | ("cancelled", "")
                job["error"] = failed[1] or job["error"]
                job["state"] = failed[0]
                return
            outs = comfy_client.collect_output_images(hist, pid)
            if outs:
                for o in outs:
                    try:
                        data = comfy_client.fetch_image(
                            url, o["filename"], o["subfolder"], o["type"]
                        )
                    except comfy_client.ComfyError as e:
                        job["error"] = f"/view error: {e}"
                        continue
                    item_id = _uuid.uuid4().hex[:12]
                    out_path = core.COMFY_GALLERY_DIR / f"{item_id}.png"
                    out_path.write_bytes(data)
                    meta = {
                        "id": item_id,
                        "filename": o["filename"],
                        "seed": gallery_seed,
                        "prompt": gallery_prompt or "(editor)",
                        "loras": [],
                        "ts": time.time(),
                        "url": f"/api/comfy/gallery/{item_id}",
                        "source": source,
                        **_image_size(data),
                    }
                    (core.COMFY_GALLERY_DIR / f"{item_id}.json").write_text(
                        json.dumps(meta), encoding="utf-8"
                    )
                    job["images"].append(meta)
                break
            time.sleep(0.4)

        job["done_count"] = 1
        job["preview"] = None
        job["state"] = "done"
        job["current"] = "Finished"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/comfy/editor/generate")
def api_comfy_editor_generate(req: ComfyEditorGenerate):
    if not req.workflow:
        raise HTTPException(400, "Empty workflow.")
    # Persist edits as the editor's current workflow.
    _update_comfy_config(lambda cfg: cfg.update(editor_workflow=req.workflow))

    job_id = uuid.uuid4().hex[:12]
    with core.COMFY_JOBS_LOCK:
        core.COMFY_JOBS[job_id] = {
            "id": job_id,
            "state": "pending",
            "total": 1,
            "done_count": 0,
            "current": "Starting…",
            "current_node": "",
            "progress": {"value": 0, "max": 0},
            "preview": None,
            "preview_ts": 0,
            "images": [],
            "error": "",
            "cancel": False,
        }
    t = threading.Thread(target=_run_comfy_raw_job, args=(job_id, req.workflow), daemon=True)
    t.start()
    return {"job_id": job_id}


# --------------------------------------------------------------------------- #
# Prompt library (SQLite) — every generated prompt lands in the database.
# --------------------------------------------------------------------------- #
def _prompt_category(caption_format: str) -> str:
    """Studio format -> library category. ai-toolkit is Ideogram JSON too."""
    return "ideogram" if caption_format in ("ideogram", "aitoolkit") else "flux"


def _save_prompt_to_library(category: str, action: str, input_text: str, prompt: str) -> int:
    """Save a prompt to the library; returns the row id.

    The "ideogram" category accepts valid JSON objects only.
    """
    if category == "ideogram":
        try:
            obj = json.loads(prompt)
        except (json.JSONDecodeError, ValueError):
            obj = None
        if not isinstance(obj, dict):
            raise ValueError("An Ideogram prompt must be a valid JSON object.")
    conn = sqlite3.connect(str(core.DB_PATH))
    try:
        cur = conn.execute(
            "INSERT INTO prompt_library(category, action, input_text, prompt, created) "
            "VALUES (?,?,?,?,?)",
            (category, action, input_text, prompt, time.time()),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


@app.post("/api/prompts/library")
def api_prompt_library_save(req: LibrarySaveRequest):
    """Manual prompt save to the library (e.g. from the bbox editor)."""
    if req.category not in ("flux", "ideogram"):
        raise HTTPException(400, "The category must be 'flux' or 'ideogram'.")
    if not req.prompt.strip():
        raise HTTPException(400, "Empty prompt.")
    try:
        pid = _save_prompt_to_library(
            req.category, req.action, req.input_text, req.prompt.strip())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"id": pid, "warnings": v15_lint.lint_v15(req.prompt)
            if req.category == "ideogram" else []}


@app.get("/api/prompts/library")
def api_prompt_library(category: str = "all"):
    """Saved prompts, newest first; optional category filter."""
    if category in ("flux", "ideogram"):
        rows = core._db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library WHERE category=? ORDER BY id DESC",
            (category,), many=True,
        )
    else:
        rows = core._db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library ORDER BY id DESC",
            many=True,
        )
    return {"prompts": [dict(r) for r in (rows or [])]}


@app.delete("/api/prompts/library/{pid}")
def api_prompt_library_delete(pid: int):
    if not core._db_query("SELECT 1 FROM prompt_library WHERE id=?", (pid,)):
        raise HTTPException(404, "No prompt with that id.")
    core._db_query("DELETE FROM prompt_library WHERE id=?", (pid,), write=True)
    return {"ok": True}


def _sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


@app.get("/api/prompts/library/export")
def api_prompt_library_export(category: str = "all"):
    """Eksport biblioteki jako plik .sql (CREATE TABLE + INSERTy)."""
    rows = api_prompt_library(category)["prompts"]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"-- Prompt library (flux-lora-prep), exported {stamp}, "
        f"category: {category}, items: {len(rows)}",
        "CREATE TABLE IF NOT EXISTS prompt_library (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    category TEXT NOT NULL CHECK (category IN ('flux','ideogram')),",
        "    action TEXT NOT NULL DEFAULT '',",
        "    input_text TEXT NOT NULL DEFAULT '',",
        "    prompt TEXT NOT NULL,",
        "    created REAL NOT NULL",
        ");",
        "",
    ]
    for r in rows:
        lines.append(
            "INSERT INTO prompt_library (id, category, action, input_text, prompt, created) "
            f"VALUES ({r['id']}, {_sql_quote(r['category'])}, {_sql_quote(r['action'])}, "
            f"{_sql_quote(r['input_text'])}, {_sql_quote(r['prompt'])}, {r['created']});"
        )
    body = "\n".join(lines) + "\n"
    fname = f"prompts_{category}_{datetime.now().strftime('%Y%m%d-%H%M%S')}.sql"
    return Response(
        content=body.encode("utf-8"),
        media_type="application/sql; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# --------------------------------------------------------------------------- #
# Ideogram 4 render — built-in workflow (backend/ideogram_workflow.py);
# jobs and gallery shared with the rest of the ComfyUI integration.
# --------------------------------------------------------------------------- #
class IdeogramRenderRequest(BaseModel):
    prompt: str       # minified JSON v15
    params: dict = {}


@app.get("/api/ideogram/render/config")
def api_ideogram_render_config():
    """Last-used render parameters (merged with the defaults)."""
    return {"params": ideogram_workflow.merge_params(core._load_named(core.IDEOGRAM_RENDER_CFG_PATH)),
            "presets": list(ideogram_workflow.PRESETS.keys())}


@app.post("/api/ideogram/render")
def api_ideogram_render(req: IdeogramRenderRequest):
    """Render a v15 prompt with the built-in Ideogram 4 workflow on ComfyUI."""
    try:
        obj = json.loads(req.prompt)
    except (json.JSONDecodeError, ValueError):
        obj = None
    if not isinstance(obj, dict):
        raise HTTPException(400, "The prompt must be a JSON object (v15).")
    params = ideogram_workflow.merge_params(req.params)
    core._save_named(core.IDEOGRAM_RENDER_CFG_PATH, params)
    workflow = ideogram_workflow.build_workflow(req.prompt, params)

    job_id = uuid.uuid4().hex[:12]
    with core.COMFY_JOBS_LOCK:
        core.COMFY_JOBS[job_id] = {
            "id": job_id,
            "state": "pending",
            "total": 1,
            "done_count": 0,
            "current": "Starting…",
            "current_node": "",
            "progress": {"value": 0, "max": 0},
            "preview": None,
            "preview_ts": 0,
            "images": [],
            "error": "",
            "cancel": False,
        }
    t = threading.Thread(target=_run_comfy_raw_job, args=(job_id, workflow),
                         kwargs={"source": "ideogram"}, daemon=True)
    t.start()
    return {"job_id": job_id, "warnings": v15_lint.lint_v15(req.prompt)}


class IdeogramNormalizeRequest(BaseModel):
    text: str


_LEGACY_STYLE_KEYS = ("aesthetics", "lighting", "photo", "art_style", "color_palette")


def _had_legacy_style(obj: dict) -> bool:
    """The pre-v15 ``style_description`` with any non-empty style field."""
    style = obj.get("style_description")
    if not isinstance(style, dict):
        return False
    return any(v.strip() if isinstance(v, str) else bool(v)
               for v in (style.get(k) for k in _LEGACY_STYLE_KEYS))


@app.post("/api/ideogram/normalize")
def api_ideogram_normalize(req: IdeogramNormalizeRequest):
    """Pasted text -> v15 prompt (same normaliser as the LLM endpoints).

    A fully double-encoded paste (the text is a JSON string holding the
    object) is unwrapped once. Text without a JSON object, or JSON without
    a v15 prompt after unwrapping, is a 400.
    """
    text = req.text
    obj = prompts._extract_json_object(text)
    if obj is None:
        try:
            inner = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            inner = None
        if isinstance(inner, str):
            text = inner
            obj = prompts._extract_json_object(text)
    if obj is None:
        raise HTTPException(400, "No JSON object found in the pasted text.")
    obj = prompts._unwrap_v15(obj)
    if "high_level_description" not in obj and "compositional_deconstruction" not in obj:
        raise HTTPException(400, "No Ideogram prompt found in the JSON.")
    prompt = prompts.normalize_ideogram_v15(text)
    return {"prompt": prompt, "warnings": v15_lint.lint_v15(prompt),
            "legacy_style": _had_legacy_style(obj)}


def _vlm_image_to_v15(image, instruction: str, model: str, quant: str,
                      max_tokens: int, default_ratio: str,
                      ensure: Callable[[str], str], job: dict | None = None) -> str:
    """Run the chosen vision model (local or LM Studio) and normalize to v15."""
    lm_id = core._lmstudio_model_id(model)
    if lm_id is not None:
        if job is not None:
            job["state"] = "analyzing"
        raw = lmstudio.caption_image(core._lmstudio_url(), lm_id, image, instruction, max_tokens)
    else:
        if job is not None:
            job["state"] = "loading_model"
        source = ensure(model)
        if job is not None:
            job["current"] = ""  # the download is over; its "100%" must not stay up
        captioner.ensure_loaded(model, quant if quant in ("4bit", "none") else "4bit",
                                source=source)
        if job is not None:
            job["state"] = "analyzing"
        raw = captioner.query_image(image, instruction, max_new_tokens=max_tokens)
    return prompts.normalize_ideogram_v15(raw, default_ratio=default_ratio)


def _florence_analyze(image, ensure: Callable[[str], str], job: dict | None):
    """Florence caption + measured elements; ``job`` follows loading_model -> analyzing."""
    if job is not None:
        job["state"] = "loading_model"
    ensure(florence.DEFAULT_MODEL)
    if job is not None:
        job["current"] = ""
        job["state"] = "analyzing"
    return florence.analyze_image(image)


def _analyze_image(image, engine: str, model: str, quant: str, max_tokens: int,
                   ensure: Callable[[str], str], job: dict | None = None) -> dict:
    """Reference image -> v15 draft: {json, elements, model, warnings}.

    Engines: "florence" (caption + measured bboxes + OCR), "vlm" (the chosen
    vision model drafts the whole JSON, estimating bboxes itself), "hybrid"
    (Florence measures the bboxes/OCR, the vision model writes the v15 prose);
    any other value runs Florence. Blocking; errors propagate to the caller.
    """
    ratio = florence.nearest_aspect(image.width, image.height)
    used_model = florence.DEFAULT_MODEL
    if engine == "vlm":
        draft = _vlm_image_to_v15(image, prompts.build_image_v15_instruction(),
                                  model, quant, max_tokens, ratio, ensure, job)
        used_model = model
    elif engine == "hybrid":
        caption, elements = _florence_analyze(image, ensure, job)
        base = florence.build_v15_draft(caption, elements, image.width, image.height)
        draft = _vlm_image_to_v15(image, prompts.build_hybrid_v15_instruction(base),
                                  model, quant, max_tokens, ratio, ensure, job)
        used_model = f"{florence.DEFAULT_MODEL} + {model}"
    else:
        caption, elements = _florence_analyze(image, ensure, job)
        draft = florence.build_v15_draft(caption, elements, image.width, image.height)
    n_elements = len((json.loads(draft).get("compositional_deconstruction") or {})
                     .get("elements") or [])
    return {"json": draft, "elements": n_elements,
            "model": used_model, "warnings": v15_lint.lint_v15(draft)}


def _decode_image(data: bytes):
    """Decode an upload by content, not MIME (HEIC arrives with an empty type),
    upright as shown (the EXIF orientation applied)."""
    try:
        return ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:  # noqa: BLE001
        return None


def _run_analyze_job(job: dict, image, engine: str, model: str, quant: str,
                     max_tokens: int) -> None:
    try:
        job["result"] = _analyze_image(image, engine, model, quant, max_tokens,
                                       lambda m: core._ensure_model_mapped(m, job), job)
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        if isinstance(e, HTTPException):
            msg = str(e.detail)
        elif isinstance(e, lmstudio.LMStudioError):
            msg = f"LM Studio: {e}"
        else:
            msg = f"Image analysis failed: {e}"
        job["error"] = f"{msg}\n{traceback.format_exc()}"
        job["state"] = "error"


@app.post("/api/ideogram/analyze/jobs")
async def api_ideogram_analyze_job_start(
        file: UploadFile,
        engine: Literal["florence", "vlm", "hybrid"] = Form("florence"),
        model: str = Form(captioner.DEFAULT_MODEL),
        quant: Literal["4bit", "none"] = Form("4bit"),
        max_tokens: int = Form(1536, ge=64, le=8192)):
    """Background image analysis (see _analyze_image); poll the GET route."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "Upload an image file.")
    image = await run_in_threadpool(_decode_image, data)
    if image is None:
        raise HTTPException(400, "Failed to read the image.")
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "kind": "analyze", "state": "pending",
           "current": "", "error": "", "result": None}
    # Florence (florence, hybrid) and local VLMs use our GPU; only LM Studio does not.
    lm_only = engine == "vlm" and core._lmstudio_model_id(model) is not None
    core._start_job(job, _run_analyze_job, (job, image, engine, model, quant, max_tokens),
               local_model=not lm_only)
    return {"job_id": job_id}


@app.get("/api/ideogram/analyze/jobs/{job_id}")
def api_ideogram_analyze_job(job_id: str):
    job = core._job_of_kind(job_id, "analyze")
    return {"state": job["state"], "current": job["current"],
            "error": job["error"], "result": job["result"]}


def _generate_prompt(req: PromptJobRequest, ensure: Callable[[str], str],
                     job: dict | None = None) -> dict:
    """Expand or refine ``req.text`` and save the result to the library.

    ``ensure`` turns a model id into a local path (a job-bound ``_ensure_model_mapped``).
    When ``job`` is given its ``state`` follows loading_model -> generating.
    Returns {prompt, warnings, library_id}; errors propagate to the caller.
    """
    text = req.text.strip()
    quant = req.quant if req.quant in ("4bit", "none") else "4bit"
    if req.caption_format in ("ideogram", "aitoolkit"):
        system = prompts.build_ideogram_studio_v15(
            req.action, req.subject, req.elements_detail, req.desc_detail)
    else:
        system = prompts.build_studio_system(req.action, req.subject)
    lm_id = core._lmstudio_model_id(req.model)
    if lm_id is not None:
        if job is not None:
            job["state"] = "generating"
        raw = lmstudio.generate_text(core._lmstudio_url(), lm_id, system, text, req.max_tokens)
    else:
        if job is not None:
            job["state"] = "loading_model"
        source = ensure(req.model)
        if job is not None:
            job["current"] = ""  # the download is over; its "100%" must not stay up
        captioner.ensure_loaded(req.model, quant, source=source)
        if job is not None:
            job["state"] = "generating"
        raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
    if req.caption_format in ("ideogram", "aitoolkit"):
        final = prompts.normalize_ideogram_v15(raw)
        warnings = v15_lint.lint_v15(final)
    else:
        final = prompts.clean_prompt(raw)
        warnings = []
    library_id = _save_prompt_to_library(
        _prompt_category(req.caption_format), req.action, text, final)
    return {"prompt": final, "warnings": warnings, "library_id": library_id}


def _run_prompt_job(job: dict, req: PromptJobRequest) -> None:
    try:
        res = _generate_prompt(req, lambda m: core._ensure_model_mapped(m, job), job)
        job["result"] = {**res, "format": req.caption_format}
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        if isinstance(e, HTTPException):
            msg = str(e.detail)
        elif isinstance(e, lmstudio.LMStudioError):
            msg = f"LM Studio: {e}"
        else:
            msg = f"Generation error: {e}"
        job["error"] = f"{msg}\n{traceback.format_exc()}"
        job["state"] = "error"


@app.post("/api/prompt/jobs")
def api_prompt_job_start(req: PromptJobRequest):
    if not req.text.strip():
        raise HTTPException(400, "Type a prompt to expand or refine.")
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "kind": "prompt", "state": "pending",
           "current": "", "error": "", "result": None}
    # ensure_loaded swaps the shared model; LM Studio never touches our GPU.
    core._start_job(job, _run_prompt_job, (job, req),
               local_model=core._lmstudio_model_id(req.model) is None)
    return {"job_id": job_id}


@app.get("/api/prompt/jobs/{job_id}")
def api_prompt_job(job_id: str):
    job = core._job_of_kind(job_id, "prompt")
    return {"state": job["state"], "current": job["current"],
            "error": job["error"], "result": job["result"]}


@app.post("/api/prompts/lint")
def api_prompts_lint(req: PromptLintRequest):
    if not req.prompt.strip():
        return {"warnings": []}
    return {"warnings": v15_lint.lint_v15(req.prompt)}


# --------------------------------------------------------------------------- #
# Frontend (mounted last so it doesn't shadow /api routes)
# --------------------------------------------------------------------------- #
app.include_router(api_settings.router)
models_api.configure(core._model_ctx, lambda: hf_auth.load_token(core.HF_TOKEN_PATH))
app.include_router(models_api.router)


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
