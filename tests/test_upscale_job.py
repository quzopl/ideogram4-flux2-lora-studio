from pathlib import Path

import pytest
from fastapi import HTTPException

from backend import server


def test_upscale_target_native_scale():
    assert server._upscale_target((500, 250), "native", 0, 4) == (2000, 1000)


def test_upscale_target_fixed_x2():
    assert server._upscale_target((500, 250), "x2", 0, 4) == (1000, 500)


def test_upscale_target_long_side():
    assert server._upscale_target((500, 250), "long_side", 2000, 4) == (2000, 1000)


def test_upscale_target_long_side_uses_taller_edge():
    assert server._upscale_target((250, 500), "long_side", 2000, 4) == (1000, 2000)


def test_upscale_target_never_shrinks_below_source():
    assert server._upscale_target((2000, 1000), "long_side", 500, 4) == (2000, 1000)


def test_upscale_run_request_defaults():
    r = server.UpscaleRunRequest(folder="/tmp/x", model_id="m")
    assert r.mode == "native"
    assert r.fmt == "png"


def test_upscale_out_name_distinct_for_same_stem_different_ext():
    # photo.jpg and photo.png in the same source folder must not collide.
    a = server._upscale_out_name(0, Path("/tmp/src/photo.jpg"), "png")
    b = server._upscale_out_name(1, Path("/tmp/src/photo.png"), "png")
    assert a != b


def _upscale_job(job_id: str, **overrides) -> None:
    job = {"id": job_id, "state": "done", "total": 0, "processed": 0,
           "current": "", "error": "", "config": {}, "results": [],
           "kind": "upscale"}
    job.update(overrides)
    server.JOBS[job_id] = job


def test_upscale_export_rejects_empty_output_folder():
    job_id = "test-upscale-empty-folder"
    _upscale_job(job_id)
    try:
        req = server.UpscaleExportRequest(job_id=job_id, output_folder="   ")
        with pytest.raises(HTTPException) as exc:
            server.api_upscale_export(req)
        assert exc.value.status_code == 400
    finally:
        del server.JOBS[job_id]


def test_upscale_export_rejects_unfinished_job(tmp_path):
    job_id = "test-upscale-not-done"
    _upscale_job(job_id, state="processing")
    try:
        req = server.UpscaleExportRequest(job_id=job_id, output_folder=str(tmp_path))
        with pytest.raises(HTTPException) as exc:
            server.api_upscale_export(req)
        assert exc.value.status_code == 400
    finally:
        del server.JOBS[job_id]


def test_api_job_rejects_upscale_kind_job():
    job_id = "test-api-job-upscale-kind"
    _upscale_job(job_id)
    try:
        with pytest.raises(HTTPException) as exc:
            server.api_job(job_id)
        assert exc.value.status_code == 404
    finally:
        del server.JOBS[job_id]


def test_api_job_rejects_crop_auto_job():
    job_id = "test-api-job-crop-auto"
    server.JOBS[job_id] = {
        "id": job_id, "kind": "crop_auto", "state": "done", "total": 0,
        "processed": 0, "current": "", "error": "", "crops": {}, "skipped": [],
    }
    try:
        with pytest.raises(HTTPException) as exc:
            server.api_job(job_id)
        assert exc.value.status_code == 404
    finally:
        del server.JOBS[job_id]


def test_upscale_zip_rejects_unfinished_job():
    # A mid-run download would silently produce a partial archive.
    job_id = "test-upscale-zip-not-done"
    _upscale_job(job_id, state="processing")
    try:
        with pytest.raises(HTTPException) as exc:
            server.api_upscale_zip(job_id)
        assert exc.value.status_code == 400
    finally:
        del server.JOBS[job_id]


def test_export_rejects_a_job_of_another_kind(tmp_path):
    # A crop-auto id used to reach job["results"] and blow up with a KeyError.
    job_id = "test-export-crop-auto"
    server.JOBS[job_id] = {
        "id": job_id, "kind": "crop_auto", "state": "done", "total": 0,
        "processed": 0, "current": "", "error": "", "crops": {}, "skipped": [],
    }
    try:
        req = server.ExportRequest(job_id=job_id, output_folder=str(tmp_path))
        with pytest.raises(HTTPException) as exc:
            server.api_export(req)
        assert exc.value.status_code == 404
        with pytest.raises(HTTPException) as exc:
            server.api_zip(req)
        assert exc.value.status_code == 404
    finally:
        del server.JOBS[job_id]


def test_upscale_job_endpoint_rejects_dataset_job():
    job_id = "test-upscale-endpoint-dataset"
    server.JOBS[job_id] = {
        "id": job_id, "kind": "dataset", "state": "done", "total": 0,
        "processed": 0, "current": "", "error": "", "config": {}, "results": [],
    }
    try:
        with pytest.raises(HTTPException) as exc:
            server.api_upscale_job(job_id)
        assert exc.value.status_code == 404
    finally:
        del server.JOBS[job_id]
