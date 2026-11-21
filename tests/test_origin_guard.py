"""Request-origin guard: CSRF and DNS-rebinding protection for /api/*."""
import pytest
from fastapi.testclient import TestClient

from backend import server, settings
from backend.origin_guard import is_loopback_host

client = TestClient(server.app)
LOCAL = {"host": "127.0.0.1:8123"}
BODY = {"version": 1}


@pytest.mark.parametrize("host,expected", [
    ("127.0.0.1:8123", True),
    ("localhost", True),
    ("[::1]:8123", True),
    ("::1", True),
    ("[::1]", True),
    ("LOCALHOST:8123", True),
    ("evil.com", False),
    ("127.0.0.1.evil.com", False),
    ("", False),
    ("localhost.evil.com:8123", False),
])
def test_is_loopback_host_cases(host, expected):
    assert is_loopback_host(host) is expected


def test_foreign_host_blocked_even_for_get():
    r = client.get("/api/settings", headers={"host": "evil.com"})
    assert r.status_code == 403
    assert r.json() == {"detail": "Forbidden host."}


def test_cross_origin_post_blocked():
    r = client.post("/api/settings/import", json=BODY,
                    headers={**LOCAL, "origin": "https://evil.com"})
    assert r.status_code == 403
    assert r.json() == {"detail": "Cross-origin request blocked."}
    assert not settings.CONFIG_PATH.exists()


def test_null_origin_post_blocked():
    r = client.post("/api/settings/import", json=BODY,
                    headers={**LOCAL, "origin": "null"})
    assert r.status_code == 403
    assert not settings.CONFIG_PATH.exists()


def test_sec_fetch_site_cross_site_blocked():
    r = client.post("/api/settings/import", json=BODY,
                    headers={**LOCAL, "sec-fetch-site": "cross-site"})
    assert r.status_code == 403
    assert not settings.CONFIG_PATH.exists()


def test_same_origin_post_allowed():
    r = client.post("/api/settings/import", json=BODY,
                    headers={**LOCAL, "origin": "http://127.0.0.1:8123"})
    assert r.status_code == 200


def test_localhost_other_port_origin_allowed():
    r = client.post("/api/settings/import", json=BODY,
                    headers={**LOCAL, "origin": "http://localhost:5173"})
    assert r.status_code == 200


def test_no_origin_post_allowed():
    assert client.post("/api/settings/import", json=BODY, headers=LOCAL).status_code == 200


def test_cross_origin_get_allowed_with_loopback_host():
    r = client.get("/api/settings", headers={**LOCAL, "origin": "https://evil.com"})
    assert r.status_code == 200


def test_static_files_not_guarded():
    assert client.get("/", headers={"host": "evil.com"}).status_code == 200
