# Studio v2 — widok ComfyUI (Faza 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widok ComfyUI w nowym UI (`/comfy`) z parytetem klasycznego widoku:
- połączenie z testem;
- workflow do testu LoRA z mapowaniem i biblioteką mapowań;
- test LoRA z biblioteką promptów;
- batch referencji;
- edytor workflow z listą węzłów, grafem i biblioteką;
- galeria z podglądem.

Po tej fazie klasyczne UI nie jest już potrzebne do żadnej funkcji, a jego
usunięcie to Faza 9.

**Architecture:**
- **Podział na zakładki.** Strona `/comfy` ma zakładki `LoRA test`,
  `Reference batch`, `Workflow editor` i `Gallery`, a na górze kartę
  połączenia.
- **Stan.** Żadnych modułowych zmiennych w stylu klasycznego UI. Stan
  trzymają store'y w `sessionStorage` (wzór `renderStore`) i TanStack Query.
  Wejście na stronę niczego nie nadpisuje, co rozwiązuje klasyczny problem
  z §6.1 inwentaryzacji.
- **Graf** to własny komponent SVG (warstwowy layout jak w klasycznym UI),
  bez nowej zależności.
- **Backend dostaje drobne poprawki:**
  - angielskie komunikaty;
  - galeria posortowana po `ts`;
  - etykieta źródła (`source`) przy obrazach;
  - atomowy zapis `comfy_config.json`;
  - unieważnianie cache `object_info`.

**Tech Stack:** jak w poprzednich fazach.

**Spec:** `docs/superpowers/specs/2026-11-21-studio-v2-design.md` (§5 oraz
lista parytetu, pozycja „ComfyUI”).
**Inwentaryzacja (obowiązkowa):**
`docs/superpowers/notes/2026-11-23-comfy-inventory.md`. Zawiera kontrolki,
endpointy, przepływy, graf w §4 i 23 kruche miejsca w §6. Współdzielone
endpointy jobów opisuje `docs/superpowers/notes/2026-11-22-bbox-inventory.md`.

## Global Constraints

- Obowiązują Global Constraints z planów
  `docs/superpowers/plans/2026-11-22-studio-v2-ui.md`,
  `...-dataset.md`, `...-prompts.md` i `...-bbox.md`:
  - gałąź `v2`, commit po zadaniu, bez pushowania;
  - UI po angielsku, motyw ciemny, tokeny (żadnych nowych kolorów hex poza
    `@theme`);
  - `MotionConfig reducedMotion="user"`;
  - e2e na porcie 8131 z `FLUX_PREP_WORK`; importy z `./fixtures.ts` i
    `./env.ts`; testy nawigacji czekają na odmontowanie widoku;
  - `URLSearchParams`;
  - błędy jobów: pierwsza linia w UI, pełny tekst w `title` albo w zwijanym
    `pre`;
  - polling przez `useJobPoll` z `terminal: ["done","error","cancelled"]`;
  - start jobów przez `useMutationWithToast` z `mutationKey`, a stan zajętości
    z `useIsMutating`;
  - kopiowanie przez `lib/clipboard.ts`;
  - `ConfirmDialog` zamiast `confirm()`.
- Przed commitem przechodzą:
  - `.venv/bin/python -m pytest -o addopts="" -q`;
  - `cd web && pnpm typecheck && pnpm build && pnpm exec playwright test`.
- Etykiety, opcje i wartości domyślne są jak w klasycznym widoku
  (inwentaryzacja §1). Polskie teksty z §6.17 zastępujemy angielskimi.
- **Testy e2e nigdy nie łączą się z ComfyUI.** Serwer e2e domyślnie
  wskazuje `127.0.0.1:8188`, gdzie może działać prawdziwy ComfyUI
  użytkownika:
  - `web/e2e/fixtures.ts` domyślnie podmienia albo przerywa (`route.abort()`)
    endpointy `/api/comfy/test`, `/api/comfy/loras`,
    `/api/comfy/object_info`, `/api/comfy/generate`,
    `/api/comfy/editor/generate`, `/api/comfy/job/**` i
    `/api/ideogram/render`. Testy nadpisują je własnymi routami;
  - testy, które wpisują URL, używają martwego portu (np.
    `http://127.0.0.1:9`);
  - testy wymagające stanu „brak workflow” podmieniają `/api/comfy/config`.

  Endpointy plikowe i bazodanowe (`workflow`, `mapping`, `mappings`,
  `prompts`, `workflows*`, `gallery`, `editor/load`) działają na prawdziwym
  serwerze, a testy używają unikalnych nazw.
- **Polling:** joby o jednym `jobId` (LoRA test, edytor) używają `useJobPoll`.
  Batch używa niereactowego rdzenia pollingu z Taska 34 (`pollJob`), który
  ma te same reguły: chwilowe błędy przeczekuje, kończy się na stanie
  terminalnym albo 404.
- Klasyczne UI (`/legacy/#comfy`) działa dalej. Zmiany kontraktów API są
  wyłącznie addytywne: nowe pola w odpowiedzi i angielskie teksty błędów.

## Review Focus

1. **Wejście na `/comfy` nie kasuje pracy.** Wybrane LoRA, prompt, nieznaleziony
   jeszcze URL i niezapisane edycje węzłów zostają po przejściu na inny widok
   i powrocie. Testy: Task 35 `lora rows survive navigation` i Task 37
   `editor edits survive navigation`.
2. **Test connection testuje URL widoczny w polu**, czyli najpierw go zapisuje.
   Wynik pokazuje wersję ComfyUI. Test: Task 33 `test connection saves then tests`.
3. **Job (LoRA test, batch, edytor) przeżywa nawigację**, Cancel kończy go
   jako `cancelled`, a błąd ComfyUI pokazuje się pierwszą linią z pełnym
   tekstem do rozwinięcia. Testy: Task 35 `lora job survives navigation and
   reload`, Task 36 `batch survives navigation` i Task 38 `send to comfy runs
   a job and shows images`.
4. **Galeria jest posortowana od najnowszych**, pokazuje źródło (LoRA test,
   Editor, Ideogram) i pozwala usuwać z potwierdzeniem. Testy: Task 32
   `test_gallery_sorted_by_ts_desc` i Task 34 `gallery dialog copy, arrows,
   delete asks`.
5. **Edycja pola liczbowego w edytorze nie psuje typu:** pusty INT/FLOAT daje
   błąd przy polu, a nie `null` w workflow, a FLOAT przyjmuje 0.5 także
   wtedy, gdy bieżąca wartość to 1. Test: Task 37 `number fields keep their type`.

---

### Task 32: Backend — teksty, galeria, atomowy config, cache schematów, nazwy

**Files:**
- Modify: `backend/server.py`, `backend/comfy_client.py`, `tests/conftest.py`
  (fixture `comfy_store`)
- Test: `tests/test_comfy_backend.py` (nowy)

**Interfaces:**
- Produces:
  - **Fixture `comfy_store`** (`tests/conftest.py`, nie autouse) podmienia
    wszystkie magazyny ComfyUI na `tmp_path`: `COMFY_CONFIG_PATH`, ścieżki
    `comfy_mappings.json` i `comfy_prompts.json`, `COMFY_GALLERY_DIR`,
    `DB_PATH` (z `_init_db()`) i `_OBJECT_INFO_CACHE` (czyszczony). Każdy test
    w `test_comfy_backend.py` go używa.
  - **Angielskie komunikaty zamiast polskich** (inwentaryzacja §6.17,
    backend):
    - `Najpierw wgraj workflow.` daje `Upload a workflow first.`;
    - `Najpierw wgraj workflow w sekcji Konfiguracja.` daje
      `Upload a workflow first (LoRA test → Workflow).`;
    - `Nieznany workflow.` daje `Unknown workflow.`;
    - w `comfy_client` tekst `HTTP <code> z <url>` daje `HTTP <code> from <url>`.

    Żaden test ani plik w `frontend/` nie porównuje tych tekstów
    (sprawdzone grepem).
  - **`GET /api/comfy/gallery`** sortuje po `ts` malejąco (brak `ts` na
    końcu, a remisy po `id`), a każdy element ma pole `source`:
    `"lora_test"`, `"editor"` albo `"ideogram"`.
    - Runner testu LoRA zapisuje odtąd `source: "lora_test"`.
    - `_run_comfy_raw_job(job_id, workflow, source="editor")` dostaje
      parametr, a render Ideogramu w `api_ideogram_render` przekazuje
      `source="ideogram"`.
    - Stare wpisy bez `source` dostają przy odczycie `"lora_test"`, a stare
      z `"editor"` zostają.
    - Do metadanych dochodzą `width` i `height` z PIL zapisanego obrazu,
      a przy odczycie są dopuszczalne, jeśli ich brakuje.
  - **`_update_comfy_config(fn)`:**
    - atomowy zapis (plik tymczasowy, fsync i `os.replace`) pod modułowym
      `threading.Lock`;
    - wszystkie miejsca load-modify-save (`/url`, `/workflow`, `/mapping`,
      `/editor/load`, `/editor/generate`) przechodzą przez ten helper.
  - **Cache `object_info`:**
    - `POST /api/comfy/url` czyści `_OBJECT_INFO_CACHE`;
    - `GET /api/comfy/object_info?refresh=1` omija cache.
  - **Nazwy w bibliotekach:**
    - POST na `/api/comfy/mappings`, `/prompts` i `/workflows` odrzuca nazwę
      z `/` albo pustą po `strip()` i zwraca 400 `Name must not contain "/".`
      albo `Enter a name.`;
    - trasy `DELETE /api/comfy/mappings/{name}`, `DELETE /api/comfy/prompts/{name}`,
      `GET/DELETE /api/comfy/workflows/{name}` używają `{name:path}`, więc
      wpisy ze `/`, utworzone wcześniej w klasycznym UI, da się wczytać i
      usunąć.

- [ ] **Step 1: Testy, które padają** (`tests/test_comfy_backend.py`, wszystkie
  z `comfy_store`; `comfy_client` podmieniony):
- `test_polish_messages_translated`: `/api/comfy/mapping` bez workflow daje
  400 `Upload a workflow first.`, a `GET /api/comfy/workflows/nope` daje 404
  `Unknown workflow.`;
- `test_gallery_sorted_by_ts_desc`: trzy sidecary z `ts` 1, 3, 2 dają
  kolejność 3, 2, 1;
- `test_gallery_source_defaults`: wpis bez `source` daje `"lora_test"`;
- `test_raw_runner_source_param`: runner z `source="ideogram"` zapisuje meta
  z `source: "ideogram"`, `width` i `height`;
- `test_ideogram_render_labels_source`;
- `test_comfy_config_concurrent_updates_keep_all`: najpierw zapisany
  workflow (`/api/comfy/workflow` z małym plikiem API). Potem 20 wątków
  naprzemiennie robi `/url` i `/mapping`. Każda odpowiedź ma 200, a końcowy
  config zawiera workflow, ostatni URL i mapowanie;
- `test_url_change_clears_object_info_cache`;
- `test_object_info_refresh_bypasses_cache`;
- `test_library_names_reject_slash`;
- `test_legacy_slash_names_still_deletable`: wpis `a/b` wstawiony wprost do
  pliku mapowań i do tabeli `workflows` da się wczytać (`GET` workflow) i
  usunąć (`DELETE`).

- [ ] **Step 2:** Uruchom testy i sprawdź, że padają.
- [ ] **Step 3:** Zaimplementuj.
- [ ] **Step 4:** Pełny pytest musi być zielony.
- [ ] **Step 5:** Commit `feat: comfy backend — English messages, sorted gallery with source, atomic config`.

---

### Task 33: Strona ComfyUI — połączenie, workflow i mapowanie

**Files:**
- Create:
  - `web/src/pages/comfy/ComfyPage.tsx`:
    - zakładki `LoRA test`, `Reference batch`, `Workflow editor` i
      `Gallery` ze wskaźnikiem `layoutId`;
    - aktywna zakładka w query `?tab=`;
    - nad zakładkami `ConnectionCard`;
  - `web/src/pages/comfy/ConnectionCard.tsx`;
  - `web/src/pages/comfy/WorkflowCard.tsx`, osadzony na górze zakładki
    `LoRA test`, bo workflow i mapowanie służą tylko testowi LoRA i batchowi;
  - `web/src/pages/comfy/NamedLibrary.tsx`, wspólny dla mapowań, promptów i
    workflow;
  - `web/src/pages/comfy/WorkflowDrop.tsx`;
  - `web/src/pages/comfy/queries.ts`;
  - `web/src/pages/comfy/formStore.ts`. To jedyny właściciel
    `sessionStorage` `flux.comfy.form` (`{url?, lora: {...}, batch: {...}}`).
    Tasks 35–36 dopisują tu swoje pola;
  - `web/e2e/comfy.spec.ts`.
- Modify:
  - `web/src/app/routes.tsx`: `/comfy` prowadzi do `ComfyPage`;
  - usuń `web/src/pages/ClassicPlaceholder.tsx` i test „classic views link
    to legacy” w `shell.spec.ts`, bo żaden widok już go nie używa. Link
    `Classic UI` w sidebarze zostaje;
  - `web/e2e/fixtures.ts`: domyślne podmiany i przerwania z Global
    Constraints.

**Interfaces:**
- Consumes:
  - `GET /api/comfy/config` (query `["comfy-config"]`, współdzielone z
    Settings);
  - `POST /api/comfy/url` i `POST /api/comfy/test`;
  - `POST /api/comfy/workflow` (multipart);
  - `POST /api/comfy/mapping`;
  - `GET/POST/DELETE /api/comfy/mappings`.
- Produces:
  - **ConnectionCard:**
    - pole `ComfyUI address (server URL)` z placeholderem
      `http://127.0.0.1:8188`;
    - `Save` oraz `Test connection`. Ten drugi przy zmienionym polu najpierw
      zapisuje, potem testuje, i pokazuje
      `Connected to <url> (<comfyui_version|os|ok>).` albo błąd;
    - niezapisany tekst pola trzyma `formStore`.
  - **WorkflowCard:**
    - `WorkflowDrop` (przeciągnij albo wybierz `.json` lub `.png`, a
      `input.value` się resetuje) z tekstem
      `Loaded workflow from PNG metadata|from JSON file: N nodes, M LoRA slot(s).`;
    - stan bez workflow: `No workflow uploaded yet.`;
    - **mapowanie:**
      - edytor JSON (textarea mono);
      - plakietki „mapped/unmapped” dla positive, negative, seed, width,
        height, steps i cfg oraz liczba slotów LoRA;
      - `Save mapping (active)`: niepoprawny JSON daje błąd przy polu i nic
        nie wysyła;
      - `NamedLibrary` dla mapowań: `Load` (wczytuje i aktywuje), `Delete`
        (z potwierdzeniem) i `Save as`.
    - Prompt z workflow (`current_prompt`) trafia do pola promptu testu LoRA
      (`formStore`) tylko wtedy, gdy jest puste.
  - **`NamedLibrary`:**
    - props `{title, items: Record<string, T>, onLoad, onSave(name), onDelete(name), describe?}`;
    - select `— saved … —` zachowuje wybór po odświeżeniu.

- [ ] **Step 1: Testy, które padają** (`comfy.spec.ts`):
- `test connection saves then tests`: wpisanie
  `http://127.0.0.1:9` i klik `Test connection` (podmienione
  `/api/comfy/test`) wysyła najpierw POST `/url` z tym URL-em, a potem
  pokazuje tekst z wersją;
- `url edit survives navigation`;
- `workflow upload shows mapping and badges`: prawdziwy upload pliku
  fixture `e2e/fixtures/comfy_api.json` (prosty workflow API z KSamplerem,
  CLIPTextEncode, EmptyLatentImage i dwoma LoraLoaderami) pokazuje
  mapowanie, plakietkę `positive: mapped` i `2 LoRA slots`;
- `invalid mapping json is rejected locally`;
- `mapping library save, load activates, delete asks`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI page — connection, workflow upload and mapping`.

---

### Task 34: Infrastruktura jobów i galeria

**Files:**
- Create:
  - `web/src/pages/comfy/format.ts`: `fmtEta` i `fmtProgress`, port 1:1 z
    APP:1168-1183;
  - `web/src/pages/comfy/comfyJobStore.ts`;
  - `web/src/pages/comfy/pollJob.ts`;
  - `web/src/pages/comfy/ComfyJobBox.tsx`;
  - `web/src/pages/comfy/JobObservers.tsx`;
  - `web/src/pages/comfy/GalleryTab.tsx`;
  - `web/src/pages/comfy/GalleryDialog.tsx`;
  - `web/e2e/comfy-units.spec.ts`.
- Modify: `web/src/pages/comfy/ComfyPage.tsx`, `web/e2e/comfy.spec.ts`

**Interfaces:**
- Produces:
  - **`comfyJobStore`** (`sessionStorage` `flux.comfy.jobs`):
    - `{lora: JobSlot, editor: JobSlot, batch: BatchState}`, gdzie
      `JobSlot = {jobId, last?: {state, images: SlimImage[], error}}`, a
      `SlimImage = {id, url, seed, width?, height?}` (bez `prompt`, żeby nie
      przepełnić `sessionStorage`);
    - zapis łapie `QuotaExceededError` i pokazuje toast
      `Could not keep the job state in this tab.`;
    - `startJob(slot, jobId)` i `finishJob(slot, jobId, job)`: drugi to
      compare-and-set po `jobId`, który kopiuje wynik do `last` i czyści
      `jobId`.
  - **`pollJob(jobId, {signal, intervalMs=700, onUpdate}) => Promise<Job | "gone">`**
    jest niereactowym rdzeniem pollingu z tymi samymi regułami co
    `useJobPoll`: chwilowe błędy przeczekuje, kończy się na `done`, `error`,
    `cancelled` albo na 404 (wtedy zwraca `"gone"`). Używa go batch w
    Tasku 36.
  - **`JobObservers`** jest montowany w `ComfyPage` niezależnie od
    zakładki:
    - dla każdego slotu z `jobId` uruchamia `useJobPoll` (te same klucze
      query co `ComfyJobBox`);
    - na stanie terminalnym woła `finishJob` i inwaliduje
      `["comfy-gallery"]`;
    - dzięki temu zmiana zakładki nie przerywa obserwacji.
  - **`ComfyJobBox({slot})`:**
    - czyta ten sam query co obserwator;
    - pokazuje status `current` plus `fmtProgress`, pasek, podgląd przy
      `preview_ts` i `Cancel`;
    - po zakończeniu: `Done: N image(s).` z miniaturami i linkiem
      `Open in gallery` (`?tab=gallery&image=<id>`), `Cancelled.` albo błąd
      (pierwsza linia plus rozwijany `pre`);
    - przy `done` z niepustym `error` pokazuje ostrzeżenie.
  - **Galeria:**
    - `useQuery(["comfy-gallery"])`;
    - siatka z kaskadowym wejściem, od najnowszych;
    - obrazy z `loading="lazy"`;
    - stronicowanie po stronie klienta po 48 z `Show more`;
    - na karcie: miniatura, prompt skrócony do 70 znaków, `seed`, plakietka
      źródła (`LoRA test`, `Editor`, `Ideogram`) i `✕` z `ConfirmDialog`;
    - `Refresh`.
  - **`GalleryDialog`** (shadcn dialog, Esc i tło zamykają):
    - obraz;
    - `seed`, źródło, plik i `W×H`;
    - prompt z `Copy`;
    - plakietki LoRA, z pominięciem pustych nazw;
    - `Download image`;
    - `Delete` z potwierdzeniem;
    - strzałki ←/→;
    - query `image=<id>` otwiera dialog.
  - **Testy jednostkowe** (`comfy-units.spec.ts`): najpierw sprawdź, czy spec
    Playwrighta może bezpośrednio importować `../src/pages/comfy/format.ts`
    (Playwright transpiluje TS). Jeśli tak, testuj tam funkcje czyste. Jeśli
    nie, dodaj vitest z minimalną konfiguracją i skryptem `pnpm test:unit`,
    dopisanym do bramki przed commitem.

- [ ] **Step 1: Testy, które padają:**
- `fmtProgress formats like classic` (jednostkowy): przypadki z §1.2
  inwentaryzacji (`·`, `it/s` i `~ETA left`);
- `gallery lists newest first with source badges`: sidecary zapisane przez
  spec do `E2E_WORK/comfy_gallery`, czyli PNG i JSON z różnymi `ts` i
  `source`;
- `gallery dialog copy, arrows, delete asks`;
- `open in gallery deep link opens the dialog`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI job infrastructure and gallery`.

---

### Task 35: Test LoRA

**Files:**
- Create: `web/src/pages/comfy/LoraTestTab.tsx`, `web/src/pages/comfy/LoraRows.tsx`
- Modify: `web/src/pages/comfy/formStore.ts` (pola `lora`), `web/e2e/comfy.spec.ts`

**Interfaces:**
- Consumes:
  - `GET /api/comfy/loras` (query `["comfy-loras"]`, ładowany automatycznie
    przy wejściu i przyciskiem `↻ refresh list from ComfyUI`);
  - `POST /api/comfy/generate`;
  - `GET/POST/DELETE /api/comfy/prompts`;
  - `comfyJobStore` (slot `lora`) i `ComfyJobBox`.
- Produces:
  - **LoraRows:**
    - wiersze z datalistą (`pick or type a name…`); domyślnie jest tyle
      wierszy, ile slotów;
    - `+ add LoRA` aż do liczby slotów, z komunikatem z inwentaryzacji
      §1.2 po angielsku;
    - przycisk `−` czyści wiersz (zostawia pusty slot), zamiast przesuwać
      kolejne;
    - wyszukiwarka `search LoRAs by name…` zawęża datalistę;
    - nazwa spoza listy pokazuje ostrzeżenie `not on the ComfyUI list`, ale
      jej nie blokuje;
    - przy 0 slotach widać info
      `This workflow has no LoRA loader — add one in ComfyUI.`.
  - **Formularz:**
    - `Width` 1024 (step 64), `Height` 1024, `Steps` 20,
      `CFG / Guidance` 3.5, `Seed (-1 = random)` -1, `Sample count` 2
      (1–8), wszystkie przez `NumberInput` z błędami przy polu;
    - prompt `Prompt (FLUX.2)` z `NamedLibrary` promptów (ConfirmDialog przy
      nadpisaniu niepustego promptu);
    - wszystko trzyma `formStore`.
  - **`Generate samples`:**
    - nieaktywny bez workflow (`has_workflow` false), z podpowiedzią;
    - wysyła `loras` jako tablicę **pozycyjną** o długości liczby wierszy,
      z pustymi stringami w miejscu pustych wierszy. Backend
      (`apply_overrides_multi_lora`) przypisuje wiersz i do slotu i i
      pomija puste;
    - `seed` przy -1 to `null`;
    - start przez `useMutationWithToast` z `mutationKey: ["comfy-lora-start"]`
      i `startJob("lora")` w `onSuccess`.

- [ ] **Step 1: Testy, które padają** (route-mock `generate`, `job/*` i `loras`):
- `generate sends the form`: body ma `prompt`, `width`, `height`, `steps`,
  `cfg`, `seed: null` i `batch: 2`;
- `lora slots are positional`: drugi wiersz wypełniony, a pierwszy pusty,
  daje `loras: ["", "b"]`;
- `lora rows match slots and cap`;
- `lora rows survive navigation`;
- `lora job survives navigation and reload`;
- `generate disabled without a workflow` (podmieniony `/api/comfy/config`);
- `job progress, preview, done with thumbnails`;
- `cancel ends cancelled`;
- `error shows first line and expandable details`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI LoRA test`.

---

### Task 36: Batch referencji

**Files:**
- Create: `web/src/pages/comfy/BatchTab.tsx`, `web/src/pages/comfy/batchRunner.ts`
- Modify: `web/src/pages/comfy/formStore.ts` (pola `batch`), `web/e2e/comfy.spec.ts`

**Interfaces:**
- Produces:
  - **Formularz:** `Width`, `Height`, `Steps` i `CFG` z domyślnymi wartościami
    klasycznymi, pole `Prompts (one per line)` z placeholderem jak w
    klasycznym UI i `Generate batch` (nieaktywny bez workflow).
  - **`batchRunner`:**
    - jawny wyjątek od reguły `useJobPoll` i `useIsMutating`: pętla działa
      na poziomie modułu, żeby przeżyła nawigację;
    - stan w `comfyJobStore.batch`:
      `{lines, index, jobId, results: {line, state, images, error}[], cancelled, running}`;
    - **single-flight:** moduł ma jedną aktywną pętlę. `ensureRunning()`
      wołane przy montowaniu i po przeładowaniu strony nic nie robi, gdy
      pętla już działa;
    - **compare-and-set na indeksie:** przed POST-em linii i zapis
      `{index:i, jobId:null, posting:true}`, a POST wysyła się tylko wtedy,
      gdy indeks w store'ze to wciąż i i nie ma `jobId`. Po przeładowaniu z
      `posting:true` i bez `jobId` linia nie jest wysyłana ponownie, tylko
      oznaczona `unknown (page reloaded while queueing)` i pominięta;
    - każda linia wysyła `POST /api/comfy/generate`
      `{prompt, width, height, steps, cfg, batch: 1}`, po czym działa
      `pollJob`;
    - `gone` (404) zatrzymuje batch z komunikatem;
    - błąd linii zatrzymuje batch, tak jak w klasycznym UI, i pokazuje
      `Stopped at line i: <first line>`;
    - Cancel anuluje bieżący job, czeka na `cancelled` i oznacza resztę jako
      pominięte;
    - po każdej linii inwaliduje `["comfy-gallery"]`.
  - **Lista wyników per linia** pokazuje stan i miniatury.

- [ ] **Step 1: Testy, które padają:**
- `batch runs lines sequentially`: trzy linie, każdy POST ma `batch: 1`, a
  wyniki per linia mają `done`;
- `batch survives navigation`: przy przejściu na `/models` i powrocie w
  trakcie drugiej linii każda linia dostaje dokładnie jeden POST;
- `batch cancel stops the rest`;
- `batch line error stops`;
- `batch job gone stops`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI reference batch`.

---

### Task 37: Edytor workflow — store, schematy i karty węzłów

**Files:**
- Create:
  - `web/src/pages/comfy/editor/EditorTab.tsx`;
  - `web/src/pages/comfy/editor/NodeCard.tsx`;
  - `web/src/pages/comfy/editor/FieldControl.tsx`;
  - `web/src/pages/comfy/editor/schema.ts`: `buildKnownEnums`,
    `getSchemaForName`, `isLinkValue`, `isDictValue` i parsowanie wartości;
    port z APP:1433-1473, 1525 i 1638-1730;
  - `web/src/pages/comfy/editor/editorStore.ts`.
- Modify: `web/e2e/comfy.spec.ts`, `web/e2e/comfy-units.spec.ts`

**Interfaces:**
- Consumes:
  - `GET /api/comfy/object_info` (`useQuery(["comfy-object-info"])`,
    `staleTime` 5 min; przycisk `↻ ComfyUI schemas` wysyła `?refresh=1`);
  - `POST /api/comfy/editor/load` i `GET /api/comfy/editor/workflow`.
- Produces:
  - **`editorStore`:**
    - `sessionStorage` `flux.comfy.editor`;
    - `{workflow, name, dirty, invalid: Record<"id.field", string>}`;
    - niemutowalne `setInput(id, field, value)`,
      `setSubInput(id, field, key, value)` i `setInvalid(key, msg|null)`;
    - błędy pól żyją w store'ze, a nie w stanie komponentu. Zwinięcie karty
      nie odblokowuje Generate;
    - przy pierwszym wejściu bez szkicu wczytuje `GET /editor/workflow`.
      Jeśli szkic istnieje, nie nadpisuje go;
    - przepełnienie `sessionStorage` daje widoczny toast.
  - **Widok:**
    - przełącznik `Node list` / `Graph + parameters`. Graf powstaje w
      Tasku 38; tu wystarczy placeholder zakładki;
    - filtr `filter nodes (name/type/ID)…`, który przyciemnia
      niepasujące;
    - `Expand all` i `Collapse all`;
    - `WorkflowDrop` (wczytanie przez `editor/load`).
  - **`NodeCard`:**
    - nagłówek `#id class_type`;
    - pola z literałami w `FieldControl`;
    - linki tylko do odczytu `→ #src (class) · output n`, a klik fokusuje
      kartę węzła;
    - słowniki (np. Power Lora Loader) jako podwiersze;
    - zagnieżdżone obiekty i tablice niebędące linkami jako JSON z błędem przy
      niepoprawnym JSON-ie.
  - **`FieldControl`:**
    - schemat z `object_info` (najpierw required, potem optional), a w
      drugiej kolejności `getSchemaForName`;
    - enum daje select. Wartość spoza listy jest dopisywana z sufiksem
      `(from workflow)`, a backslash zmieniany na slash;
    - `BOOLEAN` daje checkbox;
    - `INT` i `FLOAT` dają `NumberInput` z min, max i step ze schematu;
    - bez schematu FLOAT przyjmuje ułamek (`decimal`), jeśli bieżąca wartość
      jest float albo nazwa pasuje do `cfg`, `denoise`, `shift`,
      `strength*` lub `*_strength`;
    - puste albo niepoprawne pole daje `setInvalid` i nie trafia do workflow;
    - `STRING` daje textarea, gdy `multiline`, długość ponad 60 albo `
`.

- [ ] **Step 1: Testy, które padają:**
- jednostkowe `schema.ts`: `isLinkValue`, `getSchemaForName` (lora, ckpt,
  sampler) i parsowanie liczb;
- `load workflow shows node cards and links` (prawdziwe `editor/load`);
- `schema dropdowns from object_info`: pole `sampler_name` jest selectem,
  a wartość spoza listy pokazuje `(from workflow)`;
- `number fields keep their type`: `cfg` 1 zmienione na `0.5` daje `0.5` w
  store (odczyt z `sessionStorage`). Puste `steps` daje błąd, który zostaje
  także po zwinięciu karty;
- `editor edits survive navigation`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI workflow editor — schemas and node cards`.

---

### Task 38: Edytor workflow — graf, biblioteka i generowanie

**Files:**
- Create: `web/src/pages/comfy/editor/WorkflowGraph.tsx`, `web/src/pages/comfy/editor/layout.ts`
- Modify:
  - `web/src/pages/comfy/editor/EditorTab.tsx`;
  - `web/e2e/comfy.spec.ts` i `web/e2e/comfy-units.spec.ts`.

**Interfaces:**
- Consumes:
  - `POST /api/comfy/editor/generate`;
  - `/api/comfy/workflows*` (lista, wczytanie, zapis, import i usunięcie);
  - `comfyJobStore` (slot `editor`) i `ComfyJobBox`.
- Produces:
  - **`layoutGraph(workflow) => {nodes: {id, x, y}[], links: {from, to}[], width, height}`**:
    - port z APP:1785 ze stałymi z inwentaryzacji §4;
    - najdłuższa ścieżka z memoizacją i ochroną przed cyklami, bez
      kopiowania zbioru na każde wywołanie (wykładniczego).
  - **`WorkflowGraph`:**
    - SVG z krzywymi Béziera;
    - `<title>` z pełnym `class_type`;
    - węzły fokusowalne (`role="button"`, Enter);
    - klik fokusuje kartę;
    - aktywny węzeł z `current_node` joba `editor` ma klasę `active`;
    - `useMemo` na sygnaturze linków;
    - kolory z tokenów.
  - **Akcje:**
    - `▶ Send to ComfyUI (generate)`:
      - nieaktywny, gdy w store'ze jest `invalid` albo brak workflow;
      - start z `mutationKey: ["comfy-editor-start"]`;
    - `Save .json` (`<name or workflow_api>.json`, pretty);
    - `↺ Reload from disk` z `ConfirmDialog`, gdy `dirty`;
    - `↻ ComfyUI schemas`;
    - biblioteka:
      - `Save to library` (nazwa wymagana);
      - `Import from JSON` (multipart `workflows/import`, a potem wczytanie
        do edytora);
      - select `name (N nodes)`;
      - `Load` z `ConfirmDialog`, gdy `dirty`;
      - `Delete` z `ConfirmDialog`.

- [ ] **Step 1: Testy, które padają:**
- jednostkowe `layoutGraph`:
  - łańcuch 1→2→3 daje warstwy 0, 1 i 2;
  - romb 1→2, 1→3, 2→4, 3→4 daje węzeł 4 w warstwie 2;
  - cykl 1→2→1 kończy się bez zawieszenia;
- `graph renders nodes and highlights executing node`: podmieniony job z
  `current_node: "3"` daje `[data-node-id="3"]` z klasą `active`;
- `library save, load asks when dirty, delete asks` (prawdziwe workflows);
- `send to comfy runs a job and shows images`: przechwycone body to
  workflow ze store'u;
- `generate blocked while a field is invalid`;
- `save json downloads the edited workflow`.

- [ ] **Step 2:** Implementacja.
- [ ] **Step 3:** Weryfikacja: pełny zestaw testów musi być zielony.
- [ ] **Step 4:** Commit `feat: v2 ComfyUI workflow graph, library and generate`.

---

### Task 39: Dokumentacja i stan

- [ ] **Step 1:** README:
  - ComfyUI jest w v2 (zakładki, LoRA test, batch, edytor z grafem i
    galeria);
  - nowe pola galerii (`source`, `width`, `height`) i sortowanie po czasie;
  - `object_info?refresh=1`;
  - angielskie komunikaty;
  - wszystkie widoki są już w v2, a `/legacy/` zostaje do Fazy 9.
- [ ] **Step 2:** Sekcja stanu w `docs/superpowers/plans/2026-11-21-studio-v2.md`:
  Faza 8 zrobiona, otwarte sprawy i to, co musi zrobić Faza 9.
- [ ] **Step 3:** Commit `docs: ComfyUI view in v2`.
