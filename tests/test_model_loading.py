"""Models load through the model manager (server._ensure_model).

No test touches the network or loads a real model: the fixture stubs both
network seams of model_store (``_remote_size`` and ``_fetch``) and every HF
cache lookup, and points the server's config files at tmp_path. Tests that
download for real (fake ``_fetch``) set ``models_dir`` through settings.update.
"""
from __future__ import annotations

import asyncio
import io
import re
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image
from starlette.datastructures import Headers, UploadFile

from backend import captioner, florence, gpu, server, settings, upscaler
from backend import model_store as ms

ROOT = Path(__file__).resolve().parent.parent
QWEN7 = "Qwen/Qwen2.5-VL-7B-Instruct"
X4 = "realesrgan-x4"
X4_LABEL = "Real-ESRGAN x4 (photos, general)"
NO_FOLDER = "No models folder chosen — set one in Settings (Models folder)."


def _no_network(entry, target_dir, token, progress):
    raise AssertionError("_fetch must be stubbed in this test")


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "UPSCALER_CONFIG_PATH", tmp_path / "upscaler.json")
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "custom_models.json")
    monkeypatch.setattr(server, "HF_TOKEN_PATH", tmp_path / "hf.json")
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


def _upload_png():
    buf = io.BytesIO()
    Image.new("RGB", (80, 60), "red").save(buf, format="PNG")
    buf.seek(0)
    return UploadFile(buf, filename="t.png", headers=Headers({"content-type": "image/png"}))


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
    path = server._ensure_model(X4, job)
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
    server._ensure_model(X4, job)
    assert job["current"] == f"Downloading {X4_LABEL}… 2.5 GB"


def test_ensure_model_without_folder_raises_models_folder_not_set():
    with pytest.raises(ms.ModelsFolderNotSet, match=f"^{re.escape(NO_FOLDER)}$"):
        server._ensure_model(QWEN7, None)
    assert ms.DOWNLOADS == {}


def test_ensure_model_unknown_id_is_readable():
    with pytest.raises(RuntimeError, match=r"^Unknown model: nope/nope$"):
        server._ensure_model("nope/nope", {"current": ""})


def test_ensure_model_returns_existing_local_path_without_download(tmp_path):
    f = tmp_path / "x.pth"
    f.write_bytes(b"w")
    upscaler.save_config(server.UPSCALER_CONFIG_PATH, {"folder": str(tmp_path), "custom": []})
    assert server._ensure_model(f"local:{f}", None) == str(f)
    assert server._ensure_model(str(tmp_path / "my-vlm"), None) == str(tmp_path / "my-vlm")


# --------------------------------------------------------------------------- #
# Captioner and Florence load from the resolved folder
# --------------------------------------------------------------------------- #
class _FakeModel:
    dtype = None

    def eval(self):
        return self

    def to(self, *a, **kw):
        return self


def test_captioner_passes_source_to_from_pretrained(monkeypatch):
    import transformers

    seen = []

    def fake_model(name, **kw):
        seen.append(("model", name))
        return _FakeModel()

    def fake_processor(name, **kw):
        seen.append(("processor", name))
        return object()

    monkeypatch.setattr(transformers.Qwen2_5_VLForConditionalGeneration, "from_pretrained",
                        fake_model)
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained", fake_processor)
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(captioner, "_state", {"model": None, "processor": None, "key": None})

    captioner.ensure_loaded(QWEN7, "none", source="/models/Qwen--Qwen2.5-VL-7B-Instruct")
    assert seen == [("model", "/models/Qwen--Qwen2.5-VL-7B-Instruct"),
                    ("processor", "/models/Qwen--Qwen2.5-VL-7B-Instruct")]
    assert captioner._state["key"] == (QWEN7, "none")

    seen.clear()
    captioner.ensure_loaded("Qwen/Qwen2.5-VL-3B-Instruct", "none")
    assert seen == [("model", "Qwen/Qwen2.5-VL-3B-Instruct"),
                    ("processor", "Qwen/Qwen2.5-VL-3B-Instruct")]


def test_florence_loads_from_source_resolver(monkeypatch):
    import transformers

    seen = []
    monkeypatch.setattr(transformers.Florence2ForConditionalGeneration, "from_pretrained",
                        lambda name, **kw: seen.append(name) or _FakeModel())
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained",
                        lambda name, **kw: seen.append(name) or object())
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(florence, "_RUNTIME", None)
    monkeypatch.setattr(florence, "SOURCE_RESOLVER", lambda: "/models/florence")
    florence._get_runtime()
    assert seen == ["/models/florence", "/models/florence"]


def test_server_wires_florence_resolver_to_ensure_model(monkeypatch):
    calls = []
    monkeypatch.setattr(server, "_ensure_model",
                        lambda model_id, job: calls.append((model_id, job)) or "/m/flo")
    assert florence.SOURCE_RESOLVER() == "/m/flo"
    assert calls == [(florence.DEFAULT_MODEL, None)]


def test_dataset_job_loads_vlm_from_resolved_path(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WORK", tmp_path / "work")
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    calls = []
    monkeypatch.setattr(server, "_ensure_model",
                        lambda model_id, job: calls.append(model_id) or "/m/qwen7")
    loaded = []
    monkeypatch.setattr(server.captioner, "ensure_loaded",
                        lambda m, q, source=None: loaded.append((m, q, source)))
    monkeypatch.setattr(server.captioner, "caption_image", lambda *a, **kw: "a caption")
    job_id = "test-model-loading-dataset"
    server.JOBS[job_id] = {"id": job_id, "kind": "dataset", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "config": {},
                           "results": []}
    try:
        req = server.ProcessRequest(folder=str(src), model=QWEN7, quant="4bit")
        server._run_job(job_id, req, [src / "a.png"])
        job = server.JOBS[job_id]
        assert job["state"] == "done", job["error"]
        assert calls == [QWEN7]
        assert loaded == [(QWEN7, "4bit", "/m/qwen7")]
        assert job["results"][0]["caption"] == "a caption"
    finally:
        del server.JOBS[job_id]


# --------------------------------------------------------------------------- #
# Upscalers get the resolved weights path
# --------------------------------------------------------------------------- #
def test_upscale_job_uses_resolved_path(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WORK", tmp_path / "work")
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    ensured = []
    monkeypatch.setattr(server, "_ensure_model",
                        lambda model_id, job: ensured.append(model_id) or "/m/x4.pth")
    paths = []

    def fake_upscale(img, entry, passes, token=""):
        paths.append(entry["path"])
        return img.resize((img.width * 4, img.height * 4))

    monkeypatch.setattr(server.upscaler, "upscale", fake_upscale)
    job_id = "test-model-loading-upscale"
    server.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "results": []}
    try:
        req = server.UpscaleRunRequest(folder=str(src), model_id=X4)
        server._run_upscale_job(job_id, req, [src / "a.png"])
        job = server.JOBS[job_id]
        assert job["state"] == "done", job["error"]
        assert job["results"][0]["error"] == ""
        assert ensured == [X4]
        assert paths == ["/m/x4.pth"]
    finally:
        del server.JOBS[job_id]


def test_upscale_job_without_folder_fails_with_readable_error(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WORK", tmp_path / "work")
    monkeypatch.setattr(server.upscaler, "upscale",
                        lambda *a, **kw: pytest.fail("must not upscale without weights"))
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    job_id = "test-model-loading-upscale-nofolder"
    server.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending", "total": 1,
                           "processed": 0, "current": "", "error": "", "results": []}
    try:
        server._run_upscale_job(job_id, server.UpscaleRunRequest(folder=str(src), model_id=X4),
                                [src / "a.png"])
        job = server.JOBS[job_id]
        assert job["state"] == "error"
        assert job["error"].startswith(NO_FOLDER)
    finally:
        del server.JOBS[job_id]


def test_dataset_upscale_hook_uses_resolved_path(monkeypatch):
    job = {"current": ""}
    ensured = []
    monkeypatch.setattr(server, "_ensure_model",
                        lambda model_id, j: ensured.append((model_id, j)) or "/m/x4.pth")
    paths = []
    monkeypatch.setattr(server.upscaler, "upscale",
                        lambda img, entry, passes, token="": paths.append(entry["path"]) or img)
    entry = {"id": X4, "scale": 4}
    hook = server._UpscaleHook(entry, min_ratio=1.05, job=job)
    hook(Image.new("RGB", (100, 100)), (400, 400))
    assert paths == ["/m/x4.pth"] and hook.used
    assert ensured[0][0] == X4 and ensured[0][1] is job
    assert "path" not in entry  # the registry entry itself is left alone

    def no_folder(model_id, j):
        raise ms.ModelsFolderNotSet()

    monkeypatch.setattr(server, "_ensure_model", no_folder)
    hook.reset()
    img = Image.new("RGB", (100, 100))
    assert hook(img, (400, 400)) is img  # degrades to plain resizing
    assert hook.error == NO_FOLDER and not hook.used


def test_legacy_upscale_download_without_folder_400(monkeypatch):
    monkeypatch.setattr(server.upscaler, "weights_path",
                        lambda *a, **kw: pytest.fail("must not download into the HF cache"))
    with pytest.raises(HTTPException) as exc:
        server.api_upscale_download(server.UpscaleDownloadRequest(model_id=X4))
    assert exc.value.status_code == 400
    assert exc.value.detail == NO_FOLDER


def test_legacy_upscale_download_goes_to_models_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(server.upscaler, "weights_path",
                        lambda *a, **kw: pytest.fail("must not download into the HF cache"))
    md = tmp_path / "models"
    _set_models_dir(md)

    def fetch(entry, target_dir, token, progress):
        f = target_dir / entry["filename"]
        f.write_bytes(b"w")
        return f

    monkeypatch.setattr(ms, "_fetch", fetch)
    out = server.api_upscale_download(server.UpscaleDownloadRequest(model_id=X4))
    assert out["ok"] is True
    assert out["path"] == str(md / "ai-forever--Real-ESRGAN" / "RealESRGAN_x4.pth")
    row = next(m for m in out["models"] if m["id"] == X4)
    assert row["cached"] is True


def test_upscale_models_cached_flag_uses_model_store(tmp_path):
    md = tmp_path / "models"
    f = md / "ai-forever--Real-ESRGAN" / "RealESRGAN_x4.pth"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"w")
    _set_models_dir(md)
    models = {m["id"]: m for m in server.api_upscale_models()["models"]}
    assert models[X4]["cached"] is True
    assert models["realesrgan-x2"]["cached"] is False


# --------------------------------------------------------------------------- #
# Florence users: auto-crop job and image analysis
# --------------------------------------------------------------------------- #
def test_crop_auto_job_needs_florence_only_when_it_detects(tmp_path, monkeypatch):
    src = tmp_path / "src"
    src.mkdir()
    _png(src / "a.png")
    monkeypatch.setattr(server.crop_auto, "suggest_crop", lambda *a, **kw: None)

    def run(mode: str) -> dict:
        job_id = f"test-model-loading-crop-{mode}"
        server.JOBS[job_id] = {"id": job_id, "kind": "crop_auto", "state": "pending",
                               "total": 1, "processed": 0, "current": "", "error": "",
                               "crops": {}, "skipped": []}
        try:
            server._run_crop_auto(job_id, server.CropAutoRequest(folder=str(src), mode=mode),
                                  [src / "a.png"])
            return dict(server.JOBS[job_id])
        finally:
            del server.JOBS[job_id]

    job = run("person")
    assert job["state"] == "error"
    assert job["error"].startswith(NO_FOLDER)
    assert run("landscape")["state"] == "done"  # no detection, so no Florence needed


def test_analyze_without_models_folder_answers_400(monkeypatch):
    monkeypatch.setattr(server.florence, "analyze_image",
                        lambda img: ("A scene.", []))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.api_ideogram_analyze(_upload_png()))
    assert exc.value.status_code == 400
    assert exc.value.detail == NO_FOLDER


def test_prompt_maps_model_errors_to_http(tmp_path, monkeypatch):
    monkeypatch.setattr(server.captioner, "ensure_loaded", lambda m, q, source=None: None)
    monkeypatch.setattr(server.captioner, "generate_text", lambda *a, **kw: "a prompt")
    monkeypatch.setattr(server, "_save_prompt_to_library", lambda *a: 1)

    def status(model: str) -> tuple[int, str]:
        with pytest.raises(HTTPException) as exc:
            server.api_prompt(server.PromptRequest(text="a cat", model=model))
        return exc.value.status_code, exc.value.detail

    assert status(QWEN7) == (400, NO_FOLDER)
    assert status("nope/nope") == (400, "Unknown model: nope/nope")

    _set_models_dir(tmp_path / "models")

    def broken(entry, target_dir, token, progress):
        raise RuntimeError("Hub unreachable")

    monkeypatch.setattr(ms, "_fetch", broken)
    assert status(QWEN7) == (502, "Hub unreachable")


# --------------------------------------------------------------------------- #
# run.sh
# --------------------------------------------------------------------------- #
def test_run_sh_has_no_hardcoded_hf_home():
    text = (ROOT / "run.sh").read_text(encoding="utf-8")
    assert "/mnt/intel" not in text
    assert "export HF_HOME" not in text
    assert "Models folder: set it in the app (Settings → Models folder)" in text
