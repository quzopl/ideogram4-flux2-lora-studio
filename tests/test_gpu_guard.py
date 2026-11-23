"""One GPU-busy guard for every job that uses a model loaded in this process."""
import types

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import server

LOCAL_BUSY = {"state": "processing", "local_model": True}


@pytest.fixture
def client(tmp_path, monkeypatch):
    Image.new("RGB", (10, 10)).save(tmp_path / "a.png")
    for name in ("_run_job", "_run_crop_auto", "_run_upscale_job",
                 "_run_analyze_job", "_run_prompt_job"):
        monkeypatch.setattr(server, name, lambda *a, **kw: None)
    monkeypatch.setattr(server, "JOBS", {})
    c = TestClient(server.app)
    c.folder = str(tmp_path)
    return c


def _png_bytes():
    import io
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, format="PNG")
    return buf.getvalue()


def _start(c, name):
    f = c.folder
    if name == "dataset":
        return c.post("/api/process", json={"folder": f, "do_caption": True})
    if name == "crop":
        return c.post("/api/crop/auto", json={"folder": f, "mode": "person"})
    if name == "upscale":
        return c.post("/api/upscale/run",
                      json={"folder": f, "model_id": "x", "device": "cpu"})
    if name == "analyze":
        return c.post("/api/ideogram/analyze/jobs",
                      files={"file": ("a.png", _png_bytes(), "image/png")})
    return c.post("/api/prompt/jobs", json={"text": "a cat"})


@pytest.mark.parametrize("name", ["dataset", "crop", "upscale", "analyze", "prompt"])
def test_each_local_starter_409_while_a_local_job_runs(client, name):
    server.JOBS["j"] = dict(LOCAL_BUSY)
    r = _start(client, name)
    assert r.status_code == 409
    assert r.json()["detail"] == server.BUSY_MSG
    assert list(server.JOBS) == ["j"]


@pytest.mark.parametrize("state", ["pending", "loading_model"])
def test_pending_and_loading_model_count_as_busy(client, state):
    server.JOBS["j"] = {"state": state, "local_model": True}
    assert _start(client, "upscale").status_code == 409


def test_lmstudio_only_job_blocks_nothing(client):
    server.JOBS["j"] = {"state": "generating", "local_model": False}
    assert _start(client, "upscale").status_code == 200
    server.JOBS.clear()
    server.JOBS["j"] = {"state": "generating", "local_model": False}
    assert client.post("/api/unload").status_code == 200


def test_exempt_starts_pass_while_busy(client):
    server.JOBS["j"] = dict(LOCAL_BUSY)
    f = client.folder
    r = client.post("/api/process",
                    json={"folder": f, "do_caption": False, "upscale_model": ""})
    assert r.status_code == 200, r.text
    r = client.post("/api/crop/auto", json={"folder": f, "mode": "landscape"})
    assert r.status_code == 200, r.text
    r = client.post("/api/prompt/jobs", json={"text": "a cat", "model": "lmstudio:x"})
    assert r.status_code == 200, r.text


def test_job_without_flag_counts_as_busy(client):
    server.JOBS["j"] = {"state": "processing"}
    assert _start(client, "upscale").status_code == 409


def test_thread_start_failure_is_500_and_frees_the_guard(client, monkeypatch):
    class DeadThread:
        def __init__(self, *a, **kw):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    with monkeypatch.context() as m:
        m.setattr(server, "threading",
                  types.SimpleNamespace(Thread=DeadThread, Lock=server.threading.Lock))
        r = _start(client, "upscale")
    assert r.status_code == 500
    assert "Could not start the job" in r.json()["detail"]
    (job,) = server.JOBS.values()
    assert job["state"] == "error"
    assert _start(client, "upscale").status_code == 200


class Boom(BaseException):
    pass


@pytest.mark.parametrize("runner", ["_run_job", "_run_crop_auto", "_run_upscale_job"])
def test_runners_catch_base_exception(tmp_path, monkeypatch, runner):
    # The conftest-free fixture above stubs the runners; use the real ones here.
    src = tmp_path / "a.png"
    Image.new("RGB", (10, 10)).save(src)

    def boom(*a, **kw):
        raise Boom()

    monkeypatch.setattr(server, "JOBS", {})
    monkeypatch.setattr(server, "_ensure_model", boom)
    monkeypatch.setattr(server.upscaler, "resolve", lambda *a, **kw: {"id": "x"})
    job = {"id": "j", "state": "pending", "total": 1, "processed": 0, "current": "",
           "error": "", "results": [], "crops": {}, "skipped": []}
    server.JOBS["j"] = job
    if runner == "_run_job":
        args = (server.ProcessRequest(folder=str(tmp_path)),)
    elif runner == "_run_crop_auto":
        args = (server.CropAutoRequest(folder=str(tmp_path), mode="person"),)
    else:
        args = (server.UpscaleRunRequest(folder=str(tmp_path), model_id="x"),)
    kw = {"resolved": ("cpu", "CPU")} if runner == "_run_upscale_job" else {}
    getattr(server, runner)("j", args[0], [src], **kw)
    assert job["state"] == "error"
