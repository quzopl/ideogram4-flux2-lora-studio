import threading

import pytest

from backend import gpu, settings


@pytest.fixture(autouse=True)
def _no_legacy_gpu(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")


def test_load_missing_returns_defaults(tmp_path):
    d = settings.load(tmp_path / "s.json")
    assert d["version"] == 1 and d["models_dir"] == ""
    assert d["gpu"] == {"vlm": "auto", "florence": "auto", "upscale": "auto"}
    assert d["forms"] == {} and d["presets"] == {} and d["model_locations"] == {}


def test_migrates_gpu_json_to_all_roles(tmp_path):
    (tmp_path / "gpu.json").write_text('{"uuid": "GPU-abc"}')
    assert set(settings.load(tmp_path / "s.json")["gpu"].values()) == {"GPU-abc"}


def test_load_never_writes(tmp_path):
    (tmp_path / "gpu.json").write_text('{"uuid": "GPU-abc"}')
    settings.load(tmp_path / "s.json")
    assert not (tmp_path / "s.json").exists()


def test_migration_persists_on_first_update(tmp_path):
    (tmp_path / "gpu.json").write_text('{"uuid": "GPU-abc"}')
    p = tmp_path / "s.json"
    settings.set_form("upscale", {"factor": 2}, p)
    (tmp_path / "gpu.json").unlink()
    assert set(settings.load(p)["gpu"].values()) == {"GPU-abc"}


def test_no_migration_when_file_exists(tmp_path):
    p = tmp_path / "s.json"
    settings.set_form("upscale", {"factor": 2}, p)
    (tmp_path / "gpu.json").write_text('{"uuid": "GPU-abc"}')
    assert set(settings.load(p)["gpu"].values()) == {"auto"}


def test_load_default_path_uses_config_path(tmp_path):
    settings.set_form("dataset", {"mode": "style"})
    assert (tmp_path / "settings.json").exists()
    assert settings.load()["forms"]["dataset"] == {"mode": "style"}


def test_corrupt_file_backed_up(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("{not json")
    assert settings.load(p)["models_dir"] == ""
    assert list(tmp_path.glob("s.json.bad-*"))


def test_load_drops_unknown_keys_and_fills_missing(tmp_path):
    p = tmp_path / "s.json"
    p.write_text('{"version": 1, "junk": 1, "gpu": {"vlm": "GPU-x"}}')
    d = settings.load(p)
    assert "junk" not in d
    assert d["gpu"] == {"vlm": "GPU-x", "florence": "auto", "upscale": "auto"}


def test_save_is_atomic_no_tmp_left(tmp_path):
    settings.set_form("upscale", {"factor": 3}, tmp_path / "s.json")
    assert [f.name for f in tmp_path.iterdir()] == ["s.json"]


def test_forms_and_presets_roundtrip(tmp_path):
    p = tmp_path / "s.json"
    settings.set_form("dataset", {"mode": "style"}, p)
    settings.save_preset("upscale", "x3 photos", {"factor": 3}, p)
    d = settings.load(p)
    assert d["forms"]["dataset"] == {"mode": "style"}
    assert d["presets"]["upscale"]["x3 photos"] == {"factor": 3}
    assert "x3 photos" not in settings.delete_preset("upscale", "x3 photos", p)["presets"]["upscale"]


@pytest.mark.parametrize("view", ["models", "", "../x"])
def test_rejects_unknown_view(tmp_path, view):
    with pytest.raises(ValueError):
        settings.set_form(view, {}, tmp_path / "s.json")
    with pytest.raises(ValueError):
        settings.save_preset(view, "n", {}, tmp_path / "s.json")
    with pytest.raises(ValueError):
        settings.delete_preset(view, "n", tmp_path / "s.json")


@pytest.mark.parametrize("name", ["", "   ", "a/b", "x" * 65])
def test_rejects_bad_preset_name(tmp_path, name):
    with pytest.raises(ValueError):
        settings.save_preset("upscale", name, {}, tmp_path / "s.json")


def test_preset_name_is_stripped(tmp_path):
    d = settings.save_preset("upscale", "  x2  ", {"f": 2}, tmp_path / "s.json")
    assert list(d["presets"]["upscale"]) == ["x2"]


def test_import_keeps_only_known_keys(tmp_path):
    d = settings.import_doc({"version": 1, "hf_token": "hf_x", "models_dir": "/m",
                            "forms": {"upscale": {"factor": 2}}}, tmp_path / "s.json")
    assert "hf_token" not in d and d["models_dir"] == "/m"
    assert settings.load(tmp_path / "s.json")["forms"]["upscale"] == {"factor": 2}


def test_import_rejects_other_version(tmp_path):
    with pytest.raises(ValueError):
        settings.import_doc({"version": 2}, tmp_path / "s.json")


def test_failed_mutator_writes_nothing(tmp_path):
    def boom(doc):
        raise ValueError("nope")
    with pytest.raises(ValueError):
        settings.update(boom, tmp_path / "s.json")
    assert list(tmp_path.iterdir()) == []


def test_concurrent_updates_keep_all_writes(tmp_path):
    p = tmp_path / "s.json"
    threads = [threading.Thread(target=settings.save_preset,
               args=("upscale", f"p{i}", {"i": i}, p)) for i in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(settings.load(p)["presets"]["upscale"]) == 20


@pytest.mark.parametrize("name", ["", "a/b", "x" * 65])
def test_import_rejects_bad_preset_name(tmp_path, name):
    p = tmp_path / "s.json"
    with pytest.raises(ValueError):
        settings.import_doc({"version": 1, "presets": {"upscale": {name: {}}}}, p)
    assert not p.exists()
