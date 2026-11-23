"""ComfyUI routes: connection, workflows, generation jobs, gallery and the
named mapping / prompt / workflow libraries.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel

from . import comfy_client, comfy_workflows, core

router = APIRouter()


# In-memory cache for ComfyUI's /object_info (megabytes of schema — fetched lazily).
_OBJECT_INFO_CACHE: dict = {"url": None, "data": None, "ts": 0.0}
_OBJECT_INFO_TTL = 300.0  # seconds


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


@router.get("/api/comfy/config")
def api_comfy_config():
    cfg = _load_comfy_config()
    # Don't ship the (potentially huge) workflow blob on every poll — just flags.
    return {
        "url": cfg.get("url") or comfy_client.DEFAULT_URL,
        "has_workflow": bool(cfg.get("workflow")),
        "workflow_node_count": len(cfg.get("workflow") or {}),
        "mapping": cfg.get("mapping"),
    }


@router.post("/api/comfy/url")
def api_comfy_set_url(req: ComfyUrlRequest):
    url = req.url.strip().rstrip("/")
    _update_comfy_config(lambda cfg: cfg.update(url=url))
    # A new (or the same, restarted) ComfyUI may have other nodes: refetch schemas.
    _OBJECT_INFO_CACHE.update({"url": None, "data": None, "ts": 0.0})
    return {"url": url}


@router.post("/api/comfy/test")
def api_comfy_test():
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    try:
        stats = comfy_client.system_stats(url)
        return {"ok": True, "url": url, "stats": stats}
    except comfy_client.ComfyError as e:
        raise HTTPException(502, str(e))


@router.post("/api/comfy/workflow")
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


@router.post("/api/comfy/mapping")
def api_comfy_mapping(req: ComfyMappingRequest):
    """User can manually fix the auto-detected mapping if anything was wrong."""
    def apply(cfg: dict) -> None:
        if not cfg.get("workflow"):
            raise HTTPException(400, "Upload a workflow first.")
        cfg["mapping"] = req.mapping

    return {"mapping": _update_comfy_config(apply)["mapping"]}


@router.get("/api/comfy/loras")
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


@router.post("/api/comfy/generate")
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


@router.get("/api/comfy/job/{job_id}")
def api_comfy_job(job_id: str):
    job = core.COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    return _comfy_job_public(job)


@router.get("/api/comfy/job/{job_id}/preview")
def api_comfy_job_preview(job_id: str):
    job = core.COMFY_JOBS.get(job_id)
    if not job or job.get("preview") is None:
        raise HTTPException(404, "No preview.")
    return Response(content=job["preview"], media_type="image/png")


@router.post("/api/comfy/job/{job_id}/cancel")
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


@router.get("/api/comfy/gallery/{item_id}")
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


@router.get("/api/comfy/gallery")
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


@router.delete("/api/comfy/gallery/{item_id}")
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


@router.get("/api/comfy/mappings")
def api_comfy_mappings_list():
    return {"items": core._load_named(core.COMFY_MAPPINGS_PATH)}


@router.post("/api/comfy/mappings")
def api_comfy_mappings_save(req: NamedSave):
    name = _library_name(req.name)
    if not isinstance(req.value, dict):
        raise HTTPException(400, "The mapping must be a JSON object.")
    data = core._load_named(core.COMFY_MAPPINGS_PATH)
    data[name] = req.value
    core._save_named(core.COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


@router.delete("/api/comfy/mappings/{name:path}")
def api_comfy_mappings_delete(name: str):
    data = core._load_named(core.COMFY_MAPPINGS_PATH)
    data.pop(name, None)
    core._save_named(core.COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


# ---- Prompt library ---- #
@router.get("/api/comfy/prompts")
def api_comfy_prompts_list():
    return {"items": core._load_named(core.COMFY_PROMPTS_PATH)}


@router.post("/api/comfy/prompts")
def api_comfy_prompts_save(req: NamedSave):
    name = _library_name(req.name)
    data = core._load_named(core.COMFY_PROMPTS_PATH)
    data[name] = req.value if isinstance(req.value, str) else json.dumps(req.value)
    core._save_named(core.COMFY_PROMPTS_PATH, data)
    return {"ok": True, "items": data}


@router.delete("/api/comfy/prompts/{name:path}")
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


@router.get("/api/comfy/workflows")
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


@router.get("/api/comfy/workflows/{name:path}")
def api_comfy_workflows_get(name: str):
    r = core._db_query("SELECT workflow FROM workflows WHERE name=?", (name,))
    if not r:
        raise HTTPException(404, "Unknown workflow.")
    return {"name": name, "workflow": json.loads(r["workflow"])}


@router.post("/api/comfy/workflows")
def api_comfy_workflows_save(req: NamedSave):
    name = _library_name(req.name)
    if not isinstance(req.value, dict) or not req.value:
        raise HTTPException(400, "The workflow must be a non-empty JSON object.")
    _wf_upsert(name, req.value)
    return {"ok": True, "names": _wf_names()}


@router.post("/api/comfy/workflows/import")
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


@router.delete("/api/comfy/workflows/{name:path}")
def api_comfy_workflows_delete(name: str):
    core._db_query("DELETE FROM workflows WHERE name=?", (name,), write=True)
    return {"ok": True, "names": _wf_names()}


# ---- Editor workflow: surowy workflow + parametry per node ---- #
@router.get("/api/comfy/object_info")
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


@router.post("/api/comfy/editor/load")
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


@router.get("/api/comfy/editor/workflow")
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


@router.post("/api/comfy/editor/generate")
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
