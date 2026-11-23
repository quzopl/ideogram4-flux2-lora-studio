# Studio v2 — sprzątanie i wydanie 2.0 (Faza 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zostaje tylko nowe UI:
- klasyczne UI znika;
- każdy start zadania na lokalnym modelu przechodzi przez jeden strażnik „GPU zajęte”;
- `server.py` jest podzielony na routery;
- wersja to 2.0.0;
- README i zrzuty ekranu opisują v2.

**Architecture:**
- **Kolejność zadań:**
  1. ostatnia luka parytetu;
  2. usunięcie legacy;
  3. strażnik GPU;
  4. podział na routery w dwóch krokach;
  5. wydanie.
- **Wspólny stan backendu** (ścieżki, `JOBS`, strażnik, helpery modeli) trafia do `backend/core.py`. Inne moduły czytają go jako atrybut modułu (`core.X`), więc `monkeypatch.setattr(core, ...)` działa wszędzie.
- `server.py` nie re-eksportuje przeniesionych nazw. Dzięki temu stary patch `server.X` wywala się głośno, zamiast patchować nie ten moduł i pisać do prawdziwego `.work/`.

**Tech Stack:** jak w poprzednich fazach (FastAPI, pytest, React 19 + Vite, Playwright).

**Spec:** `docs/superpowers/specs/2026-11-21-studio-v2-design.md`. Mapa drogowa „Faza 9” i sekcje „Stan po Fazie N” są w `docs/superpowers/plans/2026-11-21-studio-v2.md`.

## Global Constraints

- **Obowiązują Global Constraints poprzednich planów faz 3–8:**
  - gałąź `v2`, commit po zadaniu, bez pushowania;
  - UI po angielsku;
  - tokeny kolorów;
  - e2e na porcie 8131 z `FLUX_PREP_WORK`, z importem z `./fixtures.ts`;
  - `useMutationWithToast` z `mutationKey`;
  - `ConfirmDialog` zamiast `confirm()`.
- **Weryfikacja po każdym zadaniu:**
  - `.venv/bin/python -m pytest -q` jest zielone;
  - `cd web && pnpm typecheck && pnpm build`;
  - po zadaniach 1, 2, 3 i 5 dodatkowo `pnpm exec playwright test`.
- **Zostają migracje z v1:**
  - odczyt `.work/gpu.json` w `settings.py`;
  - import planów kropu z `localStorage` w widoku Dataset;
  - `/health`.
- **Komunikat strażnika (bez zmian):** `Processing in progress — wait for it to finish.` z kodem 409.
- **Podział na routery (zadania 4–5) to przeniesienie bez zmiany zachowania:**
  - ten sam zbiór tras (metoda, ścieżka, nazwa funkcji);
  - ten sam `app.openapi()` po `json.dumps(..., sort_keys=True)`;
  - catch-all SPA na końcu.
- **Testy nie piszą do prawdziwego `.work/`.** Przed `pytest` robimy `touch` markera, a po nim `find .work -newer <marker>` jest pusty. Jeśli działa instancja użytkownika, raport wymienia, co się zmieniło.

## Review Focus

1. **Stara zakładka albo skrót do `/legacy/` (także `/legacy/#upscale`).** Ląduje w aplikacji (307 → `/`), bez pustej strony i bez 404. Test jest w zadaniu 2.
2. **Świeży klon bez `pnpm` i bez `web/dist`.** Serwer startuje, API działa, a `/` zwraca 503 z poleceniem budowania. Test jest w zadaniu 2.
3. **Zadanie, którego wątek padł albo się nie wystartował.** Nie zostawia strażnika zajętego na zawsze. `Thread.start()` rzuca → 500 i `state: "error"`. Runner łapie `BaseException`. Testy są w zadaniu 3.
4. **Zadanie tylko przez LM Studio.** Nie blokuje lokalnych zadań ani „Release GPU”. Dwa lokalne zadania naraz dają 409, a UI pokazuje tekst odmowy. Testy są w zadaniu 3.
5. **Test po podziale patchuje starą nazwę `server.X`.** Dostaje `AttributeError`, a nie cichy zapis do `.work/`. Bramka markera w zadaniach 4–5.

## Decyzje (Rulings) przyjęte w planie

- **R1. Adresy `/legacy`:** `/legacy` i `/legacy/{rest}` dają 307 → `/`. Hash (`#upscale`) przechodzi przez przekierowanie, ale SPA go ignoruje i ląduje na `/upscale`.
- **R2. Brak `web/dist`:** brak buildu daje 503 z instrukcją. `pnpm` (i Node) staje się wymagany na świeżym klonie. README mówi o tym wprost.
- **R3. Zasięg strażnika:** strażnik jest globalny dla zadań na lokalnych modelach (VLM, Florence, upscaler), na GPU i na CPU. Dwa upscale na różnych kartach dostają teraz 409, co wcześniej było świadomie dopuszczone. Zadania tylko LM Studio są zwolnione. Zadanie bez flagi `local_model` liczy się jako zajmujące.
- **R4. Natywne okno folderu:** `POST /api/fs/pick` (zenity) znika, bo v2 ma własny `FolderPicker`.
- **R5. Ścieżka folderu upscalerów:** w v2 nie da się wpisać ścieżki folderu upscalerów. Wybiera się plik wag, a skanowany jest jego folder, z tym samym efektem.
- **R6. Pola starego paska GPU:** pola klasycznego paska w `/api/gpu` i `/api/gpus` (`gpu_label`, `selected`) zostają, bo `web/src/lib/types.ts` ich używa. Jest to drobiazg na później.

---

### Task 1: Usuwanie własnego modelu upscale w v2 (ostatnia luka parytetu)

**Files:**
- Modify: `web/src/pages/UpscalePage.tsx` (pole „Model”, ok. l. 430)
- Test: `web/e2e/upscale.spec.ts`

**Interfaces:**
- Consumes: istniejący `DELETE /api/upscale/models/custom` z body `{repo_id, filename}` (`UpscaleCustomRequest`), który zwraca `{models}`. Wpis ze `useStoreModels()` (`StoreModel`) ma `source: "custom"`, `repo_id` i `filename`.
- Produces: nic dla innych zadań.

- [ ] **Step 1: Write the failing e2e test** `test('remove custom model asks, sends repo and file, and resets the choice')`:
  - zamockuj `GET /api/store/models` z wpisem upscale `{id: "hf:me/x/up.pth", source: "custom", repo_id: "me/x", filename: "up.pth", status: "missing", …}`, wybierz go w `ModelSelect`;
  - kliknij przycisk `Remove custom model`;
  - `ConfirmDialog` z tytułem `Remove custom model?` → potwierdź;
  - przechwycone żądanie `DELETE /api/upscale/models/custom` ma body `{repo_id: "me/x", filename: "up.pth"}`;
  - po sukcesie wybór modelu nie jest już `hf:me/x/up.pth`;
  - przycisk nie pojawia się dla wpisu z `source: "builtin"`.
- [ ] **Step 2: Run** `cd web && pnpm exec playwright test e2e/upscale.spec.ts -g "remove custom"` → FAIL (brak przycisku).
- [ ] **Step 3: Implement.** Obok `Add custom model…` dodaj przycisk ghost `Remove custom model`, widoczny tylko gdy wybrany wpis ma `source === "custom"`:
  - `ConfirmDialog` (destructive), a potem mutacja `useMutationWithToast` z `invalidate: [['store-models']]` i `success: 'Model removed'`;
  - po sukcesie `set('model_id', '')`; pierwszy dostępny model wybiera istniejąca logika, a jeśli jej nie ma, zostaje pusty wybór z walidacją startu.
  - Pliku wag nie usuwamy, bo usunięcie dotyczy tylko wpisu (Global Constraints z Fazy 1).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm exec playwright test e2e/upscale.spec.ts` → PASS.
- [ ] **Step 5: Commit** `feat: v2 upscale can remove a custom model`.

---

### Task 2: Usunięcie klasycznego UI

**Files:**
- Delete: `frontend/` (cały katalog)
- Modify: `backend/server.py`:
  - `FRONTEND`;
  - montowanie i `legacy_slash`;
  - `spa()`;
  - middleware `_no_cache_frontend` (tylko docstring);
  - endpointy niżej.
- Modify: `backend/gpu.py` (`save_selected`, jeśli zostanie sierotą), `run.sh`, `web/src/app/Sidebar.tsx` (link do `/legacy/`), `web/src/app/Onboarding.tsx` (warunek `startsWith('/legacy')`)
- Test: `tests/test_web_serving.py`, `tests/test_gpu_roles.py`, `tests/test_gpu.py`, `tests/test_bbox_backend.py`, `tests/test_prompt_jobs.py`, `tests/test_model_loading.py`, `tests/test_api_models.py`, `web/e2e/smoke.spec.ts`, `web/e2e/shell.spec.ts`

**Endpointy do usunięcia.** Audyt (metoda, ścieżka) pokazał, że używa ich tylko `frontend/`:
- `POST /api/fs/pick`
- `POST /api/gpu/select`
- `GET /api/upscale/models`
- `POST /api/upscale/download`
- `POST /api/ideogram/analyze` (synchroniczny)
- `POST /api/prompt` (synchroniczny)

Usuń też to, co przez to staje się sierotą, ale tylko to:
- `GpuSelectRequest`, `UpscaleDownloadRequest`, `PromptRequest`. Type hint `_generate_prompt` zmienia się na `PromptJobRequest`.
- `_upscale_registry` i `_ensure_model_http`, jeśli nic innego ich nie woła (sprawdź `grep`).
- `gpu.save_selected`. `load_selected` zostaje dla migracji.

**Interfaces:**
- Produces: `GET /legacy` i `GET /legacy/{rest:path}` → `RedirectResponse("/", 307)`, zarejestrowane przed catch-all SPA. `spa()` bez `web/dist/index.html` → `HTMLResponse` 503 z `Cache-Control: no-cache` i tekstem zawierającym `The web UI is not built` oraz `cd web && pnpm install && pnpm build`.

- [ ] **Step 1: Write/adjust failing tests**:
  - `test_web_serving`:
    - bez dist `/` → 503 z oboma fragmentami tekstu;
    - `/legacy` i `/legacy/` → 307, `location == "/"`;
    - `/legacy/style.css` → 307 na `/`;
    - `/api/fs/pick` (POST) → 404.
    - Usuń asercje o serwowaniu `frontend/`.
  - `test_gpu_roles`: `POST /api/gpu/select` → 404 zamiast testu legacy.
  - Każdy usunięty endpoint ma test, że zwraca 404 albo 405 (jeden parametryzowany test w `test_web_serving`).
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_web_serving.py tests/test_gpu_roles.py -q` → FAIL.
- [ ] **Step 3: Przenieś pokrycie, zanim skasujesz testy legacy.** Usuwasz:
  - `test_legacy_analyze_unchanged`, `test_legacy_analyze_vlm_default_tokens`, `test_legacy_analyze_honours_exif_orientation` (odpowiednik EXIF: `test_analyze_job_honours_exif_orientation`);
  - `test_legacy_prompt_endpoint_unchanged`, `test_legacy_prompt_error_codes`, `test_legacy_select_sets_all_roles`;
  - linię z `/api/upscale/models` w `test_api_models.py`.

  Przy tym:
  - `test_download_failure_same_text_job_and_legacy` zachowuje część dla zadania.
  - `test_analyze_download_does_not_block_the_event_loop` (`test_model_loading.py`) przenieś na `POST /api/ideogram/analyze/jobs`. W trakcie zablokowanego `_ensure_model` odpowiadają `GET /api/store/downloads` i `GET /api/ideogram/analyze/jobs/{id}`, a po zwolnieniu zadanie kończy się `done`.
  - `test_gpu.py`: test zapisu i odczytu zapisuje `gpu.json` bezpośrednio w formacie, którego oczekuje `load_selected`, a nie przez `save_selected`.
- [ ] **Step 4: Implement** usunięcia z listy powyżej oraz:
  - `run.sh`: komunikaty bez `/legacy/`. Bez pnpm: „nowe UI nie zostanie zbudowane — bez web/dist aplikacja pokaże instrukcję budowania”. Nieudany build: „zostaje poprzedni build (jeśli jest)”.
  - `Sidebar.tsx` bez linku do klasycznego UI; `Onboarding.tsx` bez warunku `/legacy`.
  - `grep -rn "legacy" web/src backend run.sh launch.sh` → zostają tylko migracje i stara składnia v15 (`legacy_style`, `_LEGACY_STYLE_KEYS`).
- [ ] **Step 5: e2e:**
  - `smoke.spec.ts`: usuń `classic UI loads`.
  - `shell.spec.ts`: `legacy hash opens view` zastąp testem `old /legacy/ link lands in the app`. `page.goto('/legacy/#upscale')` → URL bez `legacy`, widoczna nawigacja `Main`.
- [ ] **Step 6: Run** pytest, typecheck, build i cały Playwright → PASS.
- [ ] **Step 7: Commit** `feat!: remove the classic UI and its legacy-only endpoints`.

---

### Task 3: Wspólny strażnik „GPU zajęte”

**Files:**
- Modify: `backend/server.py`:
  - `_busy`;
  - startery `api_process`, `api_crop_auto`, `api_upscale_run`, `api_ideogram_analyze_job_start`, `api_prompt_job_start`;
  - runnery `_run_job`, `_run_crop_auto`, `_run_upscale_job`.
- Create: `tests/test_gpu_guard.py`
- Test (e2e): `web/e2e/upscale.spec.ts`, `web/e2e/dataset.spec.ts`

**Interfaces:**
- Produces (Task 4 przenosi to do `core`):
  - `BUSY_STATES = ("pending", "downloading", "loading_model", "processing", "generating", "analyzing")`. Stan `"downloading"` ustawia `model_store` (l. ~343) i dziś nie jest liczony, co trzeba naprawić.
  - `BUSY_MSG = "Processing in progress — wait for it to finish."`.
  - `_busy() -> bool`: istnieje zadanie w `JOBS` ze stanem w `BUSY_STATES` i `job.get("local_model", True)`.
  - `_start_job(job: dict, target: Callable, args: tuple, *, local_model: bool) -> None`:
    - pod `JOBS_LOCK` sprawdza: `local_model and _busy()` → `HTTPException(409, BUSY_MSG)`;
    - ustawia `job["local_model"]` i rejestruje `JOBS[job["id"]] = job`;
    - po zwolnieniu blokady startuje `threading.Thread(target=target, args=args, daemon=True)`;
    - gdy `start()` rzuci, zadanie dostaje `state="error"` i `error="Could not start the job: <e>"`, a odpowiedź to `HTTPException(500, ten tekst)`.
- **`local_model` dla starterów:**

  | Starter | `local_model` |
  |---|---|
  | dataset | `(req.do_caption and _lmstudio_model_id(req.model) is None) or bool(req.upscale_model)` |
  | crop auto | `req.mode not in crop_auto.NO_AUTO_MODES` |
  | upscale | `True` |
  | analyze | `not (engine == "vlm" and _lmstudio_model_id(model) is not None)` |
  | prompt | `_lmstudio_model_id(req.model) is None` |

  Zadania ComfyUI i render Ideogram nie przechodzą przez strażnik, bo liczą na zdalnym serwerze.
- `/api/unload` i `/api/gpu/assign` dalej wołają `_busy()`, więc zadanie tylko LM Studio ich już nie blokuje.

- [ ] **Step 1: Write failing tests** w `tests/test_gpu_guard.py`. Wątki są podmienione na atrapę, która nie startuje, przez `monkeypatch` na `server.threading.Thread`; `JOBS` jest podmienione na pusty słownik.
  - `test_each_local_starter_409_while_a_local_job_runs`: parametryzowany po 5 starterach, z aktywnym `{"state": "processing", "local_model": True}`. Odpowiedź to 409 z `BUSY_MSG`.
  - `test_downloading_job_counts_as_busy`.
  - `test_lmstudio_only_job_blocks_nothing`: aktywne `{"state":"generating","local_model":False}`. Starter upscale → 200 i `POST /api/unload` → 200.
  - `test_exempt_starts_pass_while_busy`:
    - dataset z `do_caption=False` i `upscale_model=""`;
    - crop auto w trybie z `NO_AUTO_MODES`;
    - prompt z modelem `lmstudio:x`.
  - `test_job_without_flag_counts_as_busy`: stare `{"state":"processing"}` → 409.
  - `test_thread_start_failure_is_500_and_frees_the_guard`: atrapa `start()` rzuca `RuntimeError("can't start new thread")`. Odpowiedź to 500 z tekstem `Could not start the job`, zadanie ma `state == "error"`, a następny start → 200.
  - `test_runners_catch_base_exception`: parametryzowany po `_run_job`, `_run_crop_auto` i `_run_upscale_job`. `_ensure_model` albo `upscaler.upscale` rzuca podklasę `BaseException`, a stan kończy jako `"error"`.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_gpu_guard.py -q` → FAIL.
- [ ] **Step 3: Implement.**
  - `_busy`, `_start_job` i zamiana 5 starterów na `_start_job`. Wejściowa walidacja (400) zostaje przed strażnikiem.
  - Trzy runnery łapią `BaseException`.
  - Przejrzyj każde `job["state"] = ` w `backend/` i potwierdź, że każdy stan nieterminalny jest w `BUSY_STATES`. Wynik zapisz w raporcie.
- [ ] **Step 4: e2e.** W `upscale.spec.ts` i `dataset.spec.ts` zamockowany start (`POST /api/upscale/run`, `POST /api/process`) zwraca 409 z `{detail: BUSY_MSG}`. Toast pokazuje ten tekst, a widok nie przechodzi w stan „running”. Jeśli Dataset nie startuje przez `useMutationWithToast`, test i tak wymaga widocznego tekstu.
- [ ] **Step 5: Run** pytest i cały Playwright → PASS. `JOBS` jest globalny dla serwera e2e, więc pozostawione aktywne zadanie dałoby 409 w późniejszych testach.
- [ ] **Step 6: Commit** `feat: one GPU busy guard for every local-model job`.

---

### Task 4: `backend/core.py` i routery system, dataset, upscale

**Files:**
- Create: `backend/core.py`, `backend/api_system.py`, `backend/api_dataset.py`, `backend/api_upscale.py`
- Modify: `backend/server.py`, testy odwołujące się do przeniesionych nazw

**Podział (przeniesienie kodu bez zmian w ciałach funkcji, poza `X` → `core.X`):**
- **`core.py`:**
  - `ROOT`, `WORK`, wszystkie `*_PATH`, `COMFY_GALLERY_DIR`, `IDEOGRAM_RENDER_CFG_PATH` i `SRC_THUMBS`;
  - `DB_PATH`, `_db_query`, `_init_db`;
  - `JOBS`, `JOBS_LOCK`, `COMFY_JOBS`, `COMFY_JOBS_LOCK`;
  - `BUSY_STATES`, `BUSY_MSG`, `_busy`, `_start_job`;
  - `_list_images`, `_safe_source_path`, `_job_of_kind`;
  - `_model_ctx`, `_UnknownModel`, `_ensure_model`, `_ensure_model_mapped`;
  - `_lmstudio_url`, `_set_lmstudio_url`, `_lmstudio_model_id`.
- **`api_system.py`:**
  - `/api/models`, `/api/models/custom`, `/api/fs/list`, `/api/fs/mkdir`;
  - `/api/lmstudio`, `/api/hf/token`;
  - `/api/gpu`, `/api/unload`, `/api/gpus`, `/api/gpu/assign`;
  - `/health`;
  - ich helpery (`_gpu_status`, `_smi_snapshot`, `_gpu_cards` i helpery listy modeli).
- **`api_dataset.py`:**
  - scan, `/api/src/*`, `/api/crops`, upload, process, `/api/job`, `/api/crop/auto*`, `/api/thumb`, `/api/export`, `/api/zip`;
  - `ProcessRequest` i pokrewne;
  - `_run_job`, `_run_crop_auto`, `_UpscaleHook`, `_crop_for`, `_final_caption`, `_caption_output_files`, `_job_public`, `_src_thumb_path`.
- **`api_upscale.py`:** `/api/upscale/*` (scan, custom, run, job, thumb, image, export, zip), `_resolve_device`, `_run_upscale_job` i modele żądań.
- **Pozostała część** (comfy, prompts, ideogram) zostaje w `server.py` do zadania 5 i też czyta `core.X`.

**Zasady:**
- Każda nazwa ze stanu albo patchowana w testach jest czytana przez `core.X` (`from . import core`), nigdy przez `from .core import X`.
- Moduły bibliotek (`captioner`, `upscaler`, …) każdy router importuje sam.
- `server.py` nie re-eksportuje przeniesionych nazw.
- Kolejność `include_router` jest taka sama jak kolejność sekcji w dawnym `server.py`. Routery `api_settings` i `models_api` oraz catch-all SPA zostają na końcu.

- [ ] **Step 1: Snapshot przed zmianą** (z drzewa po zadaniu 3) do `<workspace>/routes-before.json`:

```bash
.venv/bin/python -I -c "import json,sys; sys.path.insert(0,'.'); from backend import server as s; from fastapi.routing import APIRoute; r=[[sorted(x.methods or []), x.path, getattr(x.endpoint,'__name__',type(x).__name__)] for x in s.app.routes]; json.dump({'routes': sorted(r), 'last': r[-1], 'openapi': json.dumps(s.app.openapi(), sort_keys=True)}, open(sys.argv[1],'w'))" <workspace>/routes-before.json
```

- [ ] **Step 2: Przenieś kod** według listy. Testy aktualizuj w tym samym commicie: `server.X` → `core.X` albo `api_<moduł>.X`, a `server.captioner` → `captioner` itd. Klient testowy dalej używa `server.app`.
- [ ] **Step 3: Dowód czystego przeniesienia.** Ten sam skrypt zapisuje `routes-after.json`. Pola `routes`, `last` i `openapi` są identyczne.
- [ ] **Step 4: Run** `touch <workspace>/marker && .venv/bin/python -m pytest -q && find .work -newer <workspace>/marker` → testy zielone, lista pusta. Do tego `pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** `refactor: backend core module and system, dataset, upscale routers`.

---

### Task 5: Routery comfy, prompts, ideogram; cienki `server.py`

**Files:**
- Create: `backend/api_comfy.py`, `backend/api_prompts.py`, `backend/api_ideogram.py`
- Modify: `backend/server.py`, testy

**Podział:**
- **`api_comfy.py`:** całe `/api/comfy/*` (config, test, workflow, mapping, loras, generate, job, preview, cancel, gallery, mappings, prompts, workflows, object_info, editor) oraz ich helpery i `_OBJECT_INFO_CACHE`.
- **`api_prompts.py`:**
  - `/api/prompts/library*`, `/api/prompt/jobs*`, `/api/prompts/lint`;
  - `_generate_prompt`, `_run_prompt_job`, `_save_prompt_to_library`, `_prompt_category`, `_sql_quote`.
- **`api_ideogram.py`:**
  - `/api/ideogram/render*`, `/api/ideogram/normalize`, `/api/ideogram/analyze/jobs*`;
  - `_analyze_image`, `_vlm_image_to_v15`, `_florence_analyze`, `_decode_image`, `_run_analyze_job`, `_had_legacy_style`.
- **Wywołania między routerami** idą przez atrybut modułu (np. `api_comfy._run_comfy_raw_job` z renderu Ideogram).
- **`server.py` zostaje z:** tworzeniem `app`, middleware (origin guard, no-cache), startem bazy, `include_router` we wcześniejszej kolejności, przekierowaniem `/legacy` i `spa()`.

- [ ] **Step 1: Przenieś kod** według listy, zasady jak w zadaniu 4, testy w tym samym commicie.
- [ ] **Step 2: Dowód** względem tego samego `routes-before.json` z zadania 4: `routes`, `last` i `openapi` są identyczne.
- [ ] **Step 3: Run** bramkę markera z pytest jak w zadaniu 4, `pnpm typecheck && pnpm build` i cały Playwright → PASS. `wc -l backend/server.py` raport podaje (oczekiwane < 200).
- [ ] **Step 4: Commit** `refactor: comfy, prompts, ideogram routers; server.py only wires the app`.

---

### Task 6: Wydanie 2.0.0 — wersja, README, zrzuty, stan

**Files:**
- Modify: `backend/__init__.py` (`__version__ = "2.0.0"`), `web/package.json` (`"version": "2.0.0"`), `README.md`, `docs/superpowers/plans/2026-11-21-studio-v2.md`
- Create: `web/e2e/screenshots.spec.ts`
- Replace: `docs/screenshots/*.png`

**Interfaces:**
- `screenshots.spec.ts` jest pomijany, chyba że `SCREENSHOTS=1`. Na serwerze e2e (tymczasowy `FLUX_PREP_WORK`, mocki z `fixtures.ts`, nigdy instancja użytkownika) zapisuje zrzuty 1440×900 do `../docs/screenshots/`:
  - `01-dataset.png` — siatka z obrazami fixture;
  - `02-prompts.png`;
  - `03-bbox.png` — szkic z ramkami;
  - `04-comfy.png`;
  - `05-upscale.png`;
  - `06-models.png`;
  - `07-settings.png`.
- Na zrzutach nie ma `/home/...` ani prawdziwego adresu ComfyUI.

- [ ] **Step 1:** Ustaw wersje. `/health` zwraca `{"ok": true, "version": "2.0.0"}` z testem w `test_web_serving` (`test_health_reports_version`).
- [ ] **Step 2:** `screenshots.spec.ts`, potem `SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts` i obejrzenie każdego PNG.
- [ ] **Step 3: README przepisane pod v2:**
  - co to jest;
  - zrzuty;
  - wymagania: Python przez `uv`, Node i `pnpm` (wymagane do zbudowania UI);
  - `run.sh` i `launch.sh` (także skrót na pulpicie);
  - folder modeli;
  - opis każdego widoku;
  - GPU per rola i strażnik „Processing in progress”.

  Przeniesione notatki:
  - ręcznie skopiowany snapshot VLM albo Florence trzeba wskazać przez „Use existing…” (`/api/store/locate`);
  - nazwy w bibliotekach ComfyUI nie mogą zawierać `/`, także przy imporcie.

  Bez wzmianek o `/legacy/` czy klasycznym UI. Wyjątek: jedna linia, że stare zakładki przekierowują na nowe UI.
- [ ] **Step 4: Master plan:**
  - w Global Constraints dopisz linię o odrzucaniu `/` w nazwach bibliotek jako świadomej zmianie niezgodnej wstecz;
  - dopisz sekcję „Stan po Fazie 9 (2026-11-23)” z tym, co zrobione, z decyzjami R1–R6 i z listą wciąż otwartych drobiazgów z sekcji „Stan po Fazie N”, których ta faza nie ruszyła.
- [ ] **Step 5: Run** pytest, typecheck, build i cały Playwright (`screenshots` pominięty) → PASS.
- [ ] **Step 6: Commit** `release: v2.0.0 — version, README, screenshots`. Tagu nie tworzymy, bo to decyzja użytkownika.
