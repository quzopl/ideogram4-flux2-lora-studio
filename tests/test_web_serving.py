import subprocess
import sys
import threading
import time
from pathlib import Path

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


def test_root_without_dist_is_a_503_with_build_instructions(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "WEB_DIST", tmp_path / "missing")
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 503
    assert r.headers["cache-control"] == "no-cache"
    assert "The web UI is not built" in r.text
    assert "cd web && pnpm install && pnpm build" in r.text


@pytest.mark.parametrize("path", ["/legacy", "/legacy/", "/legacy/style.css"])
def test_legacy_paths_redirect_to_the_app(path):
    r = client.get(path, follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/"


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/fs/pick"),
    ("POST", "/api/gpu/select"),
    ("GET", "/api/upscale/models"),
    ("POST", "/api/upscale/download"),
    ("POST", "/api/ideogram/analyze"),
    ("POST", "/api/prompt"),
])
def test_legacy_routes_gone(method, path):
    # Not a status check: a POST to an unknown path is a 405 through the GET catch-all.
    assert not any(getattr(r, "path", None) == path and method in getattr(r, "methods", ())
                   for r in server.app.routes)


def test_work_dir_env(tmp_path):
    out = subprocess.run(
        [sys.executable, "-c",
         "import backend.server, backend.core as c, backend.settings as st, backend.gpu as g; "
         "print(c.WORK, st.CONFIG_PATH, g.CONFIG_PATH)"],
        cwd=ROOT, env={**__import__("os").environ, "FLUX_PREP_WORK": str(tmp_path)},
        capture_output=True, text=True, check=True).stdout.split()
    assert out == [str(tmp_path), str(tmp_path / "settings.json"), str(tmp_path / "gpu.json")]


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
    for p in ("/", "/settings", "/upscale"):
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


def test_nul_byte_in_path_is_not_a_server_error(dist):
    r = client.get("/x%00y")
    assert r.status_code == 200 and 'id="root"' in r.text
    assert client.get("/assets/%00.js").status_code == 404


def test_health_reports_version():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "version": "2.0.0"}
