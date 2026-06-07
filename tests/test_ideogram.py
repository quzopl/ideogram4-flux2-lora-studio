import json
from backend import prompts


def _loads(s):
    return json.loads(s)


def test_normalize_orders_top_level_keys():
    raw = ('{"compositional_deconstruction":{"background":"a park",'
           '"elements":[]},"high_level_description":"a dog runs",'
           '"style_description":{"medium":"DSLR","aesthetics":"candid",'
           '"lighting":"daylight","photo":"35mm"}}')
    out = prompts.normalize_ideogram(raw)
    assert list(_loads(out).keys()) == [
        "high_level_description", "style_description",
        "compositional_deconstruction",
    ]
    assert list(_loads(out)["style_description"].keys()) == [
        "aesthetics", "lighting", "photo", "medium",
    ]


def test_normalize_compact_separators():
    raw = '{"high_level_description":"x"}'
    out = prompts.normalize_ideogram(raw)
    assert ", " not in out and ": " not in out


def test_normalize_elements_obj_and_text():
    raw = ('{"high_level_description":"scene","compositional_deconstruction":'
           '{"background":"bg","elements":[{"type":"obj","description":"a car"},'
           '{"type":"text","content":"STOP"}]}}')
    els = _loads(prompts.normalize_ideogram(raw))["compositional_deconstruction"]["elements"]
    assert els[0] == {"type": "obj", "description": "a car"}
    assert els[1] == {"type": "text", "content": "STOP"}


def test_normalize_art_style_when_present():
    raw = ('{"high_level_description":"painting","style_description":'
           '{"aesthetics":"baroque","lighting":"chiaroscuro",'
           '"art_style":"oil painting","medium":"canvas"}}')
    sd = _loads(prompts.normalize_ideogram(raw))["style_description"]
    assert "art_style" in sd and "photo" not in sd
    assert list(sd.keys()) == ["aesthetics", "lighting", "art_style", "medium"]


def test_normalize_salvages_surrounding_text():
    raw = 'Here is the JSON:\n{"high_level_description":"hi"}\nThanks!'
    out = prompts.normalize_ideogram(raw)
    assert _loads(out)["high_level_description"] == "hi"


def test_normalize_fallback_on_invalid_json():
    raw = "just a plain sentence, not json at all"
    out = prompts.normalize_ideogram(raw)
    obj = _loads(out)
    assert obj["high_level_description"] == raw
    assert obj["compositional_deconstruction"]["background"] == raw
    assert obj["compositional_deconstruction"]["elements"] == []


def test_normalize_defaults_photo_when_style_incomplete():
    raw = '{"high_level_description":"x","style_description":{"aesthetics":"clean"}}'
    sd = _loads(prompts.normalize_ideogram(raw))["style_description"]
    assert list(sd.keys()) == ["aesthetics", "lighting", "photo", "medium"]
    assert sd["lighting"] == "" and sd["photo"] == "" and sd["medium"] == ""


def test_inject_trigger_into_high_level_description():
    base = prompts.normalize_ideogram('{"high_level_description":"a person stands"}')
    out = prompts.inject_trigger_ideogram(base, "ohwx person")
    assert _loads(out)["high_level_description"] == "ohwx person, a person stands"
    assert out.startswith("{")


def test_inject_trigger_noop_on_invalid_json():
    assert prompts.inject_trigger_ideogram("not json", "ohwx") == "not json"


def test_inject_trigger_empty_noop():
    base = prompts.normalize_ideogram('{"high_level_description":"x"}')
    assert prompts.inject_trigger_ideogram(base, "") == base


def test_ideogram_pretty_valid():
    base = prompts.normalize_ideogram('{"high_level_description":"x"}')
    pretty = prompts.ideogram_pretty(base)
    assert pretty is not None
    assert "\n" in pretty
    assert _loads(pretty)["high_level_description"] == "x"


def test_ideogram_pretty_invalid_returns_none():
    assert prompts.ideogram_pretty("not json") is None


def test_get_ideogram_prompt_person_skips_identity():
    p = prompts.get_ideogram_prompt("person")
    low = p.lower()
    assert "json" in low
    assert "high_level_description" in p
    assert "style_description" in p
    assert "compositional_deconstruction" in p
    assert "identity" in low or "tożsam" in low or "likeness" in low


def test_get_ideogram_prompt_generic_default():
    p = prompts.get_ideogram_prompt("nonexistent-mode")
    assert "json" in p.lower()


def test_build_ideogram_studio_system_actions():
    expand = prompts.build_ideogram_studio_system("expand", "auto")
    refine = prompts.build_ideogram_studio_system("refine", "person")
    assert "json" in expand.lower() and "json" in refine.lower()
    assert "high_level_description" in expand
    assert "refine" in refine.lower() or "existing" in refine.lower() or "tag" in refine.lower()


def test_inject_trigger_when_hld_missing():
    base = prompts.normalize_ideogram('{"compositional_deconstruction":{"background":"a park"}}')
    out = prompts.inject_trigger_ideogram(base, "ohwx person")
    assert _loads(out)["high_level_description"] == "ohwx person"


def test_normalize_obj_with_stray_content_key_stays_obj():
    # explicit type="obj" must win even if a spurious "content" key is present
    raw = ('{"high_level_description":"s","compositional_deconstruction":'
           '{"background":"bg","elements":[{"type":"obj","description":"a sign","content":"STOP"}]}}')
    el = _loads(prompts.normalize_ideogram(raw))["compositional_deconstruction"]["elements"][0]
    assert el == {"type": "obj", "description": "a sign"}


def test_normalize_text_content_null_becomes_empty():
    raw = ('{"high_level_description":"s","compositional_deconstruction":'
           '{"background":"bg","elements":[{"type":"text","content":null}]}}')
    el = _loads(prompts.normalize_ideogram(raw))["compositional_deconstruction"]["elements"][0]
    assert el == {"type": "text", "content": ""}


def test_person_detail_mode_covers_marks():
    # FLUX i Ideogram: tryb "person_detail" wymienia znaki szczególne
    for p in (prompts.get_prompt("person_detail"),
              prompts.get_ideogram_prompt("person_detail")):
        low = p.lower()
        assert "scar" in low and "mole" in low and "tattoo" in low
        assert "hair" in low


def test_caption_instruction_routes_by_fmt():
    assert prompts.caption_instruction("person", "concise", "flux") == prompts.get_prompt("person", "concise")
    assert prompts.caption_instruction("person", "concise", "ideogram") == prompts.get_ideogram_prompt("person")
    assert prompts.caption_instruction("person", "concise", "aitoolkit") == prompts.get_ideogram_prompt("person")


def test_postprocess_caption_routes_by_fmt():
    ideo = prompts.postprocess_caption('{"high_level_description":"x"}', "ideogram")
    assert _loads(ideo)["high_level_description"] == "x"
    flux = prompts.postprocess_caption("The image shows a cat.", "flux")
    assert not flux.lower().startswith("the image shows")


def test_postprocess_caption_aitoolkit():
    out = prompts.postprocess_caption('{"high_level_description":"y"}', "aitoolkit")
    assert _loads(out)["high_level_description"] == "y"


def test_upper_hex_list_filters_and_uppercases():
    assert prompts._upper_hex_list(["#aabbcc", "#FFF", "x", "#001122"]) == ["#AABBCC", "#001122"]
    assert prompts._upper_hex_list("nope") is None
    assert prompts._upper_hex_list(["#fff"]) is None


def test_guide_photo_style_order():
    raw = ('{"high_level_description":"a cat","style_description":'
           '{"lighting":"soft","aesthetics":"cozy","medium":"photograph",'
           '"photo":"50mm","color_palette":["#aabbcc"]},'
           '"compositional_deconstruction":{"background":"room","elements":[]}}')
    sd = _loads(prompts.normalize_ideogram_guide(raw))["style_description"]
    assert list(sd.keys()) == ["aesthetics", "lighting", "photo", "medium", "color_palette"]
    assert sd["color_palette"] == ["#AABBCC"]


def test_guide_non_photo_style_order():
    raw = ('{"high_level_description":"a knight","style_description":'
           '{"aesthetics":"epic","lighting":"chiaroscuro","art_style":"oil painting",'
           '"medium":"painting","color_palette":["#102030"]},'
           '"compositional_deconstruction":{"background":"hall","elements":[]}}')
    sd = _loads(prompts.normalize_ideogram_guide(raw))["style_description"]
    assert list(sd.keys()) == ["aesthetics", "lighting", "medium", "art_style", "color_palette"]
    assert "photo" not in sd


def test_guide_elements_obj_and_text_keys():
    raw = ('{"high_level_description":"s","compositional_deconstruction":{"background":"bg",'
           '"elements":[{"type":"obj","bbox":[10,20,30,40],"description":"a sign"},'
           '{"type":"text","bbox":[1,2,3,4],"text":"STOP","desc":"red octagon"}]}}')
    els = _loads(prompts.normalize_ideogram_guide(raw))["compositional_deconstruction"]["elements"]
    assert list(els[0].keys()) == ["type", "bbox", "desc"]
    assert els[0] == {"type": "obj", "bbox": [10, 20, 30, 40], "desc": "a sign"}
    assert list(els[1].keys()) == ["type", "bbox", "text", "desc"]
    assert els[1]["text"] == "STOP"


def test_guide_bad_bbox_dropped():
    raw = ('{"high_level_description":"s","compositional_deconstruction":{"background":"bg",'
           '"elements":[{"type":"obj","bbox":[1,2,3],"desc":"x"}]}}')
    el = _loads(prompts.normalize_ideogram_guide(raw))["compositional_deconstruction"]["elements"][0]
    assert "bbox" not in el


def test_guide_fallback_on_invalid_json():
    out = prompts.normalize_ideogram_guide("totally not json")
    obj = _loads(out)
    assert obj["high_level_description"] == "totally not json"
    assert obj["compositional_deconstruction"]["elements"] == []


def test_build_ideogram_studio_guide_has_guide_rules():
    s = prompts.build_ideogram_studio_guide("expand", "auto")
    low = s.lower()
    assert "json" in low
    for token in ("bbox", "color_palette", "art_style", "desc"):
        assert token in s
