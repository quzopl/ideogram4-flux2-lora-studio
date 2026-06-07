# Spec: obsługa LM Studio (modele GGUF przez OpenAI-compatible API)

Data: 2026-06-07

## Cel

Umożliwić użycie modeli z **LM Studio** (lokalny serwer OpenAI-compatible) do:
1. **opisów datasetu** (obraz → tekst, model wizyjny, np. Qwen2.5-VL-7B-GGUF + mmproj),
2. **Generatora promptów** (tekst → tekst),

obok dotychczasowego silnika lokalnego (`transformers`/Qwen2.5-VL). LM Studio
zarządza modelem i pamięcią GPU; aplikacja tylko wysyła żądania HTTP.

Modele LM Studio pojawiają się **na tej samej liście modeli** (oba taby) jako
`LM Studio: <nazwa>`. Brak nowych zależności Pythona — klient na `urllib`.

## Tło — API LM Studio

LM Studio wystawia OpenAI-compatible API (domyślnie `http://localhost:1234/v1`):
- `GET /v1/models` → `{"data": [{"id": "<model>"}, ...]}` (modele załadowane/dostępne),
- `POST /v1/chat/completions` → standardowe `messages`; dla wizji treść użytkownika
  to lista bloków: `{"type":"text","text":...}` oraz
  `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`.
  Odpowiedź: `{"choices":[{"message":{"content":"..."}}]}`.

Serwer LM Studio musi być włączony, a model **załadowany** przez użytkownika.
Auth nie jest wymagane (wysyłamy nagłówek `Authorization: Bearer lm-studio` dla
kompatybilności).

## Architektura i zmiany

### `backend/lmstudio.py` (nowy, tylko stdlib)

- `DEFAULT_URL = "http://localhost:1234/v1"`.
- `_post_chat(base_url, payload, timeout) -> str` — wspólny POST do
  `/v1/chat/completions` przez `urllib.request`; zwraca `choices[0].message.content`.
  Mapuje błędy sieci/HTTP na `LMStudioError` z czytelnym komunikatem.
- `list_models(base_url, timeout=3) -> list[str]` — GET `/v1/models`; zwraca listę
  `id`. Przy błędzie/timeout zwraca `[]` (nie rzuca).
- `caption_image(base_url, model, image, instruction, max_tokens) -> str` — koduje
  `PIL.Image` do PNG base64, buduje wiadomość wizyjną i zwraca treść odpowiedzi.
- `generate_text(base_url, model, system, user, max_tokens) -> str` — wiadomości
  `system`+`user`, zwraca treść.
- `class LMStudioError(RuntimeError)` — używany do czytelnych komunikatów w API.
- Kodowanie obrazu: helper `_image_data_uri(image) -> str` (`data:image/png;base64,...`),
  testowalny osobno.

### `backend/prompts.py` (DRY — wspólne dla obu silników)

- `caption_instruction(mode, style, fmt) -> str`:
  - `fmt in ("ideogram","aitoolkit")` → `get_ideogram_prompt(mode)`,
  - inaczej → `get_prompt(mode, style)`.
- `postprocess_caption(text, fmt) -> str`:
  - `fmt in ("ideogram","aitoolkit")` → `normalize_ideogram(text)`,
  - inaczej → `clean_caption(text)`.

### `backend/captioner.py` (refaktor pod DRY)

- `caption_image(...)` korzysta z `prompts.caption_instruction(...)` i
  `prompts.postprocess_caption(...)` zamiast wbudowanych warunków (zachowanie bez
  zmian; samo wyniesienie wspólnej logiki).

### `backend/server.py`

- **Konfiguracja URL:** `LMSTUDIO_CONFIG_PATH = WORK / "lmstudio.json"`; helpery
  `_lmstudio_url()` (zwraca zapisany URL lub `lmstudio.DEFAULT_URL`) i zapis.
- **Routing:** helper `_lmstudio_model_id(model) -> str | None` — gdy `model`
  zaczyna się od `"lmstudio:"` zwraca część po prefiksie, inaczej `None`.
- **`/api/models`** (`_all_models` lub osobno): po wbudowanych i własnych dorzuca
  modele LM Studio — `{f"lmstudio:{id}": f"LM Studio: {id}"}` z
  `lmstudio.list_models(_lmstudio_url())`. Niedostępny LM Studio → nic nie dodaje.
- **`_run_job`:** jeśli model jest LM Studio:
  - pomiń `captioner.ensure_loaded`,
  - dla każdego zdjęcia:
    `instruction = prompts.caption_instruction(req.mode, req.style, req.caption_format)`,
    `raw = lmstudio.caption_image(url, model_id, img, instruction, req.max_tokens)`,
    `caption = prompts.postprocess_caption(raw, req.caption_format)`.
  - błędy `LMStudioError` → zapis w `job["results"]` jako `[BŁĄD: ...]` (jak dotąd
    per-plik) lub `job["error"]` przy ładowaniu — czytelnie.
- **`api_prompt`:** jeśli model jest LM Studio:
  - `system` jak dotąd (`build_studio_system`/`build_ideogram_studio_system`),
  - `raw = lmstudio.generate_text(url, model_id, system, text, req.max_tokens)`,
  - wynik: `normalize_ideogram` (ideogram/aitoolkit) lub `clean_prompt` (flux).
  - `LMStudioError` → `HTTPException(502, "LM Studio: ...")`.
- **Endpointy konfiguracji URL:**
  - `GET /api/lmstudio` → `{"url": _lmstudio_url()}`,
  - `POST /api/lmstudio {url}` → zapis, zwrot `{"url": ...}`.

### `frontend/index.html` + `frontend/app.js`

- Pole **„LM Studio URL"** (`id="lmstudioUrl"`, domyślnie `http://localhost:1234/v1`)
  + przycisk **„🔄 Odśwież modele"** (`id="refreshModelsBtn"`) w ustawieniach datasetu,
  przy selektorze modelu.
- Start: pobierz zapisany URL (`GET /api/lmstudio`) do pola.
- „Odśwież modele": `POST /api/lmstudio {url}` → `GET /api/models` → `populateModels`
  (modele LM Studio dochodzą do listy w obu zakładkach).
- Modele LM Studio rozpoznawane po kluczu `lmstudio:` (etykieta „LM Studio: …").

## Obsługa błędów

- LM Studio offline przy `/api/models` → lista modeli bez pozycji LM Studio (bez
  wyjątku).
- Opis/prompt gdy LM Studio offline lub model niezaładowany → `LMStudioError` →
  czytelny komunikat (per-plik w opisach; `HTTPException(502)` w `/api/prompt`).
- Model nie-wizyjny użyty do opisu obrazu → LM Studio zwróci błąd/nonsens; błąd jest
  przekazywany czytelnie (poza zakresem: wykrywanie czy model jest wizyjny).

## Testy (`tests/test_lmstudio.py`, `tests/test_ideogram.py`)

1. `prompts.caption_instruction` / `postprocess_caption` — gałęzie flux vs
   ideogram/aitoolkit (dopisać do istniejących testów promptów).
2. `lmstudio._image_data_uri(img)` — zaczyna się od `data:image/png;base64,` i
   dekoduje się do PNG.
3. `lmstudio.list_models` / `caption_image` / `generate_text` — monkeypatch
   `urllib.request.urlopen` fałszywą odpowiedzią; sprawdź zbudowany payload
   (obecny blok `image_url` z data-URI; `model`, `messages`) i parsowanie
   `choices[0].message.content`. Błąd sieci → `LMStudioError` / `[]` dla list_models.
4. `server._lmstudio_model_id("lmstudio:foo") == "foo"`, a dla wbudowanego → `None`.

## Kryteria akceptacji

1. Po włączeniu serwera LM Studio i kliknięciu „🔄 Odśwież modele" załadowane modele
   pojawiają się na liście jako „LM Studio: …" w obu zakładkach.
2. Wybór modelu „LM Studio: <wizyjny>" + „Przetwórz" generuje opisy przez LM Studio
   (FLUX/Ideogram/ai-toolkit — ta sama instrukcja i normalizacja co lokalnie).
3. Generator promptów z modelem LM Studio zwraca prompt (flux: tekst; ideogram/
   aitoolkit: poprawny JSON).
4. URL LM Studio jest zapamiętany między restartami (`.work/lmstudio.json`).
5. Gdy LM Studio jest wyłączony, lista modeli i aplikacja działają normalnie (bez
   pozycji LM Studio), a próba użycia modelu LM Studio daje czytelny komunikat.
6. Brak nowych zależności Pythona (klient na `urllib`).
