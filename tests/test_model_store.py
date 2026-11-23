"""Model registry: folder names, weight checks, path resolution order."""
from __future__ import annotations

import json
from pathlib import Path

from backend import model_store as ms

QWEN7 = "Qwen/Qwen2.5-VL-7B-Instruct"


def _fake_snapshot(d: Path, model_type: str = "qwen2_5_vl", shards: int = 1,
                   drop_shard: bool = False) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps({"model_type": model_type}))
    if shards == 1:
        (d / "model.safetensors").write_bytes(b"x")
        return d
    names = [f"model-0000{i + 1}-of-0000{shards}.safetensors" for i in range(shards)]
    (d / "model.safetensors.index.json").write_text(json.dumps(
        {"weight_map": {f"w{i}": n for i, n in enumerate(names)}}))
    for n in names[: -1 if drop_shard else None]:
        (d / n).write_bytes(b"x")
    return d


def _ctx(tmp_path, locations=None, models_dir="", upscale_cfg=None, custom=None):
    return {
        "settings": {"models_dir": str(models_dir) if models_dir else "",
                     "model_locations": locations or {}},
        "upscale_cfg": upscale_cfg or {"folder": "", "custom": []},
        "custom_vlms": custom or {},
    }


def _no_hf(monkeypatch):
    monkeypatch.setattr(ms, "_hf_snapshot_path", lambda repo_id: None)
    monkeypatch.setattr(ms, "_hf_file_path", lambda repo_id, filename: None)


def _status(ctx, model_id):
    return next(e for e in ms.listing(ctx) if e["id"] == model_id)


def test_folder_name():
    assert ms.folder_name(QWEN7) == "Qwen--Qwen2.5-VL-7B-Instruct"


def test_weights_complete_single_and_sharded(tmp_path):
    assert ms.weights_complete(_fake_snapshot(tmp_path / "a"))
    assert ms.weights_complete(_fake_snapshot(tmp_path / "b", shards=2))
    assert not ms.weights_complete(_fake_snapshot(tmp_path / "c", shards=2, drop_shard=True))
    assert not ms.weights_complete(tmp_path / "nope")


def test_validate_dir_vlm_ok(tmp_path):
    assert ms.validate_dir(_fake_snapshot(tmp_path / "m"), "vlm") == {"ok": True, "reason": ""}


def test_validate_dir_wrong_type(tmp_path):
    d = _fake_snapshot(tmp_path / "m", model_type="llama")
    assert ms.validate_dir(d, "vlm") == {
        "ok": False, "reason": "Only Qwen2.5-VL models are supported here."}
    assert ms.validate_dir(d, "florence")["reason"] == "Not a Florence-2 model."
    assert ms.validate_dir(tmp_path / "x", "vlm")["reason"] == "Folder does not exist."
    (tmp_path / "e").mkdir()
    assert ms.validate_dir(tmp_path / "e", "vlm")["reason"] == \
        "Not a model folder (config.json missing)."


def test_validate_dir_incomplete_weights(tmp_path):
    d = _fake_snapshot(tmp_path / "m", shards=2, drop_shard=True)
    assert ms.validate_dir(d, "vlm") == {"ok": False, "reason": "Model weights are incomplete."}


def test_validate_dir_florence_ok(tmp_path):
    assert ms.validate_dir(_fake_snapshot(tmp_path / "f", "florence2"), "florence")["ok"]


def test_resolve_prefers_location_over_models_dir_over_hf_cache(tmp_path, monkeypatch):
    md = tmp_path / "md"
    snap_md = _fake_snapshot(md / ms.folder_name(QWEN7))
    (snap_md / ms.MARKER).write_text("")
    hf = _fake_snapshot(tmp_path / "hf")
    monkeypatch.setattr(ms, "_hf_snapshot_path", lambda r: str(hf))
    loc = _fake_snapshot(tmp_path / "loc")
    ctx = _ctx(tmp_path, {QWEN7: str(loc)}, md)
    entry = ms.find(QWEN7, ctx)
    assert ms.resolve_path(entry, ctx) == str(loc)
    ctx["settings"]["model_locations"] = {}
    assert ms.resolve_path(entry, ctx) == str(snap_md)
    ctx["settings"]["models_dir"] = ""
    assert ms.resolve_path(entry, ctx) == str(hf)


def test_resolve_falls_back_to_hf_cache(tmp_path, monkeypatch):
    hf = _fake_snapshot(tmp_path / "hf")
    monkeypatch.setattr(ms, "_hf_snapshot_path", lambda r: str(hf))
    monkeypatch.setattr(ms, "_hf_file_path", lambda r, f: None)
    row = _status(_ctx(tmp_path), QWEN7)
    assert row["status"] == "ready" and row["local_path"] == str(hf)
    assert row["download"] is None


def test_models_dir_without_marker_is_missing(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    md = tmp_path / "md"
    _fake_snapshot(md / ms.folder_name(QWEN7))
    row = _status(_ctx(tmp_path, models_dir=md), QWEN7)
    assert row["status"] == "missing" and row["local_path"] is None


def test_location_that_disappeared_is_missing(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    ctx = _ctx(tmp_path, {QWEN7: str(tmp_path / "gone")})
    assert _status(ctx, QWEN7)["status"] == "missing"


def test_invalid_location_falls_through(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    bad = _fake_snapshot(tmp_path / "bad", model_type="llama")
    ctx = _ctx(tmp_path, {QWEN7: str(bad)})
    assert _status(ctx, QWEN7)["status"] == "missing"


def test_upscale_builtin_resolves_file_in_models_dir(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    md = tmp_path / "md"
    d = md / ms.folder_name("ai-forever/Real-ESRGAN")
    d.mkdir(parents=True)
    (d / "RealESRGAN_x4.pth").write_bytes(b"x")
    ctx = _ctx(tmp_path, models_dir=md)
    row = _status(ctx, "realesrgan-x4")
    assert row["kind"] == "upscale" and row["status"] == "ready"
    assert row["local_path"] == str(d / "RealESRGAN_x4.pth")
    assert _status(ctx, "realesrgan-x2")["status"] == "missing"


def test_local_scan_entry_resolves_to_its_path(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    folder = tmp_path / "ups"
    folder.mkdir()
    f = folder / "my.pth"
    f.write_bytes(b"x")
    ctx = _ctx(tmp_path, {f"local:{f}": str(tmp_path / "other.pth")},
               upscale_cfg={"folder": str(folder), "custom": []})
    entry = ms.find(f"local:{f}", ctx)
    assert entry["source"] == "local"
    assert ms.resolve_path(entry, ctx) == str(f)
    f.unlink()
    assert ms.resolve_path(entry, ctx) is None


def test_custom_vlm_entry_ready_and_missing_when_folder_gone(tmp_path, monkeypatch):
    _no_hf(monkeypatch)
    d = _fake_snapshot(tmp_path / "mine")
    ctx = _ctx(tmp_path, custom={str(d): "mine (custom)"})
    row = _status(ctx, str(d))
    assert row["source"] == "custom" and row["label"] == "mine (custom)"
    assert row["status"] == "ready" and row["local_path"] == str(d)
    (d / "model.safetensors").unlink()
    (d / "config.json").unlink()
    d.rmdir()
    assert _status(ctx, str(d))["status"] == "missing"


def test_validate_weight_file(tmp_path):
    ok = tmp_path / "a.pth"
    ok.write_bytes(b"x")
    assert ms.validate_weight_file(ok)["ok"]
    assert not ms.validate_weight_file(tmp_path / "nope.pth")["ok"]
    bad = tmp_path / "a.txt"
    bad.write_bytes(b"x")
    assert not ms.validate_weight_file(bad)["ok"]


def test_is_qwen_vl_config():
    assert ms.is_qwen_vl_config({"model_type": "Qwen2_5_VL"})
    assert ms.is_qwen_vl_config({"architectures": ["Qwen2_5_VLForConditionalGeneration"]})
    assert not ms.is_qwen_vl_config({"model_type": "llama"})


def test_weights_complete_malformed_index_is_false(tmp_path):
    for i, body in enumerate(['[]', '{"weight_map":{"a":["x"]}}',
                              '{"weight_map":{"a":5}}', '{"weight_map":[]}',
                              'not json']):
        d = tmp_path / f"m{i}"
        d.mkdir()
        (d / "model.safetensors.index.json").write_text(body)
        assert ms.weights_complete(d) is False
    d = _fake_snapshot(tmp_path / "v")
    (d / "model.safetensors").unlink()
    (d / "model.safetensors.index.json").write_text("[]")
    assert ms.validate_dir(d, "vlm")["reason"] == "Model weights are incomplete."


def test_upscale_entry_carries_scale_and_note(tmp_path):
    ctx = _ctx(tmp_path, upscale_cfg={"folder": "", "custom": [
        {"repo_id": "u/r", "filename": "x.pth", "scale": 3}]})
    e = ms.find("realesrgan-x4", ctx)
    assert e["scale"] == 4 and e["note"] == "Solid default for photographic sources."
    assert ms.find("hf:u/r/x.pth", ctx)["scale"] == 3
