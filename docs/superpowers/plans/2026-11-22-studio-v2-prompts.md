# Studio v2 — Prompt studio (Faza 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt studio w nowym UI (`/prompts`) z pełnym parytetem klasycznego
widoku:
- Expand i Refine;
- cel FLUX.2, Ideogram 4 albo ai-toolkit;
- typ obiektu, liczba elementów i gęstość opisu;
- style presets;
- linter v15;
- wynik z akcjami Copy, Regenerate, Use as input i Edit on canvas;
- biblioteka: filtr, kopiowanie, otwarcie na canvasie, usuwanie i eksport
  `.sql`.

**Architecture:**
- **Generowanie jako job.** Synchroniczne `POST /api/prompt` zostaje dla
  klasycznego UI. Obok powstaje job w tle (`POST /api/prompt/jobs` i
  `GET /api/prompt/jobs/{id}`), który pokazuje postęp: pobieranie modelu,
  ładowanie i generowanie. Przeżywa zmianę widoku.
- **Lint na żądanie.** Nowy endpoint `POST /api/prompts/lint` lintuje
  wynik po edycji. Lint jest jeden i działa po stronie serwera.
- **Przekazanie do canvasu.** „Edit on canvas” zapisuje JSON w
  `sessionStorage` pod kluczem `flux.bbox.handoff`. Klasyczny Bbox editor go
  czyta, dopóki `/bbox` nie powstanie w v2 (Faza 7).

**Tech Stack:** jak w poprzednich fazach: React 19, TS, Vite, Tailwind v4,
shadcn/ui, Motion, TanStack Query, Playwright 1.63, FastAPI i pytest.

**Spec:** `docs/superpowers/specs/2026-11-21-studio-v2-design.md` (§5 oraz
lista parytetu, pozycja „Prompt studio”).
**Inwentaryzacja klasycznego widoku (obowiązkowa):**
`docs/superpowers/notes/2026-11-22-prompts-inventory.md`. Zawiera kontrolki,
dokładne teksty presetów, kształt API, reguły lintu i 18 kruchych miejsc.

## Global Constraints

- Obowiązują Global Constraints z
  `docs/superpowers/plans/2026-11-22-studio-v2-ui.md` oraz
  `docs/superpowers/plans/2026-11-22-studio-v2-dataset.md`:
  - gałąź `v2`, commit po zadaniu, bez pushowania;
  - UI po angielsku, motyw ciemny, tokeny z `web/src/index.css`;
  - `MotionConfig reducedMotion="user"`;
  - e2e na porcie 8131 z `FLUX_PREP_WORK`; importy z `./fixtures.ts` i
    `./env.ts`; testy nawigacji czekają na odmontowanie widoku;
  - zapytania z parametrami przez `URLSearchParams`;
  - błędy jobów pokazujemy pierwszą linią, a pełny tekst trafia do `title`;
  - polling przetrwa chwilowe błędy i zatrzymuje się tylko na stanie
    końcowym albo 404.
- Przed commitem przechodzą:
  - `.venv/bin/python -m pytest` (`pytest.ini` ma już `-q`);
  - `cd web && pnpm typecheck && pnpm build && pnpm exec playwright test`.
- Wartości domyślne, opcje, etykiety i teksty presetów są dokładnie takie
  jak w klasycznym widoku (inwentaryzacja §1.1, §1.4 i §1.5).
- `POST /api/prompt`, `/api/prompts/library*` oraz nazwy
  `_prompt_category`, `_save_prompt_to_library` i `api_prompt_library*`
  zostają bez zmian. Korzysta z nich klasyczne UI i
  `tests/test_prompt_library.py`.
- Testy e2e nie generują niczego prawdziwym modelem. `/api/prompt/jobs*`
  podmieniamy przez `page.route`. Biblioteka i lint działają na prawdziwym
  serwerze.
- Kopiowanie do schowka ma rezerwę dla `http` bez bezpiecznego kontekstu:
  `execCommand("copy")` na tymczasowej textarea, tak jak w klasycznym UI.

## Review Focus

1. **Wynik nie znika** po przejściu na inny widok w trakcie generowania ani
   po nim. Job wznawia się po powrocie, a wynik pamięta swój format. Test:
   Task 23 `generation survives navigation`.
2. **Lint odpowiada temu, co widać:** po edycji wyniku ostrzeżenia liczą się
   na nowo. Po zmianie formatu w formularzu ostrzeżenia i „Edit on canvas”
   dalej zależą od formatu wyniku, a nie od bieżącej wartości pola. Testy:
   Task 23 `edited result is re-linted` i
   `warnings follow the result format`.
3. **Brak folderu modeli albo nieudane pobranie** daje czytelny błąd w
   panelu wyniku (pierwsza linia), a nie surowy JSON. Test: Task 22
   `test_prompt_job_reports_missing_models_folder` oraz Task 23
   `job error shows first line`.
4. **Usunięcie z biblioteki** wymaga potwierdzenia. Lista odświeża się po
   wygenerowaniu i po usunięciu. Testy: Task 24 `delete asks and refreshes`
   i `new prompt appears after generation`.
5. **„Edit on canvas” otwiera prompt w Bbox editorze.** Do czasu Fazy 7 to
   klasyczny edytor. Test: Task 24 `open on canvas hands off to the classic
   bbox editor`.

---

### Task 22: Backend — job generowania promptu i lint na żądanie

**Files:**
- Modify: `backend/server.py`, `tests/conftest.py` (fixture `prompt_db`)
- Test: `tests/test_prompt_jobs.py` (nowy)

**Interfaces:**
- Produces:
  - **`POST /api/prompt/jobs`:**
    - body jak `PromptRequest`, ale z walidacją:
      - `max_tokens: int = Field(768, ge=64, le=8192)`;
      - `action: Literal["expand","refine"]`;
      - `caption_format: Literal["flux","ideogram","aitoolkit"]`;
      - `subject: Literal["auto","person","product","landscape","architecture"]`;
      - `elements_detail: Literal["few","balanced","detailed","maximal"]`;
      - `desc_detail: Literal["brief","balanced","rich"]`;
      - `quant: Literal["4bit","none"]`;
    - pusty tekst po `strip()` daje 400 `Type a prompt to expand or refine.`;
    - odpowiedź to `{"job_id": str}`.
  - **Job:**
    - kind `"prompt"` w `JOBS`;
    - kształt `{id, kind, state, current, error, result}`;
    - stany: `pending` → `loading_model` → `generating` → `done` | `error`;
    - podczas pobierania `current` pokazuje postęp przez
      `_ensure_model(model, job)`;
    - `result` = `{prompt, warnings, library_id, format}`, gdzie `format`
      to `caption_format` z żądania;
    - logika generowania jest wydzielona z `api_prompt` do
      `_generate_prompt(req, ensure: Callable[[str], str], job: dict | None = None) -> dict`;
    - klasyczne `/api/prompt` przekazuje `ensure=_ensure_model_http` i
      zachowuje obecne mapowanie błędów co do kodu i tekstu:
      - 400 z `_ensure_model_http`;
      - 502 `LM Studio: …` dla `LMStudioError`;
      - 500 `Generation error: …` dla pozostałych;
    - job przekazuje `ensure=lambda m: _ensure_model(m, job)`, co daje postęp
      pobierania w `current`. `error` joba zaczyna się tym samym tekstem, który
      klasyczny endpoint dałby w `detail`:
      - komunikat `ModelsFolderNotSet` i `ValueError`;
      - `LM Studio: …`;
      - `Generation error: …` dla pozostałych;
    - funkcja wątku joba ma catch-all `except BaseException`, który zawsze
      ustawia `state="error"`. Wątek, który się wywróci, nie może zostawić
      joba w `pending`, `loading_model` ani `generating`, bo wtedy `_busy()`
      blokowałby `/api/unload` na zawsze;
    - `_busy()` uznaje `generating` za stan zajętości, tak jak `processing`;
    - `POST /api/prompt/jobs` daje 409 `Processing in progress — wait for it to finish.`,
      gdy `_busy()` jest prawdą, a model nie zaczyna się od `lmstudio:`.
      Powód: `captioner.ensure_loaded` podmienia wspólny model, gdy różni
      się model albo kwantyzacja. Modele LM Studio nie dotykają GPU tej
      aplikacji.
  - **`GET /api/prompt/jobs/{id}`** zwraca `{state, current, error, result}`.
    Inny kind albo brak joba daje 404 (`_job_of_kind`).
  - **`POST /api/prompts/lint`:**
    - body `{"prompt": str}`;
    - odpowiedź `{"warnings": [...]}` z `v15_lint.lint_v15`;
    - pusty prompt daje `{"warnings": []}`.

- [ ] **Step 1: Testy, które padają**

Fixture `prompt_db` w `tests/conftest.py` (nie autouse) podmienia
`server.DB_PATH` na `tmp_path / "flux_prep.db"` i wywołuje
`server._init_db()`, tak jak `tests/test_prompt_library.py`. Każdy test,
który dochodzi do `_save_prompt_to_library`, go używa. Żaden test nie może
pisać do prawdziwej bazy.

`tests/test_prompt_jobs.py`. `captioner.ensure_loaded` i
`captioner.generate_text` podmieniasz, tak samo `_ensure_model_http` i
`_ensure_model` (zwracają ścieżkę). Wątek joba uruchamiasz synchronicznie,
podmieniając `threading.Thread`:
- `test_prompt_job_flux_done`: job dochodzi do `done`, a `result.prompt` jest
  oczyszczony przez `clean_prompt`, `format == "flux"`, `warnings == []` i
  wiersz trafia do biblioteki;
- `test_prompt_job_ideogram_lints`: przy formacie `ideogram`
  `result.warnings` jest listą i powstaje wiersz z kategorią `ideogram`;
- `test_prompt_job_reports_missing_models_folder`: `_ensure_model` rzuca
  `ModelsFolderNotSet()`, co daje `state == "error"`, a `error` zaczyna się
  od `No models folder chosen`;
- `test_prompt_job_validation`: `max_tokens=10` daje 422, `action="x"` daje
  422, a pusty tekst daje 400;
- `test_prompt_job_wrong_kind_404`;
- `test_lint_endpoint`: `{"prompt": "not json"}` zwraca jedno ostrzeżenie z
  `level == "err"`, a `{"prompt": ""}` zwraca `[]`;
- `test_busy_while_generating`: job w stanie `generating` sprawia, że
  `/api/unload` daje 409;
- `test_legacy_prompt_endpoint_unchanged`: `POST /api/prompt` dalej zwraca
  `{prompt, library_id, warnings}`;
- `test_legacy_prompt_error_codes`: `ModelsFolderNotSet` daje 400 z tym
  komunikatem, a `LMStudioError("x")` dla modelu `lmstudio:a` daje 502 z
  `detail` zaczynającym się od `LM Studio:`;
- `test_prompt_job_lmstudio_error_text`: `error` joba zaczyna się od
  `LM Studio:`;
- `test_prompt_job_crash_ends_in_error`: `generate_text` rzuca
  `RuntimeError("boom")`, co daje `state == "error"`, a `error` zaczyna się
  od `Generation error: boom`. Potem `/api/unload` daje 200;
- `test_prompt_job_409_while_busy`: przy innym jobie w stanie `processing`
  `POST /api/prompt/jobs` z modelem HF daje 409, a z modelem `lmstudio:x`
  daje 200.

- [ ] **Step 2:** Uruchom testy i sprawdź, że padają.
- [ ] **Step 3:** Zaimplementuj.
- [ ] **Step 4:** Pełny pytest musi być zielony.
- [ ] **Step 5:** Commit `feat: background prompt generation jobs and on-demand v15 lint`.

---

### Task 23: Strona Prompt studio — formularz, generowanie, wynik

**Files:**
- Create:
  - `web/src/pages/prompts/PromptsPage.tsx`;
  - `web/src/pages/prompts/PromptForm.tsx`;
  - `web/src/pages/prompts/ResultPanel.tsx`;
  - `web/src/pages/prompts/promptForm.ts`: typ, wartości domyślne, teksty
    presetów i mapowanie na body joba;
  - `web/src/pages/prompts/promptRunStore.ts`;
  - `web/src/components/V15Findings.tsx`, wspólny z przyszłym Bbox
    editorem;
  - `web/src/lib/clipboard.ts`;
  - `web/src/hooks/useJobPoll.ts`;
  - `web/src/components/NumberInput.tsx` (wyciągnięty z Dataset
    `SettingsPanel.tsx`, który od teraz go importuje);
  - `web/e2e/prompts.spec.ts`.
- Modify: `web/src/app/routes.tsx` (`/prompts` prowadzi do `PromptsPage`)

**Interfaces:**
- Consumes:
  - Task 22;
  - `VlmSelect` z `web/src/pages/dataset/VlmSelect.tsx`, który przenosisz do
    `web/src/components/VlmSelect.tsx` i poprawiasz import w Dataset;
  - `useSavedForm`, `PresetBar`, `JobProgress`.
- Produces:
  - **`useJobPoll<T>(key: unknown[], url: string | null, opts?: {intervalMs?: number, terminal?: string[]})`:**
    - zwraca `{data, isGone, running}`;
    - odpytuje co `intervalMs` (domyślnie 700) przez chwilowe błędy i
      zatrzymuje się na `terminal` (domyślnie `["done","error"]`) albo 404;
    - `isGone` oznacza 404;
    - w tej fazie używa go tylko Prompt studio. Migracja Upscale i Dataset
      może poczekać.
  - **`PromptForm`:**
    - pola: `{action, subject, caption_format, model, quant, max_tokens, elements_detail, desc_detail}`;
    - wartości domyślne z inwentaryzacji §1.1, czyli `expand`, `auto`,
      `flux`, `4bit`, 768, `balanced` i `balanced`;
    - `model` domyślnie to `default` z `/api/models`, tak jak w Dataset;
    - autozapis przez `useSavedForm("prompts", …)`;
    - presety przez `PresetBar view="prompts"`;
    - `text` (treść promptu) nie trafia do autozapisu ani do presetów, bo
      nie powinna lądować w `settings.json` ani w eksporcie ustawień. Trzyma
      go `promptRunStore` (`sessionStorage`);
    - `Max length` to wspólny `NumberInput`. Puste albo spoza zakresu
      64–8192 pole pokazuje błąd przy polu i blokuje Generate.
  - **`promptRunStore`** (`sessionStorage` `flux.prompts.run`):
    - stan `{text, jobId, result, edited}`;
    - `jobId` zapisuje się w `onSuccess` na poziomie mutacji, a nie w
      callbacku `mutate` (lekcja z Fazy 5);
    - po `done` `result` (`{prompt, warnings, format, library_id}`) kopiuje
      się do store'u, a `jobId` się czyści. Restart serwera nie usuwa wtedy
      pokazanego wyniku i nie wywołuje toastu 404;
    - nowe uruchomienie czyści `edited` i `result`;
    - `useJobPoll` działa tylko wtedy, gdy jest `jobId`.
  - **Formularz:**
    - przełącznik `Expand (from a short idea)` / `Refine (clean up an existing one)`
      jest segmentowany i ma wskaźnik `layoutId`;
    - podpowiedź i placeholder zmieniają się dynamicznie według
      inwentaryzacji §1.1, łącznie z sufiksem formatu;
    - pola `Element count (Ideogram)` i `Description density (Ideogram)`
      widać tylko dla `ideogram` i `aitoolkit`;
    - są trzy selecty presetów stylu (`Era…`, `Style…`, `Genre / mood…`)
      z dokładnymi tekstami z §1.4. Po wyborze opcji tekst presetu dopisuje
      się do pola, a select wraca do placeholdera.
  - **Generate:**
    - przy pustym tekście pokazuje błąd przy polu i niczego nie wysyła;
    - w przeciwnym razie wysyła `POST /api/prompt/jobs` i zapisuje
      `{jobId, format}` w `promptRunStore` (`sessionStorage`
      `flux.prompts.run`);
    - postęp pokazuje `JobProgress` bez sum (bez `processed/total`) z
      animacją nieokreśloną i tekstem:
      - `current` przy `loading_model`;
      - `Generating…` przy `generating`;
      - `Starting…` przy `pending`;
    - przycisk jest nieaktywny w trakcie generowania.
  - **`ResultPanel`:**
    - pole wyniku jest edytowalne;
    - edycje trzyma `promptRunStore` (`edited`), więc przeżywają
      nawigację;
    - `V15Findings` pokazuje ostrzeżenia tylko wtedy, gdy wynik jest JSON
      (`format` różny od `flux`);
    - po edycji uruchamia się ponowny lint przez `POST /api/prompts/lint`
      z debounce 500 ms. To `useQuery` z kluczem
      `["lint", debouncedText]`, więc starsza odpowiedź nie nadpisze nowszej.
      Bez edycji pokazują się `result.warnings`;
    - przyciski: `Copy` (z rezerwą dla `http`), `Regenerate`, `Use as input`
      (tekst przechodzi do pola wejściowego, tryb zmienia się na `refine`) i
      `Edit on canvas`. Ten ostatni pojawia się tylko dla wyniku JSON i
      wykonuje handoff z Taska 24.
  - **`V15Findings({findings})`:**
    - pusta lista daje `✓ No warnings — compliant with the v15 guidelines`;
    - `err` daje ikonę `✕` w kolorze błędu, `warn` daje `!` w kolorze
      ostrzeżenia.

- [ ] **Step 1: Testy, które padają** (`page.route` podmienia `/api/prompt/jobs*`):
- `form defaults and visibility`: domyślnie `Expand` i `FLUX.2 (natural
  language)` oraz brak pól Ideogram. Po przełączeniu na `Ideogram 4 (JSON)`
  pola się pojawiają, a podpowiedź kończy się na `Ideogram 4 (JSON).`;
- `preset appends exact text`: preset `Era… → Victorian (1890s)` dopisuje
  dokładny tekst z §1.4 po pustej linii, a select wraca do `Era…`;
- `generate sends the job body`: przechwycone body ma pola formularza, a
  `max_tokens` to 768;
- `generation survives navigation`: job jest w `generating`, potem przejście
  na `/models` (z czekaniem na odmontowanie) i powrót. Postęp jest dalej
  widoczny. Po `done` widać wynik;
- `job error shows first line`;
- `edited result is re-linted`: wynik ideogram, edycja na `not json` i po
  ~600 ms widać błąd `The prompt is not valid JSON.`. To prawdziwy endpoint
  lintu;
- `warnings follow the result format`: wynik ideogram, potem zmiana pola
  formatu na `flux`. Ostrzeżenia i `Edit on canvas` dalej są widoczne;
- `use as input switches to refine`;
- `form autosaves`: zmiana `Max length` na 2048, przeładowanie, wartość
  zostaje.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 Prompt studio — form, background generation and result`.

---

### Task 24: Biblioteka promptów i handoff do Bbox editora

**Files:**
- Create: `web/src/pages/prompts/LibraryPanel.tsx`, `web/src/lib/bboxHandoff.ts`
- Modify:
  - `web/src/pages/prompts/PromptsPage.tsx`;
  - `web/src/pages/prompts/ResultPanel.tsx`;
  - `frontend/app.js`: addytywnie, odczyt handoffu;
  - `web/e2e/prompts.spec.ts`.

**Interfaces:**
- Consumes:
  - `GET /api/prompts/library?category=`;
  - `DELETE /api/prompts/library/{id}`;
  - `GET /api/prompts/library/export?category=`.
- Produces:
  - **`LibraryPanel`:**
    - zakładki `All`, `FLUX.2` i `Ideogram (JSON)` z filtrem po stronie
      serwera;
    - dodatkowo pole `Filter…` filtruje po stronie klienta po treści i
      `input_text`;
    - wiersz ma odznakę kategorii, prompt z rozwijaniem kliknięciem i meta
      `#id · <data w lokalnym formacie przeglądarki> · „input”`. Nie używaj
      `pl-PL`;
    - przyciski: `Copy`; `Open on canvas` (tylko dla kategorii `ideogram`);
      `Delete` z `ConfirmDialog` (`Delete prompt #N? This cannot be undone.`);
    - `Export .sql` to `<a href download>` dla aktywnej kategorii;
    - `Refresh`;
    - pusty stan pokazuje tekst `The library is empty — generate your first prompt above.`;
    - wiersze wchodzą kaskadowo;
    - query key `["prompt-library", category]`. Inwalidujesz go po `done`
      joba i po usunięciu.
  - **`bboxHandoff.ts`:**
    - `handOffToBbox(json: string): void` zapisuje
      `sessionStorage["flux.bbox.handoff"] = json`, po czym
      `location.assign("/legacy/#bbox")`;
    - w Fazie 7 ta funkcja przejdzie na nawigację do v2 `/bbox`.
  - **`frontend/app.js`** (addytywnie):
    - przy starcie, jeśli `sessionStorage["flux.bbox.handoff"]` istnieje,
      usuń klucz, przełącz widok na `bbox` i wywołaj
      `window.BboxEditor.open(json)`;
    - reszta klasycznego zachowania bez zmian.

- [ ] **Step 1: Testy, które padają:**
- `library lists real rows`: wiersze wstawiasz przez prawdziwe
  `POST /api/prompts/library` (`category` `flux` i `ideogram`). Zakładka
  `Ideogram (JSON)` pokazuje tylko wiersz ideogram, a `Filter…` zawęża
  listę;
- `delete asks and refreshes`: `Cancel` zostawia wiersz, a `Delete` go
  usuwa (prawdziwy DELETE);
- `new prompt appears after generation`: przy podmienionym jobie, który
  przechodzi w `done`, następuje refetch biblioteki. Wiersz wstawiasz przed
  `done` przez POST, żeby symulować zapis serwera;
- `export link targets active category`: `href` zawiera `category=ideogram`;
- `open on canvas hands off to the classic bbox editor`: klik daje URL
  `/legacy/#bbox`, w edytorze widać `Prompt loaded for editing.`, a klucz
  `flux.bbox.handoff` jest usunięty;
- `copy falls back without clipboard API`: `addInitScript` ukrywa API
  przez `Object.defineProperty(navigator, "clipboard", { get: () => undefined })`.
  Zwykłe `delete` nie usuwa gettera z prototypu. Klik `Copy` daje toast
  `Copied`.

`clipboard.ts`: `copyText(text): Promise<void>` przechodzi na rezerwę
`execCommand`, gdy API nie istnieje i gdy `writeText` odrzuci obietnicę
(np. dokument bez focusu).

Testy biblioteki dzielą jedną bazę przez cały przebieg e2e. Każdy test
wstawia wiersze z unikalnym znacznikiem (np. `marker-<test>-<Date.now()>`) i
sprawdza tylko je, nigdy liczby wierszy.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 prompt library and bbox editor handoff`.

---

### Task 25: Dokumentacja i stan

- [ ] **Step 1:** README:
  - Prompt studio jest w v2, generowanie działa w tle;
  - nowe endpointy `POST /api/prompt/jobs`, `GET /api/prompt/jobs/{id}` i
    `POST /api/prompts/lint`;
  - handoff do Bbox editora przez `sessionStorage`.
- [ ] **Step 2:** Sekcja stanu w `docs/superpowers/plans/2026-11-21-studio-v2.md`:
  Faza 6 zrobiona, otwarte sprawy.
- [ ] **Step 3:** Commit `docs: Prompt studio in v2`.
