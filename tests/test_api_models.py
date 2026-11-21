import pytest
from fastapi.testclient import TestClient

from backend import model_store, server, settings, upscaler

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Never read the dev box's .work/ configs or its HF cache."""
    monkeypatch.setattr(server, "UPSCALER_CONFIG_PATH", tmp_path / "upscaler.json")
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "custom_models.json")
    monkeypatch.setattr(server, "HF_TOKEN_PATH", tmp_path / "hf.json")
    monkeypatch.setattr(model_store, "_hf_snapshot_path", lambda repo_id: None)
    monkeypatch.setattr(model_store, "_hf_file_path", lambda repo_id, filename: None)
    monkeypatch.setattr(upscaler, "_hf_cached", lambda repo_id, filename: False)


def test_store_models_lists_builtin_vlm_florence_upscale():
    r = client.get("/api/store/models")
    assert r.status_code == 200
    body = r.json()
    assert body["models_dir"] == ""
    kinds = {m["kind"] for m in body["models"]}
    assert {"vlm", "florence", "upscale"} <= kinds
    assert all(m["status"] in ("ready", "downloading", "missing") for m in body["models"])


def test_store_models_survives_import_of_bad_location():
    r = client.post("/api/settings/import", json={
        "version": 1, "model_locations": {"Qwen/Qwen2.5-VL-7B-Instruct": 5}})
    assert r.status_code == 200
    assert r.json()["model_locations"] == {}
    r = client.get("/api/store/models")
    assert r.status_code == 200
    row = next(m for m in r.json()["models"] if m["id"] == "Qwen/Qwen2.5-VL-7B-Instruct")
    assert row["status"] == "missing"
    assert client.get("/api/upscale/models").status_code == 200


def test_download_without_any_folder_400():
    mid = client.get("/api/store/models").json()["models"][0]["id"]
    r = client.post("/api/store/download", json={"model_id": mid})
    assert r.status_code == 400
    assert r.json()["detail"] == "Choose a folder to download into."


def test_download_unknown_model_404(tmp_path):
    r = client.post("/api/store/download",
                    json={"model_id": "nope/nope", "dest": str(tmp_path)})
    assert r.status_code == 404


def test_locate_bad_folder_400_with_reason(tmp_path):
    mid = next(m["id"] for m in client.get("/api/store/models").json()["models"]
               if m["kind"] == "florence")
    r = client.post("/api/store/locate", json={"model_id": mid, "path": str(tmp_path)})
    assert r.status_code == 400
    assert r.json()["detail"]
    assert settings.load()["model_locations"] == {}


def test_locate_then_forget_keeps_files(tmp_path):
    models = client.get("/api/store/models").json()["models"]
    up = next(m for m in models if m["kind"] == "upscale" and not m.get("path"))
    f = tmp_path / "w.pth"
    f.write_bytes(b"x" * 10)
    r = client.post("/api/store/locate", json={"model_id": up["id"], "path": str(f)})
    assert r.status_code == 200
    assert settings.load()["model_locations"][up["id"]] == str(f.resolve())
    row = next(m for m in r.json()["models"] if m["id"] == up["id"])
    assert row["local_path"] == str(f.resolve())
    r = client.post("/api/store/forget", json={"model_id": up["id"]})
    assert r.status_code == 200
    assert up["id"] not in settings.load()["model_locations"]
    assert f.exists()
    assert client.post("/api/store/forget", json={"model_id": up["id"]}).status_code == 200
    assert client.post("/api/store/forget", json={"model_id": "zzz"}).status_code == 404


def test_cancel_unknown_job_404():
    assert client.post("/api/store/downloads/nope/cancel").status_code == 404
    assert client.get("/api/store/downloads").json() == {"downloads": []}


def test_fs_list_has_free_bytes_and_writable(tmp_path):
    j = client.get("/api/fs/list", params={"path": str(tmp_path)}).json()
    assert j["free_bytes"] > 0
    assert j["writable"] is True
    assert "files" not in j


def test_fs_list_weight_files(tmp_path):
    for n in ("b.safetensors", "a.pth", "c.txt"):
        (tmp_path / n).write_bytes(b"x")
    (tmp_path / "d.pth").mkdir()
    j = client.get("/api/fs/list", params={"path": str(tmp_path), "files": "weights"}).json()
    assert j["files"] == ["a.pth", "b.safetensors"]


def test_fs_mkdir_creates_and_rejects_existing(tmp_path):
    t = tmp_path / "new"
    r = client.post("/api/fs/mkdir", json={"path": str(t)})
    assert r.status_code == 200 and t.is_dir()
    assert r.json()["path"] == str(t.resolve())
    assert client.post("/api/fs/mkdir", json={"path": str(t)}).status_code == 400
    assert client.post("/api/fs/mkdir",
                       json={"path": str(tmp_path / "x" / "y")}).status_code == 400
    assert client.post("/api/fs/mkdir", json={"path": "rel"}).status_code == 400
