import pydantic
import pytest
from PIL import Image

from backend import api_upscale, core, upscaler


def test_target_factor_3():
    assert api_upscale._upscale_target((500, 250), "factor", 0, 4, 3.0) == (1500, 750)


def test_target_factor_15():
    assert api_upscale._upscale_target((400, 200), "factor", 0, 4, 1.5) == (600, 300)


@pytest.mark.parametrize("scale,factor,passes", [(4, 3, 1), (2, 3, 2), (2, 8, 2), (4, 4, 1)])
def test_passes_for_factor(scale, factor, passes):
    tgt = api_upscale._upscale_target((500, 250), "factor", 0, scale, float(factor))
    assert upscaler.plan_passes((500, 250), tgt, scale, min_ratio=1.0) == passes


@pytest.mark.parametrize("bad", [{"factor": 1.0}, {"factor": 9}, {"mode": "x5"}])
def test_request_validation(bad):
    with pytest.raises(pydantic.ValidationError):
        api_upscale.UpscaleRunRequest(folder="/x", model_id="m", **bad)


def _run_job(tmp_path, monkeypatch, entry, factor, model_scale=None):
    src = tmp_path / "src"
    src.mkdir()
    Image.new("RGB", (100, 50), "red").save(src / "a.png")
    monkeypatch.setattr(core, "WORK", tmp_path / "work")
    monkeypatch.setattr(core, "_ensure_model", lambda mid, job: "/fake")
    monkeypatch.setattr(upscaler, "resolve", lambda mid, cfg: dict(entry))
    monkeypatch.setattr(upscaler, "load_config", lambda p: {})
    monkeypatch.setattr(api_upscale, "_resolve_device", lambda v: ("cpu", "CPU"))
    if model_scale is not None:
        monkeypatch.setattr(upscaler, "model_scale",
                            lambda e, token="", device=None: model_scale)
    scale = entry["scale"] or model_scale
    monkeypatch.setattr(
        upscaler, "upscale",
        lambda img, e, passes, token="", device=None: img.resize(
            (img.width * scale ** passes, img.height * scale ** passes)))
    job_id = "test-upscale-factor-job"
    core.JOBS[job_id] = {"id": job_id, "kind": "upscale", "state": "pending",
                           "total": 1, "processed": 0, "current": "", "error": "",
                           "config": {}, "results": []}
    try:
        req = api_upscale.UpscaleRunRequest(folder=str(src), model_id="m",
                                       mode="factor", factor=factor)
        api_upscale._run_upscale_job(job_id, req, [src / "a.png"])
        assert core.JOBS[job_id]["state"] == "done", core.JOBS[job_id]["error"]
        return core.JOBS[job_id]["results"][0]
    finally:
        del core.JOBS[job_id]


def test_job_x3_exact_size_and_passes(tmp_path, monkeypatch):
    res = _run_job(tmp_path, monkeypatch, {"id": "f", "scale": 4}, 3.0)
    assert (res["width"], res["height"]) == (300, 150) and res["passes"] == 1


def test_job_local_model_uses_real_scale(tmp_path, monkeypatch):
    res = _run_job(tmp_path, monkeypatch,
                   {"id": "local:/m/x.pth", "scale": 0, "path": "/m/x.pth"},
                   4.0, model_scale=2)
    assert res["passes"] == 2 and (res["width"], res["height"]) == (400, 200)
