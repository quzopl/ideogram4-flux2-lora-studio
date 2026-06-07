# Ideogram 4 (opisy + prompty) i import HEIC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać Ideogram 4 jako format opisów datasetu i jako tryb Generatora promptów, oraz umożliwić import zdjęć HEIC/HEIF.

**Architecture:** VLM (Qwen2.5-VL) generuje treść; cała struktura/poprawność JSON Ideogram powstaje po stronie Pythona (czyste funkcje w `backend/prompts.py`, testowane jednostkowo). Serwer dokłada pola wyboru formatu i zapis `.txt`+`.json`. HEIC wpinany przez `pillow-heif` (rejestracja dekodera + rozszerzenia), bo dalszy pipeline i tak konwertuje do RGB→PNG/JPG.

**Tech Stack:** Python 3.12, FastAPI, Pillow + pillow-heif, transformers/Qwen2.5-VL, vanilla JS; testy: pytest (uruchamiane przez `uv`).

**Spec:** `docs/superpowers/specs/2026-06-07-ideogram4-captions-heic-design.md`

**Uwaga o uruchamianiu testów:** środowisko jest zarządzane przez `uv`; w `.venv` nie ma `pip`. Pytest instalujemy przez `VIRTUAL_ENV=.venv uv pip install pytest`, a testy uruchamiamy przez `.venv/bin/python -m pytest`.

**Uwaga o git:** repo nie jest gitem. Task 1 robi `git init`, dzięki czemu kroki „Commit" działają jako lokalne checkpointy (bez pushy na zewnątrz). Jeśli użytkownik nie chce historii git, pomiń kroki Commit.

---

### Task 1: Inicjalizacja repo i narzędzi testowych

**Files:**
- Create: `pytest.ini`
- Create: `tests/__init__.py`
- Modify: `requirements.txt`

- [ ] **Step 1: git init (lokalny checkpoint)**

```bash
cd ~/wsl/flux-lora-prep
git init
printf '%s\n' '.venv/' '__pycache__/' '*.pyc' '.work/' 'work/' '.pytest_cache/' > .gitignore
git add -A && git commit -m "chore: init git for plan execution

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 2: Zainstaluj pytest i pillow-heif**

Run:
```bash
VIRTUAL_ENV=.venv uv pip install pytest pillow-heif
```
Expected: instalacja kończy się sukcesem (pytest + pillow_heif dostępne).

- [ ] **Step 3: Dodaj pillow-heif do requirements.txt**

W sekcji `# Image processing` w `requirements.txt`, pod linią `pillow>=10.2.0`, dodaj:

```
pillow-heif>=0.16.0
```

- [ ] **Step 4: Utwórz konfigurację pytest i pakiet testów**

`pytest.ini`:
```ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -q
```

`tests/__init__.py`: (pusty plik)

- [ ] **Step 5: Sanity-check pytest**

Run:
```bash
.venv/bin/python -m pytest
```
Expected: `no tests ran` (kolekcja działa, 0 testów) — brak błędów konfiguracji.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt pytest.ini tests/__init__.py .gitignore
git commit -m "chore: add pytest + pillow-heif tooling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `normalize_ideogram` — parsowanie i kompaktowy JSON

**Files:**
- Modify: `backend/prompts.py` (dodanie funkcji + `import json` na górze)
- Test: `tests/test_ideogram.py`

- [ ] **Step 1: Napisz failujący test**

Utwórz `tests/test_ideogram.py`:
```python
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
    # ścisła kolejność kluczy top-level
    assert list(_loads(out).keys()) == [
        "high_level_description", "style_description",
        "compositional_deconstruction",
    ]
    # ścisła kolejność w style_description (photo, nie art_style)
    assert list(_loads(out)["style_description"].keys()) == [
        "aesthetics", "lighting", "photo", "medium",
    ]


def test_normalize_compact_separators():
    raw = '{"high_level_description":"x"}'
    out = prompts.normalize_ideogram(raw)
    assert ", " not in out and ": " not in out  # kompaktowy zapis


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
    obj = _loads(out)  # nadal poprawny JSON
    assert obj["high_level_description"] == raw
    assert obj["compositional_deconstruction"]["background"] == raw
    assert obj["compositional_deconstruction"]["elements"] == []


def test_normalize_defaults_photo_when_style_incomplete():
    raw = '{"high_level_description":"x","style_description":{"aesthetics":"clean"}}'
    sd = _loads(prompts.normalize_ideogram(raw))["style_description"]
    assert list(sd.keys()) == ["aesthetics", "lighting", "photo", "medium"]
    assert sd["lighting"] == "" and sd["photo"] == "" and sd["medium"] == ""
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: FAIL — `AttributeError: module 'backend.prompts' has no attribute 'normalize_ideogram'`.

- [ ] **Step 3: Zaimplementuj `normalize_ideogram`**

W `backend/prompts.py` dodaj na górze (po `from __future__`):
```python
import json
```

Na końcu pliku dodaj:
```python
# =========================================================================== #
# Ideogram 4 — strukturalne opisy JSON.
#
# Ideogram 4 był trenowany na opisach JSON o ścisłej kolejności kluczy i
# kompaktowym zapisie. Model (VLM/LLM) generuje treść, a poprawną strukturę
# składamy tutaj, w Pythonie — niezależnie od tego, co dokładnie zwróci model.
# =========================================================================== #
def _extract_json_object(raw: str) -> dict | None:
    """Wyłuskaj i sparsuj pierwszy obiekt {...} z surowego tekstu modelu."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(raw[start:end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _norm_elements(raw_elements) -> list[dict]:
    """Sprowadź listę elementów do {type:obj,description} / {type:text,content}."""
    out: list[dict] = []
    if not isinstance(raw_elements, list):
        return out
    for el in raw_elements:
        if not isinstance(el, dict):
            continue
        if el.get("type") == "text" or "content" in el:
            out.append({"type": "text", "content": str(el.get("content", "")).strip()})
        else:
            desc = el.get("description", el.get("name", ""))
            out.append({"type": "obj", "description": str(desc).strip()})
    return out


def _norm_style(raw_style) -> dict:
    """Złóż style_description w ścisłej kolejności z dokładnie jednym z photo/art_style."""
    raw_style = raw_style if isinstance(raw_style, dict) else {}
    style: dict = {
        "aesthetics": str(raw_style.get("aesthetics", "")).strip(),
        "lighting": str(raw_style.get("lighting", "")).strip(),
    }
    # Dokładnie jedno z photo / art_style. Domyślnie photo (dataset zdjęciowy).
    if "art_style" in raw_style and "photo" not in raw_style:
        style["art_style"] = str(raw_style.get("art_style", "")).strip()
    else:
        style["photo"] = str(raw_style.get("photo", "")).strip()
    style["medium"] = str(raw_style.get("medium", "")).strip()
    return style


def _compact(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def normalize_ideogram(raw: str) -> str:
    """Zamień surowe wyjście modelu na poprawny, kompaktowy JSON-string Ideogram.

    Buduje nowy obiekt o ścisłej kolejności kluczy. Gdy wejście nie zawiera
    poprawnego JSON-a, zawija tekst w minimalny poprawny schemat (fallback).
    """
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
        result["style_description"] = _norm_style(obj.get("style_description"))
    result["compositional_deconstruction"] = {
        "background": str(comp_raw.get("background", "")).strip(),
        "elements": _norm_elements(comp_raw.get("elements")),
    }
    return _compact(result)
```

- [ ] **Step 4: Uruchom test — ma przejść**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: PASS (7 testów).

- [ ] **Step 5: Commit**

```bash
git add backend/prompts.py tests/test_ideogram.py
git commit -m "feat: normalize_ideogram builds strict-order compact JSON

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `inject_trigger_ideogram` i `ideogram_pretty`

**Files:**
- Modify: `backend/prompts.py`
- Test: `tests/test_ideogram.py` (dopisanie testów)

- [ ] **Step 1: Dopisz failujące testy**

Dodaj na końcu `tests/test_ideogram.py`:
```python
def test_inject_trigger_into_high_level_description():
    base = prompts.normalize_ideogram('{"high_level_description":"a person stands"}')
    out = prompts.inject_trigger_ideogram(base, "ohwx person")
    assert _loads(out)["high_level_description"] == "ohwx person, a person stands"
    # nadal kompaktowy JSON, trigger NIE przed '{'
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
    assert "\n" in pretty  # ładnie sformatowany (indent)
    assert _loads(pretty)["high_level_description"] == "x"


def test_ideogram_pretty_invalid_returns_none():
    assert prompts.ideogram_pretty("not json") is None
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: FAIL — brak `inject_trigger_ideogram` / `ideogram_pretty`.

- [ ] **Step 3: Zaimplementuj obie funkcje**

W `backend/prompts.py`, po `normalize_ideogram`, dodaj:
```python
def inject_trigger_ideogram(json_str: str, trigger: str) -> str:
    """Wstaw trigger na początek high_level_description (nie przed cały JSON).

    Gdy wejście nie jest poprawnym JSON-em lub trigger pusty — zwróć bez zmian.
    """
    trigger = trigger.strip()
    if not trigger:
        return json_str
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return json_str
    if not isinstance(obj, dict):
        return json_str
    hld = str(obj.get("high_level_description", "")).strip()
    obj["high_level_description"] = f"{trigger}, {hld}" if hld else trigger
    return _compact(obj)


def ideogram_pretty(json_str: str) -> str | None:
    """Ładnie sformatowany obiekt JSON do pliku .json. None gdy wejście błędne."""
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    return json.dumps(obj, indent=2, ensure_ascii=False)
```

- [ ] **Step 4: Uruchom — ma przejść**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: PASS (12 testów łącznie).

- [ ] **Step 5: Commit**

```bash
git add backend/prompts.py tests/test_ideogram.py
git commit -m "feat: inject_trigger_ideogram + ideogram_pretty helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Instrukcje promptów Ideogram (opis z obrazu + studio tekstowe)

**Files:**
- Modify: `backend/prompts.py`
- Test: `tests/test_ideogram.py` (dopisanie testów)

- [ ] **Step 1: Dopisz failujące testy**

Dodaj na końcu `tests/test_ideogram.py`:
```python
def test_get_ideogram_prompt_person_skips_identity():
    p = prompts.get_ideogram_prompt("person")
    low = p.lower()
    assert "json" in low
    assert "high_level_description" in p
    assert "style_description" in p
    assert "compositional_deconstruction" in p
    # tryb person: pomijaj stałą tożsamość
    assert "identity" in low or "tożsam" in low or "likeness" in low


def test_get_ideogram_prompt_generic_default():
    # nieznany tryb nie wywala — schodzi do generic
    p = prompts.get_ideogram_prompt("nonexistent-mode")
    assert "json" in p.lower()


def test_build_ideogram_studio_system_actions():
    expand = prompts.build_ideogram_studio_system("expand", "auto")
    refine = prompts.build_ideogram_studio_system("refine", "person")
    assert "json" in expand.lower() and "json" in refine.lower()
    assert "high_level_description" in expand
    # refine wspomina o istniejącym/tagowym prompcie
    assert "refine" in refine.lower() or "existing" in refine.lower() or "tag" in refine.lower()
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: FAIL — brak `get_ideogram_prompt` / `build_ideogram_studio_system`.

- [ ] **Step 3: Zaimplementuj instrukcje**

W `backend/prompts.py` dodaj (np. po sekcji Ideogram normalize):
```python
# --- Instrukcja: opis obrazu jako JSON Ideogram 4 -------------------------- #
_IDEOGRAM_SCHEMA = (
    " Return ONLY one JSON object, nothing else, with exactly these top-level "
    "keys in this order: \"high_level_description\" (one or two sentences), "
    "\"style_description\" (an object with keys in this order: \"aesthetics\", "
    "\"lighting\", then exactly one of \"photo\" or \"art_style\" — use \"photo\" "
    "for photographs — then \"medium\"), and \"compositional_deconstruction\" "
    "(an object with \"background\" describing the setting and \"elements\", a "
    "list where each item is either {\"type\":\"obj\",\"description\":\"...\"} for "
    "an object or {\"type\":\"text\",\"content\":\"...\"} for visible text). Do not "
    "add any other keys, comments or prose outside the JSON."
)

_IDEOGRAM_FOCUS = {
    "person": (
        "Describe this image of a person as an Ideogram structured caption for "
        "training a LoRA of a specific person. Describe ONLY what varies between "
        "photos — pose, action, facial expression, gaze, all clothing and "
        "accessories, shot type, camera angle, background and lighting — and refer "
        "to the subject generically as \"the person\". Do NOT describe the person's "
        "permanent identity or likeness: skip facial features, face shape, eye and "
        "hair color, skin tone, body build and age, so the trigger word can absorb them."
    ),
    "architecture": (
        "Describe this building or structure as an Ideogram structured caption: the "
        "building type and architectural style, main materials and colors, notable "
        "features, surroundings, time of day, viewpoint and lighting."
    ),
    "landscape": (
        "Describe this landscape as an Ideogram structured caption: the type of "
        "scenery, terrain and landforms, vegetation and water, sky and weather, time "
        "of day and season, dominant colors and lighting."
    ),
    "generic": (
        "Describe this image as an Ideogram structured caption: the main subject and "
        "its key attributes, important secondary objects, colors and setting, framing, "
        "camera angle and lighting."
    ),
}


def get_ideogram_prompt(mode: str) -> str:
    focus = _IDEOGRAM_FOCUS.get(mode, _IDEOGRAM_FOCUS["generic"])
    return focus + _IDEOGRAM_SCHEMA


# --- Instrukcja: Generator promptów w trybie Ideogram (text-only) ---------- #
_IDEOGRAM_STUDIO_BASE = (
    "You are a prompt engineer for the Ideogram 4 text-to-image model, which was "
    "trained on structured JSON captions. You turn the user's input into one valid "
    "Ideogram JSON prompt."
)

_IDEOGRAM_STUDIO_ACTION = {
    "expand": (
        " The user gives a short idea. Expand it into a complete Ideogram JSON "
        "prompt, inventing plausible concrete details (setting, composition, "
        "lighting, medium) that fit the idea while staying faithful to it."
    ),
    "refine": (
        " The user gives an existing prompt that may be messy, tag-based, or written "
        "for another model. Rewrite it as a valid Ideogram JSON prompt: preserve "
        "their intent and key elements, and fill the schema fields. Do not introduce "
        "major new subjects."
    ),
}


def build_ideogram_studio_system(action: str = "expand", subject: str = "auto") -> str:
    act = _IDEOGRAM_STUDIO_ACTION.get(action, _IDEOGRAM_STUDIO_ACTION["expand"])
    subj = _STUDIO_SUBJECT.get(subject, "")
    return _IDEOGRAM_STUDIO_BASE + act + subj + _IDEOGRAM_SCHEMA
```

- [ ] **Step 4: Uruchom — ma przejść**

Run: `.venv/bin/python -m pytest tests/test_ideogram.py -q`
Expected: PASS (15 testów łącznie).

- [ ] **Step 5: Commit**

```bash
git add backend/prompts.py tests/test_ideogram.py
git commit -m "feat: Ideogram prompt instructions (image caption + studio)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `captioner.caption_image` — parametr formatu

**Files:**
- Modify: `backend/captioner.py:119-160`

- [ ] **Step 1: Dodaj parametr `fmt` i routing**

W `backend/captioner.py` zmień sygnaturę i ciało `caption_image`:

Zmień nagłówek z:
```python
def caption_image(
    image: Image.Image, mode: str, style: str = "concise", max_new_tokens: int = 256
) -> str:
    """Generate a cleaned caption for a single PIL image."""
```
na:
```python
def caption_image(
    image: Image.Image,
    mode: str,
    style: str = "concise",
    max_new_tokens: int = 256,
    fmt: str = "flux",
) -> str:
    """Generate a cleaned caption for a single PIL image.

    fmt="flux" -> natural-language caption; fmt="ideogram" -> compact JSON caption.
    """
```

Zmień blok budowania instrukcji z:
```python
    instruction = prompts.get_prompt(mode, style)
```
na:
```python
    if fmt == "ideogram":
        instruction = prompts.get_ideogram_prompt(mode)
    else:
        instruction = prompts.get_prompt(mode, style)
```

Zmień zakończenie funkcji z:
```python
    return prompts.clean_caption(decoded)
```
na:
```python
    if fmt == "ideogram":
        return prompts.normalize_ideogram(decoded)
    return prompts.clean_caption(decoded)
```

- [ ] **Step 2: Sprawdź, że moduł się kompiluje/importuje**

Run: `.venv/bin/python -c "import backend.captioner as c; import inspect; print('fmt' in inspect.signature(c.caption_image).parameters)"`
Expected: `True`

- [ ] **Step 3: Commit**

```bash
git add backend/captioner.py
git commit -m "feat: caption_image supports fmt=ideogram (JSON output)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Serwer — pola formatu, format na wyniku, trigger, zapis .txt+.json

**Files:**
- Modify: `backend/server.py` (`ProcessRequest`, `PromptRequest`, pętla joba, `_final_caption`, `api_export`, `api_zip`, `/api/prompt`)
- Test: `tests/test_server_caption.py`

- [ ] **Step 1: Napisz failujące testy (czyste, bez GPU)**

Utwórz `tests/test_server_caption.py`:
```python
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
    assert out.startswith("{")  # trigger NIE przed '{'
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
    assert names == ["p.txt"]  # zepsuty JSON -> bez .json
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `.venv/bin/python -m pytest tests/test_server_caption.py -q`
Expected: FAIL — brak `_caption_output_files` oraz brak gałęzi ideogram w `_final_caption`.

- [ ] **Step 3: Dodaj pola formatu do modeli**

W `backend/server.py`, w `ProcessRequest` (po `do_caption: bool = True`):
```python
    caption_format: str = "flux"  # "flux" | "ideogram"
```
W `PromptRequest` (po `max_tokens: int = 320`):
```python
    caption_format: str = "flux"  # "flux" | "ideogram"
```

- [ ] **Step 4: Przekaż format do captioningu i zapisz na wyniku**

W pętli joba (`backend/server.py`, blok ~229-242) zmień:
```python
                caption = ""
                if req.do_caption:
                    caption = captioner.caption_image(
                        img, req.mode, req.style, req.max_tokens
                    )

                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": out_name,
                    "width": w,
                    "height": h,
                    "caption": caption,
                })
```
na:
```python
                caption = ""
                if req.do_caption:
                    caption = captioner.caption_image(
                        img, req.mode, req.style, req.max_tokens,
                        fmt=req.caption_format,
                    )

                job["results"].append({
                    "idx": i,
                    "src_name": src.name,
                    "out_name": out_name,
                    "width": w,
                    "height": h,
                    "caption": caption,
                    "format": req.caption_format,
                })
```

- [ ] **Step 5: Ucz `_final_caption` formatu Ideogram**

Zmień `_final_caption` (`backend/server.py:160-166`):
```python
def _final_caption(req: ExportRequest, result: dict) -> str:
    """Resolve the caption for a result, applying any edit and the trigger word."""
    caption = req.captions.get(str(result["idx"]), result["caption"]).strip()
    trigger = req.trigger.strip()
    if req.prepend_trigger and trigger:
        if result.get("format") == "ideogram":
            return prompts.inject_trigger_ideogram(caption, trigger)
        caption = f"{trigger}, {caption}" if caption else trigger
    return caption
```
Upewnij się, że `from . import prompts` jest zaimportowane na górze `server.py` (jest używane pośrednio; jeśli nie ma — dodaj `from . import prompts`).

- [ ] **Step 6: Dodaj helper `_caption_output_files`**

Tuż po `_final_caption` w `backend/server.py` dodaj:
```python
def _caption_output_files(base_name: str, caption: str, fmt: str) -> list[tuple[str, str]]:
    """Zwróć listę (nazwa_pliku, treść) do zapisania dla danego opisu.

    Zawsze .txt; dla poprawnego JSON Ideogram dodatkowo ładny .json.
    """
    files: list[tuple[str, str]] = [(f"{base_name}.txt", caption + "\n")]
    if fmt == "ideogram":
        pretty = prompts.ideogram_pretty(caption)
        if pretty is not None:
            files.append((f"{base_name}.json", pretty + "\n"))
    return files
```

- [ ] **Step 7: Uruchom testy serwera — mają przejść**

Run: `.venv/bin/python -m pytest tests/test_server_caption.py -q`
Expected: PASS (6 testów).

- [ ] **Step 8: Użyj helpera w `api_export`**

W `backend/server.py` `api_export` zmień blok zapisu opisu (linie ~357-359):
```python
        caption = _final_caption(req, r)
        txt_name = Path(r["out_name"]).with_suffix(".txt").name
        (out_dir / txt_name).write_text(caption + "\n", encoding="utf-8")
        written += 1
```
na:
```python
        caption = _final_caption(req, r)
        base = Path(r["out_name"]).stem
        for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
            (out_dir / fname).write_text(content, encoding="utf-8")
        written += 1
```

- [ ] **Step 9: Użyj helpera w `api_zip`**

W `backend/server.py` `api_zip` zmień blok (linie ~1162-1164):
```python
            caption = _final_caption(req, r)
            txt_name = Path(r["out_name"]).with_suffix(".txt").name
            zf.writestr(txt_name, caption + "\n")
```
na:
```python
            caption = _final_caption(req, r)
            base = Path(r["out_name"]).stem
            for fname, content in _caption_output_files(base, caption, r.get("format", "flux")):
                zf.writestr(fname, content)
```

- [ ] **Step 10: Obsłuż Ideogram w `/api/prompt`**

W `backend/server.py` `api_prompt` (linie ~1133-1135) zmień:
```python
        system = prompts.build_studio_system(req.action, req.subject)
        raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        return {"prompt": prompts.clean_prompt(raw)}
```
na:
```python
        if req.caption_format == "ideogram":
            system = prompts.build_ideogram_studio_system(req.action, req.subject)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format == "ideogram":
            return {"prompt": prompts.normalize_ideogram(raw)}
        return {"prompt": prompts.clean_prompt(raw)}
```

- [ ] **Step 11: Pełny przebieg testów + kompilacja**

Run:
```bash
.venv/bin/python -m pytest -q
.venv/bin/python -c "import backend.server"
```
Expected: wszystkie testy PASS; import serwera bez błędów.

- [ ] **Step 12: Commit**

```bash
git add backend/server.py tests/test_server_caption.py
git commit -m "feat: server Ideogram format (process, prompt, export+zip .txt/.json)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: HEIC — rejestracja dekodera i rozszerzenia

**Files:**
- Modify: `backend/image_utils.py:7-10`
- Test: `tests/test_heic.py`

- [ ] **Step 1: Napisz failujący test**

Utwórz `tests/test_heic.py`:
```python
from pathlib import Path
from PIL import Image
from backend import image_utils


def test_supported_ext_includes_heic():
    assert ".heic" in image_utils.SUPPORTED_EXT
    assert ".heif" in image_utils.SUPPORTED_EXT


def test_process_heic_file(tmp_path: Path):
    # zapisz przykładowy HEIC, potem przetwórz przez pipeline
    src = tmp_path / "sample.heic"
    Image.new("RGB", (1200, 800), (120, 60, 30)).save(src, format="HEIF")
    img, (w, h) = image_utils.process_image(str(src), 512, 64, square=True)
    assert img.mode == "RGB"
    assert (w, h) == (512, 512)
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `.venv/bin/python -m pytest tests/test_heic.py -q`
Expected: FAIL — `.heic` nie ma w `SUPPORTED_EXT` (i/lub PIL nie zna `HEIF`).

- [ ] **Step 3: Zarejestruj dekoder i dodaj rozszerzenia**

W `backend/image_utils.py` zmień górę pliku:
```python
from PIL import Image, ImageOps

# Włącz odczyt/zapis HEIC/HEIF (zdjęcia z iPhone'a) — opcjonalna zależność.
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:  # pragma: no cover - środowisko bez pillow-heif
    pass

# Extensions we accept as input.
SUPPORTED_EXT = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif",
    ".heic", ".heif",
}
```

- [ ] **Step 4: Uruchom — ma przejść**

Run: `.venv/bin/python -m pytest tests/test_heic.py -q`
Expected: PASS (2 testy).

- [ ] **Step 5: Commit**

```bash
git add backend/image_utils.py tests/test_heic.py
git commit -m "feat: HEIC/HEIF input support via pillow-heif

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — dropdowny formatu i `accept` dla HEIC

**Files:**
- Modify: `frontend/index.html` (ustawienia datasetu, Generator promptów, input pliku)
- Modify: `frontend/app.js` (payload `/api/process`, payload `/api/prompt`)

- [ ] **Step 1: Dodaj dropdown formatu w ustawieniach datasetu**

W `frontend/index.html`, w panelu ustawień datasetu (obok pola wyboru trybu/stylu), dodaj:
```html
<label>Format docelowy</label>
<select id="captionFormat">
  <option value="flux" selected>FLUX.2 (naturalny język)</option>
  <option value="ideogram">Ideogram 4 (JSON)</option>
</select>
```
(Umieść w tym samym kontenerze, w którym są `mode`/`style`, zachowując istniejący styl.)

- [ ] **Step 2: Dodaj dropdown formatu w Generatorze promptów**

W `frontend/index.html`, w sekcji zakładki ✨ (obok `action`/`subject`), dodaj:
```html
<label>Format docelowy</label>
<select id="promptFormat">
  <option value="flux" selected>FLUX.2 (naturalny język)</option>
  <option value="ideogram">Ideogram 4 (JSON)</option>
</select>
```

- [ ] **Step 3: Rozszerz `accept` w input pliku**

W `frontend/index.html` znajdź `<input type="file" id="fileInput" ...>` i ustaw/rozszerz atrybut `accept`:
```html
accept="image/*,.heic,.heif,image/heic,image/heif"
```

- [ ] **Step 4: Dołącz `caption_format` do payloadu `/api/process`**

W `frontend/app.js`, w funkcji budującej payload procesu (tam, gdzie zbierane są `mode`, `style`, `resolution` itd.), dodaj:
```javascript
    caption_format: $("captionFormat").value,
```

- [ ] **Step 5: Dołącz `caption_format` do payloadu `/api/prompt`**

W `frontend/app.js`, w funkcji wysyłającej żądanie do `/api/prompt` (z `text`, `action`, `subject`), dodaj do ciała żądania:
```javascript
    caption_format: $("promptFormat").value,
```

- [ ] **Step 6: Weryfikacja statyczna (HTML/JS się ładują)**

Run:
```bash
grep -n 'id="captionFormat"' frontend/index.html
grep -n 'id="promptFormat"' frontend/index.html
grep -n 'caption_format' frontend/app.js
```
Expected: każdy grep zwraca dopasowanie.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: format dropdowns (dataset + prompts) and HEIC accept

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Weryfikacja end-to-end na żywym serwerze

**Files:** brak (weryfikacja manualna)

- [ ] **Step 1: (Re)start serwera**

Run:
```bash
pkill -f "uvicorn backend.server" 2>/dev/null; sleep 1
./run.sh > .work/server.log 2>&1 &
sleep 4 && curl -sf -o /dev/null http://127.0.0.1:8000/ && echo "UP"
```
Expected: `UP`.

- [ ] **Step 2: Test endpointu prompt w trybie Ideogram (wymaga GPU/modelu)**

Run:
```bash
curl -s -X POST http://127.0.0.1:8000/api/prompt \
  -H 'Content-Type: application/json' \
  -d '{"text":"a cat on a red sofa","action":"expand","subject":"auto","caption_format":"ideogram"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if json.loads(d['prompt']).get('high_level_description') is not None else 'BAD'); print(d['prompt'][:200])"
```
Expected: `OK` + początek poprawnego JSON-a. (Jeśli brak GPU/modelu — odnotuj i przetestuj `/api/prompt` ręcznie w UI.)

- [ ] **Step 3: Test datasetu Ideogram w UI**

W przeglądarce (http://127.0.0.1:8000): wskaż folder/zdjęcia (dorzuć jeden plik `.heic`), wybierz tryb `person`, **Format docelowy = Ideogram 4**, przetwórz. Sprawdź, że:
- HEIC został wczytany i pojawia się miniatura,
- każdy opis to poprawny JSON (kompaktowy),
- po podaniu triggera podgląd/eksport wstawia trigger do `high_level_description`.

- [ ] **Step 4: Test eksportu (.txt + .json)**

Po przetworzeniu wyeksportuj do folderu testowego i sprawdź:
```bash
ls /sciezka/do/eksportu | grep -E '\.(txt|json)$' | head
python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('/sciezka/do/eksportu/*.json')]; print('all json valid')"
```
Expected: pary `*.txt` i `*.json`; wszystkie `.json` poprawne.

- [ ] **Step 5: Regresja FLUX**

Powtórz krótki przebieg z **Format docelowy = FLUX.2** i potwierdź, że opisy są naturalnym tekstem oraz że eksport tworzy tylko `*.txt` (bez `*.json`).

- [ ] **Step 6: Commit (jeśli były poprawki)**

```bash
git add -A
git commit -m "test: e2e verification of Ideogram formats and HEIC import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (autor planu)

- **Pokrycie spec:** normalize/strict-order (T2), trigger+pretty (T3), instrukcje opis+studio (T4), captioner fmt (T5), pola+routing+_final_caption+zapis .txt/.json+/api/prompt (T6), HEIC (T7), dropdowny+accept+payloady (T8), e2e+regresja (T9). Wszystkie kryteria akceptacji ze spec mają task.
- **Brak placeholderów:** każdy krok kodu zawiera pełny kod/komendę i oczekiwany wynik.
- **Spójność typów:** `normalize_ideogram`/`inject_trigger_ideogram`/`ideogram_pretty`/`get_ideogram_prompt`/`build_ideogram_studio_system`/`_caption_output_files`/`caption_image(fmt=...)`/`caption_format` używane konsekwentnie między taskami.
