import pytest
from fastapi import HTTPException
from PIL import Image

from backend import api_dataset, core, server


def _req(**kw):
    base = dict(folder="/tmp/x")
    base.update(kw)
    return api_dataset.ProcessRequest(**base)


def test_process_request_crop_defaults():
    r = _req()
    assert r.crop_mode == "center"
    assert r.fit == "cover"
    assert r.crops == {}
    assert (r.centering_x, r.centering_y) == ("center", "center")


def test_process_request_accepts_crops():
    r = _req(crop_mode="manual", crops={"a.jpg": [1, 2, 3, 4]})
    assert r.crops["a.jpg"] == [1, 2, 3, 4]


def test_crop_for_manual_returns_box():
    r = _req(crop_mode="manual", crops={"a.jpg": [1, 2, 30, 40]})
    assert api_dataset._crop_for(r, "a.jpg") == [1, 2, 30, 40]


def test_crop_for_manual_missing_entry_is_none():
    r = _req(crop_mode="manual", crops={})
    assert api_dataset._crop_for(r, "a.jpg") is None


def test_crop_for_auto_returns_box():
    # Auto boxes are computed by /api/crop/auto and land in the same plan, so
    # "auto" must read it too — otherwise the mode silently means "centre".
    r = _req(crop_mode="auto", crops={"a.jpg": [1, 2, 30, 40]})
    assert api_dataset._crop_for(r, "a.jpg") == [1, 2, 30, 40]


def test_crop_for_center_mode_ignores_plan():
    r = _req(crop_mode="center", crops={"a.jpg": [1, 2, 30, 40]})
    assert api_dataset._crop_for(r, "a.jpg") is None


def test_crop_for_rejects_malformed_box():
    for mode in ("auto", "manual"):
        r = _req(crop_mode=mode, crops={"a.jpg": [1, 2, 30]})
        assert api_dataset._crop_for(r, "a.jpg") is None


def test_safe_source_path_rejects_traversal(tmp_path):
    (tmp_path / "ok.png").write_bytes(b"x")
    with pytest.raises(HTTPException):
        core._safe_source_path(str(tmp_path), "../secret.png")
    with pytest.raises(HTTPException):
        core._safe_source_path(str(tmp_path), "sub/ok.png")


def test_safe_source_path_rejects_missing_file(tmp_path):
    with pytest.raises(HTTPException):
        core._safe_source_path(str(tmp_path), "nope.png")


def test_safe_source_path_accepts_real_file(tmp_path):
    Image.new("RGB", (10, 10)).save(tmp_path / "ok.png")
    assert core._safe_source_path(str(tmp_path), "ok.png").name == "ok.png"


def test_crop_auto_endpoint_starts_job(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    Image.new("RGB", (10, 10)).save(tmp_path / "a.png")
    started = []
    monkeypatch.setattr(api_dataset, "_run_crop_auto",
                        lambda *args: started.append(args))
    monkeypatch.setattr(core, "JOBS", {})
    r = TestClient(server.app).post("/api/crop/auto", json={"folder": str(tmp_path)})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 1 and r.json()["job_id"] in core.JOBS
