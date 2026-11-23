"""Dataset routes: scan or upload sources, crop plans, the process job, export."""
from __future__ import annotations

import hashlib
import io
import shutil
import traceback
import uuid
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

from . import (captioner, core, crop_auto, crop_store, florence, hf_auth, image_utils, lmstudio,
               prompts, upscaler)

router = APIRouter()


class ScanRequest(BaseModel):
    folder: str


class ProcessRequest(BaseModel):
    folder: str
    mode: str = "person"
    style: str = "concise"  # "concise" | "detailed"
    resolution: int = Field(1024, ge=256, le=4096)
    step: int = Field(64, ge=8, le=256)
    square: bool = False
    fmt: Literal["png", "jpg"] = "png"
    jpg_quality: int = Field(95, ge=50, le=100)
    model: str = captioner.DEFAULT_MODEL
    quant: str = "4bit"  # "4bit" | "none"
    max_tokens: int = Field(512, ge=64, le=8192)
    do_caption: bool = True
    caption_format: Literal["flux", "ideogram", "aitoolkit"] = "flux"

    # Cropping
    crop_mode: Literal["center", "auto", "manual"] = "center"
    fit: Literal["cover", "contain"] = "cover"  # "cover" (crop) | "contain" (pad)
    pad_color: str = "#000000"
    centering_x: str = "center"      # left | center | right
    centering_y: str = "center"      # top | center | bottom
    crops: dict[str, list[int]] = {} # source file name -> [x, y, w, h]

    # Upscaling
    upscale_model: str = ""          # empty = disabled
    upscale_min_ratio: float = 1.05


class CropAutoRequest(BaseModel):
    folder: str
    mode: str = "person"
    resolution: int = Field(1024, ge=256, le=4096)
    step: int = Field(64, ge=8, le=256)
    square: bool = False
    names: list[str] = []       # empty = all images in the folder


class CropPlanRequest(BaseModel):
    folder: str
    plan: dict[str, list[int]]
    mode: Literal["center", "auto", "manual"]


class ExportRequest(BaseModel):
    job_id: str
    output_folder: str = ""
    trigger: str = ""
    prepend_trigger: bool = True
    captions: dict[str, str] = {}  # index (as str) -> edited caption
    exclude_idx: list[int] = []    # indices removed by the user in the UI


def _crop_for(req: "ProcessRequest", name: str) -> list[int] | None:
    """Crop box for a source file, or None when the mode has no per-file box.

    Both ``auto`` and ``manual`` read the plan that travels with the request —
    auto boxes are computed by ``/api/crop/auto`` and land in the very same
    plan, so the only difference between the two modes is who drew the box.
    ``center`` is the explicit "ignore the plan" mode.
    """
    if req.crop_mode in ("auto", "manual"):
        box = req.crops.get(name)
        return list(box) if box and len(box) == 4 else None
    return None


def _src_thumb_path(folder: str, name: str) -> Path:
    key = hashlib.sha1(str(Path(folder).expanduser().resolve()).encode()).hexdigest()[:16]
    return core.SRC_THUMBS / key / (name + ".jpg")


def _final_caption(req: ExportRequest, result: dict) -> str:
    """Resolve the caption for a result, applying any edit and the trigger word."""
    caption = req.captions.get(str(result["idx"]), result["caption"]).strip()
    trigger = req.trigger.strip()
    if req.prepend_trigger and trigger:
        if result.get("format") in ("ideogram", "aitoolkit"):
            return prompts.inject_trigger_ideogram(caption, trigger)
        caption = f"{trigger}, {caption}" if caption else trigger
    return caption


def _caption_output_files(base_name: str, caption: str, fmt: str) -> list[tuple[str, str]]:
    """Return the (filename, content) list to write for a given caption.

    Always .txt; "ideogram" additionally gets a pretty .json. "aitoolkit" = .txt only.
    """
    files: list[tuple[str, str]] = [(f"{base_name}.txt", caption + "\n")]
    if fmt == "ideogram":
        pretty = prompts.ideogram_pretty(caption)
        if pretty is not None:
            files.append((f"{base_name}.json", pretty + "\n"))
    return files


class _UpscaleHook:
    """Callable passed to process_image(upscale=...); records what it did.

    Keeps the pipeline honest: a broken upscaler degrades to plain LANCZOS
    instead of killing the job. A failed model ensure is remembered for the
    rest of the job, so later images report the same error instead of each
    starting another download (and restarting one the user cancelled).
    """

    def __init__(self, entry: dict, min_ratio: float = 1.05, token: str = "",
                 fit: str = "cover", run=None, job: dict | None = None):
        self.entry = entry
        self.min_ratio = min_ratio
        self.token = token
        self.fit = fit
        self.used = False
        self.error = ""
        self.job = job
        self._injected = run is not None
        self._scale = 0
        self._ensure_error: str | None = None  # survives reset(): one attempt per job
        self._run = run or (lambda img, entry, passes: upscaler.upscale(
            img, entry, passes, token=self.token))

    def reset(self) -> None:
        self.used = False
        self.error = ""

    def __call__(self, img, target):
        try:
            # Any scale > 1 plans the same number of passes, so images that
            # need none are returned before the model is ensured or loaded.
            if upscaler.plan_passes(
                    (img.width, img.height), target,
                    int(self.entry.get("scale") or 0) or 2,
                    self.min_ratio, fit=self.fit) <= 0:
                return img
            entry = self.entry
            if not self._injected:
                if self._ensure_error is not None:
                    self.error = self._ensure_error
                    return img
                try:
                    entry = {**entry, "path": core._ensure_model(entry["id"], self.job)}
                except Exception as e:  # noqa: BLE001 - remembered, then the fallback below
                    self._ensure_error = str(e)
                    raise
            if not self._scale:
                # Local models register scale 0: ask the loaded model, once.
                self._scale = (int(entry.get("scale") or 0)
                               or upscaler.model_scale(entry, self.token))
            passes = upscaler.plan_passes(
                (img.width, img.height), target, self._scale, self.min_ratio,
                fit=self.fit)
            if passes <= 0:
                return img
            out = self._run(img, entry, passes)
        except Exception as e:  # noqa: BLE001 - fall back to plain resizing
            self.error = str(e)
            return img
        self.used = True
        return out


def _job_public(job: dict) -> dict:
    """Strip non-serialisable internals before sending to the client."""
    return {
        "id": job["id"],
        "state": job["state"],
        "total": job["total"],
        "processed": job["processed"],
        "current": job["current"],
        "error": job["error"],
        "config": job["config"],
        "results": [
            {
                "idx": r["idx"],
                "src_name": r["src_name"],
                "out_name": r["out_name"],
                "width": r["width"],
                "height": r["height"],
                "caption": r["caption"],
                "upscaled": r.get("upscaled", False),
                "upscale_error": r.get("upscale_error", ""),
            }
            for r in job["results"]
        ],
    }


def _run_job(job_id: str, req: ProcessRequest, files: list[Path]) -> None:
    job = core.JOBS[job_id]
    job_dir = core.WORK / job_id
    proc_dir = job_dir / "processed"
    thumb_dir = job_dir / "thumbs"
    proc_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    ext = "jpg" if req.fmt == "jpg" else "png"

    try:
        lm_id = core._lmstudio_model_id(req.model)
        lm_url = core._lmstudio_url() if lm_id is not None else None
        if req.do_caption and lm_id is None:
            job["state"] = "loading_model"
            quant = req.quant if req.quant in ("4bit", "none") else "4bit"
            source = core._ensure_model(req.model, job)
            job["current"] = "Loading the VLM model…"
            captioner.ensure_loaded(req.model, quant, source=source)

        hook = None
        if req.upscale_model:
            entry = upscaler.resolve(
                req.upscale_model, upscaler.load_config(core.UPSCALER_CONFIG_PATH))
            if entry:
                job["state"] = "loading_model"
                job["current"] = "Loading the upscale model…"
                hook = _UpscaleHook(entry, req.upscale_min_ratio,
                                    hf_auth.load_token(core.HF_TOKEN_PATH),
                                    fit=req.fit, job=job)

        job["state"] = "processing"
        prefix = (req.mode or "img")

        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                if hook:
                    hook.reset()
                img, (w, h) = image_utils.process_image(
                    str(src), req.resolution, req.step, req.square,
                    crop=_crop_for(req, src.name),
                    centering=image_utils.centering_pair(req.centering_x, req.centering_y),
                    fit=req.fit,
                    pad_color=req.pad_color,
                    upscale=hook,
                )
                out_name = f"{prefix}_{i:04d}.{ext}"
                image_utils.save_image(
                    img, str(proc_dir / out_name), req.fmt, req.jpg_quality
                )
                thumb = image_utils.make_thumbnail(img)
                thumb.save(str(thumb_dir / f"{i:04d}.jpg"), format="JPEG", quality=80)

                caption = ""
                if req.do_caption:
                    if lm_id is not None:
                        instruction = prompts.caption_instruction(
                            req.mode, req.style, req.caption_format)
                        raw = lmstudio.caption_image(
                            lm_url, lm_id, img, instruction, req.max_tokens)
                        caption = prompts.postprocess_caption(raw, req.caption_format)
                    else:
                        caption = captioner.caption_image(
                            img, req.mode, req.style, req.max_tokens,
                            fmt=req.caption_format,
                        )

                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": out_name,
                    "width": w,
                    "height": h,
                    "caption": caption,
                    "format": req.caption_format,
                    "upscaled": bool(hook and hook.used),
                    "upscale_error": hook.error if hook else "",
                })
            except Exception as e:  # noqa: BLE001 - record per-file failures, keep going
                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": "",
                    "width": 0,
                    "height": 0,
                    "caption": f"[ERROR: {e}]",
                })
            job["processed"] = i + 1

        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@router.post("/api/scan")
def api_scan(req: ScanRequest):
    files = core._list_images(req.folder)
    return {
        "folder": str(Path(req.folder).expanduser()),
        "count": len(files),
        "files": [f.name for f in files],
    }


@router.get("/api/src/thumb")
def api_src_thumb(folder: str, name: str):
    """Cached JPEG thumbnail of a source image (for the crop grid)."""
    src = core._safe_source_path(folder, name)
    cache = _src_thumb_path(folder, name)
    if not cache.exists() or cache.stat().st_mtime < src.stat().st_mtime:
        cache.parent.mkdir(parents=True, exist_ok=True)
        img = image_utils.load_source(str(src))
        thumb = image_utils.make_thumbnail(img, 480)
        thumb.save(str(cache), format="JPEG", quality=80)
    return FileResponse(str(cache), media_type="image/jpeg")


@router.get("/api/src/image")
def api_src_image(folder: str, name: str):
    """Down-scaled source image for the crop editor, with the true source size."""
    src = core._safe_source_path(folder, name)
    img = image_utils.load_source(str(src))
    full_w, full_h = img.width, img.height
    preview = image_utils.make_thumbnail(img, 1600)
    buf = io.BytesIO()
    preview.save(buf, format="JPEG", quality=88)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers={"X-Src-Width": str(full_w), "X-Src-Height": str(full_h)},
    )


@router.get("/api/src/size")
def api_src_size(folder: str, name: str):
    """True size of a source image after EXIF rotation, from the header only."""
    src = core._safe_source_path(folder, name)
    try:
        with Image.open(src) as img:
            w, h = img.size
            if img.getexif().get(0x0112) in (5, 6, 7, 8):
                w, h = h, w
    except OSError as e:  # UnidentifiedImageError is an OSError
        raise HTTPException(400, "Not a readable image.") from e
    return {"width": w, "height": h}


@router.get("/api/crops")
def api_crops_get(folder: str):
    return crop_store.load(folder)


@router.put("/api/crops")
def api_crops_put(req: CropPlanRequest):
    if not req.folder:
        raise HTTPException(400, "No folder given.")
    for name, box in req.plan.items():
        if not name or name != Path(name).name or name == "..":
            raise HTTPException(400, f"Invalid file name: {name!r}")
        if len(box) != 4 or any(v < 0 for v in box) or box[2] == 0 or box[3] == 0:
            raise HTTPException(
                400, f"Invalid crop box for {name!r}: need [x, y, w, h], w and h > 0.")
    return crop_store.save(req.folder, req.plan, req.mode)


@router.post("/api/upload")
async def api_upload(files: list[UploadFile]):
    dest = core.WORK / "uploads" / uuid.uuid4().hex
    dest.mkdir(parents=True, exist_ok=True)
    saved_names: list[str] = []
    for f in files:
        if Path(f.filename).suffix.lower() not in image_utils.SUPPORTED_EXT:
            continue
        target = dest / Path(f.filename).name
        with open(target, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved_names.append(target.name)
    return {"folder": str(dest), "count": len(saved_names), "files": sorted(saved_names)}


@router.post("/api/process")
def api_process(req: ProcessRequest):
    files = core._list_images(req.folder)
    if not files:
        raise HTTPException(400, "No supported images in the folder.")

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "kind": "dataset",
        "state": "pending",
        "total": len(files),
        "processed": 0,
        "current": "",
        "error": "",
        "config": req.model_dump(),
        "results": [],
    }
    core._start_job(job, _run_job, (job_id, req, files),
                    local_model=(req.do_caption and core._lmstudio_model_id(req.model) is None)
                    or bool(req.upscale_model))
    return {"job_id": job_id, "total": len(files)}


@router.get("/api/job/{job_id}")
def api_job(job_id: str):
    return _job_public(core._job_of_kind(job_id, "dataset"))


def _run_crop_auto(job_id: str, req: CropAutoRequest, files: list[Path]) -> None:
    job = core.JOBS[job_id]
    try:
        job["state"] = "processing"
        # Before the loop: suggest_crop swallows detection errors, so a missing
        # model would otherwise end as a "done" job without any crops.
        if req.mode not in crop_auto.NO_AUTO_MODES:
            core._ensure_model(florence.DEFAULT_MODEL, job)
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                box = crop_auto.suggest_crop(
                    img, req.mode, req.resolution, req.step, req.square)
                if box:
                    job["crops"][src.name] = box
            except Exception as e:  # noqa: BLE001 - one bad file must not kill the job
                job["skipped"].append(f"{src.name}: {e}")
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@router.post("/api/crop/auto")
def api_crop_auto(req: CropAutoRequest):
    files = core._list_images(req.folder)
    if req.names:
        wanted = set(req.names)
        files = [f for f in files if f.name in wanted]
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "kind": "crop_auto", "state": "pending",
        "total": len(files), "processed": 0, "current": "", "error": "",
        "crops": {}, "skipped": [],
    }
    core._start_job(job, _run_crop_auto, (job_id, req, files),
                    local_model=req.mode not in crop_auto.NO_AUTO_MODES)
    return {"job_id": job_id, "total": len(files)}


@router.get("/api/crop/auto/{job_id}")
def api_crop_auto_job(job_id: str):
    job = core._job_of_kind(job_id, "crop_auto")
    return {
        "state": job["state"], "total": job["total"],
        "processed": job["processed"], "current": job["current"],
        "error": job["error"], "crops": job["crops"], "skipped": job["skipped"],
    }


@router.get("/api/thumb/{job_id}/{idx}")
def api_thumb(job_id: str, idx: int):
    path = core.WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail.")
    return FileResponse(str(path))


@router.post("/api/export")
def api_export(req: ExportRequest):
    job = core._job_of_kind(req.job_id, "dataset")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")

    if not req.output_folder.strip():
        raise HTTPException(400, "Enter a destination folder.")
    out_dir = Path(req.output_folder).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    proc_dir = core.WORK / req.job_id / "processed"

    exclude = set(req.exclude_idx)
    written = 0
    for r in job["results"]:
        if not r["out_name"] or r["idx"] in exclude:
            continue  # skip failed or user-removed items
        src_img = proc_dir / r["out_name"]
        if not src_img.exists():
            continue
        shutil.copy2(src_img, out_dir / r["out_name"])

        caption = _final_caption(req, r)
        base = Path(r["out_name"]).stem
        for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
            (out_dir / fname).write_text(content, encoding="utf-8")
        written += 1

    return {"output_folder": str(out_dir), "written": written}


@router.post("/api/zip")
def api_zip(req: ExportRequest):
    """Build the dataset as an in-memory ZIP and return it as a download."""
    job = core._job_of_kind(req.job_id, "dataset")
    if job["state"] != "done":
        raise HTTPException(400, "The job is not finished.")

    proc_dir = core.WORK / req.job_id / "processed"
    exclude = set(req.exclude_idx)

    buf = io.BytesIO()
    written = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in job["results"]:
            if not r["out_name"] or r["idx"] in exclude:
                continue
            src_img = proc_dir / r["out_name"]
            if not src_img.exists():
                continue
            zf.write(str(src_img), r["out_name"])
            caption = _final_caption(req, r)
            base = Path(r["out_name"]).stem
            for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
                zf.writestr(fname, content)
            written += 1

    if written == 0:
        raise HTTPException(400, "No images to package.")

    buf.seek(0)
    fname = f"dataset_{job['config'].get('mode', 'lora')}_{req.job_id[:8]}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
