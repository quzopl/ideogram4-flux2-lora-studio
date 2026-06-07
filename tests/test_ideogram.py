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
