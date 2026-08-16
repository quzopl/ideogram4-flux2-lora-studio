"""Super-resolution models for the dataset pipeline and the Upscale tab.

Weights come from three places: a small built-in list downloaded from Hugging
Face, user-added HF repos, and a local folder scan (e.g. ComfyUI's
models/upscale_models). Files are loaded by spandrel, which detects the
architecture and scale on its own.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

WEIGHT_EXT = {".pth", ".safetensors"}
MAX_PASSES = 2

# NOTE: repo ids are verified by an actual download in the last task of the
# plan; an entry that cannot be fetched is removed from this list.
BUILTIN_MODELS = [
    {"id": "realesrgan-x4", "label": "Real-ESRGAN x4 (photos, general)",
     "repo_id": "ai-forever/Real-ESRGAN", "filename": "RealESRGAN_x4.pth",
     "scale": 4, "note": "Solid default for photographic sources."},
    {"id": "realesrgan-x2", "label": "Real-ESRGAN x2 (photos, gentle)",
     "repo_id": "ai-forever/Real-ESRGAN", "filename": "RealESRGAN_x2.pth",
     "scale": 2, "note": "Less aggressive, keeps grain."},
    {"id": "ultrasharp-x4", "label": "4x-UltraSharp (crisp detail)",
     "repo_id": "lokCX/4x-Ultrasharp", "filename": "4x-UltraSharp.pth",
     "scale": 4, "note": "Sharper, can exaggerate texture."},
]

_LOCK = threading.Lock()
_RUNTIME: dict | None = None      # {"model", "torch", "device", "key", "scale"}


# --------------------------------------------------------------------------- #
# Pure helpers (no torch, no network)
# --------------------------------------------------------------------------- #
def plan_passes(src_size, target_size, scale: int, min_ratio: float = 1.05) -> int:
    """How many model passes to reach ``target_size`` (0 = skip the upscaler)."""
    sw, sh = src_size
    tw, th = target_size
    if sw <= 0 or sh <= 0 or scale <= 1:
        return 0
    ratio = max(tw / sw, th / sh)
    if ratio <= min_ratio:
        return 0
    passes, cur = 0, 1.0
    while cur < ratio and passes < MAX_PASSES:
        cur *= scale
        passes += 1
    return passes


def scan_folder(folder: str) -> list[dict]:
    """Weight files found in a local folder, as registry entries."""
    if not folder:
        return []
    p = Path(folder).expanduser()
    if not p.is_dir():
        return []
    out: list[dict] = []
    try:
        entries = sorted(p.iterdir())
    except OSError:  # PermissionError, etc.
        return []
    for f in entries:
        if f.is_file() and f.suffix.lower() in WEIGHT_EXT:
            out.append({
                "id": f"local:{f}",
                "label": f"Local: {f.name}",
                "repo_id": "",
                "filename": f.name,
                "path": str(f),
                "scale": 0,          # spandrel reports the real scale on load
                "note": str(p),
            })
    return out


def load_config(path) -> dict:
    """Read .work/upscaler.json; defaults to {"folder": "", "custom": []} when missing or invalid."""
    p = Path(path)
    if not p.exists():
        return {"folder": "", "custom": []}
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"folder": "", "custom": []}
    if not isinstance(cfg, dict):
        return {"folder": "", "custom": []}
    cfg.setdefault("folder", "")
    cfg.setdefault("custom", [])
    return cfg


def save_config(path, cfg: dict) -> None:
    Path(path).write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _hf_cached(repo_id: str, filename: str) -> bool:
    """True when the file is already in the local HF cache (no network call)."""
    try:
        from huggingface_hub import try_to_load_from_cache
        return isinstance(try_to_load_from_cache(repo_id, filename), str)
    except Exception:  # noqa: BLE001 - hub missing or cache unreadable
        return False


def registry(cfg: dict) -> list[dict]:
    """Built-in + user HF models + local folder scan, each with a cached flag."""
    out: list[dict] = []
    for m in BUILTIN_MODELS:
        entry = dict(m)
        entry["cached"] = _hf_cached(m["repo_id"], m["filename"])
        entry["source"] = "builtin"
        out.append(entry)
    for c in cfg.get("custom", []):
        repo_id, filename = c.get("repo_id", ""), c.get("filename", "")
        if not repo_id or not filename:
            continue
        out.append({
            "id": f"hf:{repo_id}/{filename}",
            "label": f"HF: {repo_id}/{filename}",
            "repo_id": repo_id, "filename": filename,
            "scale": int(c.get("scale") or 0), "note": "",
            "cached": _hf_cached(repo_id, filename), "source": "custom",
        })
    for m in scan_folder(cfg.get("folder", "")):
        entry = dict(m)
        entry["cached"] = os.path.exists(m["path"])
        entry["source"] = "local"
        out.append(entry)
    return out


def resolve(model_id: str, cfg: dict) -> dict | None:
    """Registry entry for an id, or None when it is unknown."""
    for m in registry(cfg):
        if m["id"] == model_id:
            return m
    return None
