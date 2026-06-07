# LM Studio support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pozwolić używać modeli z LM Studio (lokalny OpenAI-compatible API) do opisów datasetu i Generatora promptów, obok silnika lokalnego transformers.

**Architecture:** Nowy stdlib-owy klient `backend/lmstudio.py` woła `/v1/chat/completions`. Wspólna logika instrukcji/normalizacji ląduje w `prompts.py` (DRY dla obu silników). Serwer routuje po prefiksie klucza modelu `lmstudio:` i scala modele LM Studio do `/api/models`. Front dostaje pole URL + „Odśwież modele".

**Tech Stack:** FastAPI, Pydantic, Pillow, `urllib` (bez nowych zależności), vanilla JS; testy: pytest (`.venv/bin/python -m pytest`).

**Spec:** `docs/superpowers/specs/2026-06-07-lmstudio-support-design.md`

---

### Task 1: DRY — wspólne `caption_instruction` / `postprocess_caption`

**Files:**
- Modify: `backend/prompts.py` (dodać 2 funkcje na końcu)
- Modify: `backend/captioner.py` (użyć ich w `caption_image`)
- Test: `tests/test_ideogram.py` (dopisać)

- [ ] **Step 1: Dopisz failujące testy** na końcu `tests/test_ideogram.py`:
```python
def test_caption_instruction_routes_by_fmt():
    assert prompts.caption_instruction("person", "concise", "flux") == prompts.get_prompt("person", "concise")
    assert prompts.caption_instruction("person", "concise", "ideogram") == prompts.get_ideogram_prompt("person")
    assert prompts.caption_instruction("person", "concise", "aitoolkit") == prompts.get_ideogram_prompt("person")


def test_postprocess_caption_routes_by_fmt():
    ideo = prompts.postprocess_caption('{"high_level_description":"x"}', "ideogram")
    assert _loads(ideo)["high_level_description"] == "x"
    flux = prompts.postprocess_caption("The image shows a cat.", "flux")
    assert not flux.lower().startswith("the image shows")
```

- [ ] **Step 2: Uruchom — fail.** `.venv/bin/python -m pytest tests/test_ideogram.py -q` → brak `caption_instruction`.

- [ ] **Step 3: Dodaj funkcje** na końcu `backend/prompts.py`:
```python
def caption_instruction(mode: str, style: str, fmt: str) -> str:
    """Instrukcja opisu obrazu wspólna dla obu silników (lokalny i LM Studio)."""
    if fmt in ("ideogram", "aitoolkit"):
        return get_ideogram_prompt(mode)
    return get_prompt(mode, style)


def postprocess_caption(text: str, fmt: str) -> str:
    """Post-processing surowego opisu wg formatu (wspólny dla obu silników)."""
    if fmt in ("ideogram", "aitoolkit"):
        return normalize_ideogram(text)
    return clean_caption(text)
```

- [ ] **Step 4: Refaktor `captioner.caption_image`.** W `backend/captioner.py` zamień:
```python
    if fmt in ("ideogram", "aitoolkit"):
        instruction = prompts.get_ideogram_prompt(mode)
    else:
        instruction = prompts.get_prompt(mode, style)
```
na:
```python
    instruction = prompts.caption_instruction(mode, style, fmt)
```
oraz zamień:
```python
    if fmt in ("ideogram", "aitoolkit"):
        return prompts.normalize_ideogram(decoded)
    return prompts.clean_caption(decoded)
```
na:
```python
    return prompts.postprocess_caption(decoded, fmt)
```

- [ ] **Step 5: Uruchom — pass.** `.venv/bin/python -m pytest -q` (oczekiwane: wszystkie przechodzą) oraz `.venv/bin/python -c "import backend.captioner"`.

- [ ] **Step 6: Commit**
```bash
git add backend/prompts.py backend/captioner.py tests/test_ideogram.py
git commit -m "refactor: shared caption_instruction/postprocess_caption helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Klient `backend/lmstudio.py`

**Files:**
- Create: `backend/lmstudio.py`
- Test: `tests/test_lmstudio.py`

- [ ] **Step 1: Napisz failujące testy** — utwórz `tests/test_lmstudio.py`:
```python
import base64
import json
import pytest
from PIL import Image
from backend import lmstudio


class _FakeResp:
    def __init__(self, obj):
        self._b = json.dumps(obj).encode("utf-8")
    def read(self):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_image_data_uri_is_png():
    uri = lmstudio._image_data_uri(Image.new("RGB", (4, 4), (1, 2, 3)))
    assert uri.startswith("data:image/png;base64,")
    raw = base64.b64decode(uri.split(",", 1)[1])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"


def test_list_models_parses(monkeypatch):
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp({"data": [{"id": "a"}, {"id": "b"}]}))
    assert lmstudio.list_models("http://x/v1") == ["a", "b"]


def test_list_models_offline_returns_empty(monkeypatch):
    def boom(req, timeout=0):
        raise OSError("refused")
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", boom)
    assert lmstudio.list_models("http://x/v1") == []


def test_caption_image_payload_and_parse(monkeypatch):
    captured = {}
    def fake(req, timeout=0):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp({"choices": [{"message": {"content": "a caption"}}]})
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", fake)
    out = lmstudio.caption_image("http://x/v1", "m", Image.new("RGB", (4, 4)), "describe", 100)
    assert out == "a caption"
    assert captured["url"].endswith("/chat/completions")
    assert captured["body"]["model"] == "m"
    content = captured["body"]["messages"][0]["content"]
    assert any(b.get("type") == "image_url"
               and b["image_url"]["url"].startswith("data:image/png;base64,")
               for b in content)
    assert any(b.get("type") == "text" and b["text"] == "describe" for b in content)


def test_generate_text_parse(monkeypatch):
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp({"choices": [{"message": {"content": "txt"}}]}))
    assert lmstudio.generate_text("http://x/v1", "m", "sys", "usr") == "txt"


def test_chat_network_error_raises(monkeypatch):
    def boom(req, timeout=0):
        raise OSError("refused")
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", boom)
    with pytest.raises(lmstudio.LMStudioError):
        lmstudio.generate_text("http://x/v1", "m", "s", "u")
```

- [ ] **Step 2: Uruchom — fail.** `.venv/bin/python -m pytest tests/test_lmstudio.py -q` → brak modułu `lmstudio`.

- [ ] **Step 3: Utwórz `backend/lmstudio.py`:**
```python
"""Klient lokalnego API LM Studio (OpenAI-compatible). Tylko biblioteka standardowa."""
from __future__ import annotations

import base64
import io
import json
import urllib.error
import urllib.request

from PIL import Image

DEFAULT_URL = "http://localhost:1234/v1"
_HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer lm-studio"}


class LMStudioError(RuntimeError):
    """Czytelny błąd komunikacji z LM Studio."""


def _image_data_uri(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _request(url: str, payload: dict | None, timeout: float) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    method = "POST" if payload is not None else "GET"
    req = urllib.request.Request(url, data=data, headers=_HEADERS, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def list_models(base_url: str = DEFAULT_URL, timeout: float = 3.0) -> list[str]:
    """Lista id modeli z LM Studio; pusta lista, gdy serwer niedostępny."""
    try:
        out = _request(f"{base_url.rstrip('/')}/models", None, timeout)
    except (urllib.error.URLError, OSError, ValueError):
        return []
    data = out.get("data", []) if isinstance(out, dict) else []
    return [m["id"] for m in data if isinstance(m, dict) and m.get("id")]


def _chat(base_url: str, payload: dict, timeout: float) -> str:
    url = f"{base_url.rstrip('/')}/chat/completions"
    try:
        out = _request(url, payload, timeout)
    except urllib.error.HTTPError as e:
        raise LMStudioError(f"LM Studio HTTP {e.code}.") from e
    except (urllib.error.URLError, OSError) as e:
        raise LMStudioError(f"Nie można połączyć z LM Studio ({base_url}).") from e
    except ValueError as e:
        raise LMStudioError("Błędna odpowiedź LM Studio (nie-JSON).") from e
    try:
        return out["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LMStudioError("LM Studio zwróciło odpowiedź bez treści.") from e


def caption_image(base_url: str, model: str, image: Image.Image,
                  instruction: str, max_tokens: int = 256, timeout: float = 180.0) -> str:
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": instruction},
                {"type": "image_url", "image_url": {"url": _image_data_uri(image)}},
            ],
        }],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    return _chat(base_url, payload, timeout)


def generate_text(base_url: str, model: str, system: str, user: str,
                  max_tokens: int = 320, timeout: float = 120.0) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    return _chat(base_url, payload, timeout)
```

- [ ] **Step 4: Uruchom — pass.** `.venv/bin/python -m pytest tests/test_lmstudio.py -q` (6 testów).

- [ ] **Step 5: Commit**
```bash
git add backend/lmstudio.py tests/test_lmstudio.py
git commit -m "feat: stdlib LM Studio client (chat/completions, vision)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Integracja w serwerze (config, routing, /api/models, endpointy)

**Files:**
- Modify: `backend/server.py`
- Test: `tests/test_lmstudio.py` (dopisać testy serwera)

- [ ] **Step 1: Dopisz failujące testy** na końcu `tests/test_lmstudio.py`:
```python
from backend import server


def test_lmstudio_model_id():
    assert server._lmstudio_model_id("lmstudio:foo") == "foo"
    assert server._lmstudio_model_id("Qwen/Qwen2.5-VL-7B-Instruct") is None


def test_lmstudio_url_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LMSTUDIO_CONFIG_PATH", tmp_path / "lm.json")
    assert server._lmstudio_url() == lmstudio.DEFAULT_URL          # domyślny gdy brak
    assert server._set_lmstudio_url("http://host:9/v1") == "http://host:9/v1"
    assert server._lmstudio_url() == "http://host:9/v1"


def test_all_models_includes_lmstudio(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    monkeypatch.setattr(server.lmstudio, "list_models", lambda url, timeout=3.0: ["vl-7b"])
    models = server._all_models()
    assert models["lmstudio:vl-7b"] == "LM Studio: vl-7b"
```

- [ ] **Step 2: Uruchom — fail.** `.venv/bin/python -m pytest tests/test_lmstudio.py -q` → brak `_lmstudio_model_id`.

- [ ] **Step 3: Import + stałe.** W `backend/server.py` przy innych importach `from . import ...` dodaj `lmstudio` (np. zmień istniejący `from . import captioner, comfy_client, image_utils, prompts` dodając `lmstudio`, albo dodaj osobną linię `from . import lmstudio`). Przy stałych `*_PATH` (obok `CUSTOM_MODELS_PATH`) dodaj:
```python
LMSTUDIO_CONFIG_PATH = WORK / "lmstudio.json"
```

- [ ] **Step 4: Helpery URL + routing.** Tuż przed `_all_models` (lub po nim) dodaj:
```python
def _lmstudio_url() -> str:
    data = _load_named(LMSTUDIO_CONFIG_PATH)
    return data.get("url") or lmstudio.DEFAULT_URL


def _set_lmstudio_url(url: str) -> str:
    url = url.strip() or lmstudio.DEFAULT_URL
    _save_named(LMSTUDIO_CONFIG_PATH, {"url": url})
    return url


def _lmstudio_model_id(model: str) -> str | None:
    """Zwróć id modelu LM Studio (część po 'lmstudio:'), inaczej None."""
    prefix = "lmstudio:"
    return model[len(prefix):] if model.startswith(prefix) else None
```

- [ ] **Step 5: Scal modele LM Studio w `_all_models`.** Zamień:
```python
def _all_models() -> dict:
    """Wbudowane modele + zapamiętane własne (własne nadpisują przy kolizji)."""
    return {**captioner.AVAILABLE_MODELS, **_load_named(CUSTOM_MODELS_PATH)}
```
na:
```python
def _all_models() -> dict:
    """Wbudowane + własne + (jeśli dostępne) modele z LM Studio."""
    models = {**captioner.AVAILABLE_MODELS, **_load_named(CUSTOM_MODELS_PATH)}
    for mid in lmstudio.list_models(_lmstudio_url()):
        models[f"lmstudio:{mid}"] = f"LM Studio: {mid}"
    return models
```

- [ ] **Step 6: Uruchom testy serwera — pass.** `.venv/bin/python -m pytest tests/test_lmstudio.py -q`.

- [ ] **Step 7: Endpointy konfiguracji.** Po endpointach `/api/models/custom` (po `api_models_custom_remove` / `api_fs_pick`) dodaj:
```python
class LmStudioConfig(BaseModel):
    url: str = ""


@app.get("/api/lmstudio")
def api_lmstudio_get():
    return {"url": _lmstudio_url()}


@app.post("/api/lmstudio")
def api_lmstudio_set(req: LmStudioConfig):
    return {"url": _set_lmstudio_url(req.url)}
```

- [ ] **Step 8: Routing w `_run_job`.** Zamień blok ładowania modelu:
```python
    try:
        if req.do_caption:
            job["state"] = "loading_model"
            job["current"] = "Ładowanie modelu VLM (pierwsze uruchomienie pobiera wagi)…"
            quant = req.quant if req.quant in ("4bit", "none") else "4bit"
            captioner.ensure_loaded(req.model, quant)
```
na:
```python
    try:
        lm_id = _lmstudio_model_id(req.model)
        if req.do_caption and lm_id is None:
            job["state"] = "loading_model"
            job["current"] = "Ładowanie modelu VLM (pierwsze uruchomienie pobiera wagi)…"
            quant = req.quant if req.quant in ("4bit", "none") else "4bit"
            captioner.ensure_loaded(req.model, quant)
```
oraz blok generowania opisu:
```python
                caption = ""
                if req.do_caption:
                    caption = captioner.caption_image(
                        img, req.mode, req.style, req.max_tokens,
                        fmt=req.caption_format,
                    )
```
na:
```python
                caption = ""
                if req.do_caption:
                    if lm_id is not None:
                        instruction = prompts.caption_instruction(
                            req.mode, req.style, req.caption_format)
                        raw = lmstudio.caption_image(
                            _lmstudio_url(), lm_id, img, instruction, req.max_tokens)
                        caption = prompts.postprocess_caption(raw, req.caption_format)
                    else:
                        caption = captioner.caption_image(
                            img, req.mode, req.style, req.max_tokens,
                            fmt=req.caption_format,
                        )
```
(Per-plik `try/except` już zapisuje błędy jako `[BŁĄD: ...]`, więc `LMStudioError` jest obsłużony.)

- [ ] **Step 9: Routing w `api_prompt`.** Zamień ciało `try` (linie ~1275-1285):
```python
        captioner.ensure_loaded(req.model, quant)
        if req.caption_format in ("ideogram", "aitoolkit"):
            system = prompts.build_ideogram_studio_system(req.action, req.subject)
        else:
            system = prompts.build_studio_system(req.action, req.subject)
        raw = captioner.generate_text(system, text, max_new_tokens=req.max_tokens)
        if req.caption_format in ("ideogram", "aitoolkit"):
            return {"prompt": prompts.normalize_ideogram(raw)}
        return {"prompt": prompts.clean_prompt(raw)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Błąd generowania: {e}")
```
na:
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
    except lmstudio.LMStudioError as e:
        raise HTTPException(502, f"LM Studio: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Błąd generowania: {e}")
```

- [ ] **Step 10: Pełny suite + import.**
```bash
.venv/bin/python -m pytest -q
.venv/bin/python -c "import backend.server"
```
Expected: wszystkie testy PASS; import OK.

- [ ] **Step 11: Commit**
```bash
git add backend/server.py tests/test_lmstudio.py
git commit -m "feat: route to LM Studio by model prefix; merge models; url config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — URL LM Studio + „Odśwież modele"

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

- [ ] **Step 1: Dodaj pole URL + przycisk.** W `frontend/index.html` znajdź pole modelu:
```html
        <div class="field">
          <label>Model VLM</label>
          <select id="model"></select>
          <button type="button" id="addModelBtn" class="mini">📁 Dodaj model z folderu</button>
          <button type="button" id="removeModelBtn" class="mini">🗑 Usuń własny</button>
        </div>
```
i wstaw ZARAZ po nim:
```html
        <div class="field">
          <label>LM Studio URL</label>
          <input type="text" id="lmstudioUrl" placeholder="http://localhost:1234/v1" />
          <button type="button" id="refreshModelsBtn" class="mini">🔄 Odśwież modele</button>
        </div>
```

- [ ] **Step 2: Wczytaj URL przy starcie.** W `frontend/app.js` w funkcji `init` zamień:
```javascript
(async function init() {
  try {
    const { models, default: def } = await api("/api/models");
    populateModels(models, def);
  } catch (e) {
    console.error(e);
  }
})();
```
na:
```javascript
(async function init() {
  try {
    const { models, default: def } = await api("/api/models");
    populateModels(models, def);
    const cfg = await api("/api/lmstudio");
    if ($("lmstudioUrl")) $("lmstudioUrl").value = cfg.url;
  } catch (e) {
    console.error(e);
  }
})();
```

- [ ] **Step 3: Obsługa „Odśwież modele".** W `frontend/app.js` przy handlerach modeli (obok `addModelBtn`) dodaj:
```javascript
async function refreshModels() {
  try {
    if ($("lmstudioUrl")) await api("/api/lmstudio", { url: $("lmstudioUrl").value.trim() });
    const { models, default: def } = await api("/api/models");
    populateModels(models, def);
    alert("Odświeżono listę modeli.");
  } catch (e) {
    alert("Błąd odświeżania: " + e.message);
  }
}
if ($("refreshModelsBtn")) $("refreshModelsBtn").onclick = refreshModels;
```

- [ ] **Step 4: Weryfikacja statyczna.**
```bash
grep -n 'id="lmstudioUrl"\|id="refreshModelsBtn"' frontend/index.html
grep -n 'function refreshModels\|/api/lmstudio' frontend/app.js
node --check frontend/app.js && echo "app.js OK"
```
Expected: każdy grep ma dopasowanie; node --check OK.

- [ ] **Step 5: Commit**
```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: LM Studio URL field + refresh models button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Weryfikacja na żywym serwerze

**Files:** brak (weryfikacja)

- [ ] **Step 1: Restart serwera.**
```bash
cd ~/wsl/flux-lora-prep
pkill -9 -f "uvicorn backend.server" 2>/dev/null; sleep 1
./run.sh > .work/server.log 2>&1 &
sleep 4 && curl -sf -o /dev/null http://127.0.0.1:8023/ && echo UP
```

- [ ] **Step 2: Endpoint konfiguracji URL działa (offline LM Studio).**
```bash
curl -s http://127.0.0.1:8023/api/lmstudio
curl -s -X POST http://127.0.0.1:8023/api/lmstudio -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:1234/v1"}'
```
Expected: oba zwracają `{"url":"http://localhost:1234/v1"}`.

- [ ] **Step 3: Lista modeli działa gdy LM Studio offline (bez pozycji LM Studio, bez błędu).**
```bash
curl -s http://127.0.0.1:8023/api/models | python3 -c "import sys,json;m=json.load(sys.stdin)['models'];print('lmstudio offline OK; pozycje LM Studio:', [k for k in m if k.startswith('lmstudio:')])"
```
Expected: `[]` (gdy LM Studio wyłączony) i brak błędu.

- [ ] **Step 4: Pole URL + przycisk w UI.**
```bash
curl -s http://127.0.0.1:8023/ | grep -o 'id="lmstudioUrl"\|Odśwież modele' | sort -u
```
Expected: oba dopasowania.

- [ ] **Step 5: (z włączonym LM Studio — manualnie)** Włącz serwer w LM Studio i załaduj model wizyjny (np. `Qwen2.5-VL-7B-Instruct-GGUF`). W UI kliknij „🔄 Odśwież modele" → na liście pojawia się „LM Studio: …". Wybierz go, wgraj zdjęcie, „Przetwórz" → opis powstaje przez LM Studio. Sprawdź też Generator promptów z tym modelem. (Jeśli LM Studio niedostępne w trakcie wdrożenia — odnotuj i zostaw do testu użytkownikowi.)

- [ ] **Step 6: Commit (jeśli były poprawki)**
```bash
git add -A
git commit -m "test: verify LM Studio integration (offline-safe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (autor planu)

- **Pokrycie spec:** klient lmstudio (T2), DRY helpery (T1), config URL + endpointy (T3), routing model-prefix w opisach i promptach (T3), scalanie `/api/models` (T3), front URL+refresh (T4), offline-safe + błędy (T2/T3), e2e (T5). Wszystkie 6 kryteriów akceptacji mają task.
- **Brak placeholderów:** każdy krok ma pełny kod/komendę i oczekiwany wynik.
- **Spójność typów:** `caption_instruction`/`postprocess_caption`, `lmstudio.list_models/caption_image/generate_text/LMStudioError/_image_data_uri`, `_lmstudio_url/_set_lmstudio_url/_lmstudio_model_id`, klucz `lmstudio:<id>`, `LmStudioConfig` — użyte spójnie między taskami.
