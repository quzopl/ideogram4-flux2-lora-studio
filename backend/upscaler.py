"""Super-resolution models for the dataset pipeline and the Upscale tab.

Weights come from three places: a small built-in list downloaded from Hugging
Face, user-added HF repos, and a local folder scan (e.g. ComfyUI's
models/upscale_models). Files are loaded by spandrel, which detects the
architecture and scale on its own.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

WEIGHT_EXT = {".pth", ".safetensors"}
MAX_PASSES = 2

log = logging.getLogger(__name__)

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
# {"model", "torch", "device", "dtype", "key", "scale"}
_RUNTIME: dict | None = None
_NOTE = ""                        # last non-fatal event (e.g. the CPU fallback)


# --------------------------------------------------------------------------- #
# Pure helpers (no torch, no network)
# --------------------------------------------------------------------------- #
def plan_passes(src_size, target_size, scale: int, min_ratio: float = 1.05,
                fit: str = "cover") -> int:
    """How many model passes to reach ``target_size`` (0 = skip the upscaler).

    ``fit="cover"`` needs the *larger* of the two axis ratios (the image is
    cropped afterwards); ``fit="contain"`` only needs the smaller one, because
    the fit letterboxes what is left over.
    """
    sw, sh = src_size
    tw, th = target_size
    if sw <= 0 or sh <= 0 or scale <= 1:
        return 0
    ratio = min(tw / sw, th / sh) if fit == "contain" else max(tw / sw, th / sh)
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


# --------------------------------------------------------------------------- #
# GPU helpers (torch / spandrel imported lazily so this module stays importable
# without a torch install, and the test suite never triggers a real load)
# --------------------------------------------------------------------------- #
def weights_path(entry: dict, token: str = "") -> str:
    """Local path to the weights, downloading them from HF when needed."""
    if entry.get("path"):
        return entry["path"]
    from huggingface_hub import hf_hub_download
    return hf_hub_download(
        repo_id=entry["repo_id"], filename=entry["filename"],
        token=token or None)


def _load(entry: dict, token: str = "") -> dict:
    """Load (and cache) the spandrel descriptor for one registry entry."""
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is not None and _RUNTIME["key"] == entry["id"]:
            return _RUNTIME
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        path = weights_path(entry, token)
        model = ModelLoader().load_from_file(path)
        if not isinstance(model, ImageModelDescriptor):
            raise RuntimeError(f"{entry['filename']} is not an image upscaler.")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # fp16 halves both the weights and the activations, but only where the
        # architecture says it is safe (spandrel knows which ones overflow).
        half = device == "cuda" and bool(getattr(model, "supports_half", False))
        dtype = torch.float16 if half else torch.float32
        model.to(device)
        if half:
            model.to(dtype=dtype)
        model.eval()
        _RUNTIME = {"model": model, "torch": torch, "device": device,
                    "dtype": dtype, "key": entry["id"], "scale": int(model.scale)}
        return _RUNTIME


def unload() -> None:
    """Release the upscaler from memory (wired to the 'Release GPU' button)."""
    global _RUNTIME, _NOTE
    with _LOCK:
        if _RUNTIME is None:
            return
        torch = _RUNTIME["torch"]
        _RUNTIME = None
        _NOTE = ""
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def is_loaded() -> bool:
    return _RUNTIME is not None


def loaded_key() -> str:
    return _RUNTIME["key"] if _RUNTIME else ""


def status() -> dict:
    """Topbar-friendly view of the upscaler runtime."""
    rt = _RUNTIME
    return {
        "loaded": rt is not None,
        "key": rt["key"] if rt else "",
        "device": rt["device"] if rt else "",
        "note": _NOTE,
    }


def _to_tensor(img, torch):
    import numpy as np
    arr = np.asarray(img.convert("RGB"), dtype="float32") / 255.0
    return torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)


def _to_image(tensor, torch):
    import numpy as np
    from PIL import Image as PILImage
    arr = tensor.squeeze(0).clamp(0, 1).permute(1, 2, 0).cpu().float().numpy()
    return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8))


def _run_once(rt: dict, img, tile: int = 512, overlap: int = 32):
    """One model pass, tiled so a 12 GB card survives x4 on large photos.

    The source stays on the CPU and only one padded tile at a time reaches the
    device, so VRAM depends on ``tile`` and not on the size of the photo. Each
    tile is run with ``overlap`` pixels of context on every side, then trimmed
    back to its own block before being pasted into the output canvas: every
    output pixel is written exactly once, by the tile that had context around
    it — no accumulator, no seam.
    """
    from PIL import Image as PILImage

    torch = rt["torch"]
    model, device, scale = rt["model"], rt["device"], rt["scale"]
    dtype = rt.get("dtype")
    src = _to_tensor(img, torch)                    # CPU, fp32
    _, _, h, w = src.shape
    canvas = PILImage.new("RGB", (w * scale, h * scale))
    step = max(16, tile)
    with torch.no_grad():
        for y in range(0, h, step):
            for x in range(0, w, step):
                y2, x2 = min(y + step, h), min(x + step, w)
                # Block grown by the context margin, clamped to the image.
                py, px = max(0, y - overlap), max(0, x - overlap)
                py2, px2 = min(h, y2 + overlap), min(w, x2 + overlap)
                patch = src[:, :, py:py2, px:px2].to(device=device, dtype=dtype)
                res = model(patch)
                top, left = (y - py) * scale, (x - px) * scale
                res = res[:, :, top:top + (y2 - y) * scale,
                          left:left + (x2 - x) * scale]
                canvas.paste(_to_image(res, torch), (x * scale, y * scale))
                del patch, res
    return canvas


def _to_cpu(rt: dict) -> None:
    """Move the loaded model to the CPU (last-resort fallback after an OOM)."""
    torch = rt["torch"]
    rt["model"].to("cpu")
    if rt.get("dtype") is not None and rt["dtype"] != torch.float32:
        rt["model"].to(dtype=torch.float32)
    rt["device"] = "cpu"
    rt["dtype"] = torch.float32
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _is_oom(e: Exception) -> bool:
    return "out of memory" in str(e).lower()


def _empty_cache(rt: dict) -> None:
    torch = rt["torch"]
    # A CPU-only torch build has no working cuda allocator; calling into it
    # here would mask the error we are actually trying to recover from.
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def upscale(img, entry: dict, passes: int, token: str = ""):
    """Run ``passes`` model passes over the image, shrinking tiles on OOM.

    Ladder: tile 512 -> 256 -> 128, and if even the smallest tile runs out of
    memory the model is moved to the CPU and the pass is retried there. The
    fallback is slow, so it is logged and reported through ``status()``.
    """
    if passes <= 0:
        return img
    rt = _load(entry, token)
    for _ in range(passes):
        img = _run_pass(rt, img)
    return img


def _run_pass(rt: dict, img):
    global _NOTE
    for tile in (512, 256, 128):
        try:
            return _run_once(rt, img, tile=tile)
        except Exception as e:  # noqa: BLE001 - OOM -> smaller tile, then CPU
            if not _is_oom(e):
                raise
            _empty_cache(rt)
            if tile == 128:
                if rt["device"] == "cpu":
                    raise
                _NOTE = ("Ran out of VRAM even at tile 128 — this pass ran on "
                         "the CPU (slow).")
                log.warning("upscaler: %s", _NOTE)
                _to_cpu(rt)
                return _run_once(rt, img, tile=128)
    raise RuntimeError("unreachable")  # pragma: no cover
