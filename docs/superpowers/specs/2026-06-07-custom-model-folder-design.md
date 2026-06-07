# Spec: wskazanie modelu z własnego folderu (przeglądarka + zapamiętanie)

Data: 2026-06-07

## Cel

Umożliwić użytkownikowi wybranie modelu VLM (Qwen2.5-VL) z dowolnego folderu na
maszynie **bez wpisywania ścieżki** — przez przeglądarkę katalogów w UI — oraz
**zapamiętanie** wybranych modeli tak, by pojawiały się na liście modeli w obu
zakładkach (Dataset i Generator promptów) także po restarcie.

Motywacja: wagi modeli mogą leżeć poza domyślnym cache Hugging Face (np. na innym
dysku/montowaniu), a użytkownik chce je wskazać raz i wybierać z listy.

## Kluczowy fakt techniczny

`transformers.*.from_pretrained(model_name)` przyjmuje zarówno repo-id z HF, jak i
**ścieżkę do lokalnego folderu**. `captioner.ensure_loaded(model_name, quant)` i
`caption_image(...)` przekazują `req.model` wprost do `from_pretrained`, więc klucz
modelu może być absolutną ścieżką — bez zmian w `captioner.py`. Aplikacja zawsze
ładuje `Qwen2_5_VLForConditionalGeneration`, dlatego walidujemy, że wskazany folder
to model Qwen2.5-VL.

## Architektura i zmiany

### `backend/server.py`

**Trwały zapis.**
- `CUSTOM_MODELS_PATH = WORK / "custom_models.json"` (katalog `.work/`, jest w
  `.gitignore`, przeżywa restart serwera).
- Format: `{ "<absolutna_ścieżka>": "<etykieta>" }`. Wykorzystuje istniejące
  `_load_named(path)` / `_save_named(path, data)`.

**Przeglądarka systemu plików.**
- `GET /api/fs/list?path=<dir>` → `{"path": <abs>, "parent": <abs|null>, "dirs":
  [<nazwy_podkatalogów>], "is_model": <bool>}`.
- Gdy brak `path` → start w `Path.home()`.
- Listuje **wyłącznie podkatalogi** (nie pliki). Wpisy nieczytelne (PermissionError)
  są pomijane. Ścieżka nieistniejąca lub nie-katalog → `HTTPException(400, ...)`.
- `parent` = katalog nadrzędny lub `null`, gdy jesteśmy w korzeniu (`path.parent ==
  path`).
- `is_model` = czy `path` zawiera `config.json` (marker katalogu modelu HF).
- Implementacja przez helper `_list_subdirs(path: Path) -> list[str]` (posortowane
  nazwy podkatalogów, błędy odczytu → pominięcie).

**Walidacja katalogu modelu.**
- Helper `_model_dir_info(path: Path) -> dict` zwraca `{"ok": bool, "reason": str,
  "label": str}`:
  - katalog nie istnieje / nie jest katalogiem → `ok=False`, reason „Folder nie
    istnieje".
  - brak `config.json` → `ok=False`, reason „To nie jest folder modelu (brak
    config.json)".
  - `config.json` istnieje, ale nie wskazuje Qwen2.5-VL → `ok=False`, reason
    „Obsługiwane są tylko modele Qwen2.5-VL".
  - poprawny → `ok=True`, `label = "<nazwa_folderu> (własny)"`.
  - Detekcja Qwen2.5-VL: wczytaj `config.json`; uznaj za zgodny, gdy
    `model_type` zawiera `qwen2_5_vl` (case-insensitive) **lub** dowolny wpis w
    `architectures` zawiera `Qwen2_5_VL`. Błąd parsowania `config.json` →
    `ok=False`, reason „Nie można odczytać config.json".

**Dodanie modelu.**
- `POST /api/models/custom` body `{"path": str}`:
  - `info = _model_dir_info(Path(path).expanduser().resolve())`.
  - jeśli `not info["ok"]` → `HTTPException(400, info["reason"])`.
  - wczytaj `_load_named(CUSTOM_MODELS_PATH)`, dodaj `{str(resolved): info["label"]}`,
    zapisz `_save_named(...)`.
  - zwróć `{"models": <scalone>, "default": captioner.DEFAULT_MODEL, "added":
    str(resolved)}`.

**Usunięcie modelu.**
- `DELETE /api/models/custom` body `{"path": str}`:
  - wczytaj, usuń klucz `str(Path(path).expanduser().resolve())` jeśli jest, zapisz.
  - zwróć `{"models": <scalone>, "default": captioner.DEFAULT_MODEL}`.

**Scalanie listy modeli.**
- Helper `_all_models() -> dict`: `{**captioner.AVAILABLE_MODELS,
  **_load_named(CUSTOM_MODELS_PATH)}` (własne nadpisują przy kolizji klucza).
- `GET /api/models` (istniejący, ~283) zwraca `{"models": _all_models(), "default":
  captioner.DEFAULT_MODEL}`.

**Modele Pydantic.** `class CustomModel(BaseModel): path: str` dla dodania/usunięcia.

### `backend/captioner.py`
Bez zmian. (Ładowanie ze ścieżki działa; klucz `_state["key"]` może być ścieżką.)

### `frontend/index.html`
- Przy selektorze `#model` (Dataset) i `#pModel` (Generator promptów) dodać przycisk
  `📁 Dodaj model z folderu` (`id="addModelBtn"` oraz `id="pAddModelBtn"`).
- Dodać ukryty modal przeglądarki folderów (`id="fsModal"`) z elementami:
  - bieżąca ścieżka (`id="fsPath"`),
  - przycisk „⬆ Wyżej" (`id="fsUp"`),
  - lista podfolderów (`id="fsList"`),
  - przycisk „Wybierz ten folder" (`id="fsPick"`, domyślnie disabled),
  - przycisk „Anuluj" (`id="fsCancel"`),
  - komunikat błędu/statusu (`id="fsMsg"`),
  - sekcja „Zapamiętane własne modele" (`id="fsSaved"`) z listą i ✕ do usuwania.

### `frontend/app.js`
- Wydzielić wypełnianie dropdownów do funkcji `populateModels(models, def)`,
  używanej przy starcie **i** po dodaniu/usunięciu modelu (odświeża `#model` i
  `#pModel`, zachowując bieżący wybór, a po dodaniu zaznaczając nowy klucz).
- Otwarcie modala (oba przyciski) → `fsBrowse(home)` (bez `path` → backend użyje
  domyślnego katalogu). Render listy: klik w folder → `fsBrowse(dir)`; „⬆ Wyżej" →
  `fsBrowse(parent)`; aktywuj „Wybierz ten folder", gdy `is_model`.
- „Wybierz ten folder" → `POST /api/models/custom {path: currentPath}`; sukces →
  `populateModels`, zaznacz nowy, zamknij modal; błąd → pokaż `fsMsg`.
- Sekcja „Zapamiętane": pokazuje własne modele (klucze spoza
  `AVAILABLE_MODELS`); ✕ → `DELETE /api/models/custom {path}` → `populateModels`.

## Bezpieczeństwo

Endpoint `/api/fs/list` ujawnia nazwy katalogów lokalnemu klientowi. Aplikacja
nasłuchuje wyłącznie na `127.0.0.1`. Zwracamy tylko nazwy podkatalogów (nie pliki),
ścieżki normalizujemy przez `expanduser().resolve()`. To akceptowalne dla narzędzia
lokalnego.

## Obsługa błędów

- `fs/list`: nieistniejąca/nie-katalog ścieżka → 400; nieczytelne wpisy pomijane.
- `models/custom` (POST): walidacja jak wyżej → 400 z czytelnym `reason`.
- Po dodaniu, gdy folder zostanie później przeniesiony/usunięty, `ensure_loaded`
  rzuci wyjątek → istniejąca ścieżka 500 pokaże komunikat (poza zakresem auto-
  czyszczenie martwych wpisów).

## Testy (`tests/test_models_custom.py`)

1. `_list_subdirs(tmp_path)` — tworzy podkatalogi + plik; zwraca tylko nazwy
   katalogów, posortowane.
2. `_model_dir_info` — cztery przypadki: nie-katalog; brak config.json; config.json
   z `model_type: "llama"` (odrzucony); config.json z `model_type:
   "qwen2_5_vl"` (zaakceptowany, label kończy się „ (własny)").
3. Round-trip: `_save_named(CUSTOM_MODELS_PATH, {...})` + `_all_models()` zawiera
   zarówno wbudowane, jak i własne klucze. (Użyć monkeypatch na `CUSTOM_MODELS_PATH`
   wskazujący tmp, by nie ruszać prawdziwego pliku.)

## Kryteria akceptacji

1. „📁 Dodaj model z folderu" otwiera modal; nawigacja po katalogach działa (wejście,
   wyjście wyżej), bez wpisywania ścieżki.
2. „Wybierz ten folder" aktywny tylko dla folderu z poprawnym modelem Qwen2.5-VL;
   dla innych — czytelny komunikat.
3. Po dodaniu model pojawia się na liście w **obu** zakładkach i jest zaznaczony.
4. Po restarcie serwera dodany model nadal jest na liście (zapis w
   `.work/custom_models.json`).
5. Wybranie własnego modelu i uruchomienie opisów/promptów ładuje wagi z tego folderu
   (działa, gdy folder zawiera kompletny model Qwen2.5-VL).
6. ✕ przy zapamiętanym modelu usuwa go z listy (i z pliku).
