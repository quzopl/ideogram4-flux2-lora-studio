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
