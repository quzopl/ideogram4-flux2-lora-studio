import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from backend import gpu, server

ROOT = Path(__file__).resolve().parent.parent
client = TestClient(server.app)


@pytest.fixture
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text('<div id="root"></div>')
    (d / "assets" / "app.js").write_text("console.log('spa')")
    monkeypatch.setattr(server, "WEB_DIST", d)
    return d


def test_root_serves_web_dist_index(dist):
    r = client.get("/")
    assert r.status_code == 200 and 'id="root"' in r.text


def test_spa_fallback_serves_index(dist):
    for p in ("/settings", "/models/x"):
        r = client.get(p)
        assert r.status_code == 200 and 'id="root"' in r.text


def test_assets_served(dist):
    r = client.get("/assets/app.js")
    assert r.status_code == 200 and r.text == "console.log('spa')"


def test_unknown_api_path_is_json_404(dist):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_root_redirects_to_legacy_without_dist(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WEB_DIST", tmp_path / "missing")
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/legacy/"


def test_legacy_serves_frontend():
    r = client.get("/legacy/")
    assert r.status_code == 200 and "app.js" in r.text
    assert 'href="/style.css"' not in r.text and 'src="/app.js"' not in r.text
    assert client.get("/legacy/style.css").status_code == 200


def test_work_dir_env(tmp_path):
    out = subprocess.run(
        [sys.executable, "-c",
         "import backend.server as s, backend.settings as st, backend.gpu as g; "
         "print(s.WORK, st.CONFIG_PATH, g.CONFIG_PATH)"],
        cwd=ROOT, env={**__import__("os").environ, "FLUX_PREP_WORK": str(tmp_path)},
        capture_output=True, text=True, check=True).stdout.split()
    assert out == [str(tmp_path), str(tmp_path / "settings.json"), str(tmp_path / "gpu.json")]


def test_fs_pick_is_post():
    assert client.get("/api/fs/pick").status_code == 405
    fake = subprocess.CompletedProcess([], 0, stdout="/tmp/x\n", stderr="")
    with patch("subprocess.run", return_value=fake):
        r = client.post("/api/fs/pick")
    assert r.status_code == 200 and r.json() == {"path": "/tmp/x"}


def test_gpus_concurrent_polls_share_one_smi_run(monkeypatch):
    calls = []

    def slow():
        calls.append(1)
        time.sleep(0.3)
        return {}

    monkeypatch.setattr(gpu, "smi_stats", slow)
    monkeypatch.setattr(gpu, "probe", lambda: [])
    codes = []

    def poll():
        codes.append(client.get("/api/gpus").status_code)

    ts = [threading.Thread(target=poll) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert codes == [200, 200]
    assert len(calls) == 1


def test_html_responses_are_not_cached(dist):
    for p in ("/", "/settings", "/upscale", "/legacy/"):
        r = client.get(p)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
        assert r.headers.get("cache-control") == "no-cache", p


def test_missing_asset_is_404_not_index(dist):
    r = client.get("/assets/index-OLD.js")
    assert r.status_code == 404
    assert not r.headers["content-type"].startswith("text/html")


def test_missing_asset_is_404_without_dist(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WEB_DIST", tmp_path / "missing")
    assert client.get("/assets/index-OLD.js", follow_redirects=False).status_code == 404


def test_legacy_without_slash_redirects(dist):
    r = client.get("/legacy", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/legacy/"


def test_nul_byte_in_path_is_not_a_server_error(dist):
    r = client.get("/x%00y")
    assert r.status_code == 200 and 'id="root"' in r.text
    assert client.get("/assets/%00.js").status_code == 404
    assert client.get("/legacy/%00").status_code < 500
