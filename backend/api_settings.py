"""HTTP face of the settings store (backend/settings.py).

Every ValueError from the store or from the folder checks becomes a 400 whose
``detail`` is the message, so the UI can show it as is.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import fsutil, settings

router = APIRouter(prefix="/api/settings")


class ModelsDirReq(BaseModel):
    models_dir: str


class ValuesReq(BaseModel):
    values: dict


def _bad(e: ValueError) -> HTTPException:
    return HTTPException(400, str(e))


@router.get("")
def get_settings() -> dict:
    return settings.load()


@router.patch("")
def patch_settings(req: ModelsDirReq) -> dict:
    try:
        p = fsutil.writable_dir(req.models_dir)
        return settings.update(lambda d: d.__setitem__("models_dir", str(p)))
    except ValueError as e:
        raise _bad(e)


@router.put("/forms/{view}")
def put_form(view: str, req: ValuesReq) -> dict:
    try:
        return settings.set_form(view, req.values)
    except ValueError as e:
        raise _bad(e)


@router.put("/presets/{view}/{name}")
def put_preset(view: str, name: str, req: ValuesReq) -> dict:
    try:
        return settings.save_preset(view, name, req.values)
    except ValueError as e:
        raise _bad(e)


@router.delete("/presets/{view}/{name}")
def delete_preset(view: str, name: str) -> dict:
    try:
        return settings.delete_preset(view, name)
    except ValueError as e:
        raise _bad(e)


@router.get("/export")
def export_settings() -> JSONResponse:
    return JSONResponse(
        settings.load(),
        headers={"Content-Disposition": 'attachment; filename="flux-lora-prep-settings.json"'})


@router.post("/import")
def import_settings(doc: dict) -> dict:
    try:
        return settings.import_doc(doc)
    except ValueError as e:
        raise _bad(e)
