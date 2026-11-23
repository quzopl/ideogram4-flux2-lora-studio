import json
import threading

import pytest
from fastapi.testclient import TestClient

from backend import captioner, core, lmstudio, model_store, prompts, server

client = TestClient(server.app)

IDEO = json.dumps({"aspect_ratio": "1:1", "high_level_description": "a dog"})


class _SyncThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._t, self._a, self._k = target, args, kwargs or {}

    def start(self):
        self._t(*self._a, **self._k)


@pytest.fixture(autouse=True)
def _env(monkeypatch, prompt_db):
    monkeypatch.setattr(threading, "Thread", _SyncThread)
    monkeypatch.setattr(captioner, "ensure_loaded", lambda *a, **k: None)
    monkeypatch.setattr(captioner, "generate_text", lambda *a, **k: "A tabby cat.")
    monkeypatch.setattr(core, "_ensure_model", lambda m, job=None: "/p")
    core.JOBS.clear()
    yield
    core.JOBS.clear()


def _start(**kw):
    body = {"text": "a cat", **kw}
    r = client.post("/api/prompt/jobs", json=body)
    assert r.status_code == 200, r.text
    return r.json()["job_id"]


def _get(jid):
    r = client.get(f"/api/prompt/jobs/{jid}")
    assert r.status_code == 200
    return r.json()


def test_prompt_job_flux_done():
    jid = _start()
    j = _get(jid)
    assert j["state"] == "done"
    assert j["result"]["prompt"] == prompts.clean_prompt("A tabby cat.")
    assert j["result"]["format"] == "flux"
    assert j["result"]["warnings"] == []
    rows = client.get("/api/prompts/library").json()["prompts"]
    assert [r["id"] for r in rows] == [j["result"]["library_id"]]


def test_prompt_job_ideogram_lints(monkeypatch):
    monkeypatch.setattr(captioner, "generate_text", lambda *a, **k: IDEO)
    j = _get(_start(caption_format="ideogram"))
    assert j["state"] == "done"
    assert isinstance(j["result"]["warnings"], list)
    assert j["result"]["format"] == "ideogram"
    rows = client.get("/api/prompts/library").json()["prompts"]
    assert rows[0]["category"] == "ideogram"


def test_prompt_job_reports_missing_models_folder(monkeypatch):
    def boom(m, job=None):
        raise model_store.ModelsFolderNotSet()
    monkeypatch.setattr(core, "_ensure_model", boom)
    j = _get(_start())
    assert j["state"] == "error"
    assert j["error"].startswith("No models folder chosen")


def test_prompt_job_validation():
    post = lambda **kw: client.post("/api/prompt/jobs", json={"text": "a", **kw})  # noqa: E731
    assert post(max_tokens=10).status_code == 422
    assert post(action="x").status_code == 422
    assert client.post("/api/prompt/jobs", json={"text": "  "}).status_code == 400


def test_prompt_job_wrong_kind_404():
    core.JOBS["d"] = {"id": "d", "kind": "dataset", "state": "done"}
    assert client.get("/api/prompt/jobs/d").status_code == 404
    assert client.get("/api/prompt/jobs/nope").status_code == 404


def test_lint_endpoint():
    r = client.post("/api/prompts/lint", json={"prompt": "not json"}).json()
    assert len(r["warnings"]) == 1 and r["warnings"][0]["level"] == "err"
    assert client.post("/api/prompts/lint", json={"prompt": ""}).json() == {"warnings": []}


def test_busy_while_generating():
    core.JOBS["g"] = {"id": "g", "kind": "prompt", "state": "generating"}
    assert client.post("/api/unload").status_code == 409


def test_prompt_job_lmstudio_error_text(monkeypatch):
    def lm(*a, **k):
        raise lmstudio.LMStudioError("x")
    monkeypatch.setattr(lmstudio, "generate_text", lm)
    j = _get(_start(model="lmstudio:a"))
    assert j["state"] == "error" and j["error"].startswith("LM Studio:")


def test_prompt_job_crash_ends_in_error(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(captioner, "generate_text", boom)
    j = _get(_start())
    assert j["state"] == "error" and j["error"].startswith("Generation error: boom")
    assert client.post("/api/unload").status_code == 200


def test_prompt_job_409_while_busy(monkeypatch):
    core.JOBS["p"] = {"id": "p", "kind": "dataset", "state": "processing"}
    r = client.post("/api/prompt/jobs", json={"text": "a"})
    assert r.status_code == 409
    assert r.json()["detail"] == "Processing in progress — wait for it to finish."
    monkeypatch.setattr(lmstudio, "generate_text", lambda *a, **k: "ok")
    assert client.post("/api/prompt/jobs",
                       json={"text": "a", "model": "lmstudio:x"}).status_code == 200


def test_download_failure_text_in_job(monkeypatch):
    def dl(m, job=None):
        raise RuntimeError("Download incomplete: x")
    monkeypatch.setattr(core, "_ensure_model", dl)
    assert _get(_start())["error"].split("\n")[0] == "Download incomplete: x"


def test_value_error_outside_ensure_is_generation_error(monkeypatch):
    def bad(*a, **k):
        raise ValueError("bad")
    monkeypatch.setattr(captioner, "generate_text", bad)
    assert _get(_start())["error"].split("\n")[0] == "Generation error: bad"


@pytest.mark.parametrize("where, exc, first", [
    ("ensure", model_store.ModelsFolderNotSet(), None),
    ("lmstudio", lmstudio.LMStudioError("x"), "LM Studio: x"),
    ("generate", RuntimeError("boom"), "Generation error: boom"),
])
def test_prompt_job_error_has_traceback_after_first_line(monkeypatch, where, exc, first):
    def boom(*a, **k):
        raise exc
    kw = {}
    if where == "ensure":
        monkeypatch.setattr(core, "_ensure_model", boom)
    elif where == "lmstudio":
        monkeypatch.setattr(lmstudio, "generate_text", boom)
        kw["model"] = "lmstudio:a"
    else:
        monkeypatch.setattr(captioner, "generate_text", boom)
    err = _get(_start(**kw))["error"]
    head, _, rest = err.partition("\n")
    if first is None:
        assert head.startswith("No models folder chosen")
    else:
        assert head == first
    assert rest.startswith("Traceback (most recent call last):")


def test_prompt_job_download_progress_cleared_before_loading(monkeypatch):
    def ensure(m, job=None):
        job["current"] = "Downloading Model: 100%"
        return "/p"
    seen = []

    def loaded(*a, **k):
        job = next(iter(core.JOBS.values()))
        seen.append((job["state"], job["current"]))
    monkeypatch.setattr(core, "_ensure_model", ensure)
    monkeypatch.setattr(captioner, "ensure_loaded", loaded)
    assert _get(_start())["state"] == "done"
    assert seen == [("loading_model", "")]
