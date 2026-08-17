import json
import stat
from pathlib import Path
from unittest.mock import patch

import pytest

from backend import upscaler


def test_builtin_models_shape():
    assert upscaler.BUILTIN_MODELS
    for m in upscaler.BUILTIN_MODELS:
        assert set(["id", "label", "repo_id", "filename", "scale"]) <= set(m)
        assert m["scale"] in (2, 4)


def test_plan_passes_zero_when_target_is_smaller():
    assert upscaler.plan_passes((2000, 1000), (1024, 512), 4) == 0


def test_plan_passes_zero_below_min_ratio():
    assert upscaler.plan_passes((1000, 1000), (1024, 1024), 4, min_ratio=1.05) == 0


def test_plan_passes_one_for_moderate_gap():
    assert upscaler.plan_passes((512, 512), (1024, 1024), 4) == 1
    assert upscaler.plan_passes((512, 512), (1024, 1024), 2) == 1


def test_plan_passes_two_when_one_is_not_enough():
    assert upscaler.plan_passes((256, 256), (1024, 1024), 2) == 2


def test_plan_passes_capped_at_two():
    assert upscaler.plan_passes((64, 64), (2048, 2048), 2) == 2


def test_plan_passes_contain_uses_the_smaller_ratio():
    # 1000x500 -> 1024x1024 bucket: cover needs the model, contain does not.
    assert upscaler.plan_passes((1000, 500), (1024, 1024), 4) == 1
    assert upscaler.plan_passes((1000, 500), (1024, 1024), 4, fit="contain") == 0


def test_run_once_covers_every_output_pixel(monkeypatch):
    """Tiling must write each output pixel exactly once — no gaps, no seams."""
    torch = pytest.importorskip("torch")
    import numpy as np
    from PIL import Image

    def fake_2x(t):                       # stand-in for a real x2 model
        return torch.nn.functional.interpolate(t, scale_factor=2, mode="nearest")

    rt = {"torch": torch, "model": fake_2x, "device": "cpu",
          "dtype": torch.float32, "scale": 2, "key": "fake"}

    # Deliberately not a multiple of the tile size, and never black, so an
    # unwritten cell shows up as a zero pixel.
    h, w = 37, 53
    arr = np.fromfunction(
        lambda y, x, c: 40 + (y * 3 + x * 5 + c * 7) % 200, (h, w, 3)).astype("uint8")
    out = upscaler._run_once(rt, Image.fromarray(arr), tile=16, overlap=4)

    assert out.size == (w * 2, h * 2)
    got = np.asarray(out)
    assert got.min() > 0, "some output cell was never written"
    expected = np.repeat(np.repeat(arr, 2, axis=0), 2, axis=1)
    assert np.array_equal(got, expected)


def test_run_pass_falls_back_to_cpu_when_the_smallest_tile_ooms(monkeypatch):
    seen = []

    def fake_run_once(rt, img, tile=512, overlap=32):
        seen.append((rt["device"], tile))
        if rt["device"] == "cuda":
            raise RuntimeError("CUDA out of memory")
        return "upscaled"

    monkeypatch.setattr(upscaler, "_run_once", fake_run_once)
    monkeypatch.setattr(upscaler, "_empty_cache", lambda rt: None)
    monkeypatch.setattr(upscaler, "_to_cpu",
                        lambda rt: rt.__setitem__("device", "cpu"))

    rt = {"device": "cuda"}
    assert upscaler._run_pass(rt, "img") == "upscaled"
    assert seen == [("cuda", 512), ("cuda", 256), ("cuda", 128), ("cpu", 128)]
    assert "CPU" in upscaler.status()["note"]


def test_run_pass_reraises_non_oom_errors(monkeypatch):
    def boom(rt, img, tile=512, overlap=32):
        raise RuntimeError("weights are corrupt")

    monkeypatch.setattr(upscaler, "_run_once", boom)
    with pytest.raises(RuntimeError, match="corrupt"):
        upscaler._run_pass({"device": "cuda"}, "img")


def test_scan_folder_lists_weight_files(tmp_path):
    (tmp_path / "4x-Foo.pth").write_bytes(b"x")
    (tmp_path / "2x-Bar.safetensors").write_bytes(b"x")
    (tmp_path / "readme.txt").write_text("nope")
    found = upscaler.scan_folder(str(tmp_path))
    names = sorted(m["filename"] for m in found)
    assert names == ["2x-Bar.safetensors", "4x-Foo.pth"]
    assert all(m["id"].startswith("local:") for m in found)


def test_scan_folder_missing_folder_is_empty():
    assert upscaler.scan_folder("/definitely/not/here") == []


def test_config_roundtrip(tmp_path):
    p = tmp_path / "upscaler.json"
    upscaler.save_config(p, {"folder": "/models", "custom": []})
    assert upscaler.load_config(p)["folder"] == "/models"
    assert upscaler.load_config(tmp_path / "missing.json") == {"folder": "", "custom": []}


def test_registry_merges_builtin_custom_and_local(tmp_path):
    (tmp_path / "4x-Local.pth").write_bytes(b"x")
    cfg = {"folder": str(tmp_path),
           "custom": [{"repo_id": "me/up", "filename": "my.pth", "scale": 4}]}
    reg = upscaler.registry(cfg)
    ids = [m["id"] for m in reg]
    assert any(m["id"] == upscaler.BUILTIN_MODELS[0]["id"] for m in reg)
    assert "hf:me/up/my.pth" in ids
    assert any(i.startswith("local:") for i in ids)
    assert all("cached" in m for m in reg)


def test_resolve_finds_model(tmp_path):
    cfg = {"folder": "", "custom": []}
    m = upscaler.resolve(upscaler.BUILTIN_MODELS[0]["id"], cfg)
    assert m and m["filename"] == upscaler.BUILTIN_MODELS[0]["filename"]
    assert upscaler.resolve("nope", cfg) is None


def test_scan_folder_handles_permission_denied(tmp_path):
    """scan_folder gracefully returns [] when directory is not readable."""
    d = tmp_path / "no_read"
    d.mkdir()
    d.chmod(0o000)
    try:
        assert upscaler.scan_folder(str(d)) == []
    finally:
        d.chmod(0o755)


def test_load_config_handles_invalid_json_shapes(tmp_path):
    """load_config returns default dict when JSON is valid but not an object."""
    # Test with JSON array
    p_array = tmp_path / "array.json"
    p_array.write_text("[]")
    assert upscaler.load_config(p_array) == {"folder": "", "custom": []}

    # Test with JSON null
    p_null = tmp_path / "null.json"
    p_null.write_text("null")
    assert upscaler.load_config(p_null) == {"folder": "", "custom": []}

    # Test with JSON number
    p_num = tmp_path / "number.json"
    p_num.write_text("42")
    assert upscaler.load_config(p_num) == {"folder": "", "custom": []}
