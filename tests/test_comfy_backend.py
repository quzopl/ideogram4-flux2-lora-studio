"""v2 ComfyUI backend: English messages, gallery order and source, atomic config
updates, object_info cache control and library names."""
import io
import json
import threading
import time
import urllib.error
import urllib.request

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import api_comfy, comfy_client, core, server

client = TestClient(server.app)

pytestmark = pytest.mark.usefixtures("comfy_store")

API_WF = {
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["4", 0]}},
    "3": {"class_type": "KSampler", "inputs": {"seed": 5, "steps": 20, "cfg": 7.0,
                                              "positive": ["6", 0]}},
}
V15 = json.dumps({"aspect_ratio": "1:1", "high_level_description": "a fox",
                  "compositional_deconstruction": {"background": "snow", "elements": []}})


class _SyncThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._t, self._a, self._k = target, args, kwargs or {}

    def start(self):
        self._t(*self._a, **self._k)


def _png(w=80, h=60) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "red").save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def fake_comfy(monkeypatch):
    """ComfyUI that renders one 80x60 image; object_info counts its calls."""
    calls = {"object_info": 0}

    def object_info(url):
        calls["object_info"] += 1
        return {"n": calls["object_info"], "url": url}

    monkeypatch.setattr(comfy_client, "object_info", object_info)
    monkeypatch.setattr(comfy_client, "queue_prompt", lambda url, wf, client_id=None: "P1")
    monkeypatch.setattr(comfy_client, "stream_events",
                        lambda url, cid, pid, on_event, **kw: on_event("done", None))
    monkeypatch.setattr(comfy_client, "history", lambda url, pid: {
        "P1": {"outputs": {"9": {"images": [{"filename": "out.png"}]}}}})
    monkeypatch.setattr(comfy_client, "fetch_image", lambda *a, **k: _png())
    return calls


def _job(jid="j"):
    job = {"id": jid, "state": "pending", "total": 1, "done_count": 0, "current": "",
           "current_node": "", "progress": {"value": 0, "max": 0}, "preview": None,
           "preview_ts": 0, "images": [], "error": "", "cancel": False}
    core.COMFY_JOBS[jid] = job
    return job


def _upload_workflow():
    r = client.post("/api/comfy/workflow",
                    files={"file": ("wf.json", json.dumps(API_WF).encode(), "application/json")})
    assert r.status_code == 200, r.text
    return r.json()


def _sidecar(item_id, **meta):
    (core.COMFY_GALLERY_DIR / f"{item_id}.json").write_text(
        json.dumps({"id": item_id, "url": f"/api/comfy/gallery/{item_id}", **meta}),
        encoding="utf-8")


def _gallery():
    r = client.get("/api/comfy/gallery")
    assert r.status_code == 200, r.text
    return r.json()["items"]


def _sidecars():
    return [json.loads(p.read_text(encoding="utf-8"))
            for p in core.COMFY_GALLERY_DIR.glob("*.json")]


# --------------------------------------------------------------------------- #
# English messages
# --------------------------------------------------------------------------- #
def test_polish_messages_translated():
    r = client.post("/api/comfy/mapping", json={"mapping": {}})
    assert r.status_code == 400
    assert r.json()["detail"] == "Upload a workflow first."

    r = client.get("/api/comfy/workflows/nope")
    assert r.status_code == 404
    assert r.json()["detail"] == "Unknown workflow."

    r = client.post("/api/comfy/generate", json={"prompt": "p"})
    assert r.status_code == 400
    assert r.json()["detail"] == "Upload a workflow first (LoRA test → Workflow)."


def test_comfy_client_http_error_is_english(monkeypatch):
    def urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, io.BytesIO(b"bad"))
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    with pytest.raises(comfy_client.ComfyError) as e:
        comfy_client._request("http://c/x")
    assert str(e.value) == "HTTP 500 from http://c/x: bad"


# --------------------------------------------------------------------------- #
# Gallery
# --------------------------------------------------------------------------- #
def test_gallery_sorted_by_ts_desc():
    # File-name order (a, b, c) differs from ts order on purpose.
    _sidecar("a", ts=1)
    _sidecar("b", ts=3)
    _sidecar("c", ts=2)
    _sidecar("0", source="editor")  # no ts: last
    _sidecar("e", ts=2)             # tie with "c": by id
    assert [m["id"] for m in _gallery()] == ["b", "c", "e", "a", "0"]


def test_gallery_source_defaults():
    _sidecar("old", ts=1)
    _sidecar("ed", ts=2, source="editor")
    _sidecar("ide", ts=3, source="ideogram")
    by_id = {m["id"]: m for m in _gallery()}
    assert by_id["old"]["source"] == "lora_test"
    assert by_id["ed"]["source"] == "editor"
    assert by_id["ide"]["source"] == "ideogram"
    assert "width" not in by_id["old"]  # legacy items without a size still list


def test_raw_runner_source_param():
    job = _job()
    api_comfy._run_comfy_raw_job("j", dict(API_WF), source="ideogram")
    assert job["state"] == "done", job["error"]
    [meta] = _sidecars()
    assert meta["source"] == "ideogram"
    assert (meta["width"], meta["height"]) == (80, 60)
    assert job["images"][0]["source"] == "ideogram"


def test_raw_runner_defaults_to_editor():
    job = _job()
    api_comfy._run_comfy_raw_job("j", dict(API_WF))
    assert job["state"] == "done", job["error"]
    [meta] = _sidecars()
    assert meta["source"] == "editor"


def test_lora_runner_labels_source_and_size():
    _upload_workflow()
    job = _job()
    api_comfy._run_comfy_job("j", api_comfy.ComfyGenerateRequest(prompt="p", steps=4))
    assert job["state"] == "done", job["error"]
    [meta] = _sidecars()
    assert meta["source"] == "lora_test"
    assert (meta["width"], meta["height"]) == (80, 60)


def test_runner_tolerates_undecodable_image(monkeypatch):
    monkeypatch.setattr(comfy_client, "fetch_image", lambda *a, **k: b"not an image")
    job = _job()
    api_comfy._run_comfy_raw_job("j", dict(API_WF))
    assert job["state"] == "done", job["error"]
    [meta] = _sidecars()
    assert "width" not in meta and "height" not in meta


def test_ideogram_render_labels_source(monkeypatch):
    monkeypatch.setattr(threading, "Thread", _SyncThread)
    r = client.post("/api/ideogram/render", json={"prompt": V15, "params": {}})
    assert r.status_code == 200, r.text
    job = core.COMFY_JOBS[r.json()["job_id"]]
    assert job["state"] == "done", job["error"]
    [meta] = _sidecars()
    assert meta["source"] == "ideogram"
    assert [m["source"] for m in _gallery()] == ["ideogram"]


# --------------------------------------------------------------------------- #
# comfy_config.json: atomic, locked read-modify-write
# --------------------------------------------------------------------------- #
def test_comfy_config_concurrent_updates_keep_all(monkeypatch):
    _upload_workflow()
    real_load = api_comfy._load_comfy_config

    def slow_load():  # widens the read-modify-write window
        cfg = real_load()
        time.sleep(0.03)
        return cfg
    monkeypatch.setattr(api_comfy, "_load_comfy_config", slow_load)

    urls = [f"http://h{i}:8188" for i in range(10)]
    mappings = [{"prompt_node": "6", "prompt_field": "text", "tag": i} for i in range(10)]
    barrier = threading.Barrier(20)
    statuses: list[int] = []

    def worker(i):
        barrier.wait()
        if i % 2:
            r = client.post("/api/comfy/url", json={"url": urls[i // 2]})
        else:
            r = client.post("/api/comfy/mapping", json={"mapping": mappings[i // 2]})
        statuses.append(r.status_code)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert statuses == [200] * 20
    cfg = json.loads(core.COMFY_CONFIG_PATH.read_text(encoding="utf-8"))
    assert cfg["workflow"] == API_WF
    assert cfg["url"] in urls
    assert cfg["mapping"] in mappings
    assert not list(core.COMFY_CONFIG_PATH.parent.glob("*.tmp"))


def test_update_comfy_config_aborts_without_writing():
    _upload_workflow()
    before = core.COMFY_CONFIG_PATH.read_text(encoding="utf-8")

    def boom(cfg):
        cfg["url"] = "http://changed"
        raise RuntimeError("no")
    with pytest.raises(RuntimeError):
        api_comfy._update_comfy_config(boom)
    assert core.COMFY_CONFIG_PATH.read_text(encoding="utf-8") == before


def test_editor_load_and_generate_persist_editor_workflow(monkeypatch):
    monkeypatch.setattr(threading, "Thread", _SyncThread)
    _upload_workflow()
    r = client.post("/api/comfy/editor/load",
                    files={"file": ("e.json", json.dumps(API_WF).encode(), "application/json")})
    assert r.status_code == 200, r.text
    edited = {**API_WF, "6": {**API_WF["6"], "inputs": {"text": "a dog", "clip": ["4", 0]}}}
    r = client.post("/api/comfy/editor/generate", json={"workflow": edited})
    assert r.status_code == 200, r.text
    cfg = json.loads(core.COMFY_CONFIG_PATH.read_text(encoding="utf-8"))
    assert cfg["editor_workflow"] == edited
    assert cfg["workflow"] == API_WF


# --------------------------------------------------------------------------- #
# object_info cache
# --------------------------------------------------------------------------- #
def test_url_change_clears_object_info_cache(fake_comfy):
    client.post("/api/comfy/url", json={"url": "http://c:8188"})
    assert client.get("/api/comfy/object_info").json()["n"] == 1
    assert client.get("/api/comfy/object_info").json()["n"] == 1  # cached
    # Same URL again (e.g. ComfyUI restarted with new nodes): fetch afresh.
    assert client.post("/api/comfy/url", json={"url": "http://c:8188"}).status_code == 200
    assert client.get("/api/comfy/object_info").json()["n"] == 2
    assert fake_comfy["object_info"] == 2


def test_object_info_refresh_bypasses_cache(fake_comfy):
    assert client.get("/api/comfy/object_info").json()["n"] == 1
    assert client.get("/api/comfy/object_info", params={"refresh": 1}).json()["n"] == 2
    assert client.get("/api/comfy/object_info").json()["n"] == 2  # the refreshed copy
    assert fake_comfy["object_info"] == 2


# --------------------------------------------------------------------------- #
# Library names
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("path,value", [
    ("/api/comfy/mappings", {"prompt_node": "6"}),
    ("/api/comfy/prompts", "a prompt"),
    ("/api/comfy/workflows", API_WF),
])
def test_library_names_reject_slash(path, value):
    r = client.post(path, json={"name": "a/b", "value": value})
    assert r.status_code == 400
    assert r.json()["detail"] == 'Name must not contain "/".'

    r = client.post(path, json={"name": "   ", "value": value})
    assert r.status_code == 400
    assert r.json()["detail"] == "Enter a name."

    r = client.post(path, json={"name": " ok ", "value": value})
    assert r.status_code == 200, r.text


def test_workflow_import_checks_a_typed_name():
    def post(name):
        files = {"file": ("from file.json", json.dumps(API_WF).encode(), "application/json")}
        return client.post("/api/comfy/workflows/import", files=files, data={"name": name})

    r = post("a/b")
    assert r.status_code == 400
    assert r.json()["detail"] == 'Name must not contain "/".'
    assert api_comfy._wf_names() == []

    r = post(" ok ")
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "ok"

    # No name typed: the file's name.
    r = post("   ")
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "from file"
    assert api_comfy._wf_names() == ["from file", "ok"]


def test_legacy_slash_names_still_deletable():
    core.COMFY_MAPPINGS_PATH.write_text(
        json.dumps({"a/b": {"prompt_node": "6"}, "keep": {}}), encoding="utf-8")
    r = client.delete("/api/comfy/mappings/a%2Fb")
    assert r.status_code == 200, r.text
    assert r.json()["items"] == {"keep": {}}

    core.COMFY_PROMPTS_PATH.write_text(json.dumps({"x/y": "p", "keep": "q"}),
                                         encoding="utf-8")
    r = client.delete("/api/comfy/prompts/x/y")
    assert r.status_code == 200, r.text
    assert r.json()["items"] == {"keep": "q"}

    api_comfy._wf_upsert("a/b", API_WF)
    r = client.get("/api/comfy/workflows/a%2Fb")
    assert r.status_code == 200, r.text
    assert r.json() == {"name": "a/b", "workflow": API_WF}
    r = client.delete("/api/comfy/workflows/a/b")
    assert r.status_code == 200, r.text
    assert "a/b" not in r.json()["names"]
    assert client.get("/api/comfy/workflows/a%2Fb").status_code == 404
