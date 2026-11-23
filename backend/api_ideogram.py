"""Ideogram 4 routes: the built-in render workflow, v15 normalisation and the
image-analysis jobs.
"""
from __future__ import annotations

import io
import json
import threading
import traceback
import uuid
from typing import Callable, Literal

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import (api_comfy, captioner, core, florence, ideogram_workflow, lmstudio, prompts,
               v15_lint)

router = APIRouter()


# --------------------------------------------------------------------------- #
# Ideogram 4 render — built-in workflow (backend/ideogram_workflow.py);
# jobs and gallery shared with the rest of the ComfyUI integration.
# --------------------------------------------------------------------------- #
class IdeogramRenderRequest(BaseModel):
    prompt: str       # minified JSON v15
    params: dict = {}


@router.get("/api/ideogram/render/config")
def api_ideogram_render_config():
    """Last-used render parameters (merged with the defaults)."""
    return {"params": ideogram_workflow.merge_params(core._load_named(core.IDEOGRAM_RENDER_CFG_PATH)),
            "presets": list(ideogram_workflow.PRESETS.keys())}


@router.post("/api/ideogram/render")
def api_ideogram_render(req: IdeogramRenderRequest):
    """Render a v15 prompt with the built-in Ideogram 4 workflow on ComfyUI."""
    try:
        obj = json.loads(req.prompt)
    except (json.JSONDecodeError, ValueError):
        obj = None
    if not isinstance(obj, dict):
        raise HTTPException(400, "The prompt must be a JSON object (v15).")
    params = ideogram_workflow.merge_params(req.params)
    core._save_named(core.IDEOGRAM_RENDER_CFG_PATH, params)
    workflow = ideogram_workflow.build_workflow(req.prompt, params)

    job_id = uuid.uuid4().hex[:12]
    with core.COMFY_JOBS_LOCK:
        core.COMFY_JOBS[job_id] = {
            "id": job_id,
            "state": "pending",
            "total": 1,
            "done_count": 0,
            "current": "Starting…",
            "current_node": "",
            "progress": {"value": 0, "max": 0},
            "preview": None,
            "preview_ts": 0,
            "images": [],
            "error": "",
            "cancel": False,
        }
    t = threading.Thread(target=api_comfy._run_comfy_raw_job, args=(job_id, workflow),
                         kwargs={"source": "ideogram"}, daemon=True)
    t.start()
    return {"job_id": job_id, "warnings": v15_lint.lint_v15(req.prompt)}


class IdeogramNormalizeRequest(BaseModel):
    text: str


_LEGACY_STYLE_KEYS = ("aesthetics", "lighting", "photo", "art_style", "color_palette")


def _had_legacy_style(obj: dict) -> bool:
    """The pre-v15 ``style_description`` with any non-empty style field."""
    style = obj.get("style_description")
    if not isinstance(style, dict):
        return False
    return any(v.strip() if isinstance(v, str) else bool(v)
               for v in (style.get(k) for k in _LEGACY_STYLE_KEYS))


@router.post("/api/ideogram/normalize")
def api_ideogram_normalize(req: IdeogramNormalizeRequest):
    """Pasted text -> v15 prompt (same normaliser as the LLM endpoints).

    A fully double-encoded paste (the text is a JSON string holding the
    object) is unwrapped once. Text without a JSON object, or JSON without
    a v15 prompt after unwrapping, is a 400.
    """
    text = req.text
    obj = prompts._extract_json_object(text)
    if obj is None:
        try:
            inner = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            inner = None
        if isinstance(inner, str):
            text = inner
            obj = prompts._extract_json_object(text)
    if obj is None:
        raise HTTPException(400, "No JSON object found in the pasted text.")
    obj = prompts._unwrap_v15(obj)
    if "high_level_description" not in obj and "compositional_deconstruction" not in obj:
        raise HTTPException(400, "No Ideogram prompt found in the JSON.")
    prompt = prompts.normalize_ideogram_v15(text)
    return {"prompt": prompt, "warnings": v15_lint.lint_v15(prompt),
            "legacy_style": _had_legacy_style(obj)}


def _vlm_image_to_v15(image, instruction: str, model: str, quant: str,
                      max_tokens: int, default_ratio: str,
                      ensure: Callable[[str], str], job: dict | None = None) -> str:
    """Run the chosen vision model (local or LM Studio) and normalize to v15."""
    lm_id = core._lmstudio_model_id(model)
    if lm_id is not None:
        if job is not None:
            job["state"] = "analyzing"
        raw = lmstudio.caption_image(core._lmstudio_url(), lm_id, image, instruction, max_tokens)
    else:
        if job is not None:
            job["state"] = "loading_model"
        source = ensure(model)
        if job is not None:
            job["current"] = ""  # the download is over; its "100%" must not stay up
        captioner.ensure_loaded(model, quant if quant in ("4bit", "none") else "4bit",
                                source=source)
        if job is not None:
            job["state"] = "analyzing"
        raw = captioner.query_image(image, instruction, max_new_tokens=max_tokens)
    return prompts.normalize_ideogram_v15(raw, default_ratio=default_ratio)


def _florence_analyze(image, ensure: Callable[[str], str], job: dict | None):
    """Florence caption + measured elements; ``job`` follows loading_model -> analyzing."""
    if job is not None:
        job["state"] = "loading_model"
    ensure(florence.DEFAULT_MODEL)
    if job is not None:
        job["current"] = ""
        job["state"] = "analyzing"
    return florence.analyze_image(image)


def _analyze_image(image, engine: str, model: str, quant: str, max_tokens: int,
                   ensure: Callable[[str], str], job: dict | None = None) -> dict:
    """Reference image -> v15 draft: {json, elements, model, warnings}.

    Engines: "florence" (caption + measured bboxes + OCR), "vlm" (the chosen
    vision model drafts the whole JSON, estimating bboxes itself), "hybrid"
    (Florence measures the bboxes/OCR, the vision model writes the v15 prose);
    any other value runs Florence. Blocking; errors propagate to the caller.
    """
    ratio = florence.nearest_aspect(image.width, image.height)
    used_model = florence.DEFAULT_MODEL
    if engine == "vlm":
        draft = _vlm_image_to_v15(image, prompts.build_image_v15_instruction(),
                                  model, quant, max_tokens, ratio, ensure, job)
        used_model = model
    elif engine == "hybrid":
        caption, elements = _florence_analyze(image, ensure, job)
        base = florence.build_v15_draft(caption, elements, image.width, image.height)
        draft = _vlm_image_to_v15(image, prompts.build_hybrid_v15_instruction(base),
                                  model, quant, max_tokens, ratio, ensure, job)
        used_model = f"{florence.DEFAULT_MODEL} + {model}"
    else:
        caption, elements = _florence_analyze(image, ensure, job)
        draft = florence.build_v15_draft(caption, elements, image.width, image.height)
    n_elements = len((json.loads(draft).get("compositional_deconstruction") or {})
                     .get("elements") or [])
    return {"json": draft, "elements": n_elements,
            "model": used_model, "warnings": v15_lint.lint_v15(draft)}


def _decode_image(data: bytes):
    """Decode an upload by content, not MIME (HEIC arrives with an empty type),
    upright as shown (the EXIF orientation applied)."""
    try:
        return ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:  # noqa: BLE001
        return None


def _run_analyze_job(job: dict, image, engine: str, model: str, quant: str,
                     max_tokens: int) -> None:
    try:
        job["result"] = _analyze_image(image, engine, model, quant, max_tokens,
                                       lambda m: core._ensure_model_mapped(m, job), job)
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        if isinstance(e, HTTPException):
            msg = str(e.detail)
        elif isinstance(e, lmstudio.LMStudioError):
            msg = f"LM Studio: {e}"
        else:
            msg = f"Image analysis failed: {e}"
        job["error"] = f"{msg}\n{traceback.format_exc()}"
        job["state"] = "error"


@router.post("/api/ideogram/analyze/jobs")
async def api_ideogram_analyze_job_start(
        file: UploadFile,
        engine: Literal["florence", "vlm", "hybrid"] = Form("florence"),
        model: str = Form(captioner.DEFAULT_MODEL),
        quant: Literal["4bit", "none"] = Form("4bit"),
        max_tokens: int = Form(1536, ge=64, le=8192)):
    """Background image analysis (see _analyze_image); poll the GET route."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "Upload an image file.")
    image = await run_in_threadpool(_decode_image, data)
    if image is None:
        raise HTTPException(400, "Failed to read the image.")
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "kind": "analyze", "state": "pending",
           "current": "", "error": "", "result": None}
    # Florence (florence, hybrid) and local VLMs use our GPU; only LM Studio does not.
    lm_only = engine == "vlm" and core._lmstudio_model_id(model) is not None
    core._start_job(job, _run_analyze_job, (job, image, engine, model, quant, max_tokens),
                    local_model=not lm_only)
    return {"job_id": job_id}


@router.get("/api/ideogram/analyze/jobs/{job_id}")
def api_ideogram_analyze_job(job_id: str):
    job = core._job_of_kind(job_id, "analyze")
    return {"state": job["state"], "current": job["current"],
            "error": job["error"], "result": job["result"]}
