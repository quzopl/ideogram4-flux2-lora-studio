import pytest
from fastapi import HTTPException
from PIL import Image

from backend import server


def _req(**kw):
    base = dict(folder="/tmp/x")
    base.update(kw)
    return server.ProcessRequest(**base)


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
    assert server._crop_for(r, "a.jpg") == [1, 2, 30, 40]


def test_crop_for_manual_missing_entry_is_none():
    r = _req(crop_mode="manual", crops={})
    assert server._crop_for(r, "a.jpg") is None


def test_crop_for_center_mode_ignores_plan():
    r = _req(crop_mode="center", crops={"a.jpg": [1, 2, 30, 40]})
    assert server._crop_for(r, "a.jpg") is None


def test_safe_source_path_rejects_traversal(tmp_path):
    (tmp_path / "ok.png").write_bytes(b"x")
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "../secret.png")
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "sub/ok.png")


def test_safe_source_path_rejects_missing_file(tmp_path):
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "nope.png")


def test_safe_source_path_accepts_real_file(tmp_path):
    Image.new("RGB", (10, 10)).save(tmp_path / "ok.png")
    assert server._safe_source_path(str(tmp_path), "ok.png").name == "ok.png"
