from PIL import Image

from backend import server


def test_process_request_upscale_defaults():
    r = server.ProcessRequest(folder="/tmp/x")
    assert r.upscale_model == ""
    assert r.upscale_min_ratio == 1.05


def test_upscale_hook_skips_when_target_is_smaller():
    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05,
                               run=lambda img, entry, passes: img)
    img = Image.new("RGB", (2000, 1000))
    out = hook(img, (1024, 512))
    assert out is img
    assert hook.used is False


def test_upscale_hook_runs_and_marks_used():
    calls = {}

    def run(img, entry, passes):
        calls["passes"] = passes
        return img.resize((img.width * 4, img.height * 4))

    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05, run=run)
    out = hook(Image.new("RGB", (256, 256)), (1024, 1024))
    assert calls["passes"] == 1
    assert out.size == (1024, 1024)
    assert hook.used is True


def test_upscale_hook_falls_back_on_error():
    def boom(img, entry, passes):
        raise RuntimeError("CUDA out of memory")

    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05, run=boom)
    img = Image.new("RGB", (256, 256))
    out = hook(img, (1024, 1024))
    assert out is img                  # obraz przechodzi dalej nietknięty
    assert hook.used is False
    assert "CUDA out of memory" in hook.error


def test_job_public_exposes_upscaled_flag():
    job = {
        "id": "j", "state": "done", "total": 1, "processed": 1, "current": "",
        "error": "", "config": {},
        "results": [{"idx": 0, "src_name": "a.png", "out_name": "person_0000.png",
                     "width": 1024, "height": 1024, "caption": "x",
                     "upscaled": True}],
    }
    pub = server._job_public(job)
    assert pub["results"][0]["upscaled"] is True
