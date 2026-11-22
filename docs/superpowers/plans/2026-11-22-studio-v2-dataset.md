# Studio v2 — widok Dataset (Faza 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widok Dataset w nowym UI (`/dataset`) z pełnym parytetem klasycznego
widoku. Zakres: źródło (folder, upload, HEIC), siatka miniatur, crop w czterech
trybach, ustawienia z autozapisem i presetami, przetwarzanie z postępem,
przegląd i edycja captionów oraz eksport do folderu lub `.zip`.

**Architecture:**
- Strona React korzysta z istniejącego API datasetu (`/api/scan`,
  `/api/upload`, `/api/process`, `/api/job`, `/api/crop/auto`, `/api/export`,
  `/api/zip`).
- Edytor kropu przechodzi z `frontend/crop_editor.js` do imperatywnego modułu
  TS. Komponent React montuje go w `useEffect`.
- Plany kropu trafiają do nowego, małego magazynu w backendzie
  (`/api/crops`), kluczowanego rozwiązaną ścieżką folderu.
- Backend dostaje tylko walidację żądań i ten magazyn.

**Tech Stack:** jak w `docs/superpowers/plans/2026-11-22-studio-v2-ui.md`:
React 19, TS, Vite, Tailwind v4, shadcn/ui, Motion, TanStack Query,
Playwright 1.63, FastAPI i pytest.

**Spec:** `docs/superpowers/specs/2026-11-21-studio-v2-design.md`: §5 oraz
lista parytetu, pozycja „Dataset”.
**Inwentaryzacja klasycznego widoku (obowiązkowa lektura):**
`docs/superpowers/notes/2026-11-22-dataset-inventory.md`. Zawiera kontrolki,
wartości, kształty API i 22 kruche miejsca, a przy każdym numer linii.

## Global Constraints

- Obowiązują wszystkie Global Constraints z
  `docs/superpowers/plans/2026-11-22-studio-v2-ui.md`:
  - gałąź `v2`, commit po zadaniu, bez pushowania;
  - teksty UI po angielsku, motyw ciemny, tokeny z `web/src/index.css`;
  - `MotionConfig reducedMotion="user"`, animacje nie blokują kliknięć;
  - e2e na porcie 8131 z `FLUX_PREP_WORK`, importy z `./fixtures.ts` i `./env.ts`;
  - token HF nigdy po stronie klienta;
  - brak cichego katalogu pobierania.
- Przed commitem przechodzą:
  - `.venv/bin/python -m pytest` (`pytest.ini` ma już `-q`);
  - `cd web && pnpm typecheck && pnpm build && pnpm exec playwright test`.
- Klasyczny widok `/legacy/` działa dalej bez zmian. Nie usuwamy
  `frontend/crop_editor.js`.
- Wartości domyślne i opcje kontrolek są dokładnie takie jak w klasycznym
  widoku (inwentaryzacja §1.2), łącznie z etykietami opcji.
- Wszystkie zapytania z `folder` lub `name` w query kodujemy przez
  `URLSearchParams` (`encodeURIComponent`).
- Błędy jobów (`job.error` zawiera traceback) pokazujemy tylko pierwszą
  linią, a pełny tekst trafia do `title`.
- Polling jobów przetrwa chwilowe błędy sieci i zatrzymuje się tylko na
  stanie końcowym albo 404. Tak samo działa już Upscale w
  `web/src/pages/UpscalePage.tsx`.

## Review Focus

1. **Edycje captionów nie giną** przy przejściu na inny widok i z powrotem
   ani przy kolejnych odpytaniach joba w trakcie przetwarzania. Test: Task 20
   `caption edits survive navigation and polling`.
2. **Plan kropu przeżywa przeładowanie** i należy do folderu, nie do sesji.
   Plan z klasycznego UI (`localStorage` `cropPlan:<folder>`) zostaje
   przejęty przy pierwszym otwarciu folderu. Testy: Task 17
   `test_crops_roundtrip_by_resolved_folder` i Task 18
   `crop plan survives reload` oraz `legacy crop plan is imported`.
3. **Upload kończący się błędem lub bez obsługiwanych plików** daje czytelny
   komunikat zamiast „Uploaded undefined images”, a `Process` zostaje
   nieaktywny. Test: Task 19 `upload with no supported files explains why`.
4. **Nieprawidłowe ustawienia** (`step` 0, `jpg_quality` 10, puste pole
   liczbowe) dają 422 z czytelnym `detail` w toaście, zanim job wystartuje.
   Testy: Task 17 `test_process_rejects_bad_numbers` i Task 20
   `empty number field is caught before submit`.
5. **Auto-crop all przy istniejących kropach** pyta o potwierdzenie. Tekst
   pytania mówi prawdę: pliki bez wykrytego boksu zachowują stary krop. Test:
   Task 19 `auto-crop all confirms and merges`.

---

### Task 17: Backend — walidacja żądań i magazyn planów kropu

**Files:**
- Modify: `backend/server.py` (`ProcessRequest`, `CropAutoRequest`, nowe trasy `/api/crops` i `/api/src/size`), `tests/conftest.py` (izolacja `crop_store.PATH`)
- Create: `backend/crop_store.py`
- Test: `tests/test_crop_store.py` (nowy), `tests/test_process_validation.py` (nowy)

**Interfaces:**
- Produces:
  - **`crop_store.py`:**
    - `PATH: Path` na poziomie modułu, liczony z `FLUX_PREP_WORK` tak jak
      `settings.CONFIG_PATH` (`<work>/crop_plans.json`). Autouse fixture w
      `tests/conftest.py` podmienia go na `tmp_path`, tak jak
      `settings.CONFIG_PATH`;
    - `load(folder: str, path: Path | None = None) -> dict` zwraca
      `{"plan": {name: [x,y,w,h]}, "mode": "center"|"auto"|"manual", "exists": bool}`;
    - `exists` jest `False` tylko wtedy, gdy dla folderu nigdy nic nie
      zapisano. Zapisany pusty plan daje `exists: True`, dzięki czemu
      przejęcie planu z klasycznego UI nie wraca po „Clear crops”;
    - `save(folder: str, plan: dict, mode: str, path: Path | None = None) -> dict`;
    - klucz to `str(Path(folder).expanduser().resolve())`;
    - zapis atomowy, tak jak w `settings.py`: plik tymczasowy, fsync,
      `os.replace`, lock.
  - **`GET /api/crops?folder=`** zwraca dokument z `load`. Nieznany folder
    daje `{"plan": {}, "mode": "center", "exists": false}`.
  - **`GET /api/src/size?folder=&name=`** zwraca `{"width": int, "height": int}`,
    czyli prawdziwy rozmiar po obrocie EXIF:
    - odczyt samego nagłówka przez `Image.open` bez dekodowania pikseli;
      orientacja EXIF 5–8 zamienia `w` i `h`;
    - ta sama walidacja ścieżki co `/api/src/thumb` (`_safe_source_path`);
    - z tego endpointu korzysta „Apply to same ratio”.
  - **`PUT /api/crops`:**
    - body: `{folder: str, plan: dict[str, list[int]], mode: Literal["center","auto","manual"]}`;
    - odpowiedź to zapisany dokument;
    - 400, gdy boks nie ma dokładnie 4 nieujemnych intów albo `w` lub `h`
      wynosi 0;
    - 400, gdy nazwa nie jest gołą nazwą pliku (zawiera `/` albo jest równa
      `..`).
  - **Walidacja w `ProcessRequest`:**
    - `resolution: int = Field(1024, ge=256, le=4096)`;
    - `step: int = Field(64, ge=8, le=256)`;
    - `jpg_quality: int = Field(95, ge=50, le=100)`;
    - `max_tokens: int = Field(512, ge=64, le=8192)`;
    - `fmt: Literal["png","jpg"]`;
    - `caption_format: Literal["flux","ideogram","aitoolkit"]`;
    - `fit: Literal["cover","contain"]`;
    - `crop_mode: Literal["center","auto","manual"]`.
  - **`CropAutoRequest`** dostaje tę samą walidację `resolution` i `step`.

- [ ] **Step 1: Napisz testy, które padają**

`tests/test_crop_store.py`:
- `test_crops_roundtrip_by_resolved_folder`: `save` dla `tmp/a/../a` i `load`
  dla `tmp/a` zwracają ten sam plan;
- `test_unknown_folder_is_empty_center`;
- `test_put_crops_rejects_bad_box`: `[1,2,3]` daje 400 i `[0,0,0,10]` daje
  400;
- `test_put_crops_rejects_path_names`: nazwa `a/b.jpg` daje 400;
- `test_crops_isolated_in_tests`: zapis przez API trafia do podmienionego
  `crop_store.PATH` w `tmp_path`, a nie do prawdziwego `.work/`;
- `test_cleared_plan_still_exists`: `save(folder, {}, "center")`, potem
  `load`, daje `exists: True`;
- `test_src_size_reads_header_with_exif`: JPEG 40×20 z orientacją EXIF 6
  zwraca `{width: 20, height: 40}`, a zła nazwa daje 400.

`tests/test_process_validation.py`:
- `test_process_rejects_bad_numbers`: `step=0`, `jpg_quality=10` i
  `resolution=100` dają 422 z `detail`, każde osobno;
- `test_process_rejects_unknown_fmt`: `fmt="gif"` daje 422;
- `test_process_defaults_still_accepted`: minimalne body `{folder}` z
  folderem zawierającym jeden obraz daje 200. Podmień `threading.Thread`,
  żeby job nie startował naprawdę.

- [ ] **Step 2:** Uruchom testy i sprawdź, że padają: `.venv/bin/python -m pytest tests/test_crop_store.py tests/test_process_validation.py`.
- [ ] **Step 3:** Zaimplementuj.
- [ ] **Step 4:** Uruchom `.venv/bin/python -m pytest`. Wszystko musi być zielone.
- [ ] **Step 5:** Commit `feat: crop plan store and stricter dataset request validation`.

---

### Task 18: Edytor kropu jako moduł TS i hook planów

**Files:**
- Create:
  - `web/src/editors/crop/cropMath.ts` (czysta geometria);
  - `web/src/editors/crop/cropEditor.ts` (imperatywny kontroler);
  - `web/src/components/CropEditorDialog.tsx`;
  - `web/src/hooks/useCropPlan.ts`;
  - `web/e2e/crop.spec.ts`.
- Modify: `web/src/pages/Playground.tsx` (demo edytora). Folder i plik
  podajesz w query: `/_playground?cropFolder=<abs>&cropFiles=a.png,b.png`,
  bo bundle nie zna `E2E_WORK`. Spec kopiuje fixtury do `E2E_WORK/crops`.

**Interfaces:**
- Consumes: `GET/PUT /api/crops` (Task 17), `GET /api/src/image` (nagłówki
  `X-Src-Width` i `X-Src-Height` dają prawdziwy rozmiar), `POST /api/crop/auto`
  i `GET /api/crop/auto/{id}`.
- Produces:
  - **`cropMath.ts`**, port logiki z `frontend/crop_editor.js:151-358`:
    - `type Box = [number, number, number, number]`;
    - `defaultBox(srcW: number, srcH: number, ratio: number | null): Box`;
    - `clampBox(b: Box, srcW: number, srcH: number, ratio: number | null, minSide = 16): Box`;
    - `resizeBox(b: Box, handle: Handle, dx: number, dy: number, srcW: number, srcH: number, ratio: number | null): Box`;
    - `fractional(b: Box, srcW: number, srcH: number)` i
      `fromFractional(...)` dla „Apply to same ratio”.
  - **`cropEditor.ts`:** `createCropEditor(stage: HTMLElement, img: HTMLImageElement, opts: {srcW, srcH, ratio, box, onChange(box)}) => { setRatio(r), setBox(b), destroy() }`.
    - Przeciąganie i 8 uchwytów obsługują pointer events.
    - Strzałki działają tylko przy focusie na stage (`tabIndex=0`), a nie na
      `window`. Shift daje krok 10 px.
    - Skalę liczy `ResizeObserver`.
  - **`useCropPlan(folder: string | null)`:**
    - zwraca `{plan, mode, loaded, set(name, box), merge(boxes), clear(), setMode(m)}`;
    - zapisuje przez `PUT /api/crops` z debounce 300 ms;
    - przejmuje `localStorage["cropPlan:" + folder]` tylko wtedy, gdy
      `/api/crops` zwraca `exists: false` (format `{plan, mode}` albo goły
      obiekt planu). Zapisuje go do `/api/crops` i nie usuwa wpisu z
      `localStorage`;
    - `mode` jest jedynym źródłem „Crop source”, zapisywanym per folder,
      tak jak w klasycznym UI. Nie należy do formularza ani do presetów.
  - **`<CropEditorDialog folder name files square onClose />`:**
    - przycisk `Auto (Florence)` uruchamia `/api/crop/auto` z
      `names: [name]` i odpytuje go;
    - `Reset`;
    - `Apply to same ratio`: proporcje w granicy 0.02. Rozmiary bierzesz
      z `GET /api/src/size` (Task 17), jedno lekkie zapytanie na plik;
    - `Save` zapisuje boks i ustawia tryb `manual`;
    - `Cancel` i Esc zamykają bez zapisu;
    - wybór proporcji ma opcje `free`, `1:1`, `3:4`, `4:3` i `16:9`. Przy
      `square` jest zablokowany na 1:1;
    - pokazuje rozmiar `crop W × H px`.

- [ ] **Step 1: Testy, które padają**

`web/e2e/crop.spec.ts`. Fixtury to dwa PNG w `E2E_WORK/crops` o rozmiarach
400×300 i 800×600, ten sam stosunek boków:
- `save writes a manual crop`: otwórz edytor, przeciągnij uchwyt `se` o
  -50 px i kliknij Save. `GET /api/crops?folder=` zwraca boks z liczbami
  całkowitymi i `mode: "manual"`;
- `crop plan survives reload`;
- `legacy crop plan is imported`:
  `addInitScript(localStorage.setItem("cropPlan:<folder>", JSON.stringify({plan:{"a.png":[10,10,100,100]}, mode:"manual"})))`,
  następnie wejście na stronę i sprawdzenie, że `/api/crops` zwraca ten plan;
- `apply to same ratio`: boks z pliku 400×300 przenosi się proporcjonalnie
  na plik 800×600;
- `square locks ratio`: przy `square` wybór proporcji jest nieaktywny, a
  boks ma `w == h`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Uruchom `pnpm typecheck && pnpm build && pnpm exec playwright test` i pytest. Wszystko musi być zielone.
- [ ] **Step 4:** Commit `feat: crop editor as a TS module with server-stored crop plans`.

---

### Task 19: Strona Dataset — źródło, siatka, crop bar i ustawienia

**Files:**
- Create:
  - `web/src/pages/dataset/DatasetPage.tsx`;
  - `web/src/pages/dataset/SourcePanel.tsx`;
  - `web/src/pages/dataset/SourceGrid.tsx`;
  - `web/src/pages/dataset/SettingsPanel.tsx`;
  - `web/src/pages/dataset/VlmSelect.tsx`;
  - `web/src/pages/dataset/datasetForm.ts` (typ formularza, wartości
    domyślne, mapowanie na `ProcessRequest`);
  - `web/e2e/dataset.spec.ts`.
- Modify: `web/src/app/routes.tsx` (`/dataset` prowadzi do `DatasetPage`, a nie do `ClassicPlaceholder`)

**Interfaces:**
- Consumes:
  - `POST /api/scan` i `POST /api/upload` (sprawdzaj `res.ok`!);
  - `GET /api/src/thumb`;
  - `GET /api/models` i `POST/DELETE /api/models/custom`;
  - `POST /api/crop/auto` i `GET /api/crop/auto/{id}`;
  - `useCropPlan`, `CropEditorDialog` (Task 18), `FolderPicker`,
    `DropZone`, `ModelSelect kind="upscale"`, `PresetBar`, `useSavedForm`.
- Produces:
  - **`DatasetForm`** z polami:
    - `{folder, mode, style, caption_format, resolution, step, square, fit, pad_color, centering_x, centering_y, fmt, jpg_quality, model, quant, max_tokens, do_caption, upscale_model, trigger, prepend_trigger, output_folder}`;
    - bez `crop_mode`, bo ten należy do `useCropPlan`;
    - wartości domyślne według inwentaryzacji §1.2, z tym że `model`
      domyślnie to `default` z `/api/models`;
    - `toProcessRequest(form, cropDoc)` buduje body dla `/api/process`:
      `crop_mode = cropDoc.mode`, `crops = cropDoc.plan`;
    - zapisany niepusty `folder` przy wejściu na stronę jest od razu
      skanowany (`/api/scan`). Błąd skanu pokazuje się tylko w linii
      statusu, bez toastu.
  - Autozapis: `useSavedForm("dataset", defaults)`, bez planów kropu.
    Presety: `PresetBar view="dataset"`. Preset obejmuje ustawienia, ale nie
    `folder`, `trigger` ani `output_folder`.
  - `VlmSelect`:
    - lista z `/api/models`;
    - dla id będących repo HF z magazynu (`/api/store/models`, `kind: "vlm"`)
      pokazuje odznakę statusu i `Download` przez `DownloadDialog`;
    - `Add model from folder…` otwiera `FolderPicker` (`requireWritable={false}`)
      i robi `POST /api/models/custom`;
    - `Remove custom` jest tylko dla własnych modeli i wymaga potwierdzenia;
    - `Refresh` tylko ponownie pobiera `/api/models`, co obejmuje też LM
      Studio. URL LM Studio edytuje się w Settings.
  - `upscale_model` używa `ModelSelect kind="upscale"` z nowym propem
    `noneLabel="Off (plain LANCZOS)"`, czyli opcją o wartości `""`.
  - Siatka:
    - kafelki wchodzą kaskadowo;
    - kafelek ma odznakę `✂`, gdy jest krop;
    - klik otwiera `CropEditorDialog`.
  - Crop bar:
    - `Auto-crop all` z potwierdzeniem w dialogu (nie `confirm()`). Tekst:
      `Auto-crop recomputes a crop for every photo. Photos where nothing is detected keep their current crop (N existing).`;
    - postęp w crop barze;
    - `skipped` pokazuje się jako lista ostrzeżeń;
    - po zakończeniu `merge` i tryb `manual`;
    - `Clear crops` z potwierdzeniem.
  - Wybór trybu `Auto` przy pustym planie pokazuje wskazówkę
    `Run "Auto-crop all" to compute crops — without them the centre crop is used.`
    To naprawia kruche miejsce nr 1 z inwentaryzacji.

- [ ] **Step 1: Testy, które padają**

`web/e2e/dataset.spec.ts`:
- `scan shows the grid`: folder z 3 PNG w `E2E_WORK` daje 3 kafelki z
  miniaturami z `/api/src/thumb` i tekst `Found 3 images`;
- `upload via drop`: dwa pliki przez `DataTransfer` dają 2 kafelki. Folder
  pochodzi z `/api/upload`;
- `settings autosave and defaults`: domyślnie `Caption mode` to `Person
  (variable traits only)`, `Target resolution` to `1024`, a `Bucket step`
  to `64`. Po zmianie `resolution` na 1280 i przeładowaniu strony wartość
  zostaje;
- `crop badge after editor save`: zapis w edytorze daje odznakę `✂` na
  kafelku;
- `vlm select lists api models`: po podmianie `/api/models` przez
  `page.route` na 2 modele lista ma 2 pozycje z ich etykietami;
- `upload with no supported files explains why`: `/api/upload` zwraca
  `count: 0`, co daje komunikat `No supported images in the upload` i
  nieaktywny `Process`;
- `auto-crop all confirms and merges`: podmieniony job auto-crop zwraca
  boks dla 1 z 2 plików, gdy oba mają już krop. Dialog zawiera `keep their
  current crop`, a po zakończeniu oba pliki mają krop i jeden z nich jest
  nowy;
- `crop source is per folder`: `Manual` w folderze A, potem skan folderu B
  pokazuje `Centre`, a powrót do A znów pokazuje `Manual`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 Dataset view — source, crop grid and settings`.

---

### Task 20: Dataset — przetwarzanie, przegląd captionów, eksport

**Files:**
- Create:
  - `web/src/pages/dataset/RunPanel.tsx`;
  - `web/src/pages/dataset/ResultsGrid.tsx`;
  - `web/src/pages/dataset/ExportPanel.tsx`;
  - `web/src/pages/dataset/runStore.ts`.
- Modify: `web/src/pages/dataset/DatasetPage.tsx`, `web/e2e/dataset.spec.ts`

**Interfaces:**
- Consumes:
  - `POST /api/process` (body z `toProcessRequest`) i `GET /api/job/{id}`;
  - `GET /api/thumb/{job}/{idx}`;
  - `POST /api/export` i `POST /api/zip`. Gdy `res.ok`, odpowiedź to blob,
    a nazwę pliku bierzesz z `Content-Disposition`. W przeciwnym razie
    odpowiedź to JSON z `detail`.
- Produces:
  - **`runStore.ts`:**
    - stan `{jobId, folder, edits: Record<idx, string>, deleted: number[]}`
      w `sessionStorage` `flux.dataset.run`;
    - `getRun()`, `startRun(jobId, folder)`, `setEdit(idx, text)`,
      `toggleDeleted(idx)`;
    - przy zapisie edycji debounce 300 ms.
  - **`Process`:**
    - jest nieaktywny bez źródła albo w trakcie joba;
    - przed wysłaniem sprawdza pola liczbowe i pokazuje błąd przy polu;
    - `JobProgress` mapuje `state` z `current`. Dla `loading_model`
      pokazuje tekst `current`.
  - **ResultsGrid:**
    - karty dochodzą w trakcie przetwarzania, kaskadowo;
    - karta ma miniaturę, `out_name`, `W×H`, `✨` przy upscalu i textarea z
      wartością `edits[idx] ?? caption`;
    - kolejne odpytania joba nie nadpisują edycji;
    - gdy włączony jest `prepend_trigger` i trigger jest niepusty, karta
      pokazuje podgląd triggera. Dla formatów JSON tekst brzmi
      `trigger added to high_level_description`;
    - przycisk `Remove` ukrywa kartę, a toast z `Undo` ją przywraca;
    - nieudane pliki (`out_name == ""`) mają czerwoną kartę z błędem, bez
      textarea i nie liczą się do eksportu;
    - ostrzeżenie o upscalu pokazuje liczbę i pierwszy błąd.
  - **ExportPanel:**
    - jest aktywny tylko przy `state == "done"`;
    - pole `Output folder` z `FolderPicker`, przycisk `Save to folder` i
      `Download .zip`;
    - tekst `To export: N images (M removed)` liczy tylko udane i nieusunięte;
    - body: `captions` zawiera tylko pozycje z edycją, a `exclude_idx`
      usunięte. Backend dla reszty bierze oryginał (inwentaryzacja §6.8);
    - w trakcie eksportu przyciski są nieaktywne, a wynik pokazuje toast
      `Saved N pairs to <folder>`.

- [ ] **Step 1: Testy, które padają** (`page.route` podmienia
  `/api/process`, `/api/job/*`, `/api/thumb/*`, `/api/export` i `/api/zip`):
- `process sends the form`: przechwycone body ma `resolution: 1024`,
  `step: 64`, `crop_mode` i `crops` z planu;
- `results arrive while processing`: job przechodzi `loading_model`,
  `processing` (1 wynik) i `done` (2 wyniki). Widać tekst `current` i
  karty pojawiające się po kolei;
- `caption edits survive navigation and polling`: edycja w trakcie
  `processing`, kolejne odpytanie, przejście na `/models` i powrót. Tekst
  edycji zostaje;
- `remove and undo`;
- `export sends only edits and exclusions`: body `/api/export` ma
  `captions` tylko z edytowanym idx i `exclude_idx` z usuniętym;
- `zip downloads with server filename`: `page.waitForEvent("download")`,
  a `suggestedFilename()` równa się nazwie z `Content-Disposition`;
- `empty number field is caught before submit`: puste `Max tokens` nie
  wysyła `/api/process` i pokazuje błąd przy polu.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 Dataset processing, caption review and export`.

---

### Task 21: Dokumentacja i stan

**Files:**
- Modify: `README.md` (sekcja nowego UI: Dataset w v2), `docs/superpowers/plans/2026-11-21-studio-v2.md` (stan Fazy 5)

- [ ] **Step 1:** README:
  - Dataset jest już w v2;
  - plany kropu leżą na serwerze w `.work/crop_plans.json`, a plany z
    klasycznego UI są przejmowane;
  - edycje captionów trzyma karta przeglądarki (`sessionStorage`) do
    eksportu.
- [ ] **Step 2:** Sekcja stanu w starym planie:
  - Faza 5 zrobiona;
  - otwarte: walidacja `ProcessRequest` mogłaby objąć `mode` i `style`
    (dziś to wolne stringi).
- [ ] **Step 3:** Commit `docs: Dataset view in v2`.
