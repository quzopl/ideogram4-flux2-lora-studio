import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import core, server

client = TestClient(server.app)


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "WORK", tmp_path)
    out = tmp_path / "j1" / "upscaled"
    out.mkdir(parents=True)
    Image.new("RGB", (128, 64), "red").save(out / "0000_a_up.png")
    core.JOBS["j1"] = {"kind": "upscale", "state": "done", "total": 2, "processed": 2,
                         "current": "", "error": None,
                         "results": [{"idx": 0, "out_name": "0000_a_up.png"},
                                     {"idx": 1, "out_name": ""}]}
    yield "j1"
    core.JOBS.pop("j1", None)


def test_upscale_image_serves_full_output(job):
    import io
    r = client.get(f"/api/upscale/image/{job}/0")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(r.content)).size == (128, 64)


def test_upscale_image_missing_404(job):
    assert client.get(f"/api/upscale/image/{job}/5").status_code == 404
    assert client.get(f"/api/upscale/image/{job}/1").status_code == 404
