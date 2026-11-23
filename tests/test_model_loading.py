"""Models load through the model manager (core._ensure_model).

No test touches the network or loads a real model: the fixture stubs both
network seams of model_store (``_remote_size`` and ``_fetch``) and every HF
cache lookup, and points the server's config files at tmp_path. Tests that
download for real (fake ``_fetch``) set ``models_dir`` through settings.update.
"""
from __future__ import annotations

import io
import re
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from backend import (api_dataset, api_prompts, api_upscale, captioner, core, crop_auto, florence,
                     gpu, server, settings, upscaler)
from backend import model_store as ms
from tests.conftest import ML_MODULES

pytestmark = pytest.mark.usefixtures("ml_modules_at_start")

ROOT = Path(__file__).resolve().parent.parent
QWEN7 = "Qwen/Qwen2.5-VL-7B-Instruct"
X4 = "realesrgan-x4"
X4_LABEL = "Real-ESRGAN x4 (photos, general)"
NO_FOLDER = "No models folder chosen — set one in Settings (Models folder)."


def _no_network(entry, target_dir, token, progress):
    raise AssertionError("_fetch must be stubbed in this test")


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "UPSCALER_CONFIG_PATH", tmp_path / "upscaler.json")
    monkeypatch.setattr(core, "CUSTOM_MODELS_PATH", tmp_path / "custom_models.json")
    monkeypatch.setattr(core, "HF_TOKEN_PATH", tmp_path / "hf.json")
    monkeypatch.setattr(ms, "_hf_snapshot_path", lambda repo_id: None)
    monkeypatch.setattr(ms, "_hf_file_path", lambda repo_id, filename: None)
    monkeypatch.setattr(upscaler, "_hf_cached", lambda repo_id, filename: False)
    monkeypatch.setattr(ms, "_remote_size", lambda entry, token: None)
    monkeypatch.setattr(ms, "_fetch", _no_network)
    ms.DOWNLOADS.clear()
    yield
    for t in threading.enumerate():
        if t.name.startswith("download-"):
            t.join(5)
    ms.DOWNLOADS.clear()


def _set_models_dir(path: Path) -> None:
    settings.update(lambda d: d.__setitem__("models_dir", str(path)))


class _Job(dict):
    """A job dict that remembers every value written to "current"."""

    def __init__(self, on_current=None):
        super().__init__(current="")
        self.history: list[str] = []
        self._on_current = on_current

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key == "current":
            self.history.append(value)
            if self._on_current:
                self._on_current(value)


def _png(path: Path, size=(64, 48)) -> Path:
    Image.new("RGB", size, "red").save(path, format="PNG")
    return path


# --------------------------------------------------------------------------- #
# _ensure_model
# --------------------------------------------------------------------------- #
def test_ensure_model_reports_download_progress_in_job(tmp_path, monkeypatch):
    md = tmp_path / "models"
    _set_models_dir(md)
    monkeypatch.setattr(ms, "_remote_size", lambda entry, token: 100)
    half_seen = threading.Event()

    def fetch(entry, target_dir, token, progress):
        progress(50, 0)
        half_seen.wait(5)
        f = target_dir / entry["filename"]
        f.write_bytes(b"w")
        return f

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = _Job(on_current=lambda v: v.endswith("50%") and half_seen.set())
    path = core._ensure_model(X4, job)
    assert path == str(md / "ai-forever--Real-ESRGAN" / "RealESRGAN_x4.pth")
    assert f"Downloading {X4_LABEL}… 50%" in job.history
    assert "Downloading" in job["current"] and "%" in job["current"]
    assert job["current"] == f"Downloading {X4_LABEL}… 100%"


def test_ensure_model_reports_gigabytes_when_size_unknown(tmp_path, monkeypatch):
    _set_models_dir(tmp_path / "models")

    def fetch(entry, target_dir, token, progress):
        progress(2_500_000_000, 0)
        f = target_dir / entry["filename"]
        f.write_bytes(b"w")
        return f

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = _Job()
    core._ensure_model(X4, job)
    assert job["current"] == f"Downloading {X4_LABEL}… 2.5 GB"


def test_ensure_model_without_folder_raises_models_folder_not_set():
    with pytest.raises(ms.ModelsFolderNotSet, match=f"^{re.escape(NO_FOLDER)}$"):
        core._ensure_model(QWEN7, None)
    assert ms.DOWNLOADS == {}


def test_ensure_model_unknown_id_is_readable():
    with pytest.raises(RuntimeError, match=r"^Unknown model: nope/nope$"):
        core._ensure_model("nope/nope", {"current": ""})


def test_ensure_model_returns_existing_local_path_without_download(tmp_path):
    f = tmp_path / "x.pth"
    f.write_bytes(b"w")
    upscaler.save_config(core.UPSCALER_CONFIG_PATH, {"folder": str(tmp_path), "custom": []})
    assert core._ensure_model(f"local:{f}", None) == str(f)
    assert core._ensure_model(str(tmp_path / "my-vlm"), None) == str(tmp_path / "my-vlm")


# --------------------------------------------------------------------------- #
# Captioner and Florence load from the resolved folder
# --------------------------------------------------------------------------- #
class _FakeModel:
    dtype = None

    def eval(self):
        return self

    def to(self, *a, **kw):
        return self


def test_captioner_passes_source_to_from_pretrained(monkeypatch, fake_ml):
    transformers = fake_ml.transformers

    seen = []

    def fake_model(name, **kw):
        seen.append(("model", name))
        return _FakeModel()

    def fake_processor(name, **kw):
        seen.append(("processor", name))
        return object()

    transformers.Qwen2_5_VLForConditionalGeneration = SimpleNamespace(from_pretrained=fake_model)
    transformers.AutoProcessor = SimpleNamespace(from_pretrained=fake_processor)
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(captioner, "_state", {"model": None, "processor": None, "key": None})

    captioner.ensure_loaded(QWEN7, "none", source="/models/Qwen--Qwen2.5-VL-7B-Instruct")
    assert seen == [("model", "/models/Qwen--Qwen2.5-VL-7B-Instruct"),
                    ("processor", "/models/Qwen--Qwen2.5-VL-7B-Instruct")]
    assert captioner._state["key"] == (QWEN7, "none", "cpu")

    seen.clear()
    captioner.ensure_loaded("Qwen/Qwen2.5-VL-3B-Instruct", "none")
    assert seen == [("model", "Qwen/Qwen2.5-VL-3B-Instruct"),
                    ("processor", "Qwen/Qwen2.5-VL-3B-Instruct")]


def test_captioner_failed_swap_forgets_the_old_model(monkeypatch, fake_ml):
    loads = []

    def fake_model(name, **kw):
        loads.append(name)
        if name == "/m/broken":
            raise OSError("no weights in /m/broken")
        return _FakeModel()

    fake_ml.transformers.Qwen2_5_VLForConditionalGeneration = SimpleNamespace(
        from_pretrained=fake_model)
    fake_ml.transformers.AutoProcessor = SimpleNamespace(from_pretrained=lambda name, **kw: object())
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(captioner, "_state", {"model": None, "processor": None, "key": None})

    captioner.ensure_loaded(QWEN7, "none", source="/m/qwen7")
    with pytest.raises(OSError, match="no weights"):
        captioner.ensure_loaded("Qwen/Qwen2.5-VL-3B-Instruct", "none", source="/m/broken")
    # The old model was released for the swap, so nothing may claim it is loaded.
    assert captioner._state["key"] is None
    assert not captioner.is_loaded() and captioner.loaded_device() == ""
    captioner.ensure_loaded(QWEN7, "none", source="/m/qwen7")
    assert loads == ["/m/qwen7", "/m/broken", "/m/qwen7"]
    assert captioner.is_loaded() and captioner._state["key"] == (QWEN7, "none", "cpu")


def test_florence_loads_from_source_resolver(monkeypatch, fake_ml):
    transformers = fake_ml.transformers

    seen = []
    transformers.Florence2ForConditionalGeneration = SimpleNamespace(
        from_pretrained=lambda name, **kw: seen.append(name) or _FakeModel())
    transformers.AutoProcessor = SimpleNamespace(
        from_pretrained=lambda name, **kw: seen.append(name) or object())
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(florence, "_RUNTIME", None)
    monkeypatch.setattr(florence, "SOURCE_RESOLVER", lambda: "/models/florence")
    florence._get_runtime()
    assert seen == ["/models/florence", "/models/florence"]


def test_server_wires_florence_resolver_to_ensure_model(monkeypatch):
    calls = []
    monkeypatch.setattr(core, "_ensure_model",
                        lambda model_id, job: calls.append((model_id, job)) or "/m/flo")
    assert florence.SOURCE_RESOLVER() == "/m/flo"
    assert calls == [(florence.DEFAULT_MODEL, None)]


def test_dataset_job_loads_vlm_from_resolved_path(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "WORK", tmp_path / "work")
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    calls = []
    monkeypatch.setattr(core, "_ensure_model",
                        lambda model_id, job: calls.append(model_id) or "/m/qwen7")
    loaded = []
    monkeypatch.setattr(captioner, "ensure_loaded",
                        lambda m, q, source=None: loaded.append((m, q, source)))
    monkeypatch.setattr(captioner, "caption_image", lambda *a, **kw: "a caption")
    job_id = "test-model-loading-dataset"
    core.JOBS[job_id] = {"id": job_id, "kind": "dataset", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "config": {},
                           "results": []}
    try:
        req = api_dataset.ProcessRequest(folder=str(src), model=QWEN7, quant="4bit")
        api_dataset._run_job(job_id, req, [src / "a.png"])
        job = core.JOBS[job_id]
        assert job["state"] == "done", job["error"]
        assert calls == [QWEN7]
        assert loaded == [(QWEN7, "4bit", "/m/qwen7")]
        assert job["results"][0]["caption"] == "a caption"
    finally:
        del core.JOBS[job_id]


# --------------------------------------------------------------------------- #
# Upscalers get the resolved weights path
# --------------------------------------------------------------------------- #
def test_upscale_job_uses_resolved_path(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "WORK", tmp_path / "work")
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    ensured = []
    monkeypatch.setattr(core, "_ensure_model",
                        lambda model_id, job: ensured.append(model_id) or "/m/x4.pth")
    paths = []

    def fake_upscale(img, entry, passes, token="", device=None):
        paths.append(entry["path"])
        return img.resize((img.width * 4, img.height * 4))

    monkeypatch.setattr(upscaler, "upscale", fake_upscale)
    monkeypatch.setattr(api_upscale, "_resolve_device", lambda v: ("cpu", "CPU"))
    job_id = "test-model-loading-upscale"
    core.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "results": []}
    try:
        req = api_upscale.UpscaleRunRequest(folder=str(src), model_id=X4)
        api_upscale._run_upscale_job(job_id, req, [src / "a.png"])
        job = core.JOBS[job_id]
        assert job["state"] == "done", job["error"]
        assert job["results"][0]["error"] == ""
        assert ensured == [X4]
        assert paths == ["/m/x4.pth"]
    finally:
        del core.JOBS[job_id]


def test_upscale_job_without_folder_fails_with_readable_error(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "WORK", tmp_path / "work")
    monkeypatch.setattr(upscaler, "upscale",
                        lambda *a, **kw: pytest.fail("must not upscale without weights"))
    monkeypatch.setattr(api_upscale, "_resolve_device", lambda v: ("cpu", "CPU"))
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    job_id = "test-model-loading-upscale-nofolder"
    core.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "results": []}
    try:
        api_upscale._run_upscale_job(job_id, api_upscale.UpscaleRunRequest(folder=str(src), model_id=X4),
                                [src / "a.png"])
        job = core.JOBS[job_id]
        assert job["state"] == "error"
        assert job["error"].startswith(NO_FOLDER)
    finally:
        del core.JOBS[job_id]


def test_dataset_upscale_hook_uses_resolved_path(monkeypatch):
    job = {"current": ""}
    ensured = []
    monkeypatch.setattr(core, "_ensure_model",
                        lambda model_id, j: ensured.append((model_id, j)) or "/m/x4.pth")
    paths = []
    monkeypatch.setattr(upscaler, "upscale",
                        lambda img, entry, passes, token="": paths.append(entry["path"]) or img)
    entry = {"id": X4, "scale": 4}
    hook = api_dataset._UpscaleHook(entry, min_ratio=1.05, job=job)
    hook(Image.new("RGB", (100, 100)), (400, 400))
    assert paths == ["/m/x4.pth"] and hook.used
    assert ensured[0][0] == X4 and ensured[0][1] is job
    assert "path" not in entry  # the registry entry itself is left alone

    def no_folder(model_id, j):
        raise ms.ModelsFolderNotSet()

    monkeypatch.setattr(core, "_ensure_model", no_folder)
    hook.reset()
    img = Image.new("RGB", (100, 100))
    assert hook(img, (400, 400)) is img  # degrades to plain resizing
    assert hook.error == NO_FOLDER and not hook.used


def test_dataset_upscale_hook_remembers_a_failed_ensure(monkeypatch):
    calls = []

    def failing(model_id, j):
        calls.append(model_id)
        raise RuntimeError("Download cancelled.")

    monkeypatch.setattr(core, "_ensure_model", failing)
    monkeypatch.setattr(upscaler, "upscale",
                        lambda *a, **kw: pytest.fail("no weights, nothing to upscale with"))
    hook = api_dataset._UpscaleHook({"id": X4, "scale": 4}, min_ratio=1.05, job={})
    for _ in range(3):  # three images that all need upscaling
        hook.reset()    # as _run_job does before each image
        img = Image.new("RGB", (100, 100))
        assert hook(img, (400, 400)) is img
        assert hook.error == "Download cancelled." and not hook.used
    assert calls == [X4]  # one attempt, not one fetch (or restarted download) per image


# --------------------------------------------------------------------------- #
# Florence users: auto-crop job and image analysis
# --------------------------------------------------------------------------- #
def test_crop_auto_job_needs_florence_only_when_it_detects(tmp_path, monkeypatch):
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    monkeypatch.setattr(crop_auto, "suggest_crop", lambda *a, **kw: None)

    def run(mode: str) -> dict:
        job_id = f"test-model-loading-crop-{mode}"
        core.JOBS[job_id] = {"id": job_id, "kind": "crop_auto", "state": "pending",
                               "total": 1, "processed": 0, "current": "", "error": "",
                               "crops": {}, "skipped": []}
        try:
            api_dataset._run_crop_auto(job_id, api_dataset.CropAutoRequest(folder=str(src), mode=mode),
                                  [src / "a.png"])
            return dict(core.JOBS[job_id])
        finally:
            del core.JOBS[job_id]

    job = run("person")
    assert job["state"] == "error"
    assert job["error"].startswith(NO_FOLDER)
    assert run("landscape")["state"] == "done"  # no detection, so no Florence needed


def _await_job(client, route: str, job_id: str) -> dict:
    for _ in range(200):
        job = client.get(f"{route}/{job_id}").json()
        if job["state"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError("the job never finished")


def _analyze_png() -> dict:
    buf = io.BytesIO()
    Image.new("RGB", (80, 60), "red").save(buf, format="PNG")
    return {"file": ("t.png", buf.getvalue(), "image/png")}


def test_analyze_job_without_models_folder_fails_with_the_setup_text(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(florence, "analyze_image", lambda img: ("A scene.", []))
    with TestClient(server.app) as client:
        r = client.post("/api/ideogram/analyze/jobs", files=_analyze_png())
        assert r.status_code == 200, r.text
        job = _await_job(client, "/api/ideogram/analyze/jobs", r.json()["job_id"])
    assert job["state"] == "error"
    assert job["error"].split("\n")[0] == NO_FOLDER


def test_analyze_download_does_not_block_the_event_loop(monkeypatch):
    from fastapi.testclient import TestClient

    entered, release = threading.Event(), threading.Event()

    def slow_download(model_id, job):
        entered.set()
        release.wait(10)
        return "/m/florence"

    monkeypatch.setattr(core, "_ensure_model", slow_download)
    monkeypatch.setattr(florence, "analyze_image", lambda img: ("A scene.", []))
    route = "/api/ideogram/analyze/jobs"
    with TestClient(server.app) as client:  # one event loop serves every request
        try:
            r = client.post(route, files=_analyze_png())
            assert r.status_code == 200, r.text
            job_id = r.json()["job_id"]
            assert entered.wait(5)
            out = {}
            poll = threading.Thread(target=lambda: out.update(
                downloads=client.get("/api/store/downloads"),
                job=client.get(f"{route}/{job_id}")))
            poll.start()
            poll.join(2)
            assert "job" in out, "the event loop is blocked while the model downloads"
            assert out["downloads"].status_code == 200
            assert out["job"].status_code == 200 and out["job"].json()["state"] != "done"
        finally:
            release.set()
        job = _await_job(client, route, job_id)
    assert job["state"] == "done", job["error"]
    assert job["result"]["model"] == florence.DEFAULT_MODEL


def test_prompt_job_maps_model_errors_to_the_job_error(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(captioner, "ensure_loaded", lambda m, q, source=None: None)
    monkeypatch.setattr(captioner, "generate_text", lambda *a, **kw: "a prompt")
    monkeypatch.setattr(api_prompts, "_save_prompt_to_library", lambda *a: 1)

    with TestClient(server.app) as client:
        def error_of(model: str) -> str:
            r = client.post("/api/prompt/jobs", json={"text": "a cat", "model": model})
            assert r.status_code == 200, r.text
            job = _await_job(client, "/api/prompt/jobs", r.json()["job_id"])
            assert job["state"] == "error"
            return job["error"].split("\n")[0]

        assert error_of(QWEN7) == NO_FOLDER
        assert error_of("nope/nope") == "Unknown model: nope/nope"

        _set_models_dir(tmp_path / "models")

        def broken(entry, target_dir, token, progress):
            raise RuntimeError("Hub unreachable")

        monkeypatch.setattr(ms, "_fetch", broken)
        assert error_of(QWEN7) == "Hub unreachable"


def test_run_sh_has_no_hardcoded_hf_home():
    text = (ROOT / "run.sh").read_text(encoding="utf-8")
    assert "/mnt/intel" not in text
    assert "export HF_HOME" not in text
    assert "Models folder: set it in the app (Settings → Models folder)" in text


def test_dataset_upscale_hook_uses_real_scale_for_local_models(monkeypatch):
    monkeypatch.setattr(core, "_ensure_model", lambda model_id, j: "/m/local.pth")
    scales = []
    monkeypatch.setattr(upscaler, "model_scale",
                        lambda entry, token="", device=None: scales.append(entry["path"]) or 4)
    planned = []
    real_plan = upscaler.plan_passes
    monkeypatch.setattr(upscaler, "plan_passes",
                        lambda size, target, scale, *a, **kw:
                        planned.append(scale) or real_plan(size, target, scale, *a, **kw))
    monkeypatch.setattr(upscaler, "upscale", lambda img, entry, passes, token="": img)
    hook = api_dataset._UpscaleHook({"id": "local:/m/local.pth", "scale": 0}, min_ratio=1.05, job={})
    hook(Image.new("RGB", (100, 100)), (400, 400))
    assert planned == [2, 4]            # early check (guess), then the real scale
    hook(Image.new("RGB", (100, 100)), (400, 400))
    assert planned == [2, 4, 2, 4] and scales == ["/m/local.pth"]  # probed once, memoised
    assert hook.used and not hook.error


def test_dataset_upscale_hook_skips_model_when_no_pass_needed(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("must not touch the model")

    monkeypatch.setattr(core, "_ensure_model", boom)
    monkeypatch.setattr(upscaler, "model_scale", boom)
    for entry in ({"id": X4, "scale": 4}, {"id": "local:/m/x.pth", "scale": 0}):
        hook = api_dataset._UpscaleHook(entry, min_ratio=1.05, job={})
        img = Image.new("RGB", (1000, 1000))
        assert hook(img, (500, 500)) is img
        assert hook.error == "" and not hook.used


# --------------------------------------------------------------------------- #
# Keep last: guards the tests above
# --------------------------------------------------------------------------- #
def test_file_never_imports_real_torch_or_transformers(ml_modules_at_start):
    # Vacuous for a module an earlier file already imported (test_gpu.py loads torch).
    assert {m for m in ML_MODULES if m in sys.modules} <= ml_modules_at_start
