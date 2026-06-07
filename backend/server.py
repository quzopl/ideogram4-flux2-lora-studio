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
import shutil
import sqlite3
import threading
import time
import traceback
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import captioner, comfy_client, comfy_workflows, image_utils, lmstudio, prompts

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
WORK = ROOT / ".work"
WORK.mkdir(exist_ok=True)

COMFY_CONFIG_PATH = WORK / "comfy_config.json"
COMFY_MAPPINGS_PATH = WORK / "comfy_mappings.json"
COMFY_PROMPTS_PATH = WORK / "comfy_prompts.json"
COMFY_WORKFLOWS_PATH = WORK / "comfy_workflows.json"
CUSTOM_MODELS_PATH = WORK / "custom_models.json"
LMSTUDIO_CONFIG_PATH = WORK / "lmstudio.json"
COMFY_GALLERY_DIR = WORK / "comfy_gallery"
COMFY_GALLERY_DIR.mkdir(exist_ok=True)

DB_PATH = WORK / "flux_prep.db"


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

app = FastAPI(title="FLUX LoRA Dataset Prep")

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
    resolution: int = 1024
    step: int = 64
    square: bool = False
    fmt: str = "png"  # "png" | "jpg"
    jpg_quality: int = 95
    model: str = captioner.DEFAULT_MODEL
    quant: str = "4bit"  # "4bit" | "none"
    max_tokens: int = 256
    do_caption: bool = True
    caption_format: str = "flux"  # "flux" | "ideogram"


class ExportRequest(BaseModel):
    job_id: str
    output_folder: str = ""
    trigger: str = ""
    prepend_trigger: bool = True
    captions: dict[str, str] = {}  # index (as str) -> edited caption
    exclude_idx: list[int] = []    # indices removed by the user in the UI


class PromptRequest(BaseModel):
    text: str
    action: str = "expand"   # "expand" (rozbuduj) | "refine" (popraw)
    subject: str = "auto"    # auto | person | product | landscape | architecture
    model: str = captioner.DEFAULT_MODEL
    quant: str = "4bit"      # "4bit" | "none"
    max_tokens: int = 320
    caption_format: str = "flux"  # "flux" | "ideogram"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _list_images(folder: str) -> list[Path]:
    p = Path(folder).expanduser()
    if not p.is_dir():
        raise HTTPException(400, f"Folder nie istnieje: {folder}")
    files = [
        f for f in sorted(p.iterdir())
        if f.is_file() and f.suffix.lower() in image_utils.SUPPORTED_EXT
    ]
    return files


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
    """Zwróć listę (nazwa_pliku, treść) do zapisania dla danego opisu.

    Zawsze .txt; dla "ideogram" dodatkowo ładny .json. "aitoolkit" = sam .txt.
    """
    files: list[tuple[str, str]] = [(f"{base_name}.txt", caption + "\n")]
    if fmt == "ideogram":
        pretty = prompts.ideogram_pretty(caption)
        if pretty is not None:
            files.append((f"{base_name}.json", pretty + "\n"))
    return files


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
            job["current"] = "Ładowanie modelu VLM (pierwsze uruchomienie pobiera wagi)…"
            quant = req.quant if req.quant in ("4bit", "none") else "4bit"
            captioner.ensure_loaded(req.model, quant)

        job["state"] = "processing"
        prefix = (req.mode or "img")

        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img, (w, h) = image_utils.process_image(
                    str(src), req.resolution, req.step, req.square
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
                })
            except Exception as e:  # noqa: BLE001 - record per-file failures, keep going
                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": "",
                    "width": 0,
                    "height": 0,
                    "caption": f"[BŁĄD: {e}]",
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
    """Posortowane (case-insensitive) nazwy podkatalogów; nieczytelne pomijane."""
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


def _model_dir_info(path: Path) -> dict:
    """Czy `path` to folder z modelem Qwen2.5-VL. {ok, reason, label}."""
    if not path.is_dir():
        return {"ok": False, "reason": "Folder nie istnieje.", "label": ""}
    cfg = path / "config.json"
    if not cfg.is_file():
        return {"ok": False,
                "reason": "To nie jest folder modelu (brak config.json).",
                "label": ""}
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {"ok": False, "reason": "Nie można odczytać config.json.", "label": ""}
    model_type = str(data.get("model_type", "")).lower()
    arch = " ".join(data.get("architectures", []) or [])
    if "qwen2_5_vl" in model_type or "Qwen2_5_VL" in arch:
        return {"ok": True, "reason": "", "label": f"{path.name} (własny)"}
    return {"ok": False,
            "reason": "Obsługiwane są tylko modele Qwen2.5-VL.",
            "label": ""}


def _lmstudio_url() -> str:
    data = _load_named(LMSTUDIO_CONFIG_PATH)
    return data.get("url") or lmstudio.DEFAULT_URL


def _set_lmstudio_url(url: str) -> str:
    url = url.strip() or lmstudio.DEFAULT_URL
    _save_named(LMSTUDIO_CONFIG_PATH, {"url": url})
    return url


def _lmstudio_model_id(model: str) -> str | None:
    """Zwróć id modelu LM Studio (część po 'lmstudio:'), inaczej None."""
    prefix = "lmstudio:"
    return model[len(prefix):] if model.startswith(prefix) else None


def _all_models() -> dict:
    """Wbudowane + własne + (jeśli dostępne) modele z LM Studio."""
    models = {**captioner.AVAILABLE_MODELS, **_load_named(CUSTOM_MODELS_PATH)}
    for mid in lmstudio.list_models(_lmstudio_url()):
        models[f"lmstudio:{mid}"] = f"LM Studio: {mid}"
    return models


def _add_custom_model(path: str) -> dict:
    """Zwaliduj i zapisz własny model. Rzuca ValueError z czytelnym powodem."""
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
def api_fs_list(path: str = ""):
    base = (Path(path).expanduser() if path else Path.home()).resolve()
    if not base.is_dir():
        raise HTTPException(400, f"Nie jest folderem: {base}")
    parent = None if base.parent == base else str(base.parent)
    return {
        "path": str(base),
        "parent": parent,
        "dirs": _list_subdirs(base),
        "is_model": _model_dir_info(base)["ok"],
    }


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


@app.get("/api/fs/pick")
def api_fs_pick():
    """Otwórz natywne systemowe okno wyboru folderu (zenity/WSLg) i zwróć ścieżkę.

    Przeglądarka nie udostępnia bezwzględnej ścieżki, więc używamy standardowego
    okna systemowego — działa, bo aplikacja jest lokalna.
    """
    import subprocess

    try:
        proc = subprocess.run(
            ["zenity", "--file-selection", "--directory",
             "--title=Wybierz folder z modelem Qwen2.5-VL"],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        raise HTTPException(500, "Brak 'zenity' — natywne okno wyboru niedostępne.")
    except subprocess.TimeoutExpired:
        return {"cancelled": True}
    path = proc.stdout.strip()
    if proc.returncode != 0 or not path:
        return {"cancelled": True}  # użytkownik anulował
    return {"path": path}


class LmStudioConfig(BaseModel):
    url: str = ""


@app.get("/api/lmstudio")
def api_lmstudio_get():
    return {"url": _lmstudio_url()}


@app.post("/api/lmstudio")
def api_lmstudio_set(req: LmStudioConfig):
    return {"url": _set_lmstudio_url(req.url)}


@app.post("/api/scan")
def api_scan(req: ScanRequest):
    files = _list_images(req.folder)
    return {
        "folder": str(Path(req.folder).expanduser()),
        "count": len(files),
        "files": [f.name for f in files],
    }


@app.post("/api/upload")
async def api_upload(files: list[UploadFile]):
    dest = WORK / "uploads" / uuid.uuid4().hex
    dest.mkdir(parents=True, exist_ok=True)
    saved = 0
    for f in files:
        if Path(f.filename).suffix.lower() not in image_utils.SUPPORTED_EXT:
            continue
        target = dest / Path(f.filename).name
        with open(target, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved += 1
    return {"folder": str(dest), "count": saved}


@app.post("/api/process")
def api_process(req: ProcessRequest):
    files = _list_images(req.folder)
    if not files:
        raise HTTPException(400, "Brak obsługiwanych obrazów w folderze.")

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
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
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Nieznane zadanie.")
    return _job_public(job)


@app.get("/api/thumb/{job_id}/{idx}")
def api_thumb(job_id: str, idx: int):
    path = WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "Brak miniatury.")
    return FileResponse(str(path))


@app.post("/api/export")
def api_export(req: ExportRequest):
    job = JOBS.get(req.job_id)
    if not job:
        raise HTTPException(404, "Nieznane zadanie.")
    if job["state"] != "done":
        raise HTTPException(400, "Zadanie nie jest zakończone.")

    if not req.output_folder.strip():
        raise HTTPException(400, "Podaj folder docelowy.")
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


@app.get("/api/gpu")
def api_gpu():
    return captioner.gpu_status()


@app.post("/api/unload")
def api_unload():
    if _busy():
        raise HTTPException(409, "Trwa przetwarzanie — poczekaj na zakończenie.")
    captioner.unload()
    return captioner.gpu_status()


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
        raise HTTPException(400, "Pusty plik.")
    try:
        workflow = comfy_workflows.extract_auto(file.filename or "", raw)
        mapping = comfy_workflows.autodetect_mapping(workflow)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Nie udało się odczytać workflow: {e}")

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
            job["current"] = f"Próbka {i + 1}/{batch}: kolejkuję…"
            job["progress"] = {"value": 0, "max": req.steps or 0, "speed": 0.0, "eta": 0.0}
            job["_spd_lv"] = None  # re-anchor speed tracker for this sample

            patched = _normalize_paths(patched)  # napraw ścieżki \ -> / (lora/ckpt)
            try:
                pid = comfy_client.queue_prompt(url, patched, client_id=client_id)
            except comfy_client.ComfyError as e:
                job["state"] = "error"
                job["error"] = f"Błąd kolejkowania: {e}"
                return

            # Drive the WS until the prompt is done.
            def on_event(kind: str, payload):
                if kind == "progress":
                    _progress_update(
                        job, payload.get("value"), payload.get("max") or (req.steps or 0)
                    )
                    job["current"] = f"Próbka {i + 1}/{batch}: krok {payload.get('value')}/{payload.get('max')}"
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
                job["current"] = f"Próbka {i + 1}/{batch}: WS niedostępny ({e}), odpytuję history…"

            # Fetch outputs from history (no timeout — wait as long as it takes).
            while True:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    return
                try:
                    hist = comfy_client.history(url, pid)
                except comfy_client.ComfyError as e:
                    job["state"] = "error"
                    job["error"] = f"Błąd /history: {e}"
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
                            job["error"] = f"Błąd /view: {e}"
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
        job["current"] = f"Zakończono ({job['done_count']}/{batch})"
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
            "current": "Start…",
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
        raise HTTPException(404, "Nieznane zadanie.")
    return _comfy_job_public(job)


@app.get("/api/comfy/job/{job_id}/preview")
def api_comfy_job_preview(job_id: str):
    job = COMFY_JOBS.get(job_id)
    if not job or job.get("preview") is None:
        raise HTTPException(404, "Brak podglądu.")
    return Response(content=job["preview"], media_type="image/png")


@app.post("/api/comfy/job/{job_id}/cancel")
def api_comfy_job_cancel(job_id: str):
    job = COMFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Nieznane zadanie.")
    job["cancel"] = True
    return {"ok": True}


@app.get("/api/comfy/gallery/{item_id}")
def api_comfy_gallery_item(item_id: str):
    p = COMFY_GALLERY_DIR / f"{item_id}.png"
    if not p.exists():
        raise HTTPException(404, "Brak obrazu.")
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
        raise HTTPException(400, "Podaj nazwę.")
    if not isinstance(req.value, dict):
        raise HTTPException(400, "Mapowanie musi być obiektem JSON.")
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
        raise HTTPException(400, "Podaj nazwę.")
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
        raise HTTPException(400, "Podaj nazwę.")
    if not isinstance(req.value, dict) or not req.value:
        raise HTTPException(400, "Workflow musi być niepustym obiektem JSON.")
    _wf_upsert(name, req.value)
    return {"ok": True, "names": _wf_names()}


@app.post("/api/comfy/workflows/import")
async def api_comfy_workflows_import(file: UploadFile, name: str = Form("")):
    """Import a workflow from an uploaded .json or ComfyUI .png into the library."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Pusty plik.")
    try:
        wf = comfy_workflows.extract_auto(file.filename or "", raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Nie udało się odczytać workflow: {e}")
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
    """Cached passthrough of ComfyUI's /object_info (schemy node'ów)."""
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
        raise HTTPException(400, "Pusty plik.")
    try:
        workflow = comfy_workflows.extract_auto(file.filename or "", raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Nie udało się odczytać workflow: {e}")
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
        job["current"] = "Kolejkuję workflow…"
        workflow = _normalize_paths(workflow)  # napraw ścieżki \ -> / (lora/ckpt)
        try:
            pid = comfy_client.queue_prompt(url, workflow, client_id=client_id)
        except comfy_client.ComfyError as e:
            job["state"] = "error"
            job["error"] = f"Błąd kolejkowania: {e}"
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
            job["current"] = f"WS niedostępny ({e}), odpytuję history…"

        while True:
            if job.get("cancel"):
                job["state"] = "cancelled"
                return
            try:
                hist = comfy_client.history(url, pid)
            except comfy_client.ComfyError as e:
                job["state"] = "error"
                job["error"] = f"Błąd /history: {e}"
                return
            outs = comfy_client.collect_output_images(hist, pid)
            if outs:
                for o in outs:
                    try:
                        data = comfy_client.fetch_image(
                            url, o["filename"], o["subfolder"], o["type"]
                        )
                    except comfy_client.ComfyError as e:
                        job["error"] = f"Błąd /view: {e}"
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
        job["current"] = "Zakończono"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/comfy/editor/generate")
def api_comfy_editor_generate(req: ComfyEditorGenerate):
    if not req.workflow:
        raise HTTPException(400, "Pusty workflow.")
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
            "current": "Start…",
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


@app.post("/api/prompt")
def api_prompt(req: PromptRequest):
    """Expand or refine a generation prompt (FLUX.2 or Ideogram 4 JSON) using the local LLM."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Wpisz prompt do rozbudowania lub poprawy.")

    quant = req.quant if req.quant in ("4bit", "none") else "4bit"
    try:
        if req.caption_format in ("ideogram", "aitoolkit"):
            system = prompts.build_ideogram_studio_guide(req.action, req.subject)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        lm_id = _lmstudio_model_id(req.model)
        if lm_id is not None:
            raw = lmstudio.generate_text(_lmstudio_url(), lm_id, system, text, req.max_tokens)
        else:
            captioner.ensure_loaded(req.model, quant)
            raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format in ("ideogram", "aitoolkit"):
            return {"prompt": prompts.normalize_ideogram_guide(raw)}
        return {"prompt": prompts.clean_prompt(raw)}
    except lmstudio.LMStudioError as e:
        raise HTTPException(502, f"LM Studio: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Błąd generowania: {e}")


@app.post("/api/zip")
def api_zip(req: ExportRequest):
    """Build the dataset as an in-memory ZIP and return it as a download."""
    job = JOBS.get(req.job_id)
    if not job:
        raise HTTPException(404, "Nieznane zadanie.")
    if job["state"] != "done":
        raise HTTPException(400, "Zadanie nie jest zakończone.")

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
        raise HTTPException(400, "Brak zdjęć do spakowania.")

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


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
