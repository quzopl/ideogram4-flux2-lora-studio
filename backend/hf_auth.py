"""Hugging Face access token storage (.work/hf.json, never leaves the machine).

The token unlocks gated repositories for every downloader in the app: the
upscale models, the VLM and Florence-2 (transformers reads HF_TOKEN from env).
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def load_token(path) -> str:
    p = Path(path)
    if not p.exists():
        return ""
    try:
        return str(json.loads(p.read_text(encoding="utf-8")).get("token", "")).strip()
    except (OSError, json.JSONDecodeError):
        return ""


def save_token(path, token: str) -> None:
    Path(path).write_text(
        json.dumps({"token": (token or "").strip()}, indent=2), encoding="utf-8")


def clear_token(path) -> None:
    p = Path(path)
    if p.exists():
        p.unlink()


def status(token: str) -> dict:
    """Public view of the token: whether it is set plus its last 4 characters."""
    token = (token or "").strip()
    return {"set": bool(token), "tail": token[-4:] if token else ""}


def apply_env(token: str) -> None:
    """Export/remove HF_TOKEN so huggingface_hub and transformers pick it up."""
    token = (token or "").strip()
    if token:
        os.environ["HF_TOKEN"] = token
    else:
        os.environ.pop("HF_TOKEN", None)
