import json
from backend import server


def test_list_subdirs_only_dirs_sorted(tmp_path):
    (tmp_path / "b").mkdir()
    (tmp_path / "A").mkdir()
    (tmp_path / "file.txt").write_text("x")
    assert server._list_subdirs(tmp_path) == ["A", "b"]


def test_model_dir_info_not_a_dir(tmp_path):
    info = server._model_dir_info(tmp_path / "nope")
    assert info["ok"] is False


def test_model_dir_info_missing_config(tmp_path):
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is False and "config.json" in info["reason"]


def test_model_dir_info_wrong_model(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "llama"}))
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is False and "Qwen2.5-VL" in info["reason"]


def test_model_dir_info_qwen_ok(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "qwen2_5_vl"}))
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is True
    assert info["label"].endswith("(custom)")


def test_all_models_merges_custom(tmp_path, monkeypatch):
    cm = tmp_path / "cm.json"
    cm.write_text(json.dumps({"/models/qwen": "qwen (custom)"}))
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", cm)
    models = server._all_models()
    assert "/models/qwen" in models
    assert any("Qwen2.5-VL" in v for v in models.values())


import pytest


def _make_model_dir(p):
    p.mkdir()
    (p / "config.json").write_text(json.dumps({"model_type": "qwen2_5_vl"}))
    return p


def test_add_and_remove_custom_model(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    model_dir = _make_model_dir(tmp_path / "mymodel")
    res = server._add_custom_model(str(model_dir))
    assert res["added"] == str(model_dir.resolve())
    assert str(model_dir.resolve()) in server._all_models()
    server._remove_custom_model(str(model_dir))
    assert str(model_dir.resolve()) not in server._all_models()


def test_add_custom_model_rejects_non_model(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    with pytest.raises(ValueError):
        server._add_custom_model(str(tmp_path))
