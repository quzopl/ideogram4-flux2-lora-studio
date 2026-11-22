# Studio v2 — Bbox editor, From image i render Ideogram 4 (Faza 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bbox editor w nowym UI (`/bbox`) z parytetem klasycznego widoku:
- edytowalny canvas z boksami (przeciąganie, zmiana rozmiaru, cykl nakładających
  się boksów, z-order);
- karty z licznikami słów i żywy linter;
- Paste JSON, Copy, Download i Save to library;
- From image (Florence, VLM i Hybrid);
- render Ideogram 4 przez ComfyUI z podglądem na żywo i siatką wyników.

Przekazanie z Prompt studio trafia już do v2 `/bbox`.

**Architecture:**
- **Model dokumentu v15** to czysty moduł TS (`web/src/editors/bbox/model.ts`).
  Kolejność elementów w tablicy to z-order (ostatni na wierzchu), więc
  niepotrzebne jest osobne pole `z`.
- **Canvas** to komponent React z pointer capture, 8 uchwytami i
  `ResizeObserver`.
- **Lint jest jeden: serwerowy.** `POST /api/prompts/lint` z debounce, bez
  klienckiej kopii reguł, więc numeracja elementów zgadza się z serwerem.
- **Wklejony JSON normalizuje serwer** (nowy `POST /api/ideogram/normalize`
  na bazie `normalize_ideogram_v15`).
- **From image jako job** z postępem, tak jak prompt w Fazie 6.
  Synchroniczne `/api/ideogram/analyze` zostaje dla klasycznego UI.
- **Render** używa istniejących `/api/ideogram/render` i `/api/comfy/job/*`.
  Cancel naprawdę przerywa ComfyUI (`/interrupt`).
- **Szkic edytora** trzyma `sessionStorage`, więc przeżywa nawigację.

**Tech Stack:** jak w poprzednich fazach.

**Spec:** `docs/superpowers/specs/2026-11-21-studio-v2-design.md` (§5 oraz
lista parytetu, pozycja „Bbox editor”).
**Inwentaryzacja (obowiązkowa):**
`docs/superpowers/notes/2026-11-22-bbox-inventory.md`, a reguły lintu i
handoff w `docs/superpowers/notes/2026-11-22-prompts-inventory.md`.

## Global Constraints

- Obowiązują Global Constraints z planów
  `docs/superpowers/plans/2026-11-22-studio-v2-ui.md`,
  `...-dataset.md` i `...-prompts.md`:
  - gałąź `v2`, commit po zadaniu, bez pushowania;
  - UI po angielsku, motyw ciemny, tokeny;
  - `MotionConfig reducedMotion="user"`;
  - e2e na porcie 8131 z `FLUX_PREP_WORK`; importy z `./fixtures.ts` i
    `./env.ts`; testy nawigacji czekają na odmontowanie widoku;
  - `URLSearchParams`;
  - błędy jobów: pierwsza linia w UI, pełny tekst w `title`;
  - polling przez `useJobPoll`;
  - `jobId` zapisany w `onSuccess` na poziomie mutacji;
  - kopiowanie przez `lib/clipboard.ts`.
- Przed commitem przechodzą:
  - `.venv/bin/python -m pytest`;
  - `cd web && pnpm typecheck && pnpm build && pnpm exec playwright test`.
- Etykiety, opcje i wartości domyślne kontrolek są takie jak w klasycznym
  widoku (inwentaryzacja §1.1, §1.4 i §1.5). Wyjątek: rzeczy, które ten plan
  świadomie zmienia (numeracja elementów, 8 uchwytów, skróty klawiszowe).
- Klasyczne UI (`/legacy/#bbox`) działa dalej bez zmian. Klasyczne
  `/api/ideogram/analyze` i `/api/ideogram/render` zachowują kontrakt.
- Testy e2e nie uruchamiają Florence, VLM ani ComfyUI. Joby analyze i render
  oraz `/api/comfy/*` podmieniamy przez `page.route`. Lint, normalize i
  biblioteka działają na prawdziwym serwerze, a wiersze biblioteki mają
  unikalne znaczniki.
- Wyjściowy JSON ma kolejność kluczy jak `buildCaption` z klasycznego UI
  (inwentaryzacja §2.1). Minified używa `JSON.stringify` bez spacji.

## Review Focus

1. **Przeciągnięcie boksu daje poprawne `bbox` [y1,x1,y2,x2] w skali 0–1000**
   przy każdej proporcji ramki, również 3:1 i 9:16. Wartości mieszczą się w
   0–1000, a `y1<y2` i `x1<x2`. Testy: Task 27 `drag and resize update the
   bbox` i `bbox stays in range at extreme ratios`.
2. **Wklejony JSON w starym, zawiniętym albo podwójnie zakodowanym formacie**
   ładuje się poprawnie. Śmieci dają błąd, a edytor nie zostaje pusty ani
   częściowo nadpisany. Testy: Task 26 `test_normalize_*` i Task 28
   `paste double-encoded loads`, `paste garbage keeps the canvas`.
3. **Klik w nakładające się boksy cyklicznie zmienia zaznaczenie, a
   przeciągnięcie przesuwa zaznaczony boks** i nie zmienia wyboru, w
   przeciwieństwie do klasycznego UI. Test: Task 27 `overlap cycling on click,
   not on drag`.
4. **Render i From image przeżywają nawigację.** Anulowanie renderu
   przerywa ComfyUI, a wyniki się nie dublują. Testy: Task 26
   `test_cancel_interrupts_comfy`, Task 29 `analysis survives navigation`
   i Task 30 `render survives navigation without duplicate results`.
5. **Przekazanie z Prompt studio trafia do v2 `/bbox`.** Klucz `sessionStorage`
   jest zużywany jednorazowo, a zły JSON daje błąd zamiast pustego canvasu.
   Test: Task 28 `handoff from prompt studio`.

---

### Task 26: Backend — normalize, job analizy obrazu, prawdziwy cancel renderu

**Files:**
- Modify: `backend/server.py`, `backend/comfy_client.py`
- Test: `tests/test_bbox_backend.py` (nowy)

**Interfaces:**
- Produces:
  - **`POST /api/ideogram/normalize`:**
    - body `{"text": str}`;
    - jeśli `prompts._extract_json_object(text)` zwraca `None`, a
      `json.loads(text)` daje `str`, normalizacja idzie raz rekurencyjnie na
      tym stringu (podwójne kodowanie na najwyższym poziomie);
    - brak obiektu JSON daje 400 `No JSON object found in the pasted text.`;
    - w przeciwnym razie odpowiedź to
      `{"prompt": normalize_ideogram_v15(...), "warnings": lint_v15(prompt), "legacy_style": bool}`;
    - `legacy_style` jest `true`, gdy wejściowy obiekt (po odwinięciu) miał
      `style_description` z niepustym którymkolwiek polem (aesthetics,
      lighting, photo, art_style, color_palette), tak jak klasyczne
      `hadLegacyStyle`. UI pokazuje wtedy ostrzeżenie
      `Loaded the OLD format with style_description — those fields do not exist in v15 and were dropped; rewrite the style as prose into the HLD or background.`;
    - **normalizacja nie może gubić treści dokumentu z edytora.** Wymaga tego
      test tożsamości poniżej. Jeśli `_norm_elements_v15` albo `_norm_bbox`
      gubią albo nadpisują element bez `bbox`, element text, obj z pustym
      `desc` albo proporcję 3:1, poprawiasz to w `prompts.py` bez zmiany
      kontraktu `/api/prompt`.
  - **`POST /api/ideogram/analyze/jobs`:**
    - multipart z polami `file`, `engine` (`florence|vlm|hybrid`), `model`,
      `quant` (`4bit|none`) i `max_tokens` (64–8192, domyślnie 1536);
    - walidacja obrazu przez dekodowanie, a nie przez content type: plik z
      pustym albo nieobrazowym MIME przechodzi, jeśli `Image.open` (z
      zarejestrowanym `pillow_heif`, jak w `image_utils`) go otworzy i
      `convert("RGB")` się uda. Inaczej 400 `Failed to read the image.`;
    - pusty plik daje 400 `Upload an image file.`;
    - walidacja odbywa się przed utworzeniem joba. Klasyczny endpoint zostaje
      z dotychczasową walidacją;
    - odpowiedź `{"job_id"}`;
    - kind `"analyze"` i stany `pending`, `loading_model`, `analyzing`,
      `done`, `error`;
    - `result` = `{json, elements, model, warnings}`;
    - logika wydzielona z klasycznego `api_ideogram_analyze` do
      `_analyze_image(img, engine, model, quant, max_tokens, ensure, job=None) -> dict`;
    - błędy mapowane tak jak w `_run_prompt_job`, czyli po miejscu powstania;
      w jobie traceback idzie po pierwszej linii;
    - catch-all `BaseException`;
    - `_busy()` uznaje `analyzing` za stan zajętości;
    - 409, gdy `_busy()` i silnik nie jest czysto LM Studio. Florence zawsze
      używa lokalnego GPU, więc dla `florence` 409 obowiązuje zawsze.
  - **`GET /api/ideogram/analyze/jobs/{id}`** zwraca `{state, current, error, result}`
    przez `_job_of_kind(…, "analyze")`.
  - **`comfy_client.interrupt(base_url: str) -> None`:**
    - `POST {base_url}/interrupt`;
    - błędy sieci są połykane i logowane.
  - **`comfy_client.delete_queued(base_url: str, prompt_id: str) -> None`:**
    - `POST {base_url}/queue` z `{"delete": [prompt_id]}`;
    - błędy połykane i logowane.
  - **`POST /api/comfy/job/{id}/cancel`:**
    - job terminalny (`done`, `error`, `cancelled`) zwraca `{"ok": True}` i
      niczego nie wysyła do ComfyUI;
    - job, którego prompt jeszcze czeka w kolejce (nie dostał eventu
      `execution_start` ani `executing` ze swoim `prompt_id`), dostaje
      `delete_queued`;
    - job, którego prompt właśnie się wykonuje, dostaje `interrupt`.
      `interrupt` przerywa tylko bieżące wykonanie serwera, więc nie wolno go
      wysłać, gdy nasz prompt nie jest wykonywany;
    - runner musi zapisywać w jobie `prompt_id` i flagę `executing`;
    - przeczytaj, jak `stream_events` i pętla `/history` reagują na
      przerwany prompt (ComfyUI wysyła `execution_interrupted`). Job ma
      skończyć jako `cancelled`, a nie `error` ani zawieszony.
  - **Teksty statusu:** `current` w `_run_comfy_raw_job` zmienia się z
    `Krok v/m` na `Step v/m`.

- [ ] **Step 1: Testy, które padają** (`tests/test_bbox_backend.py`; joby
  synchronicznie przez podmienione `threading.Thread`; Florence, captioner i
  ComfyUI podmienione):
- `test_normalize_wrapped_and_legacy`: `{"caption": {...v15...}}` i stary
  format z `style_description` dają poprawny v15 bez `style_description`;
- `test_normalize_double_encoded_top_level`: `json.dumps(json.dumps(v15))` daje
  ten sam prompt co `v15`;
- `test_normalize_garbage_400`: `"hello"` daje 400 z komunikatem jak wyżej;
- `test_analyze_job_florence_done`: `result.json` jest JSON-em v15, a
  `elements` jest liczbą;
- `test_analyze_job_rejects_non_image`: zły content type daje 400 i nie
  tworzy joba;
- `test_analyze_job_error_first_line`: `_ensure_model_mapped` rzuca
  `HTTPException(400, "No models folder chosen…")`, więc `error` zaczyna się
  od tego tekstu, a po nim jest traceback;
- `test_analyze_job_409_while_busy`;
- `test_legacy_analyze_unchanged`: klasyczne `/api/ideogram/analyze` dalej
  zwraca `{json, elements, model, warnings}`;
- `test_normalize_editor_output_is_identity`: JSON w kształcie z edytora daje
  ten sam obiekt (porównanie po `json.loads`), np.
  `{"aspect_ratio":"3:1","high_level_description":"h","compositional_deconstruction":{"background":"b","elements":[{"type":"obj","bbox":[10,20,300,400],"desc":""},{"type":"obj","desc":"no box"},{"type":"text","bbox":[1,2,3,4],"text":"A\nB","desc":"d"}]}}`;
- `test_normalize_legacy_style_flag`;
- `test_analyze_job_accepts_empty_mime_image`: PNG wysłany z
  `application/octet-stream` daje 200 i `job_id`;
- `test_cancel_running_interrupts_comfy`: job z `executing=True` daje
  wywołanie `interrupt`, a `delete_queued` nie zostaje wywołane;
- `test_cancel_queued_deletes_from_queue`: job jeszcze w kolejce daje
  wywołanie `delete_queued(url, prompt_id)`, a `interrupt` nie zostaje
  wywołane;
- `test_cancel_terminal_sends_nothing`;
- `test_interrupted_run_ends_cancelled`: podmienione `stream_events`
  emitują `execution_interrupted` przy ustawionej fladze, więc job kończy
  jako `cancelled`;
- `test_raw_runner_step_text`: podmienione `stream_events` emitują progress,
  co daje `current == "Step 3/10"`.

- [ ] **Step 2:** Uruchom testy i sprawdź, że padają.
- [ ] **Step 3:** Zaimplementuj.
- [ ] **Step 4:** Pełny pytest musi być zielony.
- [ ] **Step 5:** Commit `feat: bbox backend — JSON normalize, image analysis jobs, real render cancel`.

---

### Task 27: Model v15 i canvas edytora

**Files:**
- Create:
  - `web/src/editors/bbox/model.ts`;
  - `web/src/editors/bbox/geometry.ts`;
  - `web/src/editors/bbox/BboxCanvas.tsx`;
  - `web/src/pages/bbox/BboxPage.tsx` (na razie sam canvas, toolbar
    proporcji i przyciski `+ obj` / `+ text`);
  - `web/src/pages/bbox/bboxStore.ts`;
  - `web/e2e/bbox.spec.ts`.
- Modify: `web/src/app/routes.tsx` (`/bbox` prowadzi do `BboxPage`)

**Interfaces:**
- Produces:
  - **`model.ts`:**
    - `type El = {key: string, type: "obj"|"text", bbox: [number,number,number,number] | null, desc: string, text: string}`,
      gdzie `key` to stabilne id tylko po stronie klienta (klucz kart i
      boksów), które nie trafia do JSON-a;
    - `type Doc = {aspect_ratio: string, hld: string, bg: string, elements: El[]}`;
    - `emptyDoc(): Doc` daje `1:1` i jeden pusty obj z `defBbox`, jak
      klasyczny init;
    - `toCaption(doc): object` z kolejnością kluczy jak w klasycznym
      `buildCaption`, z pominiętym `bbox`, gdy jest `null`, i z `text` tylko
      dla typu text;
    - `toJson(doc, pretty=false): string`;
    - `fromCaption(obj): Doc` przyjmuje JSON już znormalizowany przez serwer;
    - `defBbox(type, ratio)` z wartościami z inwentaryzacji §2.2;
    - `addEl(doc, type)`, `removeEl(doc, i)`,
      `moveEl(doc, i, dir: "forward"|"backward")` (zamiana sąsiadów w
      tablicy) i `setBbox(doc, i, bbox)`.
  - **`geometry.ts`:**
    - `toPx(bbox, W, H)` i `toBbox(rect, W, H)`. Ten drugi zaokrągla do
      intów, przycina do 0–1000 i wymusza minimum 10 jednostek, jak klasyczne
      `bboxFromPx`;
    - `resize(rect, handle, dx, dy, W, H, minPx=8)` dla 8 uchwytów
      (`nw n ne e se s sw w`);
    - `hitStack(doc, x, y, W, H): number[]` zwraca indeksy elementów pod
      punktem, posortowane rosnąco po polu.
  - **`BboxCanvas`** (`{doc, selected, onSelect, onChange}`):
    - ramka liczona z `ResizeObserver` na hoście i zachowuje dokładną
      proporcję `aspect_ratio`;
    - siatka 10%;
    - boksy obj są niebieskie, boksy text fioletowe `#b07cff`, a etykieta to
      `obj #N` albo `text: …`, gdzie N to indeks w tablicy plus 1, tak jak
      numeruje serwerowy lint;
    - pointer capture na elemencie i `touch-action: none`;
    - przeciągnięcie środka przesuwa boks, a uchwyty (tylko na zaznaczonym)
      zmieniają rozmiar;
    - **reguła wskaźnika:**
      - `pointerdown` na stosie, który zawiera zaznaczony element, chwyta
        zaznaczony;
      - na stosie bez zaznaczonego elementu zaznacza i chwyta najmniejszy;
      - przy równym polu wygrywa element wyżej w z-order, czyli z większym
        indeksem;
      - `pointerup` bez ruchu (poniżej 3 px), jeśli ten sam `pointerdown`
        nie zmienił zaznaczenia i stos ma ponad 1 element, przechodzi
        cyklicznie do następnego elementu stosu w kolejności od najmniejszego;
      - `pointerdown`, który zmienił zaznaczenie, nie cykluje przy swoim
        `pointerup`;
      - przeciągnięcie nigdy nie zmienia zaznaczenia;
    - klik w puste miejsce odznacza;
    - skróty przy focusie na canvasie: strzałki przesuwają o 1 jednostkę
      bboxa, a z Shift o 10; `Delete` i `Backspace` usuwają zaznaczony;
      `Escape` odznacza.
  - **`bboxStore`:**
    - `sessionStorage` `flux.bbox.draft` z `{doc, selected}`;
    - debounce 300 ms i flush na `pagehide` oraz przy odmontowaniu, wzorem
      `runStore`;
    - `useBboxDoc()` zwraca `[doc, setDoc, selected, setSelected]`.
  - **Toolbar:**
    - segmenty `1:1 4:5 9:16 16:9 3:1` ze wskaźnikiem `layoutId`;
    - pole custom `W:H`, które zatwierdza się przy blur i Enter, a niepoprawną
      wartość pokazuje jako błąd przy polu;
    - przyciski `+ obj` i `+ text`.

- [ ] **Step 1: Testy, które padają** (`web/e2e/bbox.spec.ts`). Odczyt stanu
  przez element `pre[data-testid="bbox-json"]` z pretty JSON-em; w tym
  zadaniu wystarczy minimalny podgląd, a Task 28 robi pełny panel. Dokumenty
  testowe wstrzykujesz przez `addInitScript`, który ustawia
  `sessionStorage["flux.bbox.draft"]`, bo Paste powstaje dopiero w Tasku 28:
- `new canvas has one obj with the default box`: dla `1:1` bbox to
  `[60,300,1000,700]`;
- `drag and resize update the bbox`: wstrzyknięty boks
  `[200,200,500,500]`. Przeciągnięcie środka o +10% szerokości ramki daje
  `x1` i `x2` większe o około 100 (±2), a uchwyt `se` zwiększa `y2` i `x2`;
- `bbox stays in range at extreme ratios`: przy `3:1` i `9:16` przeciągnięcie
  daleko poza ramkę daje wartości w 0–1000 oraz `y1<y2` i `x1<x2`;
- `overlap cycling on click, not on drag`: dwa boksy, mały wewnątrz dużego.
  Pierwszy klik wybiera mały, drugi duży. Przeciągnięcie zaznaczonego dużego
  przesuwa duży, a zaznaczenie zostaje;
- `keyboard nudge and delete`;
- `draft survives navigation`: zmiana, przejście na `/models` (z czekaniem
  na odmontowanie), powrót i stan jest ten sam;
- `custom ratio`: `21:9` plus Enter zmienia proporcję ramki, a `abc` daje
  błąd przy polu.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 bbox editor canvas and v15 document model`.

---

### Task 28: Panel boczny, lint, Paste JSON, eksport i handoff

**Files:**
- Create: `web/src/pages/bbox/SidePanel.tsx`, `web/src/pages/bbox/PasteBar.tsx`
- Modify:
  - `web/src/pages/bbox/BboxPage.tsx`;
  - `web/src/lib/bboxHandoff.ts` (teraz nawigacja routera do `/bbox`);
  - `web/src/pages/prompts/ResultPanel.tsx` i `LibraryPanel.tsx`, jeśli
    wymaga tego nowa sygnatura;
  - `web/e2e/bbox.spec.ts` i `web/e2e/prompts.spec.ts` (handoff idzie teraz
    do v2).

**Interfaces:**
- Consumes: `POST /api/ideogram/normalize` (Task 26), `POST /api/prompts/lint`,
  `POST /api/prompts/library`, `V15Findings`, `copyText`.
- Produces:
  - **SidePanel:**
    - karta główna: `aspect_ratio` (zmiana przy blur i Enter, więc focus nie
      ginie w trakcie pisania), `high_level_description` z licznikiem
      `N/50 words` (klasa przekroczenia powyżej 50) i
      `background (scene shell only)`;
    - karty elementów w kolejności tablicy, od spodu do wierzchu, jak w
      klasycznym UI, z nagłówkiem `obj #N` lub `text #N`;
    - na karcie: `▲` (bring forward), `▼` (send backward) i `×`;
    - odczyt `bbox [y1, x1, y2, x2]` albo `no bbox` oraz checkbox `bbox`;
    - dla text: pole `text (verbatim, \n = new line)`;
    - pole `desc` z licznikiem `N/60 words`;
    - klik w kartę zaznacza element, a zaznaczenie na canvasie przewija listę
      do karty;
    - pisanie w polach nie przemontowuje kart (focus zostaje).
  - **Lint:** `useQuery(["lint", debouncedJson])` z debounce 400 ms i
    `V15Findings`. Gdy lint się nie uda, pokazuje się wiersz błędu (wzorem
    ResultPanel), a nie stare wyniki.
  - **Akcje:**
    - `Copy (minified)` i `Pretty` kopiują przez `copyText` z toastem;
    - `Download` zapisuje `caption_v15.json` w wersji minified;
    - `Save to library` wysyła `{category:"ideogram", prompt: minified, input_text:"bbox editor", action:"manual"}`,
      pokazuje toast `Saved to the library (#id).` i inwaliduje
      `["prompt-library"]`;
    - `pre` z pretty JSON-em na żywo.
  - **PasteBar** (`📥 Paste JSON`):
    - textarea z placeholderem jak w klasycznym UI;
    - `Load` wysyła `POST /api/ideogram/normalize`, a sukces zastępuje
      dokument przez `fromCaption` i zamyka pasek. Jeśli bieżący dokument nie
      jest domyślny, najpierw pyta przez `ConfirmDialog`
      (`Replace the current canvas?`);
    - przy 400 błąd pokazuje się w pasku, a dokument się nie zmienia;
    - `Cancel`.
  - **Handoff:**
    - hook `useHandOffToBbox(): (json: string) => void` zapisuje
      `sessionStorage["flux.bbox.handoff"]` i robi `navigate("/bbox")`.
      Zastępuje on `handOffToBbox`, a wywołania w ResultPanel i LibraryPanel
      przechodzą na hook;
    - `BboxPage` zużywa klucz jednorazowo: odczyt i `removeItem` dzieją się
      synchronicznie w module, w funkcji wywołanej raz na wejście (np. w
      inicjalizatorze `useState`), a nie w cleanupie efektu, bo StrictMode
      podwójnie montuje komponenty;
    - JSON przechodzi przez `/api/ideogram/normalize`;
    - jeśli bieżący szkic nie jest domyślny, najpierw pyta przez
      `ConfirmDialog` (`Replace the current canvas with the prompt from the studio?`),
      tak jak Paste i From image;
    - po wczytaniu toast `Prompt loaded for editing.`. Przy błędzie toast z
      błędem i bez zmiany dokumentu;
    - odczyt klucza w klasycznym `frontend/app.js` zostaje, bo nie szkodzi.

- [ ] **Step 1: Testy, które padają:**
- `cards edit desc and counters`: wpisanie 61 słów w desc daje licznik
  `61/60 words` z klasą przekroczenia. Lint pokazuje ostrzeżenie zawierające
  `(obj #1)` i `60`, czyli tekst z `backend/v15_lint.py`, a nie
  odtworzony;
- `z-order buttons reorder the array`;
- `bbox checkbox omits the key`;
- `paste double-encoded loads`: wklejenie `JSON.stringify(JSON.stringify(v15))`
  ładuje poprawny dokument (prawdziwy normalize);
- `paste garbage keeps the canvas`: `hello` daje błąd w pasku, a dokument się
  nie zmienia;
- `save to library and it appears in the prompt studio library`: wiersz ze
  znacznikiem w `input_text` albo `desc`;
- `handoff from prompt studio`: wynik ideogram (podmieniony job), klik
  `Edit on canvas` daje URL `/bbox`, dokument jest załadowany, a klucz
  usunięty. Przeładowanie nie ładuje go ponownie;
- `download is minified caption_v15.json`.

Popraw istniejący test w `prompts.spec.ts`, który oczekiwał `/legacy/#bbox`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 bbox side panel, live lint, paste/export and prompt handoff`.

---

### Task 29: From image

**Files:**
- Create: `web/src/pages/bbox/FromImage.tsx`, `web/src/pages/bbox/analyzeStore.ts`
- Modify: `web/src/pages/bbox/BboxPage.tsx`, `web/e2e/bbox.spec.ts`

**Interfaces:**
- Consumes:
  - `POST /api/ideogram/analyze/jobs` (multipart) i
    `GET /api/ideogram/analyze/jobs/{id}`;
  - `VlmSelect`, `NumberInput` i `useJobPoll`.
- Produces:
  - **Kontrolki:**
    - przycisk `📷 From image` (picker `accept="image/*,.heic,.heif"`);
    - drop obrazu na host canvasu, gdzie pliki z pustym MIME, ale
      rozszerzeniem obrazu, też są przyjmowane;
    - select `Engine` z opcjami `Florence-2 — fast, measured bboxes`,
      `Hybrid — Florence bboxes + VLM prose` i
      `VLM only — full draft, estimated bboxes`;
    - `VlmSelect`, `Quantization` i `Max length (tokens)` (domyślnie 1536)
      widoczne tylko dla `hybrid` i `vlm`;
    - wybór silnika i modelu jest autozapisywany w formularzu `bbox`
      (`useSavedForm("bbox", …)`).
  - **`analyzeStore`** (`sessionStorage` `flux.bbox.analyze`):
    - `{jobId, result, applied}`;
    - na stanie terminalnym wynik (albo błąd) kopiuje się do store'u, a
      `jobId` się czyści;
    - wynik ładuje się do dokumentu tylko raz, przez compare-and-set na
      `applied` (lekcja z auto-cropu w Fazie 5), więc powrót na `/bbox` nie
      nadpisze późniejszych edycji;
    - jeśli bieżący dokument nie jest domyślny, najpierw pyta przez
      `ConfirmDialog` (`Replace the current canvas with the image draft?`);
    - przy odmowie `applied=true` i wynik zostaje dostępny jako `Load draft`;
    - toast `Draft ready: N elements (model).`.
  - **Postęp:** `JobProgress` bez sum, z tekstem `current` przy
    `loading_model` i `Analyzing…` przy `analyzing`.
  - **Podgląd zdjęcia:** miniatura źródłowego zdjęcia przy postępie
    (`URL.createObjectURL`, zwalniany przy sprzątaniu).

- [ ] **Step 1: Testy, które padają** (route-mock jobów):
- `florence draft loads into an untouched canvas`;
- `replacing an edited canvas asks first`;
- `vlm fields only for hybrid and vlm`: wysłane pola multipart zawierają
  `engine`, `model`, `quant` i `max_tokens`. Najpierw sprawdź, czy
  Playwright 1.63 w Chromium zwraca `request.postData()` dla `FormData` z
  `File`. Jeśli nie, podsłuchaj `FormData.prototype.append` przez
  `addInitScript`;
- `analysis survives navigation`;
- `analysis error shows first line`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 bbox From image (Florence, Hybrid, VLM) as a background job`.

---

### Task 30: Render Ideogram 4

**Files:**
- Create: `web/src/pages/bbox/RenderPanel.tsx`, `web/src/pages/bbox/renderStore.ts`
- Modify: `web/src/pages/bbox/BboxPage.tsx`, `web/e2e/bbox.spec.ts`

**Interfaces:**
- Consumes:
  - `GET /api/ideogram/render/config` i `POST /api/ideogram/render {prompt, params}`;
  - `GET /api/comfy/job/{id}`, `GET /api/comfy/job/{id}/preview?t=` i
    `POST /api/comfy/job/{id}/cancel`;
  - `GET /api/comfy/loras` (odświeżany przy wejściu na stronę i przyciskiem
    `↻`). Błąd daje cichą podpowiedź przy polu
    (`ComfyUI not reachable — type the LoRA name.`), a nie toast.
- Produces:
  - **Formularz** z kontrolkami i wartościami domyślnymi z inwentaryzacji
    §1.5:
    - `Quality preset` z opcjami `Quality (48 steps)`, `Default (20)` i
      `Turbo (12)`;
    - `Megapixels` 0.1–4 przez `NumberInput`, z błędem przy polu zamiast
      cichego resetu na serwerze;
    - `Seed` z checkboxem `random`;
    - `Scheduler` z opcjami `Simple (AuraFlow + euler)` i
      `Ideogram 4 (original)`;
    - `Batch` 1–16;
    - `LoRA (model-only)` z polem nazwy i datalistą. Pole jest nieaktywne,
      gdy checkbox jest wyłączony;
    - `LoRA strength` od -10 do 10;
    - zwijane `Models (advanced)` z czterema polami.
  - **Wartości początkowe** formularz bierze z `render/config`. Wysyłane
    `params` to `{...config.params, ...12 kluczy z formularza}`, więc ukryte
    ustawienia (cfg, shift…) jadą z zapisanymi wartościami i serwer ich nie
    resetuje. Odchodzi klasyczny quirk z §1.5.
  - **Uruchomienie:**
    - `Render canvas` jest nieaktywny, gdy lint zgłasza błąd (`level: err`).
      Etykieta wyjaśnia powód, a `Render anyway` pozwala renderować mimo to;
    - `random` losuje seed w przeglądarce (≤ `Number.MAX_SAFE_INTEGER`).
  - **`renderStore`** (`sessionStorage` `flux.bbox.render`):
    - `{jobId, results: Image[]}`, gdzie `results` jest deduplikowane po
      `image.id`;
    - na stanie terminalnym obrazy kopiują się do `results`, a `jobId` się
      czyści;
    - polling `useJobPoll` co 700 ms, z terminalami `done`, `error` i
      `cancelled`.
  - **Podgląd:** pasek postępu (`progress.value/max`), tekst `current` i
    podgląd na żywo, przy czym `img` zmienia `src` tylko przy nowym
    `preview_ts`.
  - **Cancel** wysyła `POST cancel` i przyjmuje stan `cancelled`.
  - **Wyniki:** siatka z kaskadowym wejściem, newest first, dla każdego obrazu
    miniatura i link do pełnego PNG (`/api/comfy/gallery/{id}`) z seedem.
    Przycisk `Clear results` czyści tylko listę w UI.

- [ ] **Step 1: Testy, które padają** (route-mock `/api/ideogram/render` i
  `/api/comfy/*`):
- `render sends prompt and params`: podmieniony `render/config` ma `cfg: 4.5`.
  Body ma `prompt` równy minified JSON-owi dokumentu, 12 kluczy formularza i
  `cfg: 4.5`, a seed jest nowy przy `random`;
- `render blocked on lint error until render anyway`;
- `progress, live preview and results`;
- `render survives navigation without duplicate results`: dwa odpytania z
  `done` i tymi samymi obrazami dają jedną miniaturę na obraz po powrocie;
- `cancel posts and shows cancelled`;
- `lora field disabled when unchecked`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 Ideogram 4 render with live preview and results`.

---

### Task 31: Dokumentacja i stan

- [ ] **Step 1:** README:
  - Bbox editor jest w v2: canvas, 8 uchwytów, skróty, cykl klikiem;
  - nowe endpointy `/api/ideogram/normalize` i `/api/ideogram/analyze/jobs*`;
  - Cancel przerywa ComfyUI;
  - szkic edytora leży w `sessionStorage`.
- [ ] **Step 2:** Sekcja stanu w `docs/superpowers/plans/2026-11-21-studio-v2.md`:
  Faza 7 zrobiona, otwarte sprawy.
- [ ] **Step 3:** Commit `docs: Bbox editor in v2`.
