"""Model downloads: target folder, progress, cancel, space checks, ensure_local.

No test touches the network. An autouse fixture stubs both network seams
(``_remote_size`` and ``_fetch``) and the HF cache lookups; tests that need a
different fake override them. The real ``_fetch`` (spawned child process plus
size polling in the parent) is exercised with ``_download`` swapped for the
module-level fakes below: the spawned child imports them from this module by
name, so they must stay top-level functions.
"""
from __future__ import annotations

import json
import multiprocessing
import re
import threading
import time
from pathlib import Path

import pytest

from backend import fsutil, settings
from backend import model_store as ms

QWEN7 = "Qwen/Qwen2.5-VL-7B-Instruct"
X4 = "realesrgan-x4"
X4_FILE = ("ai-forever/Real-ESRGAN", "RealESRGAN_x4.pth")
REAL_FETCH = ms._fetch
JOB_FIELDS = {"id", "model_id", "label", "dest", "state", "done_bytes", "total_bytes",
              "error", "path"}


def _no_network(entry, target_dir, token, progress):
    raise AssertionError("_fetch must be stubbed in this test")


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    monkeypatch.setattr(ms, "_hf_snapshot_path", lambda repo_id: None)
    monkeypatch.setattr(ms, "_hf_file_path", lambda repo_id, filename: None)
    monkeypatch.setattr(ms, "_remote_size", lambda entry, token: None)
    monkeypatch.setattr(ms, "_fetch", _no_network)
    ms.DOWNLOADS.clear()
    yield
    ms.DOWNLOADS.clear()


def _ctx(models_dir="") -> dict:
    return {"settings": {"models_dir": str(models_dir) if models_dir else "",
                         "model_locations": {}},
            "upscale_cfg": {"folder": "", "custom": []},
            "custom_vlms": {}}


def _write_snapshot(d: Path) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps({"model_type": "qwen2_5_vl"}))
    (d / "model.safetensors").write_bytes(b"x")
    return d


def _wait(job: dict, states, timeout: float = 5) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        cur = dict(ms.DOWNLOADS[job["id"]])
        if cur["state"] in states:
            return cur
        if time.monotonic() > deadline:
            pytest.fail(f"job stayed {cur['state']!r}, expected one of {sorted(states)}")
        time.sleep(0.01)


def _row(ctx: dict, model_id: str) -> dict:
    return next(e for e in ms.listing(ctx) if e["id"] == model_id)


# --------------------------------------------------------------------------- #
# Jobs (fake _fetch)
# --------------------------------------------------------------------------- #
def test_download_success_sets_location_and_marker(tmp_path, monkeypatch):
    md = tmp_path / "models"
    seen = {}

    def fetch(entry, target_dir, token, progress):
        seen.update(target=target_dir, token=token)
        return _write_snapshot(target_dir)

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = ms.start_download(QWEN7, str(md), _ctx(), token="hf_x")
    assert set(job) == JOB_FIELDS
    assert job["model_id"] == QWEN7 and job["dest"] == str(md)
    assert job["state"] in ("pending", "downloading")
    done = _wait(job, {"done"})
    target = md / ms.folder_name(QWEN7)
    assert seen == {"target": target, "token": "hf_x"}
    assert done["path"] == str(target) and done["error"] == ""
    assert (target / ms.MARKER).is_file()
    assert settings.load()["model_locations"][QWEN7] == str(target)
    row = _row(_ctx(md), QWEN7)
    assert row["status"] == "ready" and row["download"] is None


def test_progress_bytes_reported(tmp_path, monkeypatch):
    seen = []

    def fetch(entry, target_dir, token, progress):
        for done in (50, 100):
            progress(done, 100)
            j = next(iter(ms.DOWNLOADS.values()))
            seen.append((j["state"], j["done_bytes"], j["total_bytes"]))
        return _write_snapshot(target_dir)

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = ms.start_download(QWEN7, str(tmp_path / "models"), _ctx())
    done = _wait(job, {"done"})
    assert seen == [("downloading", 50, 100), ("downloading", 100, 100)]
    assert (done["done_bytes"], done["total_bytes"]) == (100, 100)


def test_cancel_leaves_no_marker(tmp_path, monkeypatch):
    md = tmp_path / "models"

    def fetch(entry, target_dir, token, progress):
        (target_dir / "config.json").write_text("{}")
        for _ in range(1000):
            progress(1, 10)
            time.sleep(0.005)
        raise AssertionError("progress never raised DownloadCancelled")

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = ms.start_download(QWEN7, str(md), _ctx())
    _wait(job, {"downloading"})
    assert ms.cancel_download(job["id"])["id"] == job["id"]
    _wait(job, {"cancelled"})
    target = md / ms.folder_name(QWEN7)
    assert target.is_dir() and not (target / ms.MARKER).exists()
    assert QWEN7 not in settings.load()["model_locations"]
    row = _row(_ctx(md), QWEN7)
    assert row["status"] == "missing" and row["download"] is None
    with pytest.raises(KeyError):
        ms.cancel_download("no-such-job")


def test_fetch_error_sets_error_state(tmp_path, monkeypatch):
    md = tmp_path / "models"

    def fetch(entry, target_dir, token, progress):
        raise RuntimeError("401 Client Error: gated repo")

    monkeypatch.setattr(ms, "_fetch", fetch)
    job = ms.start_download(QWEN7, str(md), _ctx())
    done = _wait(job, {"error"})
    assert "gated repo" in done["error"]
    assert not (md / ms.folder_name(QWEN7) / ms.MARKER).exists()
    assert QWEN7 not in settings.load()["model_locations"]
    with pytest.raises(RuntimeError, match="gated repo"):
        ms.ensure_local(QWEN7, _ctx(md))


def test_not_enough_space_message_has_gb(tmp_path, monkeypatch):
    md = tmp_path / "models"
    monkeypatch.setattr(ms, "_remote_size", lambda entry, token: int(16.6e9))
    monkeypatch.setattr(fsutil, "free_bytes", lambda path: int(3.2e9))
    expected = f"Not enough space in {md}: needs 16.6 GB, 3.2 GB free."
    with pytest.raises(ValueError, match=f"^{re.escape(expected)}$"):
        ms.start_download(QWEN7, str(md), _ctx())
    assert ms.DOWNLOADS == {}


def test_unknown_size_skips_space_check(tmp_path, monkeypatch):
    monkeypatch.setattr(fsutil, "free_bytes", lambda path: 0)
    monkeypatch.setattr(ms, "_fetch", lambda e, target_dir, tok, p: _write_snapshot(target_dir))
    job = ms.start_download(QWEN7, str(tmp_path / "models"), _ctx())
    assert _wait(job, {"done", "error"})["state"] == "done"


def test_unwritable_dest_rejected(tmp_path):
    blocker = tmp_path / "a-file"
    blocker.write_text("")
    with pytest.raises(ValueError, match="Cannot create folder"):
        ms.start_download(QWEN7, str(blocker / "models"), _ctx())
    with pytest.raises(ValueError, match="absolute"):
        ms.start_download(QWEN7, "relative/models", _ctx())
    assert ms.DOWNLOADS == {}


def test_start_download_rejects_unknown_and_local_models(tmp_path):
    md = str(tmp_path / "models")
    with pytest.raises(KeyError):
        ms.start_download("no/such-model", md, _ctx())
    with pytest.raises(KeyError):
        ms.ensure_local("no/such-model", _ctx(md))
    custom = {**_ctx(), "custom_vlms": {str(tmp_path / "my-vlm"): "Mine"}}
    with pytest.raises(ValueError, match="cannot be downloaded"):
        ms.start_download(str(tmp_path / "my-vlm"), md, custom)
    assert ms.DOWNLOADS == {}


def test_same_model_twice_returns_same_job(tmp_path, monkeypatch):
    md = tmp_path / "models"
    release = threading.Event()

    def fetch(entry, target_dir, token, progress):
        release.wait(5)
        return _write_snapshot(target_dir)

    monkeypatch.setattr(ms, "_fetch", fetch)
    a = ms.start_download(QWEN7, str(md), _ctx())
    b = ms.start_download(QWEN7, str(md), _ctx())
    assert a["id"] == b["id"] and len(ms.DOWNLOADS) == 1
    row = _row(_ctx(md), QWEN7)
    assert row["status"] == "downloading" and row["download"]["id"] == a["id"]
    release.set()
    assert _wait(a, {"done", "error"})["state"] == "done"


# --------------------------------------------------------------------------- #
# ensure_local
# --------------------------------------------------------------------------- #
def test_ensure_local_raises_when_models_dir_unset():
    assert issubclass(ms.ModelsFolderNotSet, RuntimeError)
    msg = "No models folder chosen — set one in Settings (Models folder)."
    with pytest.raises(ms.ModelsFolderNotSet, match=f"^{re.escape(msg)}$"):
        ms.ensure_local(QWEN7, _ctx())
    assert ms.DOWNLOADS == {}


def test_ensure_local_downloads_into_models_dir_and_reports_progress(tmp_path, monkeypatch):
    md = tmp_path / "models"
    monkeypatch.setattr(ms, "_remote_size", lambda entry, token: 100)
    half_seen = threading.Event()

    def fetch(entry, target_dir, token, progress):
        progress(50, 0)  # the real _fetch knows no total: _remote_size supplies it
        half_seen.wait(5)
        f = target_dir / entry["filename"]
        f.write_bytes(b"w")
        progress(100, 0)
        return f

    calls = []

    def on_progress(done, total):
        calls.append((done, total))
        if done == 50:
            half_seen.set()

    monkeypatch.setattr(ms, "_fetch", fetch)
    path = ms.ensure_local(X4, _ctx(md), on_progress=on_progress)
    f = md / ms.folder_name(X4_FILE[0]) / X4_FILE[1]
    assert path == str(f) and f.is_file()
    assert (50, 100) in calls and calls[-1] == (100, 100)
    assert not (f.parent / ms.MARKER).exists()
    assert settings.load()["model_locations"][X4] == str(f)


def test_ensure_local_passthrough_absolute_and_lmstudio(tmp_path):
    assert ms.ensure_local("/abs/custom/model", _ctx()) == "/abs/custom/model"
    assert ms.ensure_local("lmstudio:qwen2.5-vl-7b", _ctx()) == "lmstudio:qwen2.5-vl-7b"
    md = tmp_path / "models"
    target = _write_snapshot(md / ms.folder_name(QWEN7))
    (target / ms.MARKER).write_text("")
    assert ms.ensure_local(QWEN7, _ctx(md)) == str(target)
    assert ms.DOWNLOADS == {}


# --------------------------------------------------------------------------- #
# Real _fetch: spawned child, size polling, terminate on cancel
# --------------------------------------------------------------------------- #
def _child_writes_then_hangs(entry: dict, target_dir: str, token: str) -> None:
    Path(target_dir, "part.incomplete").write_bytes(b"x" * 1000)
    time.sleep(60)


def _child_fails(entry: dict, target_dir: str, token: str) -> None:
    raise RuntimeError("401 Client Error: gated repo")


def _child_writes_file(entry: dict, target_dir: str, token: str) -> None:
    Path(target_dir, entry["filename"]).write_bytes(b"w" * 10)


def test_fetch_cancel_terminates_child_process(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "_download", _child_writes_then_hangs)
    seen = []

    def progress(done, total):
        seen.append(done)
        if done >= 1000:
            raise ms.DownloadCancelled()

    t0 = time.monotonic()
    with pytest.raises(ms.DownloadCancelled):
        REAL_FETCH(ms.find(QWEN7, _ctx()), tmp_path, "", progress)
    assert time.monotonic() - t0 < 30  # the child sleeps 60 s unless terminated
    assert seen[-1] == 1000
    assert multiprocessing.active_children() == []


def test_fetch_child_error_becomes_runtime_error(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "_download", _child_fails)
    with pytest.raises(RuntimeError, match="gated repo"):
        REAL_FETCH(ms.find(QWEN7, _ctx()), tmp_path, "", lambda done, total: None)


def test_fetch_child_success_returns_file_path(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "_download", _child_writes_file)
    entry = ms.find(X4, _ctx())
    assert REAL_FETCH(entry, tmp_path, "", lambda done, total: None) == tmp_path / X4_FILE[1]
    assert (tmp_path / X4_FILE[1]).read_bytes() == b"w" * 10
