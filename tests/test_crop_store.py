from fastapi.testclient import TestClient
from PIL import Image

from backend import crop_store, server


def client():
    return TestClient(server.app)


def test_crops_roundtrip_by_resolved_folder(tmp_path):
    (tmp_path / "a").mkdir()
    p = tmp_path / "plans.json"
    crop_store.save(str(tmp_path / "a" / ".." / "a"), {"x.png": [1, 2, 3, 4]}, "manual", p)
    doc = crop_store.load(str(tmp_path / "a"), p)
    assert doc == {"plan": {"x.png": [1, 2, 3, 4]}, "mode": "manual", "exists": True}


def test_unknown_folder_is_empty_center(tmp_path):
    r = client().get("/api/crops", params={"folder": str(tmp_path / "nope")})
    assert r.status_code == 200
    assert r.json() == {"plan": {}, "mode": "center", "exists": False}


def test_put_crops_rejects_bad_box(tmp_path):
    for box in ([1, 2, 3], [0, 0, 0, 10], [0, 0, 10, 0], [-1, 0, 5, 5]):
        r = client().put("/api/crops", json={"folder": str(tmp_path),
                                              "plan": {"a.png": box}, "mode": "manual"})
        assert r.status_code == 400, box


def test_put_crops_rejects_path_names(tmp_path):
    for name in ("a/b.jpg", ".."):
        r = client().put("/api/crops", json={"folder": str(tmp_path),
                                              "plan": {name: [0, 0, 5, 5]}, "mode": "manual"})
        assert r.status_code == 400, name


def test_crops_isolated_in_tests(tmp_path):
    body = {"folder": str(tmp_path), "plan": {"a.png": [0, 0, 5, 5]}, "mode": "auto"}
    r = client().put("/api/crops", json=body)
    assert r.status_code == 200
    assert r.json() == {"plan": {"a.png": [0, 0, 5, 5]}, "mode": "auto", "exists": True}
    assert crop_store.PATH.parent == tmp_path
    assert crop_store.PATH.exists()
    assert client().get("/api/crops", params={"folder": str(tmp_path)}).json()["mode"] == "auto"


def test_cleared_plan_still_exists(tmp_path):
    p = tmp_path / "plans.json"
    crop_store.save(str(tmp_path), {}, "center", p)
    assert crop_store.load(str(tmp_path), p) == {"plan": {}, "mode": "center", "exists": True}


def test_src_size_reads_header_with_exif(tmp_path):
    img = Image.new("RGB", (40, 20))
    exif = img.getexif()
    exif[0x0112] = 6
    img.save(tmp_path / "r.jpg", exif=exif)
    r = client().get("/api/src/size", params={"folder": str(tmp_path), "name": "r.jpg"})
    assert r.status_code == 200
    assert r.json() == {"width": 20, "height": 40}
    bad = client().get("/api/src/size", params={"folder": str(tmp_path), "name": "../r.jpg"})
    assert bad.status_code == 400
