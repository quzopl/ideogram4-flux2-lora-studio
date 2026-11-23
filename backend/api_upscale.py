"""Upscale routes: the model list and the standalone "Upscale these photos" tool."""
from __future__ import annotations

import io
import shutil
import traceback
import uuid
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

from . import core, gpu, hf_auth, image_utils, upscaler

router = APIRouter()


class UpscaleScanRequest(BaseModel):
    folder: str


class UpscaleCustomRequest(BaseModel):
    repo_id: str
    filename: str
    scale: int = 0


@router.post("/api/upscale/models/scan")
def api_upscale_scan(req: UpscaleScanRequest):
    cfg = upscaler.load_config(core.UPSCALER_CONFIG_PATH)
    cfg["folder"] = req.folder.strip()
    upscaler.save_config(core.UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg), "folder": cfg["folder"]}


@router.post("/api/upscale/models/custom")
def api_upscale_custom_add(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(core.UPSCALER_CONFIG_PATH)
    entry = {"repo_id": req.repo_id.strip(), "filename": req.filename.strip(),
             "scale": req.scale}
    if not entry["repo_id"] or not entry["filename"]:
        raise HTTPException(400, "repo_id and filename are required.")
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (entry["repo_id"], entry["filename"])] + [entry]
    upscaler.save_config(core.UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


@router.delete("/api/upscale/models/custom")
def api_upscale_custom_del(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(core.UPSCALER_CONFIG_PATH)
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (req.repo_id, req.filename)]
    upscaler.save_config(core.UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


# --------------------------------------------------------------------------- #
# Standalone "Upscale these photos" tool
# --------------------------------------------------------------------------- #
class UpscaleRunRequest(BaseModel):
    folder: str
    model_id: str
    mode: Literal["native", "x2", "factor", "long_side"] = "native"
    long_side: int = 2048
    factor: float = Field(2.0, gt=1.0, le=8.0)
    fmt: str = "png"         # "png" | "jpg"
    jpg_quality: int = 95
    device: str = ""         # "" = the upscale role's card, "cpu", or a GPU UUID


class UpscaleExportRequest(BaseModel):
    job_id: str
    output_folder: str


def _upscale_target(size, mode: str, value: int, scale: int,
                    factor: float = 2.0) -> tuple[int, int]:
    """Target pixel size for the standalone upscale tool (never shrinks)."""
    w, h = size
    if mode == "x2":
        factor = 2.0
    elif mode == "factor":
        pass
    elif mode == "long_side":
        factor = max(1.0, value / max(w, h))
    else:
        factor = float(scale or 4)
    return (max(w, int(round(w * factor))), max(h, int(round(h * factor))))


def _upscale_out_name(idx: int, src: Path, ext: str) -> str:
    """Output filename for one result; the index keeps same-stem sources unique

    (e.g. photo.jpg and photo.png in the same folder must not collide).
    """
    return f"{idx:04d}_{src.stem}_up.{ext}"


def _resolve_device(value: str) -> tuple[str, str]:
    """An upscale job's device choice -> (torch device, label shown in results).

    "" is the upscale role's card, "cpu" the CPU, otherwise a card's UUID.
    """
    devices = gpu.probe()
    if value == "":
        device = gpu.device_for("upscale", devices=devices)
        dev = next((d for d in devices if gpu.device_string(d) == device), None)
        return device, gpu.label(dev, devices) if dev else "CPU"
    if value == "cpu":
        return "cpu", "CPU"
    want = gpu.normalize_uuid(value)
    for dev in devices:
        if gpu.normalize_uuid(dev["uuid"]) == want:
            return gpu.device_string(dev), gpu.label(dev, devices)
    raise ValueError("Unknown GPU.")


def _run_upscale_job(job_id: str, req: UpscaleRunRequest, files: list[Path],
                     resolved: tuple[str, str] | None = None) -> None:
    job = core.JOBS[job_id]
    out_dir = core.WORK / job_id / "upscaled"
    thumb_dir = core.WORK / job_id / "thumbs"
    ext = "jpg" if req.fmt == "jpg" else "png"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        device, device_label = resolved or _resolve_device(req.device)
        cfg = upscaler.load_config(core.UPSCALER_CONFIG_PATH)
        entry = upscaler.resolve(req.model_id, cfg)
        if not entry:
            raise RuntimeError(f"Unknown upscale model: {req.model_id}")
        token = hf_auth.load_token(core.HF_TOKEN_PATH)
        job["state"] = "loading_model"
        job["current"] = "Loading the upscale model…"
        entry = {**entry, "path": core._ensure_model(entry["id"], job)}
        scale = int(entry.get("scale") or 0) or upscaler.model_scale(entry, token, device)
        job["state"] = "processing"
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                target = _upscale_target((img.width, img.height), req.mode,
                                         req.long_side, scale, req.factor)
                passes = upscaler.plan_passes((img.width, img.height), target,
                                              scale, min_ratio=1.0)
                big = upscaler.upscale(img, entry, passes, token=token,
                                      device=device)
                if (big.width, big.height) != target:
                    big = big.resize(target, Image.LANCZOS)
                out_name = _upscale_out_name(i, src, ext)
                image_utils.save_image(big, str(out_dir / out_name),
                                       req.fmt, req.jpg_quality)
                image_utils.make_thumbnail(big, 480).save(
                    str(thumb_dir / f"{i:04d}.jpg"), format="JPEG", quality=80)
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": out_name,
                    "width": big.width, "height": big.height, "error": "",
                    "passes": passes, "device": device_label,
                })
            except Exception as e:  # noqa: BLE001 - keep going on per-file errors
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": "",
                    "width": 0, "height": 0, "error": str(e),
                    "passes": 0, "device": device_label,
                })
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@router.post("/api/upscale/run")
def api_upscale_run(req: UpscaleRunRequest):
    files = core._list_images(req.folder)
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    try:
        resolved = _resolve_device(req.device)
    except ValueError as e:
        raise HTTPException(400, str(e))
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "kind": "upscale", "state": "pending",
        "total": len(files), "processed": 0, "current": "", "error": "",
        "config": req.model_dump(), "results": [],
    }
    core._start_job(job, _run_upscale_job, (job_id, req, files, resolved),
                    local_model=True)
    return {"job_id": job_id, "total": len(files)}


@router.get("/api/upscale/job/{job_id}")
def api_upscale_job(job_id: str):
    job = core._job_of_kind(job_id, "upscale")
    return {
        "state": job["state"], "total": job["total"], "processed": job["processed"],
        "current": job["current"], "error": job["error"], "results": job["results"],
    }


@router.get("/api/upscale/thumb/{job_id}/{idx}")
def api_upscale_thumb(job_id: str, idx: int):
    path = core.WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail.")
    return FileResponse(str(path), media_type="image/jpeg")


@router.get("/api/upscale/image/{job_id}/{idx}")
def api_upscale_image(job_id: str, idx: int):
    job = core._job_of_kind(job_id, "upscale")
    res = next((r for r in job["results"] if r["idx"] == idx), None)
    if not res or not res["out_name"]:
        raise HTTPException(404, "No result.")
    path = core.WORK / job_id / "upscaled" / res["out_name"]
    if not path.is_file():
        raise HTTPException(404, "No result.")
    return FileResponse(str(path))


@router.post("/api/upscale/export")
def api_upscale_export(req: UpscaleExportRequest):
    job = core._job_of_kind(req.job_id, "upscale")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")
    if not req.output_folder.strip():
        raise HTTPException(400, "Enter a destination folder.")
    dest = Path(req.output_folder).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    src_dir = core.WORK / req.job_id / "upscaled"
    written = 0
    for r in job["results"]:
        if not r["out_name"]:
            continue
        shutil.copy2(src_dir / r["out_name"], dest / r["out_name"])
        written += 1
    return {"written": written, "folder": str(dest)}


@router.get("/api/upscale/zip/{job_id}")
def api_upscale_zip(job_id: str):
    job = core._job_of_kind(job_id, "upscale")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")
    src_dir = core.WORK / job_id / "upscaled"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in job["results"]:
            if r["out_name"]:
                zf.write(src_dir / r["out_name"], r["out_name"])
    buf.seek(0)
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="upscaled_{job_id[:8]}.zip"'},
    )
