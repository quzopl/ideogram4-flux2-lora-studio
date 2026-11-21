"""Per-role GPU assignment: the VLM, Florence-2 and the upscaler each get a card."""
import subprocess

import pytest
from fastapi.testclient import TestClient

from backend import captioner, florence, gpu, server, settings

DEVICES = [
    {"index": 0, "uuid": "GPU-4070", "name": "NVIDIA GeForce RTX 4070 Ti",
     "total_bytes": 12 << 30, "pci_bus": 1},
    {"index": 1, "uuid": "GPU-5080", "name": "NVIDIA GeForce RTX 5080",
     "total_bytes": 16 << 30, "pci_bus": 2},
]
SMI_CMD = ["nvidia-smi", "--query-gpu=uuid,memory.used,memory.total",
           "--format=csv,noheader,nounits"]

client = TestClient(server.app)


@pytest.fixture
def fake_gpus(tmp_path, monkeypatch):
    """Two fake cards, no nvidia-smi, no real models; records which roles get released."""
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "smi_stats", lambda: {})
    # .work/gpu.json exists on the dev box; settings would migrate its UUID.
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    unloaded = []
    monkeypatch.setattr(server.captioner, "unload", lambda: unloaded.append("vlm"))
    monkeypatch.setattr(server.florence, "unload", lambda: unloaded.append("florence"))
    monkeypatch.setattr(server.upscaler, "unload", lambda: unloaded.append("upscale"))
    monkeypatch.setattr(server.captioner, "gpu_status", lambda: {
        "loaded": False, "model": None, "quant": None, "cuda": True})
    monkeypatch.setattr(server, "JOBS", {})
    return unloaded


class _FakeModel:
    def eval(self):
        return self

    def to(self, *a, **kw):
        return self


# --------------------------------------------------------------------------- #
# gpu.device_for
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("value, devices, expected", [
    ("auto", DEVICES, "cuda:1"),       # most memory: the 5080
    ("cpu", DEVICES, "cpu"),
    ("GPU-4070", DEVICES, "cuda:0"),
    ("GPU-gone", DEVICES, "cuda:1"),   # card pulled out -> default, no error
    ("GPU-5080", [], "cpu"),           # no CUDA at all
])
def test_device_for_cases(value, devices, expected):
    assert gpu.device_for("vlm", {"gpu": {"vlm": value}}, devices) == expected


# --------------------------------------------------------------------------- #
# /api/gpu/assign and the legacy /api/gpu/select
# --------------------------------------------------------------------------- #
def test_assign_unloads_only_that_role(fake_gpus):
    r = client.post("/api/gpu/assign", json={"role": "upscale", "device": "GPU-4070"})
    assert r.status_code == 200
    assert fake_gpus == ["upscale"]
    assert settings.load()["gpu"] == {"vlm": "auto", "florence": "auto",
                                      "upscale": "GPU-4070"}
    assert gpu.device_for("upscale") == "cuda:0"
    assert gpu.device_for("vlm") == "cuda:1"
    assert "cards" in r.json()


def test_assign_rejects_unknown_role_and_device(fake_gpus):
    r = client.post("/api/gpu/assign", json={"role": "tts", "device": "auto"})
    assert r.status_code == 400
    assert r.json()["detail"] == "Unknown role."
    r = client.post("/api/gpu/assign", json={"role": "vlm", "device": "GPU-gone"})
    assert r.status_code == 400
    assert r.json()["detail"] == "Unknown GPU."
    assert fake_gpus == []
    assert not settings.CONFIG_PATH.exists()


def test_assign_409_when_busy(fake_gpus, monkeypatch):
    monkeypatch.setattr(server, "JOBS", {"j": {"state": "processing"}})
    r = client.post("/api/gpu/assign", json={"role": "vlm", "device": "cpu"})
    assert r.status_code == 409
    assert fake_gpus == []
    assert settings.load()["gpu"]["vlm"] == "auto"


def test_legacy_select_sets_all_roles(fake_gpus):
    # A settings file exists, so the gpu.json migration cannot do the work.
    settings.update(lambda d: d["gpu"].update(vlm="cpu", florence="GPU-5080"))
    r = client.post("/api/gpu/select", json={"uuid": "GPU-4070"})
    assert r.status_code == 200
    assert settings.load()["gpu"] == {role: "GPU-4070" for role in settings.ROLES}
    assert gpu.load_selected(gpu.CONFIG_PATH) == "GPU-4070"
    assert sorted(fake_gpus) == ["florence", "upscale", "vlm"]


# --------------------------------------------------------------------------- #
# Models follow their role's card
# --------------------------------------------------------------------------- #
def test_captioner_reloads_when_vlm_device_changes(fake_gpus, monkeypatch):
    import transformers

    loads = []
    monkeypatch.setattr(transformers.Qwen2_5_VLForConditionalGeneration, "from_pretrained",
                        lambda name, **kw: loads.append(kw.get("device_map")) or _FakeModel())
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained", lambda name, **kw: object())
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(captioner, "_state", {"model": None, "processor": None, "key": None})
    model = "Qwen/Qwen2.5-VL-3B-Instruct"

    captioner.ensure_loaded(model, "none")
    captioner.ensure_loaded(model, "none")              # same card: cached
    first = captioner._state["key"]
    settings.update(lambda d: d["gpu"].__setitem__("vlm", "GPU-4070"))
    captioner.ensure_loaded(model, "none")

    assert first == (model, "none", "cuda:1")
    assert captioner._state["key"] == (model, "none", "cuda:0")
    assert loads == ["cuda:1", "cuda:0"]


def test_florence_reloads_when_its_device_changes(fake_gpus, monkeypatch):
    import transformers

    loads = []
    monkeypatch.setattr(transformers.Florence2ForConditionalGeneration, "from_pretrained",
                        lambda name, **kw: loads.append(name) or _FakeModel())
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained", lambda name, **kw: object())
    monkeypatch.setattr(gpu, "empty_cache", lambda: None)
    monkeypatch.setattr(florence, "_RUNTIME", None)
    monkeypatch.setattr(florence, "SOURCE_RESOLVER", lambda: "/models/florence")

    assert florence._get_runtime()["device"] == "cuda:1"
    florence._get_runtime()                              # same card: cached
    settings.update(lambda d: d["gpu"].__setitem__("florence", "cpu"))
    assert florence._get_runtime()["device"] == "cpu"
    assert loads == ["/models/florence", "/models/florence"]


# --------------------------------------------------------------------------- #
# VRAM from nvidia-smi, never from torch
# --------------------------------------------------------------------------- #
def test_smi_stats_parses_and_normalizes_uuid(monkeypatch):
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, 0, stderr="", stdout=(
            "GPU-1E5C6BFF-8a60-c4d2, 13728, 16303\n"
            "GPU-e3ae12d5-a556-7282, 259, 12282\n"))

    monkeypatch.setattr(gpu.subprocess, "run", fake_run)
    assert gpu.smi_stats() == {"1e5c6bff-8a60-c4d2": (13.41, 15.92),
                               "e3ae12d5-a556-7282": (0.25, 11.99)}
    cmd, kw = calls[0]
    assert cmd == SMI_CMD
    assert kw["timeout"] == 3


@pytest.mark.parametrize("error", [FileNotFoundError("nvidia-smi"),
                                   subprocess.TimeoutExpired(SMI_CMD, 3)])
def test_smi_stats_missing_binary_returns_empty(monkeypatch, error):
    def fail(*a, **kw):
        raise error

    monkeypatch.setattr(gpu.subprocess, "run", fail)
    assert gpu.smi_stats() == {}


def test_gpus_endpoint_never_calls_torch_mem_get_info(tmp_path, monkeypatch):
    # mem_get_info(i) opens a ~200 MB CUDA context on card i; the v2 topbar
    # polls these endpoints every 2 s.
    import torch

    def boom(*a, **kw):
        raise AssertionError("torch.cuda.mem_get_info must not be called")

    monkeypatch.setattr(torch.cuda, "mem_get_info", boom)
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    monkeypatch.setattr(gpu.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(
        cmd, 0, stderr="", stdout="GPU-4070, 259, 12282\nGPU-5080, 13728, 16303\n"))
    assert client.get("/api/gpus").status_code == 200
    r = client.get("/api/gpu")
    assert r.status_code == 200
    assert (r.json()["vram_used_gb"], r.json()["vram_total_gb"]) == (13.41, 15.92)


def test_gpus_reports_roles_vram_and_loaded_per_card(fake_gpus, monkeypatch):
    monkeypatch.setattr(gpu, "smi_stats", lambda: {"4070": (0.25, 11.99)})  # 5080 unreported
    settings.update(lambda d: d["gpu"].update(vlm="GPU-4070", florence="cpu"))
    monkeypatch.setattr(captioner, "_state", {"model": object(), "processor": object(),
                                              "key": ("m", "none", "cuda:0")})

    out = client.get("/api/gpus").json()
    assert out["roles"] == {"vlm": "GPU-4070", "florence": "cpu", "upscale": "auto"}
    assert out["selected"] == "GPU-4070"
    ti, big = out["gpus"]                               # PCI order
    assert (ti["uuid"], ti["roles"], ti["loaded"]) == ("GPU-4070", ["vlm"], ["vlm"])
    assert (ti["vram_used_gb"], ti["vram_total_gb"], ti["selected"]) == (0.25, 11.99, True)
    assert (big["uuid"], big["roles"], big["loaded"]) == ("GPU-5080", ["upscale"], [])
    assert (big["vram_used_gb"], big["vram_total_gb"], big["selected"]) == (None, None, False)

    st = client.get("/api/gpu").json()
    assert st["cards"] == out["gpus"]
    assert st["gpu_label"] == "RTX 4070 Ti · 12 GB"
    assert (st["vram_used_gb"], st["vram_total_gb"]) == (0.25, 11.99)

    settings.update(lambda d: d["gpu"].__setitem__("vlm", "cpu"))
    st = client.get("/api/gpu").json()
    assert st["gpu_label"] == ""
    assert "vram_total_gb" not in st
