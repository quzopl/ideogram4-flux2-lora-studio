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


# --------------------------------------------------------------------------- #
# Framework v15 — konwerter promptów studia (aspect_ratio + HLD + composition)
# --------------------------------------------------------------------------- #

def test_v15_top_level_keys_and_order():
    raw = ('{"compositional_deconstruction":{"background":"a park","elements":[]},'
           '"high_level_description":"a dog runs","aspect_ratio":"16:9"}')
    obj = _loads(prompts.normalize_ideogram_v15(raw))
    assert list(obj.keys()) == [
        "aspect_ratio", "high_level_description", "compositional_deconstruction",
    ]
    assert obj["aspect_ratio"] == "16:9"


def test_v15_drops_legacy_style_description():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"a cat",'
           '"style_description":{"aesthetics":"cozy","lighting":"soft","photo":"50mm",'
           '"medium":"photograph","color_palette":["#AABBCC"]},'
           '"compositional_deconstruction":{"background":"room","elements":[]}}')
    obj = _loads(prompts.normalize_ideogram_v15(raw))
    assert "style_description" not in obj
    assert list(obj.keys()) == [
        "aspect_ratio", "high_level_description", "compositional_deconstruction",
    ]


def test_v15_aspect_ratio_from_px_size():
    raw = '{"size":"768x1024","high_level_description":"x"}'
    assert _loads(prompts.normalize_ideogram_v15(raw))["aspect_ratio"] == "3:4"


def test_v15_aspect_ratio_reduced():
    raw = '{"aspect_ratio":"1920:1080","high_level_description":"x"}'
    assert _loads(prompts.normalize_ideogram_v15(raw))["aspect_ratio"] == "16:9"


def test_v15_aspect_ratio_auto_or_missing_defaults():
    for raw in ('{"aspect_ratio":"auto","high_level_description":"x"}',
                '{"high_level_description":"x"}'):
        assert _loads(prompts.normalize_ideogram_v15(raw))["aspect_ratio"] == "1:1"


def test_v15_elements_key_order_no_palette():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"s",'
           '"compositional_deconstruction":{"background":"bg","elements":['
           '{"type":"obj","bbox":[10,20,30,40],"desc":"a sign","color_palette":["#AABBCC"]},'
           '{"type":"text","bbox":[1,2,3,4],"text":"STOP","desc":"red octagon"}]}}')
    els = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["elements"]
    assert list(els[0].keys()) == ["type", "bbox", "desc"]
    assert els[0] == {"type": "obj", "bbox": [10, 20, 30, 40], "desc": "a sign"}
    assert list(els[1].keys()) == ["type", "bbox", "text", "desc"]
    assert els[1]["text"] == "STOP"


def test_v15_bbox_reversed_coords_swapped():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"s",'
           '"compositional_deconstruction":{"background":"bg","elements":['
           '{"type":"obj","bbox":[900,800,100,200],"desc":"x"}]}}')
    el = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["elements"][0]
    assert el["bbox"] == [100, 200, 900, 800]


def test_v15_bad_bbox_dropped():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"s",'
           '"compositional_deconstruction":{"background":"bg","elements":['
           '{"type":"obj","bbox":[1,2,3],"desc":"x"}]}}')
    el = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["elements"][0]
    assert "bbox" not in el


def test_v15_text_multiline_preserved():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"s",'
           '"compositional_deconstruction":{"background":"bg","elements":['
           '{"type":"text","text":"ENTRE\\nVERSOS","desc":"hero title"}]}}')
    el = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["elements"][0]
    assert el["text"] == "ENTRE\nVERSOS"


def test_v15_fallback_on_invalid_json():
    out = prompts.normalize_ideogram_v15("totally not json")
    obj = _loads(out)
    assert obj["aspect_ratio"] == "1:1"
    assert obj["high_level_description"] == "totally not json"
    assert obj["compositional_deconstruction"]["elements"] == []


def test_v15_unwraps_double_encoded_hld():
    inner = ('{"aspect_ratio":"4:5","high_level_description":"a red fox",'
             '"compositional_deconstruction":{"background":"snowy field","elements":[]}}')
    raw = json.dumps({"high_level_description": inner})
    obj = _loads(prompts.normalize_ideogram_v15(raw))
    assert obj["aspect_ratio"] == "4:5"
    assert obj["high_level_description"] == "a red fox"
    assert obj["compositional_deconstruction"]["background"] == "snowy field"


def test_v15_unwraps_fenced_json_inside_hld():
    # Model potrafi owinąć właściwy JSON w ```json wewnątrz high_level_description.
    inner = ('```json {\\"aspect_ratio\\":\\"9:16\\",\\"high_level_description\\":'
             '\\"a seductive woman\\",\\"compositional_deconstruction\\":'
             '{\\"background\\":\\"neon street\\",\\"elements\\":[]}}```')
    raw = '{"aspect_ratio":"1:1","high_level_description":"' + inner + '"}'
    obj = _loads(prompts.normalize_ideogram_v15(raw))
    assert obj["aspect_ratio"] == "9:16"
    assert obj["high_level_description"] == "a seductive woman"
    assert obj["compositional_deconstruction"]["background"] == "neon street"


def test_v15_background_as_dict_flattened_to_prose():
    raw = ('{"aspect_ratio":"4:5","high_level_description":"a woman",'
           '"compositional_deconstruction":{"background":'
           '{"scene_light":"ambient neon glow","atmosphere":"urban night"},'
           '"elements":[]}}')
    bg = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["background"]
    assert bg == "ambient neon glow, urban night"
    assert "{" not in bg and "'" not in bg


def test_v15_desc_as_dict_flattened_to_prose():
    raw = ('{"aspect_ratio":"1:1","high_level_description":"s",'
           '"compositional_deconstruction":{"background":"bg","elements":['
           '{"type":"obj","desc":{"identity":"a red car","detail":"chrome trim"}}]}}')
    el = _loads(prompts.normalize_ideogram_v15(raw))["compositional_deconstruction"]["elements"][0]
    assert el["desc"] == "a red car, chrome trim"


def test_v15_unwraps_caption_wrapper():
    raw = ('{"caption":{"aspect_ratio":"9:16","high_level_description":"a tower",'
           '"compositional_deconstruction":{"background":"night sky","elements":[]}},'
           '"seed":42}')
    obj = _loads(prompts.normalize_ideogram_v15(raw))
    assert obj["aspect_ratio"] == "9:16"
    assert obj["high_level_description"] == "a tower"


def test_v15_compact_and_non_ascii():
    raw = '{"aspect_ratio":"1:1","high_level_description":"café in Łódź"}'
    out = prompts.normalize_ideogram_v15(raw)
    assert ", " not in out and ": " not in out
    assert "café" in out and "Łódź" in out


def test_build_ideogram_studio_v15_has_framework_rules():
    s = prompts.build_ideogram_studio_v15("expand", "auto")
    low = s.lower()
    assert "json" in low
    for token in ("aspect_ratio", "high_level_description",
                  "compositional_deconstruction", "bbox", "desc",
                  "transparent background"):
        assert token in s
    # v15: bez pól strukturalnych stylu, styl prozą
    assert "style_description" in s  # wymienione jako zakazane
    assert "warm" in low             # zakaz "warm" w gradacji foto
    assert "50" in s                 # limit słów HLD
    assert "0" in s and "1000" in s  # skala bboxów


def test_build_ideogram_studio_v15_refine_migrates_legacy():
    s = prompts.build_ideogram_studio_v15("refine", "person")
    low = s.lower()
    assert "refine" in low or "existing" in low or "repair" in low
    assert "style_description" in s


def test_build_v15_detail_directives():
    base = prompts.build_ideogram_studio_v15("expand", "auto")
    assert "DETAIL SETTINGS" not in base  # balanced = bez nadpisania
    s = prompts.build_ideogram_studio_v15(
        "expand", "auto", elements_detail="maximal", desc_detail="rich")
    assert "DETAIL SETTINGS" in s
    assert "10 to 16" in s and "60-word" in s
    few = prompts.build_ideogram_studio_v15("expand", "auto", elements_detail="few")
    assert "2 to 3" in few


def test_inject_trigger_works_on_v15_json():
    base = prompts.normalize_ideogram_v15(
        '{"aspect_ratio":"1:1","high_level_description":"a person stands"}')
    out = prompts.inject_trigger_ideogram(base, "ohwx person")
    obj = _loads(out)
    assert obj["high_level_description"] == "ohwx person, a person stands"
    assert obj["aspect_ratio"] == "1:1"
