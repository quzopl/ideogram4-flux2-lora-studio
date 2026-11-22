"""v2 bbox backend: JSON normalize, background image-analysis jobs, real render cancel."""
import io
import json
import threading

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from backend import captioner, comfy_client, florence, lmstudio, prompts, server

client = TestClient(server.app)

V15 = {
    "aspect_ratio": "4:3",
    "high_level_description": "a red fox in snow",
    "compositional_deconstruction": {
        "background": "snowy field",
        "elements": [{"type": "obj", "bbox": [100, 200, 800, 700], "desc": "a red fox"}],
    },
}
NO_FOLDER = "No models folder chosen — set one in Settings (Models folder)."


class _SyncThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._t, self._a, self._k = target, args, kwargs or {}

    def start(self):
        self._t(*self._a, **self._k)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(threading, "Thread", _SyncThread)
    monkeypatch.setattr(server, "_ensure_model", lambda m, job=None: f"/models/{m}")
    monkeypatch.setattr(florence, "analyze_image", lambda img: (
        "A fox in snow.", [{"type": "obj", "bbox": [100, 100, 900, 500], "desc": "fox"}]))
    monkeypatch.setattr(captioner, "ensure_loaded", lambda *a, **k: None)
    monkeypatch.setattr(captioner, "query_image", lambda *a, **k: json.dumps(V15))
    server.JOBS.clear()
    server.COMFY_JOBS.clear()
    yield
    server.JOBS.clear()
    server.COMFY_JOBS.clear()


def _png(w=80, h=60) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "red").save(buf, format="PNG")
    return buf.getvalue()


def _normalize(text):
    return client.post("/api/ideogram/normalize", json={"text": text})


# --------------------------------------------------------------------------- #
# POST /api/ideogram/normalize
# --------------------------------------------------------------------------- #
def test_normalize_wrapped_and_legacy():
    r = _normalize(json.dumps({"caption": V15}))
    assert r.status_code == 200, r.text
    assert json.loads(r.json()["prompt"]) == V15
    assert isinstance(r.json()["warnings"], list)

    legacy = {**V15, "style_description": {"aesthetics": "moody", "lighting": "dusk",
                                           "photo": "35mm", "medium": "photo"}}
    r = _normalize(json.dumps(legacy))
    assert r.status_code == 200, r.text
    out = json.loads(r.json()["prompt"])
    assert "style_description" not in out
    assert out == V15


def test_normalize_double_encoded_top_level():
    r = _normalize(json.dumps(json.dumps(V15)))
    assert r.status_code == 200, r.text
    assert r.json()["prompt"] == _normalize(json.dumps(V15)).json()["prompt"]
    assert json.loads(r.json()["prompt"]) == V15


def test_normalize_garbage_400():
    for text in ("hello", "", json.dumps("hello"), json.dumps(json.dumps("hi"))):
        r = _normalize(text)
        assert r.status_code == 400, text
        assert r.json()["detail"] == "No JSON object found in the pasted text."


def test_normalize_editor_output_is_identity():
    doc = {"aspect_ratio": "3:1", "high_level_description": "h",
           "compositional_deconstruction": {"background": "b", "elements": [
               {"type": "obj", "bbox": [10, 20, 300, 400], "desc": ""},
               {"type": "obj", "desc": "no box"},
               {"type": "text", "bbox": [1, 2, 3, 4], "text": "A\nB", "desc": "d"},
           ]}}
    minified = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    r = _normalize(minified)
    assert r.status_code == 200, r.text
    assert json.loads(r.json()["prompt"]) == doc
    assert r.json()["prompt"] == minified  # key order kept too
    assert r.json()["legacy_style"] is False


def test_normalize_legacy_style_flag():
    def flag(style):
        r = _normalize(json.dumps({**V15, "style_description": style}))
        assert r.status_code == 200, r.text
        return r.json()["legacy_style"]

    assert _normalize(json.dumps(V15)).json()["legacy_style"] is False
    assert flag({"aesthetics": "", "lighting": "", "photo": "", "medium": "x"}) is False
    for key in ("aesthetics", "lighting", "photo", "art_style"):
        assert flag({key: "something"}) is True, key
    assert flag({"color_palette": ["#ff0000"]}) is True
    # wrapped: the flag reads the unwrapped object
    wrapped = {"caption": {**V15, "style_description": {"lighting": "dusk"}}}
    assert _normalize(json.dumps(wrapped)).json()["legacy_style"] is True


# --------------------------------------------------------------------------- #
# POST /api/ideogram/analyze/jobs + GET
# --------------------------------------------------------------------------- #
def _post_analyze(data=None, content=None, mime="image/png", name="t.png"):
    content = _png() if content is None else content
    return client.post("/api/ideogram/analyze/jobs", data=data or {},
                       files={"file": (name, content, mime)})


def _job(jid):
    r = client.get(f"/api/ideogram/analyze/jobs/{jid}")
    assert r.status_code == 200, r.text
    return r.json()


def test_analyze_job_florence_done():
    r = _post_analyze()
    assert r.status_code == 200, r.text
    j = _job(r.json()["job_id"])
    assert j["state"] == "done", j["error"]
    res = j["result"]
    obj = json.loads(res["json"])
    assert list(obj) == ["aspect_ratio", "high_level_description",
                         "compositional_deconstruction"]
    assert obj["aspect_ratio"] == "4:3"
    assert isinstance(res["elements"], int) and res["elements"] == 1
    assert res["model"] == florence.DEFAULT_MODEL
    assert isinstance(res["warnings"], list)
    assert server.JOBS[r.json()["job_id"]]["kind"] == "analyze"


def test_analyze_job_vlm_passes_max_tokens_and_quant(monkeypatch):
    seen = {}
    monkeypatch.setattr(captioner, "ensure_loaded",
                        lambda m, q, source=None: seen.update(model=m, quant=q, source=source))
    monkeypatch.setattr(captioner, "query_image",
                        lambda img, instr, max_new_tokens=768:
                        seen.update(tokens=max_new_tokens) or json.dumps(V15))
    r = _post_analyze({"engine": "vlm", "model": "Qwen/X", "quant": "none"})
    j = _job(r.json()["job_id"])
    assert j["state"] == "done", j["error"]
    assert seen == {"model": "Qwen/X", "quant": "none", "source": "/models/Qwen/X",
                    "tokens": 1536}
    assert j["result"]["model"] == "Qwen/X"
    _post_analyze({"engine": "vlm", "model": "Qwen/X", "max_tokens": "4000"})
    assert seen["tokens"] == 4000


def test_analyze_job_validation():
    assert _post_analyze({"engine": "other"}).status_code == 422
    assert _post_analyze({"quant": "8bit"}).status_code == 422
    assert _post_analyze({"max_tokens": "10"}).status_code == 422
    assert _post_analyze({"max_tokens": "9000"}).status_code == 422
    assert not server.JOBS


def test_analyze_job_rejects_non_image():
    r = _post_analyze(content=b"definitely not an image", mime="text/plain", name="a.txt")
    assert r.status_code == 400
    assert r.json()["detail"] == "Failed to read the image."
    r = _post_analyze(content=b"", mime="image/png")
    assert r.status_code == 400
    assert r.json()["detail"] == "Upload an image file."
    assert not server.JOBS


def test_analyze_job_accepts_empty_mime_image():
    for mime in ("application/octet-stream", ""):
        r = _post_analyze(mime=mime, name="photo")
        assert r.status_code == 200, r.text
        assert _job(r.json()["job_id"])["state"] == "done"


def test_analyze_job_accepts_heic(tmp_path):
    pytest.importorskip("pillow_heif")
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), "blue").save(buf, format="HEIF")
    r = _post_analyze(content=buf.getvalue(), mime="", name="IMG_0001.HEIC")
    assert r.status_code == 200, r.text
    assert _job(r.json()["job_id"])["state"] == "done"


def test_analyze_job_error_first_line(monkeypatch):
    def boom(model_id, job):
        raise HTTPException(400, NO_FOLDER)
    monkeypatch.setattr(server, "_ensure_model_mapped", boom)
    j = _job(_post_analyze().json()["job_id"])
    assert j["state"] == "error"
    first, rest = j["error"].split("\n", 1)
    assert first == NO_FOLDER
    assert "Traceback" in rest


def test_analyze_job_error_mapping(monkeypatch):
    def lm_fail(*a, **k):
        raise lmstudio.LMStudioError("down")
    monkeypatch.setattr(lmstudio, "caption_image", lm_fail)
    j = _job(_post_analyze({"engine": "vlm", "model": "lmstudio:qwen"}).json()["job_id"])
    assert j["state"] == "error"
    assert j["error"].split("\n", 1)[0] == "LM Studio: down"

    def crash(img):
        raise ValueError("bad tensor")
    monkeypatch.setattr(florence, "analyze_image", crash)
    j = _job(_post_analyze().json()["job_id"])
    assert j["error"].split("\n", 1)[0] == "Image analysis failed: bad tensor"


def test_analyze_job_catches_base_exception(monkeypatch):
    def die(img):
        raise KeyboardInterrupt()
    monkeypatch.setattr(florence, "analyze_image", die)
    j = _job(_post_analyze().json()["job_id"])
    assert j["state"] == "error"


def test_analyze_job_states(monkeypatch):
    states = []

    def ensure(model_id, job):
        states.append(job["state"])
        return "/m"
    monkeypatch.setattr(server, "_ensure_model_mapped", ensure)
    monkeypatch.setattr(florence, "analyze_image", lambda img: states.append(
        next(iter(server.JOBS.values()))["state"]) or ("A.", []))
    _post_analyze()
    assert states == ["loading_model", "analyzing"]


def test_analyze_job_409_while_busy(monkeypatch):
    server.JOBS["busy"] = {"id": "busy", "kind": "dataset", "state": "processing"}
    monkeypatch.setattr(lmstudio, "caption_image", lambda *a, **k: json.dumps(V15))
    for data in ({}, {"engine": "florence"}, {"engine": "hybrid", "model": "lmstudio:q"},
                 {"engine": "vlm", "model": "Qwen/X"}):
        r = _post_analyze(data)
        assert r.status_code == 409, data
    assert list(server.JOBS) == ["busy"]
    # pure LM Studio never touches the local GPU
    r = _post_analyze({"engine": "vlm", "model": "lmstudio:q"})
    assert r.status_code == 200, r.text


def test_busy_counts_analyzing():
    server.JOBS["a"] = {"id": "a", "kind": "analyze", "state": "analyzing"}
    assert server._busy()


def test_analyze_job_unknown_or_wrong_kind():
    server.JOBS["p"] = {"id": "p", "kind": "prompt", "state": "done",
                        "current": "", "error": "", "result": None}
    assert client.get("/api/ideogram/analyze/jobs/p").status_code == 404
    assert client.get("/api/ideogram/analyze/jobs/nope").status_code == 404


def test_legacy_analyze_unchanged():
    r = client.post("/api/ideogram/analyze",
                    files={"file": ("t.png", _png(), "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"json", "elements", "model", "warnings"}
    assert body["elements"] == 1 and body["model"] == florence.DEFAULT_MODEL
    # the legacy endpoint keeps its content-type check
    r = client.post("/api/ideogram/analyze",
                    files={"file": ("t.png", _png(), "application/octet-stream")})
    assert r.status_code == 400
    assert r.json()["detail"] == "Upload an image file."
    assert not server.JOBS


def test_legacy_analyze_vlm_default_tokens(monkeypatch):
    seen = {}
    monkeypatch.setattr(captioner, "query_image",
                        lambda img, instr, max_new_tokens=0:
                        seen.update(tokens=max_new_tokens) or json.dumps(V15))
    r = client.post("/api/ideogram/analyze", data={"engine": "vlm", "model": "Qwen/X"},
                    files={"file": ("t.png", _png(), "image/png")})
    assert r.status_code == 200, r.text
    assert seen["tokens"] == 768


# --------------------------------------------------------------------------- #
# ComfyUI client: interrupt / delete_queued / stream_events
# --------------------------------------------------------------------------- #
def test_interrupt_and_delete_queued_post(monkeypatch):
    calls = []
    monkeypatch.setattr(comfy_client, "_request",
                        lambda url, data=None, timeout=30.0: calls.append((url, data)) or b"")
    comfy_client.interrupt("http://c:8188/")
    comfy_client.delete_queued("http://c:8188", "pid-1")
    assert calls[0][0] == "http://c:8188/interrupt" and calls[0][1]  # non-empty body = POST
    assert calls[1] == ("http://c:8188/queue", json.dumps({"delete": ["pid-1"]}).encode())


def test_interrupt_and_delete_swallow_errors(monkeypatch):
    def fail(*a, **k):
        raise comfy_client.ComfyError("no connection")
    monkeypatch.setattr(comfy_client, "_request", fail)
    comfy_client.interrupt("http://c")
    comfy_client.delete_queued("http://c", "p")

    def timeout(*a, **k):
        raise TimeoutError("timed out")
    monkeypatch.setattr(comfy_client, "_request", timeout)
    comfy_client.interrupt("http://c")
    comfy_client.delete_queued("http://c", "p")


class _FakeWS:
    def __init__(self, msgs):
        self.msgs = list(msgs)
        self.closed = False

    def settimeout(self, t):
        pass

    def recv(self):
        import websocket
        if not self.msgs:
            raise websocket.WebSocketTimeoutException("timeout")
        m = self.msgs.pop(0)
        return m if isinstance(m, (bytes, str)) else json.dumps(m)

    def close(self):
        self.closed = True


def _stream(monkeypatch, msgs, should_stop=None):
    import websocket
    ws = _FakeWS(msgs)
    monkeypatch.setattr(websocket, "create_connection", lambda *a, **k: ws)
    events = []
    comfy_client.stream_events("http://c", "cid", "P", lambda k, p: events.append((k, p)),
                               should_stop=should_stop)
    return events, ws


def test_stream_events_interrupted_returns(monkeypatch):
    events, ws = _stream(monkeypatch, [
        {"type": "execution_start", "data": {"prompt_id": "P"}},
        {"type": "progress", "data": {"prompt_id": "P", "value": 1, "max": 4}},
        {"type": "execution_interrupted", "data": {"prompt_id": "P", "node_id": "9"}},
    ])
    kinds = [k for k, _ in events]
    assert kinds == ["started", "progress", "interrupted"]
    assert ws.closed


def test_stream_events_started_only_for_own_prompt(monkeypatch):
    events, _ = _stream(monkeypatch, [
        {"type": "execution_start", "data": {"prompt_id": "OTHER"}},
        {"type": "executing", "data": {"node": "3"}},  # no prompt_id: not ours for sure
        {"type": "executing", "data": {"node": "3", "prompt_id": "P"}},
        {"type": "executing", "data": {"node": None, "prompt_id": "P"}},
    ])
    assert [k for k, _ in events] == ["executing", "started", "executing", "executing", "done"]


def test_stream_events_started_from_progress_when_start_was_missed(monkeypatch):
    events, _ = _stream(monkeypatch, [
        {"type": "progress", "data": {"prompt_id": "P", "value": 1, "max": 4}},
        {"type": "progress", "data": {"prompt_id": "P", "value": 2, "max": 4}},
        {"type": "executing", "data": {"node": None, "prompt_id": "P"}},
    ])
    assert [k for k, _ in events] == ["started", "progress", "progress", "executing", "done"]


def test_stream_events_should_stop_returns_while_queued(monkeypatch):
    stop = {"n": 0}

    def should_stop():
        stop["n"] += 1
        return stop["n"] > 2

    events, ws = _stream(monkeypatch, [], should_stop=should_stop)  # nothing ever arrives
    assert events == []
    assert ws.closed


# --------------------------------------------------------------------------- #
# Render job cancel
# --------------------------------------------------------------------------- #
@pytest.fixture
def comfy(monkeypatch, tmp_path):
    calls = {"interrupt": [], "delete": [], "history": 0}
    monkeypatch.setattr(server, "_load_comfy_config", lambda: {"url": "http://c"})
    monkeypatch.setattr(server, "COMFY_GALLERY_DIR", tmp_path)
    monkeypatch.setattr(comfy_client, "interrupt", lambda url: calls["interrupt"].append(url))
    monkeypatch.setattr(comfy_client, "delete_queued",
                        lambda url, pid: calls["delete"].append((url, pid)))
    monkeypatch.setattr(comfy_client, "queue_prompt", lambda url, wf, client_id=None: "P1")

    def history(url, pid):
        calls["history"] += 1
        if calls["history"] > 50:
            raise AssertionError("the runner is stuck polling /history")
        return {}
    monkeypatch.setattr(comfy_client, "history", history)
    return calls


def _comfy_job(**extra):
    job = {"id": "j", "state": "running", "total": 1, "done_count": 0, "current": "",
           "current_node": "", "progress": {"value": 0, "max": 0}, "preview": None,
           "preview_ts": 0, "images": [], "error": "", "cancel": False, **extra}
    server.COMFY_JOBS["j"] = job
    return job


def _cancel(jid="j"):
    r = client.post(f"/api/comfy/job/{jid}/cancel")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}


def test_cancel_running_interrupts_comfy(comfy):
    job = _comfy_job(prompt_id="P1", executing=True, comfy_url="http://c")
    _cancel()
    assert comfy["interrupt"] == ["http://c"]
    assert comfy["delete"] == []
    assert job["cancel"] is True


def test_cancel_queued_deletes_from_queue(comfy):
    job = _comfy_job(prompt_id="P1", executing=False, comfy_url="http://c")
    _cancel()
    assert comfy["delete"] == [("http://c", "P1")]
    assert comfy["interrupt"] == []
    assert job["cancel"] is True


def test_cancel_terminal_sends_nothing(comfy):
    for state in ("done", "error", "cancelled"):
        server.COMFY_JOBS.clear()
        job = _comfy_job(state=state, prompt_id="P1", executing=True, comfy_url="http://c")
        _cancel()
        assert job["state"] == state
    assert comfy["interrupt"] == [] and comfy["delete"] == []


def test_cancel_before_queueing_only_flags(comfy):
    job = _comfy_job(state="pending")
    _cancel()
    assert job["cancel"] is True
    assert comfy["interrupt"] == [] and comfy["delete"] == []


def test_cancel_unknown_404():
    assert client.post("/api/comfy/job/nope/cancel").status_code == 404


def test_runner_records_prompt_id_and_executing(comfy, monkeypatch):
    seen = {}

    def fake_stream(url, cid, pid, on_event, **kw):
        job = server.COMFY_JOBS["j"]
        seen["queued"] = (job.get("prompt_id"), job.get("executing"))
        on_event("started", None)
        seen["running"] = job.get("executing")
        on_event("interrupted", {})
    monkeypatch.setattr(comfy_client, "stream_events", fake_stream)
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert seen == {"queued": ("P1", False), "running": True}
    assert job["executing"] is False  # cleared once the stream ended
    assert job["state"] == "cancelled"


def test_interrupted_run_ends_cancelled(comfy, monkeypatch):
    def fake_stream(url, cid, pid, on_event, **kw):
        on_event("started", None)
        server.COMFY_JOBS["j"]["cancel"] = True  # the Cancel button was pressed
        on_event("interrupted", {"prompt_id": pid})
    monkeypatch.setattr(comfy_client, "stream_events", fake_stream)
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert job["state"] == "cancelled"
    assert job["error"] == ""
    assert comfy["history"] == 0


def test_interrupted_elsewhere_ends_cancelled(comfy, monkeypatch):
    """Interrupted from ComfyUI's own UI: no flag, still cancelled, never stuck."""
    monkeypatch.setattr(comfy_client, "stream_events",
                        lambda url, cid, pid, on_event, **kw: on_event("interrupted", {}))
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert job["state"] == "cancelled"


def test_cancel_arriving_before_prompt_id_deletes_after_queueing(comfy, monkeypatch):
    def queue(url, wf, client_id=None):
        server.COMFY_JOBS["j"]["cancel"] = True  # cancel lands while queueing
        return "P1"
    monkeypatch.setattr(comfy_client, "queue_prompt", queue)
    monkeypatch.setattr(comfy_client, "stream_events",
                        lambda *a, **k: pytest.fail("must not stream a cancelled job"))
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert comfy["delete"] == [("http://c", "P1")]
    assert job["state"] == "cancelled"


def test_runner_passes_should_stop(comfy, monkeypatch):
    seen = {}

    def fake_stream(url, cid, pid, on_event, should_stop=None):
        seen["before"] = should_stop()
        server.COMFY_JOBS["j"]["cancel"] = True
        seen["after"] = should_stop()
    monkeypatch.setattr(comfy_client, "stream_events", fake_stream)
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert seen == {"before": False, "after": True}
    assert job["state"] == "cancelled"


def test_mapped_runner_records_prompt_id(comfy, monkeypatch):
    """The classic ComfyUI view's batch runner shares the cancel endpoint."""
    monkeypatch.setattr(server, "_load_comfy_config",
                        lambda: {"url": "http://c", "workflow": {}, "mapping": {}})
    monkeypatch.setattr(server.comfy_workflows, "apply_overrides_multi_lora",
                        lambda *a, **k: {})
    seen = {}

    def fake_stream(url, cid, pid, on_event, **kw):
        job = server.COMFY_JOBS["j"]
        seen["queued"] = (job.get("prompt_id"), job.get("executing"))
        on_event("started", None)
        seen["running"] = job.get("executing")
        on_event("interrupted", {})
    monkeypatch.setattr(comfy_client, "stream_events", fake_stream)
    job = _comfy_job(state="pending")
    server._run_comfy_job("j", server.ComfyGenerateRequest(prompt="p", batch=2))
    assert seen == {"queued": ("P1", False), "running": True}
    assert job["state"] == "cancelled"
    assert job["done_count"] == 0


def test_raw_runner_step_text(comfy, monkeypatch):
    seen = {}

    def fake_stream(url, cid, pid, on_event, **kw):
        on_event("progress", {"value": 3, "max": 10})
        seen["current"] = server.COMFY_JOBS["j"]["current"]
        on_event("done", None)
    monkeypatch.setattr(comfy_client, "stream_events", fake_stream)
    monkeypatch.setattr(comfy_client, "history", lambda url, pid: {
        "P1": {"outputs": {"9": {"images": [{"filename": "a.png"}]}}}})
    monkeypatch.setattr(comfy_client, "fetch_image", lambda *a, **k: _png())
    job = _comfy_job(state="pending")
    server._run_comfy_raw_job("j", {})
    assert seen["current"] == "Step 3/10"
    assert job["state"] == "done"
    assert len(job["images"]) == 1
