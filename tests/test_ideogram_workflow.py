import json
from backend import ideogram_workflow as iw


V15 = ('{"aspect_ratio":"3:2","high_level_description":"a red fox in a meadow",'
       '"compositional_deconstruction":{"background":"a sunlit meadow","elements":[]}}')


def _nodes_by_type(wf, class_type):
    return [n for n in wf.values() if n["class_type"] == class_type]


def test_compute_dims_reference_value():
    # Value verified against Ideogrammar: 3:2 @ 2MP -> 1776x1184.
    assert iw.compute_dims("3:2", 2.0) == (1776, 1184)


def test_compute_dims_square_and_multiples():
    w, h = iw.compute_dims("1:1", 2.0)
    assert w == h and w % 16 == 0


def test_compute_dims_portrait_taller():
    w, h = iw.compute_dims("9:16", 2.0)
    assert h > w


def test_orientation_lead():
    assert iw.orientation_lead("3:2", 1776, 1184).startswith("LANDSCAPE")
    assert iw.orientation_lead("9:16", 1184, 2096).startswith("PORTRAIT")
    assert iw.orientation_lead("1:1", 1456, 1456).startswith("SQUARE")
    lead = iw.orientation_lead("3:2", 1776, 1184)
    assert "1776x1184" in lead and "do not rotate" in lead


def test_build_render_text_prefixes_lead_and_keeps_json():
    txt = iw.build_render_text(V15)
    assert txt.startswith("LANDSCAPE")
    assert V15 in txt


def test_build_workflow_injects_prompt_and_dims():
    wf = iw.build_workflow(V15, {})
    enc = _nodes_by_type(wf, "CLIPTextEncode")[0]
    assert "a red fox" in enc["inputs"]["text"]
    assert enc["inputs"]["text"].startswith("LANDSCAPE")
    latent = _nodes_by_type(wf, "EmptyFlux2LatentImage")[0]
    assert (latent["inputs"]["width"], latent["inputs"]["height"]) == (1776, 1184)


def test_build_workflow_presets():
    wf = iw.build_workflow(V15, {"preset": "Quality", "variant": "ideogram4"})
    sched = _nodes_by_type(wf, "Ideogram4Scheduler")[0]
    assert sched["inputs"]["steps"] == 48
    assert sched["inputs"]["std"] == 1.5
    wf = iw.build_workflow(V15, {"preset": "Turbo", "variant": "ideogram4"})
    sched = _nodes_by_type(wf, "Ideogram4Scheduler")[0]
    assert sched["inputs"]["steps"] == 12 and sched["inputs"]["mu"] == 0.5


def test_build_workflow_simple_variant():
    wf = iw.build_workflow(V15, {"variant": "simple"})
    assert _nodes_by_type(wf, "ModelSamplingAuraFlow")
    assert _nodes_by_type(wf, "BasicScheduler")
    assert not _nodes_by_type(wf, "Ideogram4Scheduler")
    assert _nodes_by_type(wf, "KSamplerSelect")[0]["inputs"]["sampler_name"] == "euler"


def test_build_workflow_ideogram4_variant_default_sampler():
    wf = iw.build_workflow(V15, {"variant": "ideogram4"})
    assert _nodes_by_type(wf, "KSamplerSelect")[0]["inputs"]["sampler_name"] == "res_multistep"


def test_build_workflow_seed_and_batch():
    wf = iw.build_workflow(V15, {"seed": 12345, "batch_size": 3})
    assert _nodes_by_type(wf, "RandomNoise")[0]["inputs"]["noise_seed"] == 12345
    assert _nodes_by_type(wf, "EmptyFlux2LatentImage")[0]["inputs"]["batch_size"] == 3


def test_build_workflow_lora_splice():
    wf = iw.build_workflow(V15, {"lora_enabled": True, "lora_name": "my.safetensors",
                                 "lora_strength": 0.8, "variant": "simple"})
    lora = _nodes_by_type(wf, "LoraLoaderModelOnly")[0]
    assert lora["inputs"]["lora_name"] == "my.safetensors"
    assert lora["inputs"]["strength_model"] == 0.8
    # the diffusion model's consumer (AuraFlow in the simple variant) points at the LoRA
    aura = _nodes_by_type(wf, "ModelSamplingAuraFlow")[0]
    lora_id = next(k for k, n in wf.items() if n["class_type"] == "LoraLoaderModelOnly")
    assert aura["inputs"]["model"][0] == lora_id
    # and the LoRA takes the model from the diffusion loader, not from itself
    diff_id = lora["inputs"]["model"][0]
    assert wf[diff_id]["class_type"] == "UNETLoader"


def test_build_workflow_no_lora_by_default():
    wf = iw.build_workflow(V15, {})
    assert not _nodes_by_type(wf, "LoraLoaderModelOnly")


def test_build_workflow_negative_path_untouched_by_lora():
    wf = iw.build_workflow(V15, {"lora_enabled": True, "lora_name": "x.safetensors"})
    guider = _nodes_by_type(wf, "DualModelGuider")[0]
    uncond_id = guider["inputs"]["model_negative"][0]
    assert wf[uncond_id]["class_type"] == "UNETLoader"


def test_build_workflow_fallback_ratio_when_missing():
    wf = iw.build_workflow('{"high_level_description":"x"}', {})
    latent = _nodes_by_type(wf, "EmptyFlux2LatentImage")[0]
    assert latent["inputs"]["width"] == latent["inputs"]["height"]  # 1:1


def test_render_endpoint_rejects_bad_prompt():
    import pytest
    from fastapi import HTTPException
    from backend import server
    with pytest.raises(HTTPException):
        server.api_ideogram_render(server.IdeogramRenderRequest(prompt="not json"))


def test_render_endpoint_starts_job(tmp_path, monkeypatch):
    from backend import server
    monkeypatch.setattr(server, "IDEOGRAM_RENDER_CFG_PATH", tmp_path / "r.json")
    captured = {}
    monkeypatch.setattr(server, "_run_comfy_raw_job",
                        lambda job_id, wf: captured.update(job=job_id, wf=wf))
    out = server.api_ideogram_render(server.IdeogramRenderRequest(
        prompt=V15, params={"preset": "Default", "seed": 7}))
    assert out["job_id"]
    assert isinstance(out["warnings"], list)
    # the job is registered in the shared ComfyUI machinery
    job = server.COMFY_JOBS.pop(out["job_id"])
    assert job["state"] in ("pending", "running", "done")
    # the parameters persist for the next render
    saved = server.api_ideogram_render_config()["params"]
    assert saved["preset"] == "Default" and saved["seed"] == 7
    # the workflow handed to the runner contains the prompt
    import time
    for _ in range(50):
        if captured.get("wf"):
            break
        time.sleep(0.05)
    enc = [n for n in captured["wf"].values() if n["class_type"] == "CLIPTextEncode"][0]
    assert "a red fox" in enc["inputs"]["text"]


def test_render_params_sanitized():
    p = iw.merge_params({"megapixels": 99, "batch_size": 0, "preset": "weird",
                         "lora_strength": 50})
    assert 0.1 <= p["megapixels"] <= 4
    assert p["batch_size"] == 1
    assert p["preset"] in iw.PRESETS
    assert -10 <= p["lora_strength"] <= 10
