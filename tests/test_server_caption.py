import json
from backend import server


def _export_req(**kw):
    base = dict(job_id="j", trigger="ohwx person", prepend_trigger=True,
                captions={}, exclude_idx=[])
    base.update(kw)
    return server.ExportRequest(**base)


def test_final_caption_flux_prepends_trigger():
    req = _export_req()
    r = {"idx": 0, "caption": "a man waves", "format": "flux"}
    assert server._final_caption(req, r) == "ohwx person, a man waves"


def test_final_caption_ideogram_injects_into_hld():
    cap = '{"high_level_description":"a man waves"}'
    req = _export_req()
    r = {"idx": 0, "caption": cap, "format": "ideogram"}
    out = server._final_caption(req, r)
    assert out.startswith("{")
    assert json.loads(out)["high_level_description"] == "ohwx person, a man waves"


def test_final_caption_no_trigger():
    req = _export_req(prepend_trigger=False)
    r = {"idx": 0, "caption": "a man waves", "format": "flux"}
    assert server._final_caption(req, r) == "a man waves"


def test_caption_output_files_flux_txt_only():
    files = server._caption_output_files("person_0000", "a man waves", "flux")
    names = [n for n, _ in files]
    assert names == ["person_0000.txt"]
    assert files[0][1] == "a man waves\n"


def test_caption_output_files_ideogram_txt_and_json():
    cap = '{"high_level_description":"x"}'
    files = server._caption_output_files("person_0000", cap, "ideogram")
    names = [n for n, _ in files]
    assert names == ["person_0000.txt", "person_0000.json"]
    assert files[0][1] == cap + "\n"
    assert json.loads(files[1][1])["high_level_description"] == "x"


def test_caption_output_files_ideogram_invalid_skips_json():
    files = server._caption_output_files("p", "not json", "ideogram")
    names = [n for n, _ in files]
    assert names == ["p.txt"]


def test_caption_output_files_aitoolkit_txt_only():
    cap = '{"high_level_description":"x"}'
    files = server._caption_output_files("person_0000", cap, "aitoolkit")
    names = [n for n, _ in files]
    assert names == ["person_0000.txt"]          # ai-toolkit = sam .txt, bez .json
    assert files[0][1] == cap + "\n"


def test_final_caption_aitoolkit_injects_into_hld():
    cap = '{"high_level_description":"a man waves"}'
    req = _export_req()
    r = {"idx": 0, "caption": cap, "format": "aitoolkit"}
    out = server._final_caption(req, r)
    assert out.startswith("{")
    assert json.loads(out)["high_level_description"] == "ohwx person, a man waves"
