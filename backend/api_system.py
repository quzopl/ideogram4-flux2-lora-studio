"""System routes: model list, folder browser, LM Studio, HF token, GPUs, health."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import (captioner, core, florence, fsutil, gpu, hf_auth, lmstudio, model_store,
               settings, upscaler)

router = APIRouter()


class HFTokenRequest(BaseModel):
    token: str


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


def _all_models() -> dict:
    """Built-in + custom + (when reachable) LM Studio models."""
    models = {**captioner.AVAILABLE_MODELS, **core._load_named(core.CUSTOM_MODELS_PATH)}
    for mid in lmstudio.list_models(core._lmstudio_url()):
        models[f"lmstudio:{mid}"] = f"LM Studio: {mid}"
    return models


def _add_custom_model(path: str) -> dict:
    """Validate and save a custom model. Raises ValueError with a readable reason."""
    resolved = Path(path).expanduser().resolve()
    info = _model_dir_info(resolved)
    if not info["ok"]:
        raise ValueError(info["reason"])
    data = core._load_named(core.CUSTOM_MODELS_PATH)
    data[str(resolved)] = info["label"]
    core._save_named(core.CUSTOM_MODELS_PATH, data)
    return {"added": str(resolved), "label": info["label"]}


def _remove_custom_model(path: str) -> None:
    resolved = str(Path(path).expanduser().resolve())
    data = core._load_named(core.CUSTOM_MODELS_PATH)
    if resolved in data:
        del data[resolved]
        core._save_named(core.CUSTOM_MODELS_PATH, data)


class CustomModel(BaseModel):
    path: str


@router.get("/api/models")
def api_models():
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}


@router.get("/api/fs/list")
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


@router.post("/api/fs/mkdir")
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


@router.post("/api/models/custom")
def api_models_custom_add(req: CustomModel):
    try:
        res = _add_custom_model(req.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"models": _all_models(),
            "default": captioner.DEFAULT_MODEL,
            "added": res["added"]}


@router.delete("/api/models/custom")
def api_models_custom_remove(req: CustomModel):
    _remove_custom_model(req.path)
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}


class LmStudioConfig(BaseModel):
    url: str = ""


@router.get("/api/lmstudio")
def api_lmstudio_get():
    return {"url": core._lmstudio_url()}


@router.post("/api/lmstudio")
def api_lmstudio_set(req: LmStudioConfig):
    return {"url": core._set_lmstudio_url(req.url)}


@router.get("/api/hf/token")
def api_hf_token_get():
    return hf_auth.status(hf_auth.load_token(core.HF_TOKEN_PATH))


@router.post("/api/hf/token")
def api_hf_token_set(req: HFTokenRequest):
    hf_auth.save_token(core.HF_TOKEN_PATH, req.token)
    hf_auth.apply_env(req.token)
    return hf_auth.status(req.token)


@router.delete("/api/hf/token")
def api_hf_token_clear():
    hf_auth.clear_token(core.HF_TOKEN_PATH)
    hf_auth.apply_env("")
    return {"set": False, "tail": ""}


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
    # The status shows one card: the VLM role's (none when it runs on
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
    is loaded on it. ``selected`` marks the VLM role's card."""
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


@router.get("/api/gpu")
def api_gpu():
    return _gpu_status()


@router.post("/api/unload")
def api_unload():
    if core._busy():
        raise HTTPException(409, "Processing in progress — wait for it to finish.")
    captioner.unload()
    florence.unload()
    upscaler.unload()
    return _gpu_status()


class GpuAssignRequest(BaseModel):
    role: str
    device: str


@router.get("/api/gpus")
def api_gpus():
    """Cards for the topbar select, labelled by name — never by CUDA index —
    and what each role is set to ("auto", "cpu" or a card's UUID)."""
    devices = gpu.probe()
    doc = settings.load()
    cards = _gpu_cards(devices, doc)
    vlm = next((c for c in cards if c["selected"]), None)
    return {"gpus": cards, "selected": vlm["uuid"] if vlm else None,
            "roles": dict(doc["gpu"])}


@router.post("/api/gpu/assign")
def api_gpu_assign(req: GpuAssignRequest):
    """Move one role to another card ("auto" = most memory, or "cpu"). Only
    that role's model is released — it sits on the old card; the other roles
    keep theirs loaded."""
    if core._busy():
        raise HTTPException(409, "Processing in progress — wait for it to finish.")
    if req.role not in settings.ROLES:
        raise HTTPException(400, "Unknown role.")
    if not gpu.assign_value_ok(req.device, gpu.probe()):
        raise HTTPException(400, "Unknown GPU.")
    settings.update(lambda d: d["gpu"].__setitem__(req.role, req.device))
    {"vlm": captioner.unload, "florence": florence.unload,
     "upscale": upscaler.unload}[req.role]()
    return _gpu_status()


@router.get("/health")
def health():
    return JSONResponse({"ok": True})
