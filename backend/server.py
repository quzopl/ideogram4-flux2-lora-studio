"""FastAPI backend for the FLUX LoRA dataset preparation tool.

Flow:
  1. /api/scan or /api/upload  -> point the tool at a set of source images
  2. /api/process              -> start a background job (resize + caption)
  3. /api/job/{id}             -> poll progress and review/edit captions
  4. /api/export               -> write the final dataset (images + .txt files)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.routing import Match
from PIL import Image
from pydantic import BaseModel, Field

from . import api_models as models_api, api_settings
from .origin_guard import OriginGuard
from . import (crop_store, captioner, comfy_client, comfy_workflows, crop_auto, florence, gpu,
               fsutil, hf_auth, ideogram_workflow, image_utils, lmstudio, model_store,
               prompts, settings,
               upscaler, v15_lint)

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
WORK = Path(os.environ.get("FLUX_PREP_WORK") or ROOT / ".work")
WEB_DIST = ROOT / "web" / "dist"
WORK.mkdir(parents=True, exist_ok=True)

COMFY_CONFIG_PATH = WORK / "comfy_config.json"
COMFY_MAPPINGS_PATH = WORK / "comfy_mappings.json"
COMFY_PROMPTS_PATH = WORK / "comfy_prompts.json"
COMFY_WORKFLOWS_PATH = WORK / "comfy_workflows.json"
CUSTOM_MODELS_PATH = WORK / "custom_models.json"
LMSTUDIO_CONFIG_PATH = WORK / "lmstudio.json"
HF_TOKEN_PATH = WORK / "hf.json"
UPSCALER_CONFIG_PATH = WORK / "upscaler.json"
COMFY_GALLERY_DIR = WORK / "comfy_gallery"
COMFY_GALLERY_DIR.mkdir(exist_ok=True)

DB_PATH = WORK / "flux_prep.db"

hf_auth.apply_env(hf_auth.load_token(HF_TOKEN_PATH))


def _db_query(sql: str, params: tuple = (), *, many: bool = False, write: bool = False):
    """Run a SQL statement on the project SQLite DB; connection closed each call."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(sql, params)
        if write:
            conn.commit()
            return None
        return cur.fetchall() if many else cur.fetchone()
    finally:
        conn.close()


def _init_db() -> None:
    _db_query(
        """CREATE TABLE IF NOT EXISTS workflows (
            name TEXT PRIMARY KEY,
            workflow TEXT NOT NULL,
            node_count INTEGER NOT NULL DEFAULT 0,
            created REAL NOT NULL,
            updated REAL NOT NULL
        )""",
        write=True,
    )
    _db_query(
        """CREATE TABLE IF NOT EXISTS prompt_library (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL CHECK (category IN ('flux','ideogram')),
            action TEXT NOT NULL DEFAULT '',
            input_text TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL,
            created REAL NOT NULL
        )""",
        write=True,
    )
    # One-time migration of the old JSON-file library into SQLite.
    if COMFY_WORKFLOWS_PATH.exists():
        try:
            data = json.loads(COMFY_WORKFLOWS_PATH.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        for name, wf in (data or {}).items():
            if not isinstance(wf, dict):
                continue
            if _db_query("SELECT 1 FROM workflows WHERE name=?", (name,)):
                continue
            now = time.time()
            _db_query(
                "INSERT INTO workflows(name, workflow, node_count, created, updated) "
                "VALUES (?,?,?,?,?)",
                (name, json.dumps(wf), len(wf), now, now),
                write=True,
            )


_init_db()

COMFY_JOBS: dict[str, dict] = {}
COMFY_JOBS_LOCK = threading.Lock()

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
    (the SPA index under any deep link, /legacy/), so a rebuilt web/dist is
    never paired with a cached index.html that names vanished assets.
    """
    response = await call_next(request)
    path = request.url.path
    if (path == "/" or path.endswith((".html", ".js", ".css"))
            or response.headers.get("content-type", "").startswith("text/html")):
        response.headers["Cache-Control"] = "no-cache"
    return response

# In-memory job registry. Single-user local tool, so this is sufficient.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class ScanRequest(BaseModel):
    folder: str


class ProcessRequest(BaseModel):
    folder: str
    mode: str = "person"
    style: str = "concise"  # "concise" | "detailed"
    resolution: int = Field(1024, ge=256, le=4096)
    step: int = Field(64, ge=8, le=256)
    square: bool = False
    fmt: Literal["png", "jpg"] = "png"
    jpg_quality: int = Field(95, ge=50, le=100)
    model: str = captioner.DEFAULT_MODEL
    quant: str = "4bit"  # "4bit" | "none"
    max_tokens: int = Field(512, ge=64, le=8192)
    do_caption: bool = True
    caption_format: Literal["flux", "ideogram", "aitoolkit"] = "flux"

    # Cropping
    crop_mode: Literal["center", "auto", "manual"] = "center"
    fit: Literal["cover", "contain"] = "cover"  # "cover" (crop) | "contain" (pad)
    pad_color: str = "#000000"
    centering_x: str = "center"      # left | center | right
    centering_y: str = "center"      # top | center | bottom
    crops: dict[str, list[int]] = {} # source file name -> [x, y, w, h]

    # Upscaling
    upscale_model: str = ""          # empty = disabled
    upscale_min_ratio: float = 1.05


class CropAutoRequest(BaseModel):
    folder: str
    mode: str = "person"
    resolution: int = Field(1024, ge=256, le=4096)
    step: int = Field(64, ge=8, le=256)
    square: bool = False
    names: list[str] = []       # empty = all images in the folder


class CropPlanRequest(BaseModel):
    folder: str
    plan: dict[str, list[int]]
    mode: Literal["center", "auto", "manual"]


class ExportRequest(BaseModel):
    job_id: str
    output_folder: str = ""
    trigger: str = ""
    prepend_trigger: bool = True
    captions: dict[str, str] = {}  # index (as str) -> edited caption
    exclude_idx: list[int] = []    # indices removed by the user in the UI


class PromptRequest(BaseModel):
    text: str
    action: str = "expand"   # "expand" | "refine"
    subject: str = "auto"    # auto | person | product | landscape | architecture
    model: str = captioner.DEFAULT_MODEL
    quant: str = "4bit"      # "4bit" | "none"
    max_tokens: int = 768
    caption_format: str = "flux"  # "flux" | "ideogram"
    elements_detail: str = "balanced"  # few | balanced | detailed | maximal
    desc_detail: str = "balanced"      # brief | balanced | rich


class LibrarySaveRequest(BaseModel):
    category: str            # "flux" | "ideogram"
    prompt: str
    input_text: str = ""
    action: str = "manual"


class HFTokenRequest(BaseModel):
    token: str


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _list_images(folder: str) -> list[Path]:
    p = Path(folder).expanduser()
    if not p.is_dir():
        raise HTTPException(400, f"Folder does not exist: {folder}")
    files = [
        f for f in sorted(p.iterdir())
        if f.is_file() and f.suffix.lower() in image_utils.SUPPORTED_EXT
    ]
    return files


def _safe_source_path(folder: str, name: str) -> Path:
    """Resolve ``name`` inside ``folder``, rejecting traversal and missing files."""
    if not name or name != Path(name).name:
        raise HTTPException(400, "Invalid file name.")
    base = Path(folder).expanduser().resolve()
    target = (base / name).resolve()
    if base not in target.parents or not target.is_file():
        raise HTTPException(404, "No such source image.")
    return target


def _crop_for(req: "ProcessRequest", name: str) -> list[int] | None:
    """Crop box for a source file, or None when the mode has no per-file box.

    Both ``auto`` and ``manual`` read the plan that travels with the request —
    auto boxes are computed by ``/api/crop/auto`` and land in the very same
    plan, so the only difference between the two modes is who drew the box.
    ``center`` is the explicit "ignore the plan" mode.
    """
    if req.crop_mode in ("auto", "manual"):
        box = req.crops.get(name)
        return list(box) if box and len(box) == 4 else None
    return None


def _job_of_kind(job_id: str, kind: str) -> dict:
    """Job with this id, or 404 when it is missing or of a different kind.

    Every job in ``JOBS`` is stamped with ``kind``
    (``dataset`` | ``crop_auto`` | ``upscale``) at creation, because the three
    shapes are not interchangeable: only dataset results carry ``caption``,
    only crop-auto jobs carry ``crops``, and each kind has its own routes.
    """
    job = JOBS.get(job_id)
    if not job or job.get("kind") != kind:
        raise HTTPException(404, "Unknown job.")
    return job


SRC_THUMBS = WORK / "srcthumbs"


def _src_thumb_path(folder: str, name: str) -> Path:
    key = hashlib.sha1(str(Path(folder).expanduser().resolve()).encode()).hexdigest()[:16]
    return SRC_THUMBS / key / (name + ".jpg")


def _final_caption(req: ExportRequest, result: dict) -> str:
    """Resolve the caption for a result, applying any edit and the trigger word."""
    caption = req.captions.get(str(result["idx"]), result["caption"]).strip()
    trigger = req.trigger.strip()
    if req.prepend_trigger and trigger:
        if result.get("format") in ("ideogram", "aitoolkit"):
            return prompts.inject_trigger_ideogram(caption, trigger)
        caption = f"{trigger}, {caption}" if caption else trigger
    return caption


def _caption_output_files(base_name: str, caption: str, fmt: str) -> list[tuple[str, str]]:
    """Return the (filename, content) list to write for a given caption.

    Always .txt; "ideogram" additionally gets a pretty .json. "aitoolkit" = .txt only.
    """
    files: list[tuple[str, str]] = [(f"{base_name}.txt", caption + "\n")]
    if fmt == "ideogram":
        pretty = prompts.ideogram_pretty(caption)
        if pretty is not None:
            files.append((f"{base_name}.json", pretty + "\n"))
    return files


class _UpscaleHook:
    """Callable passed to process_image(upscale=...); records what it did.

    Keeps the pipeline honest: a broken upscaler degrades to plain LANCZOS
    instead of killing the job. A failed model ensure is remembered for the
    rest of the job, so later images report the same error instead of each
    starting another download (and restarting one the user cancelled).
    """

    def __init__(self, entry: dict, min_ratio: float = 1.05, token: str = "",
                 fit: str = "cover", run=None, job: dict | None = None):
        self.entry = entry
        self.min_ratio = min_ratio
        self.token = token
        self.fit = fit
        self.used = False
        self.error = ""
        self.job = job
        self._injected = run is not None
        self._scale = 0
        self._ensure_error: str | None = None  # survives reset(): one attempt per job
        self._run = run or (lambda img, entry, passes: upscaler.upscale(
            img, entry, passes, token=self.token))

    def reset(self) -> None:
        self.used = False
        self.error = ""

    def __call__(self, img, target):
        try:
            # Any scale > 1 plans the same number of passes, so images that
            # need none are returned before the model is ensured or loaded.
            if upscaler.plan_passes(
                    (img.width, img.height), target,
                    int(self.entry.get("scale") or 0) or 2,
                    self.min_ratio, fit=self.fit) <= 0:
                return img
            entry = self.entry
            if not self._injected:
                if self._ensure_error is not None:
                    self.error = self._ensure_error
                    return img
                try:
                    entry = {**entry, "path": _ensure_model(entry["id"], self.job)}
                except Exception as e:  # noqa: BLE001 - remembered, then the fallback below
                    self._ensure_error = str(e)
                    raise
            if not self._scale:
                # Local models register scale 0: ask the loaded model, once.
                self._scale = (int(entry.get("scale") or 0)
                               or upscaler.model_scale(entry, self.token))
            passes = upscaler.plan_passes(
                (img.width, img.height), target, self._scale, self.min_ratio,
                fit=self.fit)
            if passes <= 0:
                return img
            out = self._run(img, entry, passes)
        except Exception as e:  # noqa: BLE001 - fall back to plain resizing
            self.error = str(e)
            return img
        self.used = True
        return out


def _job_public(job: dict) -> dict:
    """Strip non-serialisable internals before sending to the client."""
    return {
        "id": job["id"],
        "state": job["state"],
        "total": job["total"],
        "processed": job["processed"],
        "current": job["current"],
        "error": job["error"],
        "config": job["config"],
        "results": [
            {
                "idx": r["idx"],
                "src_name": r["src_name"],
                "out_name": r["out_name"],
                "width": r["width"],
                "height": r["height"],
                "caption": r["caption"],
                "upscaled": r.get("upscaled", False),
                "upscale_error": r.get("upscale_error", ""),
            }
            for r in job["results"]
        ],
    }


# --------------------------------------------------------------------------- #
# Background worker
# --------------------------------------------------------------------------- #
def _run_job(job_id: str, req: ProcessRequest, files: list[Path]) -> None:
    job = JOBS[job_id]
    job_dir = WORK / job_id
    proc_dir = job_dir / "processed"
    thumb_dir = job_dir / "thumbs"
    proc_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    ext = "jpg" if req.fmt == "jpg" else "png"

    try:
        lm_id = _lmstudio_model_id(req.model)
        lm_url = _lmstudio_url() if lm_id is not None else None
        if req.do_caption and lm_id is None:
            job["state"] = "loading_model"
            quant = req.quant if req.quant in ("4bit", "none") else "4bit"
            source = _ensure_model(req.model, job)
            job["current"] = "Loading the VLM model…"
            captioner.ensure_loaded(req.model, quant, source=source)

        hook = None
        if req.upscale_model:
            entry = upscaler.resolve(
                req.upscale_model, upscaler.load_config(UPSCALER_CONFIG_PATH))
            if entry:
                job["state"] = "loading_model"
                job["current"] = "Loading the upscale model…"
                hook = _UpscaleHook(entry, req.upscale_min_ratio,
                                    hf_auth.load_token(HF_TOKEN_PATH),
                                    fit=req.fit, job=job)

        job["state"] = "processing"
        prefix = (req.mode or "img")

        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                if hook:
                    hook.reset()
                img, (w, h) = image_utils.process_image(
                    str(src), req.resolution, req.step, req.square,
                    crop=_crop_for(req, src.name),
                    centering=image_utils.centering_pair(req.centering_x, req.centering_y),
                    fit=req.fit,
                    pad_color=req.pad_color,
                    upscale=hook,
                )
                out_name = f"{prefix}_{i:04d}.{ext}"
                image_utils.save_image(
                    img, str(proc_dir / out_name), req.fmt, req.jpg_quality
                )
                thumb = image_utils.make_thumbnail(img)
                thumb.save(str(thumb_dir / f"{i:04d}.jpg"), format="JPEG", quality=80)

                caption = ""
                if req.do_caption:
                    if lm_id is not None:
                        instruction = prompts.caption_instruction(
                            req.mode, req.style, req.caption_format)
                        raw = lmstudio.caption_image(
                            lm_url, lm_id, img, instruction, req.max_tokens)
                        caption = prompts.postprocess_caption(raw, req.caption_format)
                    else:
                        caption = captioner.caption_image(
                            img, req.mode, req.style, req.max_tokens,
                            fmt=req.caption_format,
                        )

                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": out_name,
                    "width": w,
                    "height": h,
                    "caption": caption,
                    "format": req.caption_format,
                    "upscaled": bool(hook and hook.used),
                    "upscale_error": hook.error if hook else "",
                })
            except Exception as e:  # noqa: BLE001 - record per-file failures, keep going
                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": "",
                    "width": 0,
                    "height": 0,
                    "caption": f"[ERROR: {e}]",
                })
            job["processed"] = i + 1

        job["current"] = ""
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
def _list_subdirs(path: Path) -> list[str]:
    """Sorted (case-insensitive) subfolder names; unreadable ones skipped."""
    out: list[str] = []
    try:
        for entry in path.iterdir():
            try:
                if entry.is_dir():
                    out.append(entry.name)
            except OSError:
                continue
    except OSError:
        return []
    return sorted(out, key=str.lower)


def _list_weight_files(path: Path) -> list[str]:
    """Sorted names of weight files (upscaler.WEIGHT_EXT) in ``path``; unreadable ones skipped."""
    out: list[str] = []
    try:
        for entry in path.iterdir():
            try:
                if entry.is_file() and entry.suffix.lower() in upscaler.WEIGHT_EXT:
                    out.append(entry.name)
            except OSError:
                continue
    except OSError:
        return []
    return sorted(out, key=str.lower)


def _model_ctx() -> dict:
    return {"settings": settings.load(),
            "upscale_cfg": upscaler.load_config(UPSCALER_CONFIG_PATH),
            "custom_vlms": _load_named(CUSTOM_MODELS_PATH)}


class _UnknownModel(RuntimeError):
    """A model id missing from the registry (a 400, unlike a failed download)."""


def _ensure_model(model_id: str, job: dict | None) -> str:
    """Local path of ``model_id``, downloaded into the Models folder when missing.

    While downloading, ``job["current"]`` shows the progress. Every failure
    carries a readable message: ModelsFolderNotSet, ValueError (folder
    unusable, not enough space), RuntimeError (unknown model, failed download).
    """
    ctx = _model_ctx()
    on_progress = None
    if job is not None:
        entry = model_store.find(model_id, ctx)
        label = entry["label"] if entry else model_id

        def on_progress(done: int, total: int) -> None:
            if total > 0:
                job["current"] = f"Downloading {label}… {int(done * 100 / total)}%"
            else:
                job["current"] = f"Downloading {label}… {done / 1e9:.1f} GB"

    try:
        return model_store.ensure_local(model_id, ctx, hf_auth.load_token(HF_TOKEN_PATH),
                                        on_progress)
    except KeyError:
        raise _UnknownModel(f"Unknown model: {model_id}") from None


def _ensure_model_http(model_id: str) -> str:
    """_ensure_model for synchronous endpoints: a setup problem is a 400, a failed download a 502."""
    try:
        return _ensure_model(model_id, None)
    except (model_store.ModelsFolderNotSet, _UnknownModel, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e


florence.SOURCE_RESOLVER = lambda: _ensure_model(florence.DEFAULT_MODEL, None)


def _model_dir_info(path: Path) -> dict:
    """Czy `path` to folder z modelem Qwen2.5-VL. {ok, reason, label}."""
    if not path.is_dir():
        return {"ok": False, "reason": "Folder nie istnieje.", "label": ""}
    cfg = path / "config.json"
    if not cfg.is_file():
        return {"ok": False,
                "reason": "This is not a model folder (config.json missing).",
                "label": ""}
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {"ok": False, "reason": "Cannot read config.json.", "label": ""}
    if model_store.is_qwen_vl_config(data):
        return {"ok": True, "reason": "", "label": f"{path.name} (custom)"}
    return {"ok": False,
            "reason": "Only Qwen2.5-VL models are supported.",
            "label": ""}


def _lmstudio_url() -> str:
    data = _load_named(LMSTUDIO_CONFIG_PATH)
    return data.get("url") or lmstudio.DEFAULT_URL


def _set_lmstudio_url(url: str) -> str:
    url = url.strip() or lmstudio.DEFAULT_URL
    _save_named(LMSTUDIO_CONFIG_PATH, {"url": url})
    return url


def _lmstudio_model_id(model: str) -> str | None:
    """Return the LM Studio model id (the part after 'lmstudio:'), else None."""
    prefix = "lmstudio:"
    return model[len(prefix):] if model.startswith(prefix) else None


def _all_models() -> dict:
    """Built-in + custom + (when reachable) LM Studio models."""
    models = {**captioner.AVAILABLE_MODELS, **_load_named(CUSTOM_MODELS_PATH)}
    for mid in lmstudio.list_models(_lmstudio_url()):
        models[f"lmstudio:{mid}"] = f"LM Studio: {mid}"
    return models


def _add_custom_model(path: str) -> dict:
    """Validate and save a custom model. Raises ValueError with a readable reason."""
    resolved = Path(path).expanduser().resolve()
    info = _model_dir_info(resolved)
    if not info["ok"]:
        raise ValueError(info["reason"])
    data = _load_named(CUSTOM_MODELS_PATH)
    data[str(resolved)] = info["label"]
    _save_named(CUSTOM_MODELS_PATH, data)
    return {"added": str(resolved), "label": info["label"]}


def _remove_custom_model(path: str) -> None:
    resolved = str(Path(path).expanduser().resolve())
    data = _load_named(CUSTOM_MODELS_PATH)
    if resolved in data:
        del data[resolved]
        _save_named(CUSTOM_MODELS_PATH, data)


class CustomModel(BaseModel):
    path: str


@app.get("/api/models")
def api_models():
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}


@app.get("/api/fs/list")
def api_fs_list(path: str = "", files: str = ""):
    base = (Path(path).expanduser() if path else Path.home()).resolve()
    if not base.is_dir():
        raise HTTPException(400, f"Not a folder: {base}")
    parent = None if base.parent == base else str(base.parent)
    out = {
        "path": str(base),
        "parent": parent,
        "dirs": _list_subdirs(base),
        "is_model": _model_dir_info(base)["ok"],
        "free_bytes": fsutil.free_bytes(base),
        "writable": os.access(base, os.W_OK),
    }
    if files == "weights":
        out["files"] = _list_weight_files(base)
    return out


class MkdirReq(BaseModel):
    path: str


@app.post("/api/fs/mkdir")
def api_fs_mkdir(req: MkdirReq):
    p = Path(req.path).expanduser()
    if not p.is_absolute():
        raise HTTPException(400, "Use an absolute path.")
    if not p.parent.is_dir():
        raise HTTPException(400, f"Parent folder does not exist: {p.parent}")
    if not os.access(p.parent, os.W_OK):
        raise HTTPException(400, f"Folder is not writable: {p.parent}")
    if p.exists():
        raise HTTPException(400, f"Already exists: {p}")
    try:
        p.mkdir()
    except OSError:
        raise HTTPException(400, f"Cannot create folder: {p}")
    return {"path": str(p.resolve())}


@app.post("/api/models/custom")
def api_models_custom_add(req: CustomModel):
    try:
        res = _add_custom_model(req.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"models": _all_models(),
            "default": captioner.DEFAULT_MODEL,
            "added": res["added"]}


@app.delete("/api/models/custom")
def api_models_custom_remove(req: CustomModel):
    _remove_custom_model(req.path)
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}


@app.post("/api/fs/pick")
def api_fs_pick():
    """Open the native system folder picker (zenity/WSLg) and return the path.

    The browser does not expose absolute paths, so we use the standard system
    dialog — it works because the app is local.
    """
    import subprocess

    try:
        proc = subprocess.run(
            ["zenity", "--file-selection", "--directory",
             "--title=Wybierz folder z modelem Qwen2.5-VL"],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        raise HTTPException(500, "'zenity' missing — the native folder picker is unavailable.")
    except subprocess.TimeoutExpired:
        return {"cancelled": True}
    path = proc.stdout.strip()
    if proc.returncode != 0 or not path:
        return {"cancelled": True}  # the user cancelled
    return {"path": path}


class LmStudioConfig(BaseModel):
    url: str = ""


@app.get("/api/lmstudio")
def api_lmstudio_get():
    return {"url": _lmstudio_url()}


@app.post("/api/lmstudio")
def api_lmstudio_set(req: LmStudioConfig):
    return {"url": _set_lmstudio_url(req.url)}


@app.get("/api/hf/token")
def api_hf_token_get():
    return hf_auth.status(hf_auth.load_token(HF_TOKEN_PATH))


@app.post("/api/hf/token")
def api_hf_token_set(req: HFTokenRequest):
    hf_auth.save_token(HF_TOKEN_PATH, req.token)
    hf_auth.apply_env(req.token)
    return hf_auth.status(req.token)


@app.delete("/api/hf/token")
def api_hf_token_clear():
    hf_auth.clear_token(HF_TOKEN_PATH)
    hf_auth.apply_env("")
    return {"set": False, "tail": ""}


@app.post("/api/scan")
def api_scan(req: ScanRequest):
    files = _list_images(req.folder)
    return {
        "folder": str(Path(req.folder).expanduser()),
        "count": len(files),
        "files": [f.name for f in files],
    }


@app.get("/api/src/thumb")
def api_src_thumb(folder: str, name: str):
    """Cached JPEG thumbnail of a source image (for the crop grid)."""
    src = _safe_source_path(folder, name)
    cache = _src_thumb_path(folder, name)
    if not cache.exists() or cache.stat().st_mtime < src.stat().st_mtime:
        cache.parent.mkdir(parents=True, exist_ok=True)
        img = image_utils.load_source(str(src))
        thumb = image_utils.make_thumbnail(img, 480)
        thumb.save(str(cache), format="JPEG", quality=80)
    return FileResponse(str(cache), media_type="image/jpeg")


@app.get("/api/src/image")
def api_src_image(folder: str, name: str):
    """Down-scaled source image for the crop editor, with the true source size."""
    src = _safe_source_path(folder, name)
    img = image_utils.load_source(str(src))
    full_w, full_h = img.width, img.height
    preview = image_utils.make_thumbnail(img, 1600)
    buf = io.BytesIO()
    preview.save(buf, format="JPEG", quality=88)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers={"X-Src-Width": str(full_w), "X-Src-Height": str(full_h)},
    )


@app.get("/api/src/size")
def api_src_size(folder: str, name: str):
    """True size of a source image after EXIF rotation, from the header only."""
    src = _safe_source_path(folder, name)
    try:
        with Image.open(src) as img:
            w, h = img.size
            if img.getexif().get(0x0112) in (5, 6, 7, 8):
                w, h = h, w
    except OSError as e:  # UnidentifiedImageError is an OSError
        raise HTTPException(400, "Not a readable image.") from e
    return {"width": w, "height": h}


@app.get("/api/crops")
def api_crops_get(folder: str):
    return crop_store.load(folder)


@app.put("/api/crops")
def api_crops_put(req: CropPlanRequest):
    if not req.folder:
        raise HTTPException(400, "No folder given.")
    for name, box in req.plan.items():
        if not name or name != Path(name).name or name == "..":
            raise HTTPException(400, f"Invalid file name: {name!r}")
        if len(box) != 4 or any(v < 0 for v in box) or box[2] == 0 or box[3] == 0:
            raise HTTPException(
                400, f"Invalid crop box for {name!r}: need [x, y, w, h], w and h > 0.")
    return crop_store.save(req.folder, req.plan, req.mode)


@app.post("/api/upload")
async def api_upload(files: list[UploadFile]):
    dest = WORK / "uploads" / uuid.uuid4().hex
    dest.mkdir(parents=True, exist_ok=True)
    saved_names: list[str] = []
    for f in files:
        if Path(f.filename).suffix.lower() not in image_utils.SUPPORTED_EXT:
            continue
        target = dest / Path(f.filename).name
        with open(target, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved_names.append(target.name)
    return {"folder": str(dest), "count": len(saved_names), "files": sorted(saved_names)}


@app.post("/api/process")
def api_process(req: ProcessRequest):
    files = _list_images(req.folder)
    if not files:
        raise HTTPException(400, "No supported images in the folder.")

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "kind": "dataset",
            "state": "pending",
            "total": len(files),
            "processed": 0,
            "current": "",
            "error": "",
            "config": req.model_dump(),
            "results": [],
        }
    t = threading.Thread(target=_run_job, args=(job_id, req, files), daemon=True)
    t.start()
    return {"job_id": job_id, "total": len(files)}


@app.get("/api/job/{job_id}")
def api_job(job_id: str):
    return _job_public(_job_of_kind(job_id, "dataset"))


def _run_crop_auto(job_id: str, req: CropAutoRequest, files: list[Path]) -> None:
    job = JOBS[job_id]
    try:
        job["state"] = "processing"
        # Before the loop: suggest_crop swallows detection errors, so a missing
        # model would otherwise end as a "done" job without any crops.
        if req.mode not in crop_auto.NO_AUTO_MODES:
            _ensure_model(florence.DEFAULT_MODEL, job)
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                box = crop_auto.suggest_crop(
                    img, req.mode, req.resolution, req.step, req.square)
                if box:
                    job["crops"][src.name] = box
            except Exception as e:  # noqa: BLE001 - one bad file must not kill the job
                job["skipped"].append(f"{src.name}: {e}")
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/crop/auto")
def api_crop_auto(req: CropAutoRequest):
    files = _list_images(req.folder)
    if req.names:
        wanted = set(req.names)
        files = [f for f in files if f.name in wanted]
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "kind": "crop_auto", "state": "pending",
            "total": len(files), "processed": 0, "current": "", "error": "",
            "crops": {}, "skipped": [],
        }
    threading.Thread(target=_run_crop_auto, args=(job_id, req, files),
                     daemon=True).start()
    return {"job_id": job_id, "total": len(files)}


@app.get("/api/crop/auto/{job_id}")
def api_crop_auto_job(job_id: str):
    job = _job_of_kind(job_id, "crop_auto")
    return {
        "state": job["state"], "total": job["total"],
        "processed": job["processed"], "current": job["current"],
        "error": job["error"], "crops": job["crops"], "skipped": job["skipped"],
    }


@app.get("/api/thumb/{job_id}/{idx}")
def api_thumb(job_id: str, idx: int):
    path = WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail.")
    return FileResponse(str(path))


@app.post("/api/export")
def api_export(req: ExportRequest):
    job = _job_of_kind(req.job_id, "dataset")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")

    if not req.output_folder.strip():
        raise HTTPException(400, "Enter a destination folder.")
    out_dir = Path(req.output_folder).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    proc_dir = WORK / req.job_id / "processed"

    exclude = set(req.exclude_idx)
    written = 0
    for r in job["results"]:
        if not r["out_name"] or r["idx"] in exclude:
            continue  # skip failed or user-removed items
        src_img = proc_dir / r["out_name"]
        if not src_img.exists():
            continue
        shutil.copy2(src_img, out_dir / r["out_name"])

        caption = _final_caption(req, r)
        base = Path(r["out_name"]).stem
        for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
            (out_dir / fname).write_text(content, encoding="utf-8")
        written += 1

    return {"output_folder": str(out_dir), "written": written}


def _busy() -> bool:
    """True while any job is still loading the model or processing images."""
    return any(
        j["state"] in ("pending", "loading_model", "processing")
        for j in JOBS.values()
    )


def _gpu_status() -> dict:
    """Captioner status extended with the upscaler runtime.

    Composed here rather than inside ``captioner`` so the two model modules
    stay independent; the topbar needs a single "is anything holding VRAM"
    flag, otherwise ⏏ Release GPU stays disabled while the upscaler is loaded.
    """
    info = captioner.gpu_status()
    up = upscaler.status()
    info["upscale_loaded"] = up["loaded"]
    info["upscale_model"] = up["key"]
    info["upscale_device"] = up["device"]
    info["upscale_note"] = up["note"]
    info["loaded"] = bool(info.get("loaded")) or up["loaded"]
    # The legacy topbar shows one card: the VLM role's (none when it runs on
    # the CPU). "cards" carries all of them for the v2 topbar.
    cards = _gpu_cards(gpu.probe(), settings.load())
    vlm = next((c for c in cards if "vlm" in c["roles"]), None)
    info["gpu_label"] = vlm["label"] if vlm else ""
    if vlm:
        info["vram_used_gb"], info["vram_total_gb"] = vlm["vram_used_gb"], vlm["vram_total_gb"]
    info["cards"] = cards
    return info


_SMI_LOCK = threading.Lock()
_SMI_LAST: dict = {}
_SMI_AT = 0.0  # time.monotonic() when _SMI_LAST was produced


def _smi_snapshot() -> dict:
    """``gpu.smi_stats()``, shared between concurrent callers: whoever holds the
    lock runs nvidia-smi, the others wait and reuse a result produced after they
    arrived."""
    global _SMI_LAST, _SMI_AT
    entered = time.monotonic()
    with _SMI_LOCK:
        if _SMI_AT < entered:
            _SMI_LAST = gpu.smi_stats()
            _SMI_AT = time.monotonic()
        return _SMI_LAST


def _gpu_cards(devices: list[dict], doc: dict) -> list[dict]:
    """``gpu.listing`` rows plus each card's VRAM (nvidia-smi; None when it did
    not report the card), the roles assigned to it and the roles whose model
    is loaded on it. ``selected`` marks the VLM role's card, as the legacy
    select expects."""
    stats = _smi_snapshot()
    assigned = {role: gpu.device_for(role, doc, devices) for role in settings.ROLES}
    loaded = {"vlm": captioner.loaded_device(), "florence": florence.loaded_device(),
              "upscale": upscaler.status()["device"]}
    by_uuid = {d["uuid"]: d for d in devices}
    rows = gpu.listing(devices, None)
    for row in rows:
        dev = gpu.device_string(by_uuid[row["uuid"]])
        row["vram_used_gb"], row["vram_total_gb"] = stats.get(
            gpu.normalize_uuid(row["uuid"]), (None, None))
        row["roles"] = [r for r in settings.ROLES if assigned[r] == dev]
        row["loaded"] = [r for r in settings.ROLES if loaded[r] == dev]
        row["selected"] = "vlm" in row["roles"]
    return rows


@app.get("/api/gpu")
def api_gpu():
    return _gpu_status()


@app.post("/api/unload")
def api_unload():
    if _busy():
        raise HTTPException(409, "Processing in progress — wait for it to finish.")
    captioner.unload()
    florence.unload()
    upscaler.unload()
    return _gpu_status()


class GpuSelectRequest(BaseModel):
    uuid: str


class GpuAssignRequest(BaseModel):
    role: str
    device: str


@app.get("/api/gpus")
def api_gpus():
    """Cards for the topbar select, labelled by name — never by CUDA index —
    and what each role is set to ("auto", "cpu" or a card's UUID)."""
    devices = gpu.probe()
    doc = settings.load()
    cards = _gpu_cards(devices, doc)
    vlm = next((c for c in cards if c["selected"]), None)
    return {"gpus": cards, "selected": vlm["uuid"] if vlm else None,
            "roles": dict(doc["gpu"])}


@app.post("/api/gpu/assign")
def api_gpu_assign(req: GpuAssignRequest):
    """Move one role to another card ("auto" = most memory, or "cpu"). Only
    that role's model is released — it sits on the old card; the other roles
    keep theirs loaded."""
    if _busy():
        raise HTTPException(409, "Processing in progress — wait for it to finish.")
    if req.role not in settings.ROLES:
        raise HTTPException(400, "Unknown role.")
    if not gpu.assign_value_ok(req.device, gpu.probe()):
        raise HTTPException(400, "Unknown GPU.")
    settings.update(lambda d: d["gpu"].__setitem__(req.role, req.device))
    {"vlm": captioner.unload, "florence": florence.unload,
     "upscale": upscaler.unload}[req.role]()
    return _gpu_status()


@app.post("/api/gpu/select")
def api_gpu_select(req: GpuSelectRequest):
    """Legacy UI: put every role on one card. Loaded models sit on the old
    card, so they are released; the next use loads them on the new one."""
    if _busy():
        raise HTTPException(409, "Processing in progress — wait for it to finish.")
    if not any(d["uuid"] == req.uuid for d in gpu.probe()):
        raise HTTPException(400, "Unknown GPU.")
    gpu.save_selected(gpu.CONFIG_PATH, req.uuid)
    settings.update(lambda d: d.__setitem__("gpu", {role: req.uuid for role in settings.ROLES}))
    captioner.unload()
    florence.unload()
    upscaler.unload()
    return _gpu_status()


class UpscaleScanRequest(BaseModel):
    folder: str


class UpscaleCustomRequest(BaseModel):
    repo_id: str
    filename: str
    scale: int = 0


class UpscaleDownloadRequest(BaseModel):
    model_id: str


def _upscale_registry(cfg: dict) -> list[dict]:
    """upscaler.registry with ``cached`` from the model store (Models folder,
    chosen location or HF cache) instead of the HF cache alone."""
    ctx = _model_ctx()
    store = {e["id"]: e for e in model_store.entries(ctx)}
    out = upscaler.registry(cfg)
    for m in out:
        if m["id"] in store:
            m["cached"] = model_store.resolve_path(store[m["id"]], ctx) is not None
    return out


@app.get("/api/upscale/models")
def api_upscale_models():
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    return {"models": _upscale_registry(cfg), "folder": cfg.get("folder", "")}


@app.post("/api/upscale/models/scan")
def api_upscale_scan(req: UpscaleScanRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    cfg["folder"] = req.folder.strip()
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg), "folder": cfg["folder"]}


@app.post("/api/upscale/models/custom")
def api_upscale_custom_add(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    entry = {"repo_id": req.repo_id.strip(), "filename": req.filename.strip(),
             "scale": req.scale}
    if not entry["repo_id"] or not entry["filename"]:
        raise HTTPException(400, "repo_id and filename are required.")
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (entry["repo_id"], entry["filename"])] + [entry]
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


@app.delete("/api/upscale/models/custom")
def api_upscale_custom_del(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (req.repo_id, req.filename)]
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


@app.post("/api/upscale/download")
def api_upscale_download(req: UpscaleDownloadRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    entry = upscaler.resolve(req.model_id, cfg)
    if not entry:
        raise HTTPException(404, "Unknown upscale model.")
    path = _ensure_model_http(entry["id"])
    return {"ok": True, "path": path, "models": _upscale_registry(cfg)}


# --------------------------------------------------------------------------- #
# Standalone "Upscale these photos" tool
# --------------------------------------------------------------------------- #
class UpscaleRunRequest(BaseModel):
    folder: str
    model_id: str
    mode: Literal["native", "x2", "factor", "long_side"] = "native"
    long_side: int = 2048
    factor: float = Field(2.0, gt=1.0, le=8.0)
    fmt: str = "png"         # "png" | "jpg"
    jpg_quality: int = 95
    device: str = ""         # "" = the upscale role's card, "cpu", or a GPU UUID


class UpscaleExportRequest(BaseModel):
    job_id: str
    output_folder: str


def _upscale_target(size, mode: str, value: int, scale: int,
                    factor: float = 2.0) -> tuple[int, int]:
    """Target pixel size for the standalone upscale tool (never shrinks)."""
    w, h = size
    if mode == "x2":
        factor = 2.0
    elif mode == "factor":
        pass
    elif mode == "long_side":
        factor = max(1.0, value / max(w, h))
    else:
        factor = float(scale or 4)
    return (max(w, int(round(w * factor))), max(h, int(round(h * factor))))


def _upscale_out_name(idx: int, src: Path, ext: str) -> str:
    """Output filename for one result; the index keeps same-stem sources unique

    (e.g. photo.jpg and photo.png in the same folder must not collide).
    """
    return f"{idx:04d}_{src.stem}_up.{ext}"


def _resolve_device(value: str) -> tuple[str, str]:
    """An upscale job's device choice -> (torch device, label shown in results).

    "" is the upscale role's card, "cpu" the CPU, otherwise a card's UUID.
    """
    devices = gpu.probe()
    if value == "":
        device = gpu.device_for("upscale", devices=devices)
        dev = next((d for d in devices if gpu.device_string(d) == device), None)
        return device, gpu.label(dev, devices) if dev else "CPU"
    if value == "cpu":
        return "cpu", "CPU"
    want = gpu.normalize_uuid(value)
    for dev in devices:
        if gpu.normalize_uuid(dev["uuid"]) == want:
            return gpu.device_string(dev), gpu.label(dev, devices)
    raise ValueError("Unknown GPU.")


def _run_upscale_job(job_id: str, req: UpscaleRunRequest, files: list[Path],
                     resolved: tuple[str, str] | None = None) -> None:
    job = JOBS[job_id]
    out_dir = WORK / job_id / "upscaled"
    thumb_dir = WORK / job_id / "thumbs"
    out_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    ext = "jpg" if req.fmt == "jpg" else "png"
    try:
        device, device_label = resolved or _resolve_device(req.device)
        cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
        entry = upscaler.resolve(req.model_id, cfg)
        if not entry:
            raise RuntimeError(f"Unknown upscale model: {req.model_id}")
        token = hf_auth.load_token(HF_TOKEN_PATH)
        job["state"] = "loading_model"
        job["current"] = "Loading the upscale model…"
        entry = {**entry, "path": _ensure_model(entry["id"], job)}
        scale = int(entry.get("scale") or 0) or upscaler.model_scale(entry, token, device)
        job["state"] = "processing"
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                target = _upscale_target((img.width, img.height), req.mode,
                                         req.long_side, scale, req.factor)
                passes = upscaler.plan_passes((img.width, img.height), target,
                                              scale, min_ratio=1.0)
                big = upscaler.upscale(img, entry, passes, token=token,
                                      device=device)
                if (big.width, big.height) != target:
                    big = big.resize(target, Image.LANCZOS)
                out_name = _upscale_out_name(i, src, ext)
                image_utils.save_image(big, str(out_dir / out_name),
                                       req.fmt, req.jpg_quality)
                image_utils.make_thumbnail(big, 480).save(
                    str(thumb_dir / f"{i:04d}.jpg"), format="JPEG", quality=80)
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": out_name,
                    "width": big.width, "height": big.height, "error": "",
                    "passes": passes, "device": device_label,
                })
            except Exception as e:  # noqa: BLE001 - keep going on per-file errors
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": "",
                    "width": 0, "height": 0, "error": str(e),
                    "passes": 0, "device": device_label,
                })
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/upscale/run")
def api_upscale_run(req: UpscaleRunRequest):
    files = _list_images(req.folder)
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    try:
        resolved = _resolve_device(req.device)
    except ValueError as e:
        raise HTTPException(400, str(e))
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "kind": "upscale", "state": "pending",
            "total": len(files), "processed": 0, "current": "", "error": "",
            "config": req.model_dump(), "results": [],
        }
    threading.Thread(target=_run_upscale_job, args=(job_id, req, files, resolved),
                     daemon=True).start()
    return {"job_id": job_id, "total": len(files)}


@app.get("/api/upscale/job/{job_id}")
def api_upscale_job(job_id: str):
    job = _job_of_kind(job_id, "upscale")
    return {
        "state": job["state"], "total": job["total"], "processed": job["processed"],
        "current": job["current"], "error": job["error"], "results": job["results"],
    }


@app.get("/api/upscale/thumb/{job_id}/{idx}")
def api_upscale_thumb(job_id: str, idx: int):
    path = WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail.")
    return FileResponse(str(path), media_type="image/jpeg")


@app.get("/api/upscale/image/{job_id}/{idx}")
def api_upscale_image(job_id: str, idx: int):
    job = _job_of_kind(job_id, "upscale")
    res = next((r for r in job["results"] if r["idx"] == idx), None)
    if not res or not res["out_name"]:
        raise HTTPException(404, "No result.")
    path = WORK / job_id / "upscaled" / res["out_name"]
    if not path.is_file():
        raise HTTPException(404, "No result.")
    return FileResponse(str(path))


@app.post("/api/upscale/export")
def api_upscale_export(req: UpscaleExportRequest):
    job = _job_of_kind(req.job_id, "upscale")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")
    if not req.output_folder.strip():
        raise HTTPException(400, "Enter a destination folder.")
    dest = Path(req.output_folder).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    src_dir = WORK / req.job_id / "upscaled"
    written = 0
    for r in job["results"]:
        if not r["out_name"]:
            continue
        shutil.copy2(src_dir / r["out_name"], dest / r["out_name"])
        written += 1
    return {"written": written, "folder": str(dest)}


@app.get("/api/upscale/zip/{job_id}")
def api_upscale_zip(job_id: str):
    job = _job_of_kind(job_id, "upscale")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")
    src_dir = WORK / job_id / "upscaled"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in job["results"]:
            if r["out_name"]:
                zf.write(src_dir / r["out_name"], r["out_name"])
    buf.seek(0)
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="upscaled_{job_id[:8]}.zip"'},
    )


# --------------------------------------------------------------------------- #
# ComfyUI integration
# --------------------------------------------------------------------------- #
def _load_comfy_config() -> dict:
    if not COMFY_CONFIG_PATH.exists():
        return {"url": comfy_client.DEFAULT_URL, "workflow": None, "mapping": None}
    try:
        return json.loads(COMFY_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"url": comfy_client.DEFAULT_URL, "workflow": None, "mapping": None}


def _save_comfy_config(cfg: dict) -> None:
    COMFY_CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


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
    cfg = _load_comfy_config()
    cfg["url"] = req.url.strip().rstrip("/")
    _save_comfy_config(cfg)
    return {"url": cfg["url"]}


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

    cfg = _load_comfy_config()
    cfg["workflow"] = workflow
    cfg["mapping"] = mapping
    _save_comfy_config(cfg)
    return {
        "node_count": len(workflow),
        "mapping": mapping,
        "source": "png" if (file.filename or "").lower().endswith(".png") else "json",
        "current_prompt": comfy_workflows.extract_current_prompt(workflow, mapping),
    }


@app.post("/api/comfy/mapping")
def api_comfy_mapping(req: ComfyMappingRequest):
    """User can manually fix the auto-detected mapping if anything was wrong."""
    cfg = _load_comfy_config()
    if not cfg.get("workflow"):
        raise HTTPException(400, "Najpierw wgraj workflow.")
    cfg["mapping"] = req.mapping
    _save_comfy_config(cfg)
    return {"mapping": cfg["mapping"]}


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


def _run_comfy_job(job_id: str, req: ComfyGenerateRequest) -> None:
    """Background worker: queues `batch` prompts, streams progress via WS,
    saves output PNGs to .work/comfy_gallery and updates job state."""
    import random
    import time
    import uuid as _uuid

    job = COMFY_JOBS[job_id]
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
                comfy_client.stream_events(url, client_id, pid, on_event)
            except Exception as e:  # noqa: BLE001
                # WS hiccup — fall back to polling /history.
                job["current"] = f"Sample {i + 1}/{batch}: WS unavailable ({e}), polling history…"

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
                        out_path = COMFY_GALLERY_DIR / f"{item_id}.png"
                        out_path.write_bytes(data)
                        meta = {
                            "id": item_id,
                            "filename": o["filename"],
                            "seed": seed,
                            "prompt": req.prompt,
                            "loras": req.loras,
                            "ts": time.time(),
                            "url": f"/api/comfy/gallery/{item_id}",
                        }
                        # Sidecar JSON with metadata (so gallery survives restart).
                        (COMFY_GALLERY_DIR / f"{item_id}.json").write_text(
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
        raise HTTPException(400, "Najpierw wgraj workflow w sekcji Konfiguracja.")

    job_id = uuid.uuid4().hex[:12]
    with COMFY_JOBS_LOCK:
        COMFY_JOBS[job_id] = {
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
    job = COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    return _comfy_job_public(job)


@app.get("/api/comfy/job/{job_id}/preview")
def api_comfy_job_preview(job_id: str):
    job = COMFY_JOBS.get(job_id)
    if not job or job.get("preview") is None:
        raise HTTPException(404, "No preview.")
    return Response(content=job["preview"], media_type="image/png")


@app.post("/api/comfy/job/{job_id}/cancel")
def api_comfy_job_cancel(job_id: str):
    job = COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    job["cancel"] = True
    return {"ok": True}


@app.get("/api/comfy/gallery/{item_id}")
def api_comfy_gallery_item(item_id: str):
    p = COMFY_GALLERY_DIR / f"{item_id}.png"
    if not p.exists():
        raise HTTPException(404, "No image.")
    return FileResponse(str(p), media_type="image/png")


@app.get("/api/comfy/gallery")
def api_comfy_gallery_list():
    items: list[dict] = []
    for meta_path in sorted(COMFY_GALLERY_DIR.glob("*.json"), reverse=True):
        try:
            items.append(json.loads(meta_path.read_text(encoding="utf-8")))
        except Exception:
            continue
    return {"items": items}


@app.delete("/api/comfy/gallery/{item_id}")
def api_comfy_gallery_delete(item_id: str):
    for ext in (".png", ".json"):
        p = COMFY_GALLERY_DIR / f"{item_id}{ext}"
        if p.exists():
            p.unlink()
    return {"ok": True}


# ---- Mappings library (named saved mappings) ---- #
def _load_named(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_named(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


class NamedSave(BaseModel):
    name: str
    value: dict | str


@app.get("/api/comfy/mappings")
def api_comfy_mappings_list():
    return {"items": _load_named(COMFY_MAPPINGS_PATH)}


@app.post("/api/comfy/mappings")
def api_comfy_mappings_save(req: NamedSave):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Enter a name.")
    if not isinstance(req.value, dict):
        raise HTTPException(400, "The mapping must be a JSON object.")
    data = _load_named(COMFY_MAPPINGS_PATH)
    data[name] = req.value
    _save_named(COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


@app.delete("/api/comfy/mappings/{name}")
def api_comfy_mappings_delete(name: str):
    data = _load_named(COMFY_MAPPINGS_PATH)
    data.pop(name, None)
    _save_named(COMFY_MAPPINGS_PATH, data)
    return {"ok": True, "items": data}


# ---- Prompt library ---- #
@app.get("/api/comfy/prompts")
def api_comfy_prompts_list():
    return {"items": _load_named(COMFY_PROMPTS_PATH)}


@app.post("/api/comfy/prompts")
def api_comfy_prompts_save(req: NamedSave):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Enter a name.")
    data = _load_named(COMFY_PROMPTS_PATH)
    data[name] = req.value if isinstance(req.value, str) else json.dumps(req.value)
    _save_named(COMFY_PROMPTS_PATH, data)
    return {"ok": True, "items": data}


@app.delete("/api/comfy/prompts/{name}")
def api_comfy_prompts_delete(name: str):
    data = _load_named(COMFY_PROMPTS_PATH)
    data.pop(name, None)
    _save_named(COMFY_PROMPTS_PATH, data)
    return {"ok": True, "items": data}


# ---- Workflow library (named saved API-format workflows, SQLite-backed) ---- #
def _wf_names() -> list[str]:
    rows = _db_query("SELECT name FROM workflows ORDER BY name COLLATE NOCASE", many=True)
    return [r[0] for r in rows]


def _wf_upsert(name: str, wf: dict) -> None:
    now = time.time()
    _db_query(
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
    rows = _db_query(
        "SELECT name, node_count, updated FROM workflows ORDER BY name COLLATE NOCASE",
        many=True,
    )
    items = [
        {"name": r["name"], "node_count": r["node_count"], "updated": r["updated"]}
        for r in rows
    ]
    return {"items": items, "names": [r["name"] for r in rows]}


@app.get("/api/comfy/workflows/{name}")
def api_comfy_workflows_get(name: str):
    r = _db_query("SELECT workflow FROM workflows WHERE name=?", (name,))
    if not r:
        raise HTTPException(404, "Nieznany workflow.")
    return {"name": name, "workflow": json.loads(r["workflow"])}


@app.post("/api/comfy/workflows")
def api_comfy_workflows_save(req: NamedSave):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Enter a name.")
    if not isinstance(req.value, dict) or not req.value:
        raise HTTPException(400, "The workflow must be a non-empty JSON object.")
    _wf_upsert(name, req.value)
    return {"ok": True, "names": _wf_names()}


@app.post("/api/comfy/workflows/import")
async def api_comfy_workflows_import(file: UploadFile, name: str = Form("")):
    """Import a workflow from an uploaded .json or ComfyUI .png into the library."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        wf = comfy_workflows.extract_auto(file.filename or "", raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Failed to read the workflow: {e}")
    nm = (name or "").strip() or Path(file.filename or "workflow").stem or "workflow"
    _wf_upsert(nm, wf)
    return {
        "ok": True,
        "name": nm,
        "node_count": len(wf),
        "workflow": wf,
        "names": _wf_names(),
    }


@app.delete("/api/comfy/workflows/{name}")
def api_comfy_workflows_delete(name: str):
    _db_query("DELETE FROM workflows WHERE name=?", (name,), write=True)
    return {"ok": True, "names": _wf_names()}


# ---- Editor workflow: surowy workflow + parametry per node ---- #
@app.get("/api/comfy/object_info")
def api_comfy_object_info():
    """Cached passthrough of ComfyUI's /object_info (node schemas)."""
    import time as _t
    cfg = _load_comfy_config()
    url = cfg.get("url") or comfy_client.DEFAULT_URL
    now = _t.time()
    if (
        _OBJECT_INFO_CACHE["url"] == url
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
    cfg = _load_comfy_config()
    cfg["editor_workflow"] = workflow
    _save_comfy_config(cfg)
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


def _run_comfy_raw_job(job_id: str, workflow: dict) -> None:
    """Submit a raw workflow as-is (no mapping/overrides). Used by the editor."""
    import time
    import uuid as _uuid

    job = COMFY_JOBS[job_id]
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
                job["current"] = f"Krok {payload.get('value')}/{payload.get('max')}"
            elif kind == "executing":
                if payload.get("node"):
                    job["current_node"] = payload["node"]
            elif kind == "preview":
                job["preview"] = payload
                job["preview_ts"] = time.time()
            elif kind == "error":
                job["error"] = payload

        try:
            comfy_client.stream_events(url, client_id, pid, on_event)
        except Exception as e:  # noqa: BLE001
            job["current"] = f"WS unavailable ({e}), polling history…"

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
                    out_path = COMFY_GALLERY_DIR / f"{item_id}.png"
                    out_path.write_bytes(data)
                    meta = {
                        "id": item_id,
                        "filename": o["filename"],
                        "seed": gallery_seed,
                        "prompt": gallery_prompt or "(editor)",
                        "loras": [],
                        "ts": time.time(),
                        "url": f"/api/comfy/gallery/{item_id}",
                        "source": "editor",
                    }
                    (COMFY_GALLERY_DIR / f"{item_id}.json").write_text(
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
    cfg = _load_comfy_config()
    cfg["editor_workflow"] = req.workflow
    _save_comfy_config(cfg)

    job_id = uuid.uuid4().hex[:12]
    with COMFY_JOBS_LOCK:
        COMFY_JOBS[job_id] = {
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
    conn = sqlite3.connect(str(DB_PATH))
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
        rows = _db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library WHERE category=? ORDER BY id DESC",
            (category,), many=True,
        )
    else:
        rows = _db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library ORDER BY id DESC",
            many=True,
        )
    return {"prompts": [dict(r) for r in (rows or [])]}


@app.delete("/api/prompts/library/{pid}")
def api_prompt_library_delete(pid: int):
    if not _db_query("SELECT 1 FROM prompt_library WHERE id=?", (pid,)):
        raise HTTPException(404, "No prompt with that id.")
    _db_query("DELETE FROM prompt_library WHERE id=?", (pid,), write=True)
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
IDEOGRAM_RENDER_CFG_PATH = WORK / "ideogram_render.json"


class IdeogramRenderRequest(BaseModel):
    prompt: str       # minified JSON v15
    params: dict = {}


@app.get("/api/ideogram/render/config")
def api_ideogram_render_config():
    """Last-used render parameters (merged with the defaults)."""
    return {"params": ideogram_workflow.merge_params(_load_named(IDEOGRAM_RENDER_CFG_PATH)),
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
    _save_named(IDEOGRAM_RENDER_CFG_PATH, params)
    workflow = ideogram_workflow.build_workflow(req.prompt, params)

    job_id = uuid.uuid4().hex[:12]
    with COMFY_JOBS_LOCK:
        COMFY_JOBS[job_id] = {
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
    t = threading.Thread(target=_run_comfy_raw_job, args=(job_id, workflow), daemon=True)
    t.start()
    return {"job_id": job_id, "warnings": v15_lint.lint_v15(req.prompt)}


def _vlm_image_to_v15(image, instruction: str, model: str, quant: str,
                      max_tokens: int, default_ratio: str) -> str:
    """Run the chosen vision model (local or LM Studio) and normalize to v15."""
    lm_id = _lmstudio_model_id(model)
    if lm_id is not None:
        raw = lmstudio.caption_image(_lmstudio_url(), lm_id, image, instruction, max_tokens)
    else:
        captioner.ensure_loaded(model, quant if quant in ("4bit", "none") else "4bit",
                                source=_ensure_model_http(model))
        raw = captioner.query_image(image, instruction, max_new_tokens=max_tokens)
    return prompts.normalize_ideogram_v15(raw, default_ratio=default_ratio)


@app.post("/api/ideogram/analyze")
async def api_ideogram_analyze(file: UploadFile, engine: str = Form("florence"),
                               model: str = Form(captioner.DEFAULT_MODEL),
                               quant: str = Form("4bit"),
                               max_tokens: int = Form(768)):
    """Reference image -> v15 prompt draft.

    Engines: "florence" (caption + measured bboxes + OCR), "vlm" (the chosen
    vision model drafts the whole JSON, estimating bboxes itself), "hybrid"
    (Florence measures the bboxes/OCR, the vision model writes the v15 prose).
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Upload an image file.")
    data = await file.read()
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Failed to read the image.")

    ratio = florence.nearest_aspect(image.width, image.height)

    def analyze() -> tuple[str, str]:
        """Model download, load and inference: blocking, so run off the event loop."""
        used_model = florence.DEFAULT_MODEL
        if engine == "vlm":
            draft = _vlm_image_to_v15(image, prompts.build_image_v15_instruction(),
                                      model, quant, max_tokens, ratio)
            used_model = model
        elif engine == "hybrid":
            _ensure_model_http(florence.DEFAULT_MODEL)
            caption, elements = florence.analyze_image(image)
            base = florence.build_v15_draft(caption, elements, image.width, image.height)
            draft = _vlm_image_to_v15(image, prompts.build_hybrid_v15_instruction(base),
                                      model, quant, max_tokens, ratio)
            used_model = f"{florence.DEFAULT_MODEL} + {model}"
        else:
            _ensure_model_http(florence.DEFAULT_MODEL)
            caption, elements = florence.analyze_image(image)
            draft = florence.build_v15_draft(caption, elements, image.width, image.height)
        return draft, used_model

    try:
        draft, used_model = await run_in_threadpool(analyze)
    except HTTPException:
        raise
    except lmstudio.LMStudioError as e:
        raise HTTPException(502, f"LM Studio: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Image analysis failed: {e}")

    n_elements = len((json.loads(draft).get("compositional_deconstruction") or {})
                     .get("elements") or [])
    return {"json": draft, "elements": n_elements,
            "model": used_model, "warnings": v15_lint.lint_v15(draft)}


@app.post("/api/prompt")
def api_prompt(req: PromptRequest):
    """Expand or refine a generation prompt (FLUX.2 or Ideogram 4 JSON) using the local LLM."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Type a prompt to expand or refine.")

    quant = req.quant if req.quant in ("4bit", "none") else "4bit"
    try:
        if req.caption_format in ("ideogram", "aitoolkit"):
            system = prompts.build_ideogram_studio_v15(
                req.action, req.subject, req.elements_detail, req.desc_detail)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        lm_id = _lmstudio_model_id(req.model)
        if lm_id is not None:
            raw = lmstudio.generate_text(_lmstudio_url(), lm_id, system, text, req.max_tokens)
        else:
            captioner.ensure_loaded(req.model, quant, source=_ensure_model_http(req.model))
            raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format in ("ideogram", "aitoolkit"):
            final = prompts.normalize_ideogram_v15(raw)
            warnings = v15_lint.lint_v15(final)
        else:
            final = prompts.clean_prompt(raw)
            warnings = []
        library_id = _save_prompt_to_library(
            _prompt_category(req.caption_format), req.action, text, final)
        return {"prompt": final, "library_id": library_id, "warnings": warnings}
    except HTTPException:
        raise
    except lmstudio.LMStudioError as e:
        raise HTTPException(502, f"LM Studio: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Generation error: {e}")


@app.post("/api/zip")
def api_zip(req: ExportRequest):
    """Build the dataset as an in-memory ZIP and return it as a download."""
    job = _job_of_kind(req.job_id, "dataset")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")

    proc_dir = WORK / req.job_id / "processed"
    exclude = set(req.exclude_idx)

    buf = io.BytesIO()
    written = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in job["results"]:
            if not r["out_name"] or r["idx"] in exclude:
                continue
            src_img = proc_dir / r["out_name"]
            if not src_img.exists():
                continue
            zf.write(str(src_img), r["out_name"])
            caption = _final_caption(req, r)
            base = Path(r["out_name"]).stem
            for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
                zf.writestr(fname, content)
            written += 1

    if written == 0:
        raise HTTPException(400, "No images to package.")

    buf.seek(0)
    fname = f"dataset_{job['config'].get('mode', 'lora')}_{req.job_id[:8]}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# --------------------------------------------------------------------------- #
# Frontend (mounted last so it doesn't shadow /api routes)
# --------------------------------------------------------------------------- #
@app.get("/health")
def health():
    return JSONResponse({"ok": True})


app.include_router(api_settings.router)
models_api.configure(_model_ctx, lambda: hf_auth.load_token(HF_TOKEN_PATH))
app.include_router(models_api.router)


@app.get("/legacy", include_in_schema=False)
def legacy_slash():
    # The mount below only matches "/legacy/..."; without this, the SPA would answer.
    return RedirectResponse("/legacy/", 307)


app.mount("/legacy", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")


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
        return RedirectResponse("/legacy/", 307)
    return FileResponse(str(index))
