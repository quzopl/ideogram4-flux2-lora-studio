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
