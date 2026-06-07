# Guide-compliant Ideogram prompt converter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sprawić, by konwerter promptów (Generator promptów, format Ideogram/ai-toolkit) generował pełny JSON Ideogram 4 zgodny z przewodnikiem (bbox, color_palette, foto/nie-foto, desc/text).

**Architecture:** Nowa para w `prompts.py` — bogata instrukcja `build_ideogram_studio_guide` + normalizator `normalize_ideogram_guide` — używana wyłącznie przez `api_prompt` dla formatów JSON. Istniejące `build_ideogram_studio_system` i `normalize_ideogram` (dataset, pragmatyczne) zostają nietknięte.

**Tech Stack:** Python (json, re), FastAPI; testy: pytest (`.venv/bin/python -m pytest`).

**Spec:** `docs/superpowers/specs/2026-06-07-ideogram-prompt-converter-guide-design.md`

---

### Task 1: `prompts.py` — guide normalizer + guide instruction

**Files:**
- Modify: `backend/prompts.py` (dodać `import re` na górze; dopisać helpery + 2 funkcje publiczne)
- Test: `tests/test_ideogram.py` (dopisać)

- [ ] **Step 1: Dopisz failujące testy** na końcu `tests/test_ideogram.py`:
```python
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
```

- [ ] **Step 2: Uruchom — fail.** `.venv/bin/python -m pytest tests/test_ideogram.py -q` → brak `_upper_hex_list`/`normalize_ideogram_guide`.

- [ ] **Step 3: Dodaj `import re`.** Na górze `backend/prompts.py`, zaraz po `import json`, dodaj:
```python
import re
```

- [ ] **Step 4: Dodaj helpery + normalizator.** Na końcu `backend/prompts.py` dopisz:
```python
# =========================================================================== #
# Ideogram 4 — pełny schemat wg przewodnika (konwerter promptów tekst->JSON).
# Osobny od pragmatycznego normalize_ideogram (ten zostaje dla opisów datasetu).
# =========================================================================== #
_HEX6_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _upper_hex_list(value) -> list | None:
    """Lista poprawnych kolorów #RRGGBB WIELKIMI literami; None gdy brak/niepoprawne."""
    if not isinstance(value, list):
        return None
    out = []
    for c in value:
        if isinstance(c, str) and _HEX6_RE.match(c.strip()):
            out.append("#" + c.strip()[1:].upper())
    return out or None


def _norm_bbox(value):
    """bbox = lista 4 liczb -> [int,int,int,int]; inaczej None."""
    if isinstance(value, list) and len(value) == 4:
        try:
            return [int(v) for v in value]
        except (TypeError, ValueError):
            return None
    return None


def _norm_style_guide(raw_style) -> dict:
    """style_description w kolejności zależnej od foto/nie-foto (wg przewodnika)."""
    raw = raw_style if isinstance(raw_style, dict) else {}
    style: dict = {}
    if "aesthetics" in raw:
        style["aesthetics"] = str(raw.get("aesthetics", "")).strip()
    if "lighting" in raw:
        style["lighting"] = str(raw.get("lighting", "")).strip()
    is_photo = "photo" in raw or "art_style" not in raw
    if is_photo:
        if "photo" in raw:
            style["photo"] = str(raw.get("photo", "")).strip()
        if "medium" in raw:
            style["medium"] = str(raw.get("medium", "")).strip()
    else:
        if "medium" in raw:
            style["medium"] = str(raw.get("medium", "")).strip()
        style["art_style"] = str(raw.get("art_style", "")).strip()
    pal = _upper_hex_list(raw.get("color_palette"))
    if pal is not None:
        style["color_palette"] = pal
    return style


def _norm_elements_guide(raw_elements) -> list:
    """Elementy w ścisłej kolejności kluczy: obj=type,bbox,desc,color_palette;
    text=type,bbox,text,desc,color_palette."""
    out: list[dict] = []
    if not isinstance(raw_elements, list):
        return out
    for el in raw_elements:
        if not isinstance(el, dict):
            continue
        etype = el.get("type")
        is_text = etype == "text" or (etype != "obj" and "text" in el)
        new: dict = {"type": "text" if is_text else "obj"}
        bbox = _norm_bbox(el.get("bbox"))
        if bbox is not None:
            new["bbox"] = bbox
        if is_text:
            new["text"] = str(el.get("text", "")).strip()
        new["desc"] = str(el.get("desc", el.get("description", ""))).strip()
        pal = _upper_hex_list(el.get("color_palette"))
        if pal is not None:
            new["color_palette"] = pal
        out.append(new)
    return out


def normalize_ideogram_guide(raw: str) -> str:
    """Surowe wyjście modelu -> kompaktowy JSON Ideogram zgodny z przewodnikiem."""
    obj = _extract_json_object(raw)
    if obj is None:
        text = " ".join(raw.strip().split())
        return _compact({
            "high_level_description": text,
            "compositional_deconstruction": {"background": text, "elements": []},
        })
    comp_raw = obj.get("compositional_deconstruction")
    comp_raw = comp_raw if isinstance(comp_raw, dict) else {}
    result: dict = {
        "high_level_description": str(obj.get("high_level_description", "")).strip(),
    }
    if "style_description" in obj:
        result["style_description"] = _norm_style_guide(obj.get("style_description"))
    result["compositional_deconstruction"] = {
        "background": str(comp_raw.get("background", "")).strip(),
        "elements": _norm_elements_guide(comp_raw.get("elements")),
    }
    return _compact(result)
```
(Reużywa istniejących `_extract_json_object` i `_compact`.)

- [ ] **Step 5: Dodaj instrukcję studia wg przewodnika.** Na końcu `backend/prompts.py` dopisz:
```python
_IDEOGRAM_GUIDE_BASE = (
    "You are a prompt engineer for the Ideogram 4 text-to-image model, which was trained "
    "on structured JSON captions with a strict key order."
)

_IDEOGRAM_GUIDE_SCHEMA = (
    " Convert the user's prompt into ONE Ideogram 4 JSON object and output JSON only, no "
    "prose. Top-level keys in this exact order: \"high_level_description\" (one or two "
    "sentences, the anchor), \"style_description\", \"compositional_deconstruction\". First "
    "decide PHOTO vs NON-PHOTO from the prompt's cues. For a photo use the key \"photo\" "
    "with \"medium\":\"photograph\" and order style_description keys as: aesthetics, "
    "lighting, photo, medium, color_palette. For a painting/illustration/3D render use "
    "\"art_style\" (never \"photo\") with a matching \"medium\" and order: aesthetics, "
    "lighting, medium, art_style, color_palette. Never use photo and art_style together. "
    "Describe lighting in rich detail. compositional_deconstruction must have \"background\" "
    "(before \"elements\") and \"elements\". Break every salient object into its own "
    "element. A literal, legible piece of text to render is a {\"type\":\"text\",\"bbox\":"
    "[y,x,y,x],\"text\":\"EXACT STRING\",\"desc\":\"...\"} element; decorative/illegible "
    "signs stay as {\"type\":\"obj\",\"bbox\":[y,x,y,x],\"desc\":\"...\"}. Give hard-to-"
    "render objects (barbell, weapon, hands) their own element; stretch atmosphere layers "
    "(haze, dust, cracks) over a large bbox. Bounding boxes are [y_min, x_min, y_max, "
    "x_max] on a 0-1000 scale, origin top-left, Y FIRST; foreground low in frame (high y), "
    "background high (low y). Colors: a \"color_palette\" array of UPPERCASE hex "
    "\"#RRGGBB\" (no shorthand), up to 16 globally and up to 5 per element, including "
    "shadows, highlights and accents. Element key order is strict — obj: type, bbox, desc, "
    "color_palette; text: type, bbox, text, desc, color_palette. Resolve contradictions "
    "deliberately instead of passing the conflict on (e.g. f/1.4 on a full body -> "
    "f/1.8-2.8; \"oil impasto\" with a 50mm lens -> pick one mode and drop the conflicting "
    "wording). Add texture cues for realism (skin pores, film grain, wet metal sheen). Keep "
    "any LoRA token exactly as given and place it at the start of the main element's desc "
    "and in high_level_description; when converting a painting to a photo, drop a painterly "
    "style trigger. Output ONLY the JSON object."
)


def build_ideogram_studio_guide(action: str = "expand", subject: str = "auto") -> str:
    """System-prompt konwertera tekst->Ideogram JSON wg pełnego przewodnika."""
    act = _IDEOGRAM_STUDIO_ACTION.get(action, _IDEOGRAM_STUDIO_ACTION["expand"])
    subj = _STUDIO_SUBJECT.get(subject, "")
    return _IDEOGRAM_GUIDE_BASE + act + subj + _IDEOGRAM_GUIDE_SCHEMA
```
(Reużywa `_IDEOGRAM_STUDIO_ACTION` i `_STUDIO_SUBJECT`.)

- [ ] **Step 6: Uruchom — pass.** `.venv/bin/python -m pytest tests/test_ideogram.py -q` (oczekiwane: wszystkie przechodzą).

- [ ] **Step 7: Commit**
```bash
git add backend/prompts.py tests/test_ideogram.py
git commit -m "feat: guide-compliant Ideogram JSON normalizer + studio instruction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Podłącz w `api_prompt` (tylko Generator promptów)

**Files:**
- Modify: `backend/server.py` (`api_prompt`)

- [ ] **Step 1: Użyj guide-pary dla formatów JSON.** W `backend/server.py` `api_prompt` zamień EXACTLY:
```python
        if req.caption_format in ("ideogram", "aitoolkit"):
            system = prompts.build_ideogram_studio_system(req.action, req.subject)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        lm_id = _lmstudio_model_id(req.model)
        if lm_id is not None:
            raw = lmstudio.generate_text(_lmstudio_url(), lm_id, system, text, req.max_tokens)
        else:
            captioner.ensure_loaded(req.model, quant)
            raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format in ("ideogram", "aitoolkit"):
            return {"prompt": prompts.normalize_ideogram(raw)}
        return {"prompt": prompts.clean_prompt(raw)}
```
na:
```python
        if req.caption_format in ("ideogram", "aitoolkit"):
            system = prompts.build_ideogram_studio_guide(req.action, req.subject)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        lm_id = _lmstudio_model_id(req.model)
        if lm_id is not None:
            raw = lmstudio.generate_text(_lmstudio_url(), lm_id, system, text, req.max_tokens)
        else:
            captioner.ensure_loaded(req.model, quant)
            raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format in ("ideogram", "aitoolkit"):
            return {"prompt": prompts.normalize_ideogram_guide(raw)}
        return {"prompt": prompts.clean_prompt(raw)}
```

- [ ] **Step 2: Pełny suite + import.**
```bash
.venv/bin/python -m pytest -q
.venv/bin/python -c "import backend.server"
```
Expected: wszystkie PASS; import OK.

- [ ] **Step 3: Commit**
```bash
git add backend/server.py
git commit -m "feat: prompt studio uses guide Ideogram converter for JSON formats

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Weryfikacja na żywym serwerze

**Files:** brak (weryfikacja)

- [ ] **Step 1: Restart.**
```bash
cd ~/wsl/flux-lora-prep
pkill -9 -f "uvicorn backend.server" 2>/dev/null; sleep 1
./run.sh > .work/server.log 2>&1 &
sleep 4 && curl -sf -o /dev/null http://127.0.0.1:8023/ && echo UP
```

- [ ] **Step 2: Konwersja Ideogram przez model lokalny 3B (jest pobrany).**
```bash
curl -s -X POST http://127.0.0.1:8023/api/prompt \
  -H 'Content-Type: application/json' \
  -d '{"text":"a man doing a mirror selfie in a pink t-shirt, neon sign BART on the wall","action":"expand","subject":"person","model":"Qwen/Qwen2.5-VL-3B-Instruct","quant":"4bit","caption_format":"ideogram"}' \
  --max-time 300 | python3 -c "
import sys, json
d = json.load(sys.stdin)
obj = json.loads(d['prompt'])
print('TOP KEYS:', list(obj.keys()))
sd = obj.get('style_description', {})
print('STYLE KEYS:', list(sd.keys()))
print('VALID JSON OK')
"
```
Expected: `TOP KEYS: ['high_level_description', 'style_description', 'compositional_deconstruction']`; `STYLE KEYS` w kolejności foto lub nie-foto z przewodnika; „VALID JSON OK". (Jeśli VRAM zajęty przez ComfyUI i 4bit nie wejdzie — odnotuj; logika i tak pokryta testami jednostkowymi.)

- [ ] **Step 3: Regresja FLUX (bez zmian).**
```bash
curl -s -X POST http://127.0.0.1:8023/api/prompt \
  -H 'Content-Type: application/json' \
  -d '{"text":"a cat on a sofa","action":"expand","subject":"auto","model":"Qwen/Qwen2.5-VL-3B-Instruct","quant":"4bit","caption_format":"flux"}' \
  --max-time 300 | python3 -c "import sys,json;p=json.load(sys.stdin)['prompt'];print('FLUX = proza, nie JSON:', not p.lstrip().startswith('{')); print(p[:120])"
```
Expected: `True` (FLUX nadal zwraca prozę).

- [ ] **Step 4: Commit (jeśli były poprawki)**
```bash
git add -A
git commit -m "test: verify guide Ideogram converter end-to-end

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (autor planu)

- **Pokrycie spec:** instrukcja guide (T1 Step 5), normalizator guide z foto/nie-foto + element keys + hex + bbox + fallback (T1 Step 4), helper `_upper_hex_list` (T1), podłączenie tylko w `api_prompt` dla JSON (T2), dataset/FLUX bez zmian (T2 zostawia build_studio_system/clean_prompt; normalize_ideogram nietknięty), e2e + regresja FLUX (T3). Wszystkie 6 kryteriów akceptacji ma task.
- **Brak placeholderów:** każdy krok ma pełny kod/komendę i oczekiwany wynik.
- **Spójność typów:** `_upper_hex_list`, `_norm_bbox`, `_norm_style_guide`, `_norm_elements_guide`, `normalize_ideogram_guide`, `build_ideogram_studio_guide` (reużywają `_extract_json_object`, `_compact`, `_IDEOGRAM_STUDIO_ACTION`, `_STUDIO_SUBJECT`) — nazwy spójne między taskami i z istniejącym kodem.
