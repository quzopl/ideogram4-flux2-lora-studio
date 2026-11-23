"""Prompt routes: the SQLite prompt library, the expand / refine prompt jobs
and the v15 lint.
"""
from __future__ import annotations

import json
import sqlite3
import time
import traceback
import uuid
from datetime import datetime
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import captioner, core, lmstudio, prompts, v15_lint

router = APIRouter()


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class PromptJobRequest(BaseModel):
    """The background prompt job's request, strictly validated."""
    text: str
    action: Literal["expand", "refine"] = "expand"
    subject: Literal["auto", "person", "product", "landscape", "architecture"] = "auto"
    model: str = captioner.DEFAULT_MODEL
    quant: Literal["4bit", "none"] = "4bit"
    max_tokens: int = Field(768, ge=64, le=8192)
    caption_format: Literal["flux", "ideogram", "aitoolkit"] = "flux"
    elements_detail: Literal["few", "balanced", "detailed", "maximal"] = "balanced"
    desc_detail: Literal["brief", "balanced", "rich"] = "balanced"


class PromptLintRequest(BaseModel):
    prompt: str = ""


class LibrarySaveRequest(BaseModel):
    category: str            # "flux" | "ideogram"
    prompt: str
    input_text: str = ""
    action: str = "manual"


# --------------------------------------------------------------------------- #
# Prompt library (SQLite) — every generated prompt lands in the database.
# --------------------------------------------------------------------------- #
def _prompt_category(caption_format: str) -> str:
    """Studio format -> library category. ai-toolkit is Ideogram JSON too."""
    return "ideogram" if caption_format in ("ideogram", "aitoolkit") else "flux"


def _save_prompt_to_library(category: str, action: str, input_text: str, prompt: str) -> int:
    """Save a prompt to the library; returns the row id.

    The "ideogram" category accepts valid JSON objects only.
    """
    if category == "ideogram":
        try:
            obj = json.loads(prompt)
        except (json.JSONDecodeError, ValueError):
            obj = None
        if not isinstance(obj, dict):
            raise ValueError("An Ideogram prompt must be a valid JSON object.")
    conn = sqlite3.connect(str(core.DB_PATH))
    try:
        cur = conn.execute(
            "INSERT INTO prompt_library(category, action, input_text, prompt, created) "
            "VALUES (?,?,?,?,?)",
            (category, action, input_text, prompt, time.time()),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


@router.post("/api/prompts/library")
def api_prompt_library_save(req: LibrarySaveRequest):
    """Manual prompt save to the library (e.g. from the bbox editor)."""
    if req.category not in ("flux", "ideogram"):
        raise HTTPException(400, "The category must be 'flux' or 'ideogram'.")
    if not req.prompt.strip():
        raise HTTPException(400, "Empty prompt.")
    try:
        pid = _save_prompt_to_library(
            req.category, req.action, req.input_text, req.prompt.strip())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"id": pid, "warnings": v15_lint.lint_v15(req.prompt)
            if req.category == "ideogram" else []}


@router.get("/api/prompts/library")
def api_prompt_library(category: str = "all"):
    """Saved prompts, newest first; optional category filter."""
    if category in ("flux", "ideogram"):
        rows = core._db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library WHERE category=? ORDER BY id DESC",
            (category,), many=True,
        )
    else:
        rows = core._db_query(
            "SELECT id, category, action, input_text, prompt, created "
            "FROM prompt_library ORDER BY id DESC",
            many=True,
        )
    return {"prompts": [dict(r) for r in (rows or [])]}


@router.delete("/api/prompts/library/{pid}")
def api_prompt_library_delete(pid: int):
    if not core._db_query("SELECT 1 FROM prompt_library WHERE id=?", (pid,)):
        raise HTTPException(404, "No prompt with that id.")
    core._db_query("DELETE FROM prompt_library WHERE id=?", (pid,), write=True)
    return {"ok": True}


def _sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


@router.get("/api/prompts/library/export")
def api_prompt_library_export(category: str = "all"):
    """Eksport biblioteki jako plik .sql (CREATE TABLE + INSERTy)."""
    rows = api_prompt_library(category)["prompts"]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"-- Prompt library (flux-lora-prep), exported {stamp}, "
        f"category: {category}, items: {len(rows)}",
        "CREATE TABLE IF NOT EXISTS prompt_library (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    category TEXT NOT NULL CHECK (category IN ('flux','ideogram')),",
        "    action TEXT NOT NULL DEFAULT '',",
        "    input_text TEXT NOT NULL DEFAULT '',",
        "    prompt TEXT NOT NULL,",
        "    created REAL NOT NULL",
        ");",
        "",
    ]
    for r in rows:
        lines.append(
            "INSERT INTO prompt_library (id, category, action, input_text, prompt, created) "
            f"VALUES ({r['id']}, {_sql_quote(r['category'])}, {_sql_quote(r['action'])}, "
            f"{_sql_quote(r['input_text'])}, {_sql_quote(r['prompt'])}, {r['created']});"
        )
    body = "\n".join(lines) + "\n"
    fname = f"prompts_{category}_{datetime.now().strftime('%Y%m%d-%H%M%S')}.sql"
    return Response(
        content=body.encode("utf-8"),
        media_type="application/sql; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def _generate_prompt(req: PromptJobRequest, ensure: Callable[[str], str],
                     job: dict | None = None) -> dict:
    """Expand or refine ``req.text`` and save the result to the library.

    ``ensure`` turns a model id into a local path (a job-bound ``_ensure_model_mapped``).
    When ``job`` is given its ``state`` follows loading_model -> generating.
    Returns {prompt, warnings, library_id}; errors propagate to the caller.
    """
    text = req.text.strip()
    quant = req.quant if req.quant in ("4bit", "none") else "4bit"
    if req.caption_format in ("ideogram", "aitoolkit"):
        system = prompts.build_ideogram_studio_v15(
            req.action, req.subject, req.elements_detail, req.desc_detail)
    else:
        system = prompts.build_studio_system(req.action, req.subject)
    lm_id = core._lmstudio_model_id(req.model)
    if lm_id is not None:
        if job is not None:
            job["state"] = "generating"
        raw = lmstudio.generate_text(core._lmstudio_url(), lm_id, system, text, req.max_tokens)
    else:
        if job is not None:
            job["state"] = "loading_model"
        source = ensure(req.model)
        if job is not None:
            job["current"] = ""  # the download is over; its "100%" must not stay up
        captioner.ensure_loaded(req.model, quant, source=source)
        if job is not None:
            job["state"] = "generating"
        raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
    if req.caption_format in ("ideogram", "aitoolkit"):
        final = prompts.normalize_ideogram_v15(raw)
        warnings = v15_lint.lint_v15(final)
    else:
        final = prompts.clean_prompt(raw)
        warnings = []
    library_id = _save_prompt_to_library(
        _prompt_category(req.caption_format), req.action, text, final)
    return {"prompt": final, "warnings": warnings, "library_id": library_id}


def _run_prompt_job(job: dict, req: PromptJobRequest) -> None:
    try:
        res = _generate_prompt(req, lambda m: core._ensure_model_mapped(m, job), job)
        job["result"] = {**res, "format": req.caption_format}
        job["current"] = ""
        job["state"] = "done"
    except BaseException as e:  # noqa: BLE001 - a dead thread must never leave the job busy
        if isinstance(e, HTTPException):
            msg = str(e.detail)
        elif isinstance(e, lmstudio.LMStudioError):
            msg = f"LM Studio: {e}"
        else:
            msg = f"Generation error: {e}"
        job["error"] = f"{msg}\n{traceback.format_exc()}"
        job["state"] = "error"


@router.post("/api/prompt/jobs")
def api_prompt_job_start(req: PromptJobRequest):
    if not req.text.strip():
        raise HTTPException(400, "Type a prompt to expand or refine.")
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "kind": "prompt", "state": "pending",
           "current": "", "error": "", "result": None}
    # ensure_loaded swaps the shared model; LM Studio never touches our GPU.
    core._start_job(job, _run_prompt_job, (job, req),
                    local_model=core._lmstudio_model_id(req.model) is None)
    return {"job_id": job_id}


@router.get("/api/prompt/jobs/{job_id}")
def api_prompt_job(job_id: str):
    job = core._job_of_kind(job_id, "prompt")
    return {"state": job["state"], "current": job["current"],
            "error": job["error"], "result": job["result"]}


@router.post("/api/prompts/lint")
def api_prompts_lint(req: PromptLintRequest):
    if not req.prompt.strip():
        return {"warnings": []}
    return {"warnings": v15_lint.lint_v15(req.prompt)}
