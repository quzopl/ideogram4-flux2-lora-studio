"""Server-side crop plans, one per source folder, in <work>/crop_plans.json.

``load`` reports ``exists: False`` only for a folder nothing was ever saved
for; a saved empty plan is ``exists: True``, so a plan adopted from the classic
UI does not come back after "Clear crops". Writes are atomic (temp file, fsync,
``os.replace``) under one lock.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

PATH = Path(os.environ.get("FLUX_PREP_WORK")
            or Path(__file__).resolve().parent.parent / ".work") / "crop_plans.json"

MODES = ("center", "auto", "manual")

_lock = threading.Lock()


def _key(folder: str) -> str:
    return str(Path(folder).expanduser().resolve())


def _read(p: Path) -> dict:
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def load(folder: str, path: Path | None = None) -> dict:
    p = Path(path) if path is not None else PATH
    entry = _read(p).get(_key(folder))
    if not isinstance(entry, dict):
        return {"plan": {}, "mode": "center", "exists": False}
    mode = entry.get("mode")
    plan = entry.get("plan")
    return {"plan": plan if isinstance(plan, dict) else {},
            "mode": mode if mode in MODES else "center", "exists": True}


def save(folder: str, plan: dict, mode: str, path: Path | None = None) -> dict:
    p = Path(path) if path is not None else PATH
    with _lock:
        doc = _read(p)
        doc[_key(folder)] = {"plan": plan, "mode": mode}
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=p.parent,
                                          delete=False, suffix=".tmp")
        try:
            with tmp:
                json.dump(doc, tmp, indent=2, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp.name, p)
        except BaseException:
            Path(tmp.name).unlink(missing_ok=True)
            raise
    return {"plan": plan, "mode": mode, "exists": True}
