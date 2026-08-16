import json
import stat
from pathlib import Path
from unittest.mock import patch

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
