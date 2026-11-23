"""State and helpers shared by the server and its routers.

The work folder and its config paths, the job registries, the GPU busy guard
and the model / LM Studio helpers live here, in one place. Other modules read
them as ``core.NAME`` at call time (never ``from .core import NAME``), so a
test that patches ``core.NAME`` is seen everywhere.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from . import florence, hf_auth, image_utils, lmstudio, model_store, settings, upscaler

ROOT = Path(__file__).resolve().parent.parent
WORK = Path(os.environ.get("FLUX_PREP_WORK") or ROOT / ".work")
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
IDEOGRAM_RENDER_CFG_PATH = WORK / "ideogram_render.json"
SRC_THUMBS = WORK / "srcthumbs"

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

# In-memory job registry. Single-user local tool, so this is sufficient.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


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


def _job_of_kind(job_id: str, kind: str) -> dict:
    """Job with this id, or 404 when it is missing or of a different kind.

    Every job in ``JOBS`` is stamped with ``kind``
    (``dataset`` | ``crop_auto`` | ``upscale`` | ``prompt``) at creation, because the
    kinds are not interchangeable: only dataset results carry ``caption``,
    only crop-auto jobs carry ``crops``, and each kind has its own routes.
    """
    job = JOBS.get(job_id)
    if not job or job.get("kind") != kind:
        raise HTTPException(404, "Unknown job.")
    return job


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


def _ensure_model_mapped(model_id: str, job: dict | None) -> str:
    """_ensure_model with failures as HTTPException: a setup problem is a 400, a failed download a 502."""
    try:
        return _ensure_model(model_id, job)
    except (model_store.ModelsFolderNotSet, _UnknownModel, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e


florence.SOURCE_RESOLVER = lambda: _ensure_model(florence.DEFAULT_MODEL, None)


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


# A model download keeps the job in pending/loading_model ("downloading" lives
# only on the model_store record), so it needs no state of its own here.
BUSY_STATES = ("pending", "loading_model", "processing", "generating", "analyzing")
BUSY_MSG = "Processing in progress — wait for it to finish."


def _busy() -> bool:
    """True while a job that uses a model loaded in this process is still active.

    Jobs without the ``local_model`` flag count as local (the safe default).
    """
    return any(
        j["state"] in BUSY_STATES and j.get("local_model", True)
        for j in list(JOBS.values())
    )


def _start_job(job: dict, target: Callable, args: tuple, *, local_model: bool) -> None:
    """Register ``job`` and start its thread; 409 if the GPU is taken.

    The check and the registration share one lock, so two simultaneous starts
    cannot both pass. ``local_model`` is False for jobs that never touch a model
    loaded in this process (LM Studio only, or no model at all).
    """
    with JOBS_LOCK:
        if local_model and _busy():
            raise HTTPException(409, BUSY_MSG)
        job["local_model"] = local_model
        JOBS[job["id"]] = job
    try:
        threading.Thread(target=target, args=args, daemon=True).start()
    except BaseException as e:  # noqa: BLE001 - a job without a thread must not stay busy
        msg = f"Could not start the job: {e}"
        job["state"] = "error"
        job["error"] = msg
        raise HTTPException(500, msg)


def _load_named(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_named(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
