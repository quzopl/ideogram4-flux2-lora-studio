import pytest
from fastapi import HTTPException

from backend import gpu, server


# Mirrors the real machine: torch enumerates the 4070 Ti first (FASTEST_FIRST),
# while the 5080 sits on the lower PCI bus.
TI = {"index": 0, "uuid": "uuid-4070ti", "name": "NVIDIA GeForce RTX 4070 Ti",
      "total_bytes": 12282 * 2 ** 20, "pci_bus": 9}
BIG = {"index": 1, "uuid": "uuid-5080", "name": "NVIDIA GeForce RTX 5080",
       "total_bytes": 16303 * 2 ** 20, "pci_bus": 1}
DEVICES = [TI, BIG]


def test_short_name_drops_vendor_prefix():
    assert gpu.short_name("NVIDIA GeForce RTX 5080") == "RTX 5080"
    assert gpu.short_name("NVIDIA RTX A6000") == "RTX A6000"
    assert gpu.short_name("Tesla T4") == "Tesla T4"


def test_label_shows_name_and_marketing_size():
    assert gpu.label(BIG, DEVICES) == "RTX 5080 · 16 GB"
    assert gpu.label(TI, DEVICES) == "RTX 4070 Ti · 12 GB"


def test_label_adds_pci_bus_when_names_collide():
    twin = dict(TI, index=2, uuid="uuid-twin", pci_bus=0x0A)
    devices = [TI, twin]
    assert gpu.label(TI, devices) == "RTX 4070 Ti · 12 GB · PCI 09"
    assert gpu.label(twin, devices) == "RTX 4070 Ti · 12 GB · PCI 0a"


def test_default_prefers_the_card_with_most_memory():
    assert gpu.default_uuid(DEVICES) == "uuid-5080"
    assert gpu.default_uuid([]) is None


def test_resolve_returns_the_stored_card():
    assert gpu.resolve("uuid-4070ti", DEVICES) is TI


def test_resolve_falls_back_to_default_when_card_is_gone():
    assert gpu.resolve("uuid-removed", DEVICES) is BIG
    assert gpu.resolve(None, DEVICES) is BIG


def test_resolve_without_cuda_is_none():
    assert gpu.resolve("uuid-5080", []) is None


def test_device_string_uses_the_current_torch_index():
    assert gpu.device_string(BIG) == "cuda:1"
    assert gpu.device_string(None) == "cpu"


def test_listing_is_in_pci_order_and_marks_the_selection():
    rows = gpu.listing(DEVICES, "uuid-4070ti")
    assert [r["uuid"] for r in rows] == ["uuid-5080", "uuid-4070ti"]
    assert [r["label"] for r in rows] == ["RTX 5080 · 16 GB", "RTX 4070 Ti · 12 GB"]
    assert [r["selected"] for r in rows] == [False, True]


def test_listing_marks_the_default_when_nothing_is_stored():
    rows = gpu.listing(DEVICES, None)
    assert [r["selected"] for r in rows] == [True, False]


def test_selection_roundtrip(tmp_path):
    p = tmp_path / "gpu.json"
    gpu.save_selected(p, "uuid-5080")
    assert gpu.load_selected(p) == "uuid-5080"


@pytest.mark.parametrize("content", ["not json", "[]", "null", '{"uuid": 5}'])
def test_load_selected_tolerates_garbage(tmp_path, content):
    p = tmp_path / "gpu.json"
    p.write_text(content)
    assert gpu.load_selected(p) is None


def test_load_selected_missing_file(tmp_path):
    assert gpu.load_selected(tmp_path / "nope.json") is None


def test_current_device_follows_the_stored_uuid(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    assert gpu.current_device() == "cuda:1"          # default: the 5080
    gpu.save_selected(gpu.CONFIG_PATH, "uuid-4070ti")
    assert gpu.current_device() == "cuda:0"


def test_current_device_without_cuda_is_cpu(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu, "probe", lambda: [])
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    assert gpu.current_device() == "cpu"


# --------------------------------------------------------------------------- #
# /api/gpu/select
# --------------------------------------------------------------------------- #
@pytest.fixture
def fake_gpus(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    unloaded = []
    monkeypatch.setattr(server.captioner, "unload", lambda: unloaded.append("vlm"))
    monkeypatch.setattr(server.florence, "unload", lambda: unloaded.append("florence"))
    monkeypatch.setattr(server.upscaler, "unload", lambda: unloaded.append("upscaler"))
    monkeypatch.setattr(server, "_gpu_status", lambda: {"ok": True})
    monkeypatch.setattr(server, "JOBS", {})
    return unloaded


def test_select_saves_the_card_and_releases_models(fake_gpus):
    server.api_gpu_select(server.GpuSelectRequest(uuid="uuid-4070ti"))
    assert gpu.load_selected(gpu.CONFIG_PATH) == "uuid-4070ti"
    assert sorted(fake_gpus) == ["florence", "upscaler", "vlm"]


def test_select_rejects_an_unknown_card(fake_gpus):
    with pytest.raises(HTTPException) as e:
        server.api_gpu_select(server.GpuSelectRequest(uuid="uuid-nope"))
    assert e.value.status_code == 400
    assert gpu.load_selected(gpu.CONFIG_PATH) is None
    assert fake_gpus == []


def test_select_is_refused_while_a_job_runs(fake_gpus, monkeypatch):
    monkeypatch.setattr(server, "JOBS", {"j": {"state": "processing"}})
    with pytest.raises(HTTPException) as e:
        server.api_gpu_select(server.GpuSelectRequest(uuid="uuid-4070ti"))
    assert e.value.status_code == 409
    assert fake_gpus == []


def test_gpus_endpoint_lists_labels(fake_gpus):
    out = server.api_gpus()
    assert [g["label"] for g in out["gpus"]] == ["RTX 5080 · 16 GB", "RTX 4070 Ti · 12 GB"]
    assert out["selected"] == "uuid-5080"


# --------------------------------------------------------------------------- #
# Device-string checks and topbar status
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("device, expected", [
    ("cuda", True), ("cuda:0", True), ("cuda:1", True), ("cpu", False), ("", False),
])
def test_is_cuda_accepts_indexed_devices(device, expected):
    # A bare `device == "cuda"` check silently turns fp16 off on "cuda:1".
    assert gpu.is_cuda(device) is expected


def test_gpu_status_reports_the_selected_card(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu, "probe", lambda: DEVICES)
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    gpu.save_selected(gpu.CONFIG_PATH, "uuid-4070ti")
    # captioner measures the torch default device; the topbar must show the chosen one
    monkeypatch.setattr(server.captioner, "gpu_status", lambda: {
        "loaded": False, "model": None, "quant": None, "cuda": True,
        "vram_used_gb": 9.9, "vram_total_gb": 99.9})
    monkeypatch.setattr(server.upscaler, "status", lambda: {
        "loaded": False, "key": "", "device": "", "note": ""})
    monkeypatch.setattr(gpu, "vram_gb", lambda dev: (1.5, 12.5) if dev["index"] == 0 else (0.5, 16.6))
    st = server._gpu_status()
    assert st["gpu_label"] == "RTX 4070 Ti · 12 GB"
    assert (st["vram_used_gb"], st["vram_total_gb"]) == (1.5, 12.5)


# --------------------------------------------------------------------------- #
# No stray CUDA contexts on cards that hold nothing
# --------------------------------------------------------------------------- #
class _FakeCuda:
    """Records which devices get touched; a real touch creates a ~200 MB context."""

    def __init__(self, reserved):
        self.reserved = reserved
        self.emptied = []
        self.meminfo_calls = []
        self._current = 0

    def is_available(self):
        return True

    def device_count(self):
        return len(self.reserved)

    def memory_reserved(self, i):
        return self.reserved[i]

    def device(self, i):
        fake = self

        class _Ctx:
            def __enter__(self):
                fake._current = i

            def __exit__(self, *a):
                return False
        return _Ctx()

    def empty_cache(self):
        self.emptied.append(self._current)

    def mem_get_info(self, *args):
        self.meminfo_calls.append(args)
        return (1, 2)


def test_empty_cache_only_touches_cards_that_hold_memory(monkeypatch):
    import torch
    fake = _FakeCuda(reserved=[0, 20 * 2 ** 20])   # only cuda:1 has allocations
    monkeypatch.setattr(torch, "cuda", fake)
    gpu.empty_cache()
    assert fake.emptied == [1]


def test_captioner_status_does_not_probe_the_default_card(monkeypatch):
    # mem_get_info() without a device creates a context on cuda:0 — the card
    # the user did NOT pick. The server measures the chosen card instead.
    import torch
    from backend import captioner
    fake = _FakeCuda(reserved=[0, 0])
    monkeypatch.setattr(torch, "cuda", fake)
    captioner.gpu_status()
    assert () not in fake.meminfo_calls
