import os

import pytest
from fastapi.testclient import TestClient

from backend import server, settings

client = TestClient(server.app)


def test_get_settings_defaults():
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["models_dir"] == ""


def test_patch_models_dir_creates_and_saves(tmp_path):
    target = tmp_path / "m" / "n"
    r = client.patch("/api/settings", json={"models_dir": str(target)})
    assert r.status_code == 200
    assert target.is_dir()
    assert r.json()["models_dir"] == str(target.resolve())
    assert settings.load()["models_dir"] == str(target.resolve())


@pytest.mark.parametrize("bad", ["relative/dir", ""])
def test_patch_models_dir_relative_400(bad):
    r = client.patch("/api/settings", json={"models_dir": bad})
    assert r.status_code == 400
    assert "absolute" in r.json()["detail"]


def test_patch_models_dir_unwritable_400(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root ignores directory permissions")
    parent = tmp_path / "ro"
    parent.mkdir()
    parent.chmod(0o500)
    try:
        r = client.patch("/api/settings", json={"models_dir": str(parent)})
    finally:
        parent.chmod(0o700)
    assert r.status_code == 400
    assert "not writable" in r.json()["detail"]


def test_put_form_and_preset_then_get():
    assert client.put("/api/settings/forms/dataset", json={"values": {"a": 1}}).status_code == 200
    assert client.put("/api/settings/presets/dataset/p1", json={"values": {"b": 2}}).status_code == 200
    doc = client.get("/api/settings").json()
    assert doc["forms"]["dataset"] == {"a": 1}
    assert doc["presets"]["dataset"]["p1"] == {"b": 2}
    r = client.delete("/api/settings/presets/dataset/p1")
    assert r.status_code == 200
    assert "p1" not in client.get("/api/settings").json()["presets"]["dataset"]


def test_unknown_view_400():
    r = client.put("/api/settings/forms/nope", json={"values": {}})
    assert r.status_code == 400
    assert "unknown view" in r.json()["detail"]


def test_export_has_attachment_header_and_no_token(tmp_path, monkeypatch):
    hf = tmp_path / "hf.json"
    hf.write_text('{"token": "hf_secret123"}')
    monkeypatch.setattr(server, "HF_TOKEN_PATH", hf)
    r = client.get("/api/settings/export")
    assert r.status_code == 200
    assert r.headers["content-disposition"] == 'attachment; filename="flux-lora-prep-settings.json"'
    assert "hf_" not in r.text


def test_import_roundtrip():
    client.put("/api/settings/forms/bbox", json={"values": {"x": 5}})
    exported = client.get("/api/settings/export").json()
    client.put("/api/settings/forms/bbox", json={"values": {"x": 9}})
    r = client.post("/api/settings/import", json=exported)
    assert r.status_code == 200
    assert client.get("/api/settings").json()["forms"]["bbox"] == {"x": 5}
    assert client.post("/api/settings/import", json={"version": 99}).status_code == 400
