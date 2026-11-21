"""Filesystem helpers shared by settings and model downloads.

Kept separate so the "is this folder usable" rules live in one place: the
settings API validates the models folder with ``writable_dir`` and the download
code asks ``free_bytes`` before fetching weights.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def writable_dir(path: str, create: bool = True) -> Path:
    """Return the resolved absolute folder ``path``, creating it when asked.

    Raises ValueError with an English message if the path is not absolute, the
    folder cannot be created or it is not writable.
    """
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("Use an absolute path.")
    if create:
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise ValueError(f"Cannot create folder: {p}") from None
    if not p.is_dir() or not os.access(p, os.W_OK):
        raise ValueError(f"Folder is not writable: {p}")
    return p.resolve()


def free_bytes(path: Path) -> int:
    """Free space on the volume holding ``path``, measured at its nearest existing ancestor."""
    p = Path(path).expanduser().absolute()
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free
