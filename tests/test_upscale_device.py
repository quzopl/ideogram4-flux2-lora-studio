import gc
import weakref

import pytest
from fastapi import HTTPException
from PIL import Image

from backend import gpu, server, upscaler

DEVICES = [
    {"index": 0, "uuid": "abc-4070", "name": "NVIDIA GeForce RTX 4070 Ti",
     "total_bytes": 12 * 2 ** 30, "pci_bus": 1},
    {"index": 1, "uuid": "def-5080", "name": "NVIDIA GeForce RTX 5080",
     "total_bytes": 16 * 2 ** 30, "pci_bus": 2},
]


class _Model:
    pass


@pytest.fixture
def fake_cards(monkeypatch):
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "device_for", lambda role, doc=None, devices=None: "cuda:1")
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(upscaler, "_RUNTIME", None)


def test_load_caches_per_model_and_device(fake_cards, monkeypatch):
    calls, refs = [], []

    def inst(path, device):
        m = _Model()
        refs.append(weakref.ref(m))
        calls.append((path, device))
        return {"model": m, "torch": None, "device": device, "dtype": None, "scale": 2}

    monkeypatch.setattr(upscaler, "_instantiate", inst)
    entry = {"id": "m", "path": "/m/x.pth"}
    upscaler._load(entry, "", "cuda:0")
    upscaler._load(entry, "", "cuda:0")
    assert len(calls) == 1
    upscaler._load(entry, "", "cuda:1")
    assert [c[1] for c in calls] == ["cuda:0", "cuda:1"]
    gc.collect()
    assert refs[0]() is None            # the previous runtime was released
    assert upscaler.loaded_key() == "m"
    upscaler._load(entry, "")           # None -> the upscale role's card (cuda:1)
    assert len(calls) == 2


def test_resolve_device_cases(fake_cards):
    assert server._resolve_device("") == ("cuda:1", "RTX 5080 · 16 GB")
    assert server._resolve_device("cpu") == ("cpu", "CPU")
    assert server._resolve_device("GPU-ABC-4070") == ("cuda:0", "RTX 4070 Ti · 12 GB")
    with pytest.raises(ValueError, match="Unknown GPU."):
        server._resolve_device("nope")


def test_resolve_device_role_on_cpu(fake_cards, monkeypatch):
    monkeypatch.setattr(gpu, "device_for", lambda role, doc=None, devices=None: "cpu")
    assert server._resolve_device("") == ("cpu", "CPU")


def test_run_with_unknown_gpu_400(fake_cards, tmp_path):
    (tmp_path / "a.png").write_bytes(b"x")
    req = server.UpscaleRunRequest(folder=str(tmp_path), model_id="m", device="nope")
    with pytest.raises(HTTPException) as exc:
        server.api_upscale_run(req)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Unknown GPU."


def test_job_reports_device_label(fake_cards, tmp_path, monkeypatch):
    src = tmp_path / "src"
    src.mkdir()
    Image.new("RGB", (100, 50), "red").save(src / "a.png")
    (src / "bad.png").write_bytes(b"not an image")
    monkeypatch.setattr(server, "WORK", tmp_path / "work")
    monkeypatch.setattr(server, "_ensure_model", lambda mid, job: "/fake")
    monkeypatch.setattr(upscaler, "resolve", lambda mid, cfg: {"id": "f", "scale": 2})
    monkeypatch.setattr(upscaler, "load_config", lambda p: {})
    seen = []
    monkeypatch.setattr(upscaler, "model_scale",
                        lambda e, token="", device=None: seen.append(device) or 2)
    monkeypatch.setattr(
        upscaler, "upscale",
        lambda img, e, passes, token="", device=None:
        seen.append(device) or img.resize((img.width * 2, img.height * 2)))
    job_id = "test-upscale-device-job"
    server.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending",
                           "total": 2, "processed": 0, "current": "", "error": "",
                           "config": {}, "results": []}
    try:
        req = server.UpscaleRunRequest(folder=str(src), model_id="m",
                                       device="def-5080")
        server._run_upscale_job(job_id, req, [src / "a.png", src / "bad.png"])
        job = server.JOBS[job_id]
        assert job["state"] == "done", job["error"]
        ok, bad = job["results"]
        assert ok["device"] == bad["device"] == "RTX 5080 · 16 GB"
        assert ok["passes"] == 1 and bad["passes"] == 0 and bad["error"]
        assert seen and set(seen) == {"cuda:1"}
    finally:
        del server.JOBS[job_id]
