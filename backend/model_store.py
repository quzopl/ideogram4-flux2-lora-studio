"""Model registry: every local model the app uses and where it lives on disk.

One place answers "which models exist" (entries) and "where is this one"
(resolve_path). Resolution order for a model: an explicit location from
settings (validated), then the shared models_dir (a snapshot counts only with
the completion MARKER; upscalers are single files), then the HF cache, else
None. Entries that carry their own "path" (local upscaler scans, custom VLM
folders) short-circuit: that path or nothing.

Everything is driven by a plain `ctx` dict built by the server, so this module
never reads settings or config files itself and never touches the network.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import captioner, florence, upscaler

MARKER = ".flux-lora-prep-complete"


def folder_name(repo_id: str) -> str:
    return repo_id.replace("/", "--")


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def is_qwen_vl_config(data: dict) -> bool:
    model_type = str(data.get("model_type", "")).lower()
    arch = " ".join(data.get("architectures", []) or [])
    return "qwen2_5_vl" in model_type or "Qwen2_5_VL" in arch


def weights_complete(path: Path) -> bool:
    path = Path(path)
    if (path / "model.safetensors").is_file():
        return True
    index = path / "model.safetensors.index.json"
    try:
        weight_map = json.loads(index.read_text(encoding="utf-8"))["weight_map"]
        files = set(weight_map.values())
        return bool(files) and all((path / f).is_file() for f in files)
    except (OSError, ValueError, KeyError, AttributeError, TypeError):
        return False


def validate_dir(path: Path, kind: str) -> dict:
    path = Path(path)

    def bad(reason: str) -> dict:
        return {"ok": False, "reason": reason}

    if not path.is_dir():
        return bad("Folder does not exist.")
    cfg = path / "config.json"
    if not cfg.is_file():
        return bad("Not a model folder (config.json missing).")
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except (OSError, ValueError):
        return bad("Not a model folder (config.json missing).")
    if kind == "vlm":
        if not is_qwen_vl_config(data):
            return bad("Only Qwen2.5-VL models are supported here.")
    elif "florence2" not in str(data.get("model_type", "")).lower():
        return bad("Not a Florence-2 model.")
    if not weights_complete(path):
        return bad("Model weights are incomplete.")
    return {"ok": True, "reason": ""}


def validate_weight_file(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        return {"ok": False, "reason": "File does not exist."}
    if path.suffix.lower() not in upscaler.WEIGHT_EXT:
        return {"ok": False, "reason": "Unsupported weight file type."}
    return {"ok": True, "reason": ""}


# --------------------------------------------------------------------------- #
# HF cache (never the network)
# --------------------------------------------------------------------------- #
def _hf_snapshot_path(repo_id: str) -> str | None:
    try:
        from huggingface_hub import try_to_load_from_cache
        cfg = try_to_load_from_cache(repo_id, "config.json")
        if not isinstance(cfg, str):
            return None
        snap = Path(cfg).parent
        return str(snap) if weights_complete(snap) else None
    except Exception:  # noqa: BLE001 - hub missing or cache unreadable
        return None


def _hf_file_path(repo_id: str, filename: str) -> str | None:
    try:
        from huggingface_hub import try_to_load_from_cache
        p = try_to_load_from_cache(repo_id, filename)
        return p if isinstance(p, str) else None
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
def entries(ctx: dict) -> list[dict]:
    out: list[dict] = []
    for repo_id, label in captioner.AVAILABLE_MODELS.items():
        out.append({"id": repo_id, "kind": "vlm", "label": label, "repo_id": repo_id,
                    "filename": "", "source": "builtin"})
    for path, label in (ctx.get("custom_vlms") or {}).items():
        out.append({"id": path, "kind": "vlm", "label": label, "repo_id": "",
                    "filename": "", "path": path, "source": "custom"})
    out.append({"id": florence.DEFAULT_MODEL, "kind": "florence",
                "label": f"Florence-2 ({florence.DEFAULT_MODEL})",
                "repo_id": florence.DEFAULT_MODEL, "filename": "", "source": "builtin"})
    for m in upscaler.registry(ctx.get("upscale_cfg") or {}):
        e = {"id": m["id"], "kind": "upscale", "label": m["label"],
             "repo_id": m.get("repo_id", ""), "filename": m.get("filename", ""),
             "source": m["source"], "scale": int(m.get("scale") or 0),
             "note": str(m.get("note") or "")}
        if m.get("path"):
            e["path"] = m["path"]
        out.append(e)
    return out


def _valid_location(entry: dict, path: Path) -> bool:
    if entry["kind"] == "upscale":
        return validate_weight_file(path)["ok"]
    return validate_dir(path, entry["kind"])["ok"]


def resolve_path(entry: dict, ctx: dict) -> str | None:
    if entry.get("path"):
        return entry["path"] if Path(entry["path"]).exists() else None
    settings = ctx.get("settings") or {}
    loc = (settings.get("model_locations") or {}).get(entry["id"])
    if loc and _valid_location(entry, Path(loc)):
        return str(loc)
    models_dir = settings.get("models_dir") or ""
    if models_dir:
        folder = Path(models_dir) / folder_name(entry["repo_id"])
        if entry["kind"] == "upscale":
            f = folder / entry["filename"]
            if f.is_file():
                return str(f)
        elif (folder / MARKER).is_file():
            return str(folder)
    if entry["kind"] == "upscale":
        return _hf_file_path(entry["repo_id"], entry["filename"])
    return _hf_snapshot_path(entry["repo_id"])


def find(model_id: str, ctx: dict) -> dict | None:
    return next((e for e in entries(ctx) if e["id"] == model_id), None)


def listing(ctx: dict) -> list[dict]:
    out = []
    for e in entries(ctx):
        p = resolve_path(e, ctx)
        out.append({**e, "status": "ready" if p else "missing",
                    "local_path": p, "download": None})
    return out
