"""Model registry: every local model the app uses and where it lives on disk.

One place answers "which models exist" (entries) and "where is this one"
(resolve_path). Resolution order for a model: an explicit location from
settings (validated), then the shared models_dir (a snapshot counts only with
the completion MARKER; upscalers are single files), then the HF cache, else
None. Entries that carry their own "path" (local upscaler scans, custom VLM
folders) short-circuit: that path or nothing.

Everything is driven by a plain `ctx` dict built by the server, so this module
never reads settings or config files itself; a finished download records its
location through settings.update. Only `_remote_size` and `_fetch` touch the
network.

Downloads go into `<dest>/<folder_name(repo_id)>`, and a snapshot only counts
once the MARKER is written after a successful fetch, so a cancelled or failed
download is never listed as ready. The hub call runs in a spawned child
process: hf_xet logs and swallows exceptions raised from progress callbacks
(Step 0 spike, 2026-11-21), so terminating the process is the only cancel that
actually stops the writes. Progress is the byte size of the target folder,
polled by the parent.
"""
from __future__ import annotations

import json
import multiprocessing
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

from . import captioner, florence, fsutil, settings, upscaler

MARKER = ".flux-lora-prep-complete"
# Without these, snapshots also pull the PyTorch, TF and Flax copies of the weights.
IGNORE_PATTERNS = ["*.bin", "*.h5", "*.msgpack", "*.onnx", "*.ot", "*.pt", "*.gguf"]


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
    with _LOCK:
        active = {j["model_id"]: dict(j) for j in DOWNLOADS.values() if j["state"] in _ACTIVE}
    out = []
    for e in entries(ctx):
        p = resolve_path(e, ctx)
        job = active.get(e["id"])
        status = "downloading" if job else ("ready" if p else "missing")
        out.append({**e, "status": status, "local_path": p, "download": job})
    return out


# --------------------------------------------------------------------------- #
# Downloads
# --------------------------------------------------------------------------- #
class DownloadCancelled(Exception):
    """Raised by a job's progress callback once the job has been cancelled."""


class ModelsFolderNotSet(RuntimeError):
    def __init__(self, message: str = "No models folder chosen — set one in Settings "
                                      "(Models folder).") -> None:
        super().__init__(message)


DOWNLOADS: dict[str, dict] = {}
_LOCK = threading.Lock()  # guards DOWNLOADS, the job dicts in it and _CANCEL
_CANCEL: set[str] = set()  # ids of jobs asked to stop
_ACTIVE = ("pending", "downloading")
_POLL = 0.5  # seconds between size polls of a running child
_WAIT_POLL = 0.1  # seconds between job checks in ensure_local


def _remote_size(entry: dict, token: str) -> int | None:
    """Bytes the download will fetch, or None when the hub cannot say."""
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(entry["repo_id"], files_metadata=True, token=token or None)
        sizes = _expected_files(entry, info)
        if not sizes or None in sizes.values():
            return None
        return sum(sizes.values())
    except Exception:  # noqa: BLE001 - offline, gated or unknown repo: size unknown
        return None


def _expected_files(entry: dict, info) -> dict[str, int | None]:
    """Name -> size of every file a download of ``entry`` fetches, per ``model_info``."""
    from huggingface_hub.utils import filter_repo_objects
    sizes = {s.rfilename: s.size for s in info.siblings or []}
    if entry["filename"]:
        return {entry["filename"]: sizes.get(entry["filename"])}
    return {n: sizes[n] for n in filter_repo_objects(list(sizes), ignore_patterns=IGNORE_PATTERNS)}


def _dir_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.stat(os.path.join(root, name)).st_size
            except OSError:  # an .incomplete renamed while we looked
                pass
    return total


def _download(entry: dict, target_dir: str, token: str) -> None:
    """The hub call itself; runs in the child process started by _fetch.

    When the Hub is unreachable (offline, refused, gated, 5xx) the hub's
    download functions fall back to whatever already sits in local_dir and
    return normally, so the leftovers of a cancelled attempt would pass as a
    finished download. Hence: look the repo up first (this raises when it is
    unreachable), pin the download to that commit and check every expected
    file afterwards.
    """
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download
    repo_id, tok = entry["repo_id"], token or None
    info = HfApi().model_info(repo_id, files_metadata=True, token=tok)
    if entry["filename"]:
        hf_hub_download(repo_id, entry["filename"], revision=info.sha, local_dir=target_dir,
                        token=tok)
    else:
        snapshot_download(repo_id, revision=info.sha, local_dir=target_dir, token=tok,
                          ignore_patterns=IGNORE_PATTERNS)
    for name, size in _expected_files(entry, info).items():
        f = Path(target_dir, name)
        if not f.is_file() or (size is not None and f.stat().st_size != size):
            raise RuntimeError(f"Download incomplete: {name} is missing or truncated.")


def _child(conn, download: Callable[[dict, str, str], None], entry: dict,
           target_dir: str, token: str) -> None:
    """Child-process entry: run ``download``, send back "" or the error text."""
    try:
        download(entry, target_dir, token)
        conn.send("")
    except Exception as e:  # noqa: BLE001 - becomes the job's error in the parent
        # Capped so it fits the pipe buffer: the parent reads only after we exit.
        conn.send((str(e) or type(e).__name__)[:2000])
    finally:
        conn.close()


def _fetch(entry: dict, target_dir: Path, token: str,
           progress: Callable[[int, int], None]) -> Path:
    """Download ``entry`` into ``target_dir`` and return the ready folder or file.

    The hub call runs in a spawned child; the parent passes the folder's byte
    size to ``progress`` every _POLL seconds (total 0: unknown here). When
    ``progress`` raises (DownloadCancelled), the child is terminated.
    """
    ctx = multiprocessing.get_context("spawn")
    recv, send = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(send, _download, entry, str(target_dir), token),
                       daemon=True)
    proc.start()
    send.close()
    try:
        while proc.is_alive():
            progress(_dir_bytes(target_dir), 0)
            proc.join(_POLL)
        try:
            error = recv.recv()
        except EOFError:  # died without reporting (killed, crashed)
            error = f"Download process exited unexpectedly (exit code {proc.exitcode})."
    finally:
        proc.terminate()
        proc.join()
        recv.close()
    if error:
        raise RuntimeError(error)
    return target_dir / entry["filename"] if entry["filename"] else target_dir


def _run(job: dict, entry: dict, target: Path, token: str, size: int | None) -> None:
    """Worker thread of one job and the only writer of ``job`` (cancel just adds to _CANCEL)."""
    job_id = job["id"]

    def progress(done: int, total: int) -> None:
        with _LOCK:
            if job_id in _CANCEL:
                raise DownloadCancelled()
            if total and not size:
                job["total_bytes"] = total
            known = job["total_bytes"]
            job["done_bytes"] = min(done, known) if known else done

    with _LOCK:
        job["state"] = "downloading"
    try:
        target.mkdir(parents=True, exist_ok=True)
        path = _fetch(entry, target, token, progress)
        if entry["kind"] != "upscale":
            (target / MARKER).write_text("")
        settings.update(lambda d: d["model_locations"].__setitem__(entry["id"], str(path)))
    except DownloadCancelled:
        with _LOCK:
            job["state"] = "cancelled"
    except Exception as e:  # noqa: BLE001 - surfaced as the job's error
        with _LOCK:
            job.update(state="error", error=str(e) or type(e).__name__)
    else:
        with _LOCK:
            job.update(state="done", path=str(path),
                       done_bytes=max(job["done_bytes"], job["total_bytes"]))
    finally:
        with _LOCK:
            _CANCEL.discard(job_id)


def _active_job(model_id: str) -> dict | None:
    """The running job of ``model_id``; the caller holds _LOCK."""
    return next((j for j in DOWNLOADS.values()
                 if j["model_id"] == model_id and j["state"] in _ACTIVE), None)


def start_download(model_id: str, dest: str, ctx: dict, token: str = "") -> dict:
    """Start downloading ``model_id`` into ``dest`` and return (a copy of) its job.

    Raises KeyError for an unknown model and ValueError when the model has no
    HF source, ``dest`` is unusable or too small. A model already downloading
    returns its running job.
    """
    entry = find(model_id, ctx)
    if entry is None:
        raise KeyError(model_id)
    if entry.get("path") or not entry["repo_id"]:
        raise ValueError("This model cannot be downloaded.")
    with _LOCK:  # before the checks: a running job has already used up some space
        running = _active_job(model_id)
        if running:
            return dict(running)
    root = fsutil.writable_dir(dest)
    size = _remote_size(entry, token)
    if size is not None:
        free = fsutil.free_bytes(root)
        if free < size:
            raise ValueError(f"Not enough space in {root}: needs {size / 1e9:.1f} GB, "
                             f"{free / 1e9:.1f} GB free.")
    with _LOCK:
        running = _active_job(model_id)
        if running:
            return dict(running)
        job = {"id": uuid.uuid4().hex, "model_id": model_id, "label": entry["label"],
               "dest": str(root), "state": "pending", "done_bytes": 0,
               "total_bytes": size or 0, "error": "", "path": ""}
        DOWNLOADS[job["id"]] = job
        out = dict(job)
    threading.Thread(target=_run, args=(job, entry, root / folder_name(entry["repo_id"]),
                                        token, size),
                     name=f"download-{model_id}", daemon=True).start()
    return out


def cancel_download(job_id: str) -> dict:
    """Ask a job to stop (KeyError for an unknown id); returns a copy of it."""
    with _LOCK:
        job = DOWNLOADS[job_id]
        if job["state"] in _ACTIVE:
            _CANCEL.add(job_id)
        return dict(job)


def ensure_local(model_id: str, ctx: dict, token: str = "",
                 on_progress: Callable[[int, int], None] | None = None) -> str:
    """Local path of ``model_id``, downloading it into models_dir first if needed.

    Absolute paths and ``lmstudio:`` ids pass through unchanged. Blocks while
    downloading and forwards (done, total) bytes to ``on_progress``.
    """
    if model_id.startswith("lmstudio:") or Path(model_id).is_absolute():
        return model_id
    entry = find(model_id, ctx)
    if entry is None:
        raise KeyError(model_id)
    path = resolve_path(entry, ctx)
    if path:
        return path
    models_dir = (ctx.get("settings") or {}).get("models_dir") or ""
    if not models_dir:
        raise ModelsFolderNotSet()
    job_id = start_download(model_id, models_dir, ctx, token)["id"]
    last = None
    while True:
        with _LOCK:
            job = dict(DOWNLOADS[job_id])
        cur = (job["done_bytes"], job["total_bytes"])
        if on_progress and cur != last:
            on_progress(*cur)
            last = cur
        if job["state"] not in _ACTIVE:
            break
        time.sleep(_WAIT_POLL)
    if job["state"] != "done":
        raise RuntimeError(job["error"] or "Download cancelled.")
    return job["path"]
