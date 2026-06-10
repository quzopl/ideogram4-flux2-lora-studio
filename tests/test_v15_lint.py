import json
from backend import v15_lint


def _lint(obj) -> list:
    return v15_lint.lint_v15(json.dumps(obj))


def _msgs(findings) -> str:
    return " | ".join(f["msg"] for f in findings)


def _ok_caption(**over):
    base = {
        "aspect_ratio": "4:5",
        "high_level_description": "A street musician plays an accordion on a cobbled square.",
        "compositional_deconstruction": {
            "background": "an old town square at dusk, sandstone facades, overcast daylight",
            "elements": [
                {"type": "obj", "bbox": [100, 250, 990, 750],
                 "desc": "a street musician in a brown jacket playing a red accordion"},
            ],
        },
    }
    base.update(over)
    return base


def test_clean_caption_has_no_findings():
    assert _lint(_ok_caption()) == []


def test_invalid_json_is_single_error():
    out = v15_lint.lint_v15("not json at all")
    assert len(out) == 1 and out[0]["level"] == "err"


def test_bad_aspect_ratio():
    out = _lint(_ok_caption(aspect_ratio="auto"))
    assert any(f["level"] == "err" and "aspect_ratio" in f["msg"] for f in out)


def test_hld_over_50_words():
    out = _lint(_ok_caption(high_level_description="word " * 51))
    assert any("50" in f["msg"] for f in out)


def test_hld_meta_opening():
    out = _lint(_ok_caption(high_level_description="This image shows a musician."))
    assert any("subject" in f["msg"] for f in out)


def test_warm_grading_flagged():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["background"] = "warm light over the square"
    assert any("warm" in f["msg"] for f in _lint(cap))


def test_camera_language_in_desc_is_error():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"][0]["desc"] = \
        "a musician with creamy bokeh behind him"
    out = _lint(cap)
    assert any(f["level"] == "err" and "camera" in f["msg"] for f in out)


def test_floor_as_element_is_error():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"].append(
        {"type": "obj", "desc": "wet rain-slicked pavement with neon puddles"})
    out = _lint(cap)
    assert any(f["level"] == "err" and "background" in f["msg"] for f in out)


def test_hedging_flagged():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"][0]["desc"] = \
        "a table with various objects such as cups"
    assert any("hedging" in f["msg"].lower() for f in _lint(cap))


def test_legacy_style_description_flagged():
    cap = _ok_caption()
    cap["style_description"] = {"aesthetics": "moody"}
    assert any("style_description" in f["msg"] for f in _lint(cap))


def test_desc_over_60_words():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"][0]["desc"] = "word " * 61
    assert any("60" in f["msg"] for f in _lint(cap))


def test_bad_bbox_order_is_error():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"][0]["bbox"] = [990, 250, 100, 750]
    out = _lint(cap)
    assert any(f["level"] == "err" and "bbox" in f["msg"] for f in out)


def test_empty_text_element():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["elements"].append(
        {"type": "text", "text": "", "desc": "a sign"})
    assert any("text" in f["msg"] for f in _lint(cap))


def test_built_environment_without_text_warns():
    cap = _ok_caption(
        high_level_description="A cozy cafe storefront with a chalkboard menu by the door.")
    assert any("text" in f["msg"] for f in _lint(cap))


def test_arranged_furniture_in_background_is_error():
    cap = _ok_caption()
    cap["compositional_deconstruction"]["background"] = \
        "a classroom with rows of desks receding toward the back wall"
    out = _lint(cap)
    assert any(f["level"] == "err" for f in out)
