"""The single settings store: models folder, per-role GPU, auto-saved form
values and named presets, in one JSON file under .work/.

``update`` is the only write path: it loads, applies a mutator and replaces the
file atomically, all under one lock, so concurrent requests never lose each
other's changes. ``load`` never writes, except to move a corrupt file aside
(``<name>.bad-<unix time>``) so the user can inspect it. A file that cannot be
read right now (OSError) is left alone: ``load`` falls back to the defaults and
``update`` fails without writing, so a good file is never replaced. Settings
written by the legacy GPU picker (.work/gpu.json) are applied on read while the
new file does not exist, and become persistent with the first ``update``.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent.parent / ".work" / "settings.json"

VIEWS = ("dataset", "prompts", "bbox", "comfy", "upscale")
ROLES = ("vlm", "florence", "upscale")
VERSION = 1

_lock = threading.Lock()


def defaults() -> dict:
    return {
        "version": VERSION,
        "models_dir": "",
        "model_locations": {},
        "gpu": {role: "auto" for role in ROLES},
        "forms": {},
        "presets": {},
    }


def _normalize(raw: dict) -> dict:
    """Overlay known keys of ``raw`` on the defaults; unknown keys are dropped,
    and so are model locations other than id -> absolute path strings."""
    doc = defaults()
    if isinstance(raw.get("models_dir"), str):
        doc["models_dir"] = raw["models_dir"]
    if isinstance(raw.get("model_locations"), dict):
        doc["model_locations"] = {k: v for k, v in raw["model_locations"].items()
                                  if isinstance(k, str) and isinstance(v, str)
                                  and v and Path(v).is_absolute()}
    if isinstance(raw.get("gpu"), dict):
        for role in ROLES:
            if isinstance(raw["gpu"].get(role), str) and raw["gpu"][role]:
                doc["gpu"][role] = raw["gpu"][role]
    if isinstance(raw.get("forms"), dict):
        doc["forms"] = {v: copy.deepcopy(x) for v, x in raw["forms"].items()
                        if v in VIEWS and isinstance(x, dict)}
    if isinstance(raw.get("presets"), dict):
        doc["presets"] = {v: copy.deepcopy(x) for v, x in raw["presets"].items()
                          if v in VIEWS and isinstance(x, dict)}
    return doc


def _migrate(doc: dict) -> None:
    """Give every role the card chosen in the legacy gpu.json, if there is one."""
    from . import gpu  # lazy: gpu will import this module
    uuid = gpu.load_selected(gpu.CONFIG_PATH)
    if uuid:
        doc["gpu"] = {role: uuid for role in ROLES}


def load(path: Path | None = None) -> dict:
    p = Path(path) if path is not None else CONFIG_PATH
    try:
        return _read(p)
    except OSError as e:
        log.warning("settings file %s could not be read (%s); using defaults", p, e)
        return defaults()


def _read(p: Path) -> dict:
    """``load`` without the fallback: an OSError while reading propagates."""
    if not p.exists():
        doc = defaults()
        _migrate(doc)
        return doc
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("not an object")
    except ValueError as e:  # JSONDecodeError and UnicodeDecodeError are ValueErrors
        bad = p.with_name(f"{p.name}.bad-{int(time.time())}")
        log.warning("settings file %s is unreadable (%s); moved to %s", p, e, bad)
        try:
            p.replace(bad)
        except OSError:
            log.warning("could not move %s aside", p)
        return defaults()
    return _normalize(raw)


def _write(doc: dict, p: Path) -> None:
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


def update(mutator: Callable[[dict], None], path: Path | None = None) -> dict:
    p = Path(path) if path is not None else CONFIG_PATH
    with _lock:
        doc = _read(p)  # a read error aborts: writing defaults would lose the file
        mutator(doc)
        _write(doc, p)
        return doc


def _check_view(view: str) -> None:
    if view not in VIEWS:
        raise ValueError(f"unknown view {view!r}; expected one of {', '.join(VIEWS)}")


def _check_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= 64 or "/" in name:
        raise ValueError("preset name must be 1-64 characters and must not contain '/'")
    return name


def set_form(view: str, values: dict, path: Path | None = None) -> dict:
    _check_view(view)
    return update(lambda d: d["forms"].__setitem__(view, values), path)


def save_preset(view: str, name: str, values: dict, path: Path | None = None) -> dict:
    _check_view(view)
    name = _check_name(name)
    return update(lambda d: d["presets"].setdefault(view, {}).__setitem__(name, values), path)


def delete_preset(view: str, name: str, path: Path | None = None) -> dict:
    _check_view(view)
    return update(lambda d: d["presets"].get(view, {}).pop(name, None), path)


def import_doc(doc: dict, path: Path | None = None) -> dict:
    """Replace the settings with an imported document, keeping only known keys."""
    if not isinstance(doc, dict) or doc.get("version") != VERSION:
        raise ValueError(f"unsupported settings version; expected {VERSION}")
    clean = _normalize(doc)
    if clean["models_dir"] and not Path(clean["models_dir"]).is_absolute():
        raise ValueError("Use an absolute path.")  # "" stays allowed: no folder chosen
    clean["presets"] = {v: {_check_name(n): x for n, x in ps.items()}
                        for v, ps in clean["presets"].items()}

    def replace(d: dict) -> None:
        d.clear()
        d.update(clean)

    return update(replace, path)
