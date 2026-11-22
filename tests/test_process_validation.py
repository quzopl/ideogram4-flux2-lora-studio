import threading

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import server


def post(tmp_path, **extra):
    return TestClient(server.app).post("/api/process", json={"folder": str(tmp_path), **extra})


@pytest.mark.parametrize("bad", [{"step": 0}, {"jpg_quality": 10}, {"resolution": 100}])
def test_process_rejects_bad_numbers(tmp_path, bad):
    r = post(tmp_path, **bad)
    assert r.status_code == 422
    assert r.json()["detail"]


def test_process_rejects_unknown_fmt(tmp_path):
    assert post(tmp_path, fmt="gif").status_code == 422


def test_process_defaults_still_accepted(tmp_path, monkeypatch):
    Image.new("RGB", (8, 8)).save(tmp_path / "a.png")

    class NoThread:
        def __init__(self, *a, **k): pass
        def start(self): pass

    monkeypatch.setattr(threading, "Thread", NoThread)
    r = post(tmp_path)
    assert r.status_code == 200
    assert r.json()["total"] == 1
