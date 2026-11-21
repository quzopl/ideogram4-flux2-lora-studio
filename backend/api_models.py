"""HTTP face of the model store (backend/model_store.py).

The UI lists models, downloads one into a chosen folder, points a model at an
existing folder/file ("locate") or forgets that pointer. Locate and forget only
edit ``model_locations`` in the settings; they never touch files on disk.

``server.py`` owns the config paths, so it hands in the context and token
getters through ``configure`` instead of this module importing ``server``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import model_store, settings

router = APIRouter(prefix="/api/store")

_ctx: Callable[[], dict] = lambda: {}  # noqa: E731
_token: Callable[[], str] = lambda: ""  # noqa: E731


def configure(ctx: Callable[[], dict], token: Callable[[], str]) -> None:
    global _ctx, _token
    _ctx, _token = ctx, token


class DownloadReq(BaseModel):
    model_id: str
    dest: str = ""


class LocateReq(BaseModel):
    model_id: str
    path: str


class ForgetReq(BaseModel):
    model_id: str


def _models() -> dict:
    ctx = _ctx()
    return {"models_dir": ctx["settings"].get("models_dir", ""),
            "models": model_store.listing(ctx)}


def _entry(model_id: str, ctx: dict) -> dict:
    entry = model_store.find(model_id, ctx)
    if entry is None:
        raise HTTPException(404, "Unknown model.")
    return entry


@router.get("/models")
def get_models() -> dict:
    return _models()


@router.post("/download")
def post_download(req: DownloadReq) -> dict:
    ctx = _ctx()
    dest = req.dest.strip() or ctx["settings"].get("models_dir", "")
    if not dest:
        raise HTTPException(400, "Choose a folder to download into.")
    try:
        return model_store.start_download(req.model_id, dest, ctx, _token())
    except KeyError:
        raise HTTPException(404, "Unknown model.")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/downloads")
def get_downloads() -> dict:
    with model_store._LOCK:
        jobs = [dict(j) for j in model_store.DOWNLOADS.values()]
    return {"downloads": jobs[::-1]}


@router.post("/downloads/{job_id}/cancel")
def post_cancel(job_id: str) -> dict:
    try:
        return model_store.cancel_download(job_id)
    except KeyError:
        raise HTTPException(404, "Unknown download.")


@router.post("/locate")
def post_locate(req: LocateReq) -> dict:
    entry = _entry(req.model_id, _ctx())
    if entry.get("path"):
        raise HTTPException(400, "This model's location is fixed.")
    path = Path(req.path).expanduser().resolve()
    check = (model_store.validate_weight_file(path) if entry["kind"] == "upscale"
             else model_store.validate_dir(path, entry["kind"]))
    if not check["ok"]:
        raise HTTPException(400, check["reason"])
    settings.update(lambda d: d["model_locations"].__setitem__(req.model_id, str(path)))
    return _models()


@router.post("/forget")
def post_forget(req: ForgetReq) -> dict:
    _entry(req.model_id, _ctx())
    settings.update(lambda d: d["model_locations"].pop(req.model_id, None))
    return _models()
