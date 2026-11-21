# Spec: Studio v2.0 — przebudowa

Data: 2026-11-21

## Po co

Wersja 2.0 studia (dataset/captiony, prompt studio, bbox editor, ComfyUI,
upscale) ma dostać nowe, animowane UI na nowoczesnym stosie oraz funkcje, o które
prosił użytkownik:

1. **wybór katalogu dla modeli**: zarówno tego, do którego modele się pobierają,
   jak i takiego, w którym model już leży;
2. **wybór katalogu przy każdym pobieraniu** modelu;
3. **zapis ustawień**;
4. **upscaling zdjęć x2 / x3 / x4** z wyborem **GPU** i **modelu**;
5. **wybór GPU**, na którym modele się uruchamiają.

## Stan obecny (to, co plan zmienia)

- Backend to FastAPI. `backend/server.py` ma 2164 linie, testów jest około 250
  (`pytest`, wszystkie zielone).
- Frontend to czysty JS bez kroku budowania (`frontend/`, około 5 tys. linii, 5 widoków).
- `run.sh` ma na sztywno `HF_HOME=/mnt/intel/huggingface`, co jest
  pozostałością po WSL. Na obecnym Manjaro ten katalog nie istnieje: `run.sh`
  założyłby go po cichu i tam pobierał modele.
- Modele pobierają się **po cichu w trakcie joba**:
  - `captioner.py` i `florence.py` przez `from_pretrained(repo_id)`,
  - `upscaler.py` przez `hf_hub_download`.

  Trafiają do cache HF i nie widać postępu.
- Istniejący folder z modelem da się wskazać tylko dla Qwen2.5-VL
  (`custom_models.json`) oraz dla upscalerów (skan folderu w `upscaler.json`).
  Dla Florence-2 nie ma takiej możliwości.
- GPU: jest jedna globalna karta (`.work/gpu.json`, wybierana po UUID). Zmiana
  karty zwalnia wszystkie modele.
- Ustawienia formularzy nie są zapamiętywane, z jednym wyjątkiem: plany kropu
  trzymane w `localStorage`. Konfiguracja serwera jest rozrzucona po około 8
  plikach `.work/*.json`.
- Upscale ma trzy tryby: `native`, `x2` i `long_side`. Liczba przebiegów
  modelu wynika z `upscaler.plan_passes` (`MAX_PASSES=2`), a dokładny rozmiar
  docelowy daje końcowy Lanczos.
- Sprzęt: RTX 5080 16 GB (sm_120) i RTX 4070 Ti 12 GB. Torch 2.12+cu130
  obsługuje sm_120. Na maszynie są node 26 i pnpm 11.

## Założenia

Użytkownik przekazał decyzje techniczne słowami „zrób plan”. Wszystkie poniższe
punkty to **moje decyzje do skreślenia lub zmiany**, nie ustalenia z użytkownikiem.

1. **„Zapis ustawień” obejmuje trzy rzeczy:**
   - (a) automatyczne zapamiętywanie wszystkich pól każdego widoku po stronie
     serwera,
   - (b) nazwane presety per widok (zapisz, wczytaj, usuń),
   - (c) eksport i import ustawień do pliku JSON.
2. **Folder modeli.**
   - W Settings jest jeden globalny **Models folder**, czyli domyślny cel
     pobierania.
   - Dialog każdego pobrania pozwala zmienić katalog dla tego jednego
     pobrania.
   - Modele lądują jako zwykłe foldery
     `<katalog>/<owner>--<repo>/`, a nie w układzie cache HF. Dzięki temu
     widać je na dysku i można je przenieść, a potem wskazać ponownie.
3. **Brak cichego katalogu domyślnego.**
   - Dopóki Models folder nie jest ustawiony, aplikacja przy pierwszym
     uruchomieniu prosi o jego wybór.
   - Job, który potrzebuje brakującego modelu, kończy się czytelnym błędem.
     Nie ma żadnego „fallbacku” do `~/.cache`.
4. **Istniejące modele.**
   - „Use existing folder/file” działa dla każdego modelu: VLM, Florence-2 i
     upscalerów.
   - Modele, które już leżą w cache HF (pobrane przez v1), są wykrywane jako
     gotowe i nie są pobierane drugi raz.
5. **GPU per rola.**
   - Są trzy role: **VLM** (captiony, prompty, analiza VLM), **Florence-2**
     (auto-crop, „From image”) i **Upscale**. Każda rola ma kartę albo CPU,
     albo `auto` (karta z największą pamięcią).
   - Zmiana karty dla roli zwalnia tylko model tej roli.
   - Widok Upscale ma własny picker GPU w formularzu joba.
   - Dotychczasowy `gpu.json` staje się startową wartością wszystkich ról.
6. **Upscale.**
   - Nowy tryb `factor`: przyciski x2 / x3 / x4 plus własna wartość 1.5–8.
   - x3 to przebieg(i) modelu, po których Lanczos skaluje w dół. To
     uogólnienie istniejącej logiki `long_side`, a nie nowy pipeline.
   - Dochodzi wgrywanie zdjęć przeciągnięciem (istniejący `/api/upload`) i
     suwak „przed/po”.
7. **Stos frontendu:**
   - React 19, TypeScript i Vite,
   - Tailwind CSS v4 i shadcn/ui (Radix),
   - Motion (motion.dev) do animacji,
   - TanStack Query do stanu serwera, sonner do toastów, lucide-react do ikon.

   Menedżerem pakietów jest pnpm. Bundle buduje `run.sh` i nie trafia do gita.
8. **UI zostaje po angielsku**, bo to świadoma decyzja z commita `1209f78`.
   Motyw jest tylko ciemny.
9. **Postęp przez polling** TanStack Query na istniejących endpointach jobów,
   bez SSE i WebSocketów.
10. **Przejście stopniowe.** Nowy frontend działa pod `/`, stary pod
    `/legacy/` do czasu, aż każdy widok osiągnie parytet. Stary jest usuwany
    w ostatniej fazie.
11. **Dane zostają tam, gdzie są:**
    - `.work/flux_prep.db` (biblioteka promptów i workflowy),
    - `hf.json` (token),
    - `comfy_*.json` i `comfy_gallery/`.

    Nie ma migracji ani przenoszenia.

## Cele, poza zakresem, anty-cele

**Cele:** pięć punktów z „Po co”, nowe UI z animacjami i pełny parytet z v1
(każda funkcja z README v1 działa w v2).

**Poza zakresem:**
- nowe silniki VLM (np. Qwen3-VL),
- logowanie i dostęp zdalny,
- jasny motyw i i18n,
- SSE,
- równoległe joby na tej samej karcie,
- usuwanie plików modeli z dysku z poziomu aplikacji.

**Anty-cele** (porażka, nawet jeśli „działa”):
- utrata biblioteki promptów, workflowów, galerii lub tokenu HF;
- ponowne pobieranie modelu, który już jest na dysku;
- pobieranie do katalogu, którego użytkownik nie wybrał;
- folder z niedokończonym pobraniem uznany za gotowy model;
- usunięcie starego UI, zanim nowe ma parytet;
- animacje, które spowalniają pracę, np. blokują klik albo ignorują
  `prefers-reduced-motion`.

## Rozważone podejścia

**Frontend:**
- **A. React + Vite + shadcn/ui + Motion (wybrane).** Ma największy ekosystem
  gotowych, dopracowanych komponentów (dialogi, select, slider, toasty) i
  najlepszą bibliotekę animacji układu (shared layout, `AnimatePresence`).
  Koszt to krok budowania przez pnpm.
- **B. Svelte 5 / SvelteKit.** Mniej kodu i wbudowane przejścia, ale mniejszy
  ekosystem komponentów i mniej przykładów dla edytorów canvasowych.
- **C. Zostać przy vanilla JS, dodać nowy CSS i View Transitions API.** Nie ma
  kroku budowania, ale 5 tys. linii ręcznego DOM-u z animacjami trudno
  utrzymać i nie spełnia to „najnowszej technologii”.

**Backend:**
- **Zachować FastAPI i rozbudować (wybrane).** Logika i około 250 testów
  działają; przepisanie byłoby ryzykiem bez zysku dla użytkownika.
- **Przepisać od zera:** odrzucone.

**Strategia przejścia:**
- **Stopniowo, z legacy pod `/legacy/` (wybrane).** Każda faza zostawia
  działającą aplikację.
- **„Big bang”:** odrzucony, bo przez kilka faz nie byłoby działającego UI.

## Projekt

### 1. Magazyn ustawień — `backend/settings.py`

Plik `.work/settings.json`:

```json
{
  "version": 1,
  "models_dir": "",
  "model_locations": {"<model_id>": "/abs/path"},
  "gpu": {"vlm": "auto", "florence": "auto", "upscale": "auto"},
  "forms": {"<view>": {"<field>": "<value>"}},
  "presets": {"<view>": {"<preset name>": {"<field>": "<value>"}}}
}
```

- Zapis jest atomowy (plik tymczasowy, potem `os.replace`) i chroniony
  blokadą. Dwie karty przeglądarki zapisujące naraz nie psują pliku.
- Uszkodzony plik jest odkładany jako `settings.json.bad-<timestamp>`, a
  aplikacja startuje z domyślnymi wartościami. Start serwera nigdy się na tym
  nie wywraca.
- Dozwolone widoki: `dataset`, `prompts`, `bbox`, `comfy`, `upscale`. Nazwa
  presetu ma 1–64 znaki i nie zawiera `/`.
- Token HF **nigdy** nie trafia do `settings.json` ani do eksportu (zostaje w
  `hf.json`).
- Migracja przy pierwszym odczycie: puste `gpu` jest wypełniane UUID-em z
  `.work/gpu.json` dla wszystkich ról.

### 2. Menedżer modeli — `backend/model_store.py`

Rejestr wszystkich modeli lokalnych:
- **VLM:** `Qwen/Qwen2.5-VL-3B-Instruct` i `Qwen/Qwen2.5-VL-7B-Instruct`. ID to
  repo-id, czyli te same klucze, których już używają requesty.
- **Florence-2:** `florence.DEFAULT_MODEL`.
- **Upscalery:** z `upscaler.registry()`, czyli wbudowane, dodane z HF i ze
  skanu folderu.
- **Własne foldery VLM:** z `custom_models.json`.

Kolejność ustalania lokalnej ścieżki modelu:
1. `model_locations[id]`, jeśli ścieżka nadal istnieje i przechodzi walidację;
2. `<models_dir>/<owner>--<repo>/`, ale tylko z markerem ukończenia
   `.flux-lora-prep-complete` (dla upscalera: istniejący plik wag);
3. cache HF, czyli to, co pobrało v1 (tylko kompletny snapshot, sprawdzany po
   `model.safetensors.index.json` lub pojedynczym `model.safetensors`);
4. brak, czyli status `missing`.

Statusy: `ready`, `downloading` (z postępem) i `missing`.

**Walidacja istniejącego folderu** (przy wskazywaniu i przy rozwiązywaniu
ścieżki z kroku 1):
- VLM: `config.json` z `qwen2_5_vl` plus komplet wag;
- Florence-2: `config.json` z `florence2` plus komplet wag;
- upscaler: plik `.pth` lub `.safetensors`.

„Komplet wag” oznacza `model.safetensors` albo
`model.safetensors.index.json`, w którym istnieje każdy wymieniony shard.

**Pobieranie:**
- Wywołanie `snapshot_download` (VLM, Florence) lub `hf_hub_download`
  (upscaler) z `local_dir=<cel>/<owner>--<repo>` i własną klasą `tqdm`, która
  liczy bajty i obsługuje anulowanie (rzuca `DownloadCancelled`).
- Przed startem sprawdzane są trzy rzeczy: czy katalog istnieje albo da się go
  utworzyć, czy jest zapisywalny, oraz czy wolne miejsce wystarcza na model.
  Rozmiar pochodzi z metadanych HF; gdy jest nieznany, sprawdzenie miejsca
  jest pomijane. Każdy błąd ma czytelny komunikat z liczbami w GB.
- Po sukcesie zapisywany jest marker ukończenia i `model_locations[id]`.
- Po anulowaniu lub błędzie zostają częściowe pliki, ale bez markera. Kolejne
  pobranie wznawia się (cache metadanych HF w `local_dir`).
- Drugie żądanie pobrania tego samego modelu zwraca już trwający job.

**Joby a brakujący model:**
- Captioner, Florence i upscaler pytają `model_store.ensure_local(id,
  on_progress)`.
- Gdy model jest brakujący, a Models folder ustawiony, model pobiera się tam,
  a job pokazuje „Downloading <label>… 34%”.
- Gdy Models folder nie jest ustawiony, job kończy się błędem „No models folder
  chosen — set one in Settings (Models folder).”. Do czasu Fazy 3 legacy UI
  dostaje to jedno pole, żeby gałąź `v2` dało się używać.
- Ścieżki absolutne (własne foldery) i modele `lmstudio:` przechodzą bez zmian.

**`run.sh`:** usunięty domyślny `HF_HOME`. Zmienna podana z zewnątrz jest nadal
respektowana, bo wpływa na krok 3 powyżej.

### 3. GPU per rola — `backend/gpu.py`

- `device_for(role)` zwraca `cuda:N` albo `cpu` na podstawie
  `settings.gpu[role]`. Wartość `auto`, nieznany UUID lub karta, której już
  nie ma, oznacza kartę domyślną (największa pamięć).
- Klucze cache modeli zawierają urządzenie:
  - `captioner._state["key"] = (model, quant, device)`,
  - `florence._RUNTIME["device"]`,
  - `upscaler._RUNTIME["key"] = (id, device)`.
- Zmiana roli zwalnia tylko model tej roli. Zwraca 409, gdy trwa
  jakikolwiek job (istniejące `_busy()`; prościej niż śledzenie zajętości per
  rola).
- `GET /api/gpus` dla każdej karty podaje VRAM i listę ról, które ją używają
  oraz mają na niej załadowany model. VRAM pochodzi z `nvidia-smi`: odczyt
  przez torch otwierałby kontekst CUDA (około 200 MB) na kartach, których
  nikt nie wybrał.
- Stary `POST /api/gpu/select` ustawia wszystkie trzy role, dla zgodności z
  legacy UI.
- Upscale: pole `device` w requeście joba. Pusty string oznacza ustawienie roli,
  można też podać UUID albo `cpu`.

### 4. Upscale x2/x3/x4

- `UpscaleRunRequest.mode` przyjmuje `native`, `x2`, `factor` lub `long_side`
  (`x2` to alias dla `factor=2`).
- `factor: float` z zakresu `(1, 8]`; wartość spoza zakresu daje 422.
- Rozmiar docelowy to `round(w·f) × round(h·f)`.
- Liczbę przebiegów liczy `plan_passes` (`MAX_PASSES=2`):

  | Model | Cel | Przebiegi | Co dalej |
  |-------|-----|-----------|----------|
  | x4 | x3 | 1 | Lanczos w dół |
  | x2 | x3 | 2 | Lanczos w dół |
  | x2 | x8 | 2 | Lanczos w górę (niedobór) |

- Wynik każdego pliku zawiera `passes` i `device`, żeby UI mogło pokazać, co się
  stało.

### 5. Frontend v2 — `web/`

**Układ:**
- boczna nawigacja z animowanym wskaźnikiem aktywnego widoku: Dataset, Prompt
  studio, Bbox editor, ComfyUI, Upscale, Models, Settings;
- górny pasek z kartami GPU: nazwa, animowany pasek VRAM, załadowane modele i
  przycisk „Release”.

**Wspólne komponenty:**
- `FolderPicker`: dialog oparty na `/api/fs/list`, z breadcrumbs, „New folder”,
  wolnym miejscem i znacznikiem zapisu;
- `GpuSelect`;
- `ModelSelect`, który pokazuje status modelu i pozwala pobrać go w miejscu;
- `PresetBar`, który wczytuje, zapisuje i usuwa presety;
- `useAutosave(view)` z debounce 500 ms;
- `JobProgress`.

**Models:** tabela modeli ze statusem, ścieżką i rozmiarem. Akcje: „Download…”
(dialog z katalogiem i wolnym miejscem), „Use existing…”, „Forget” oraz
anulowanie pobierania.

**Settings:**
- Models folder,
- GPU per rola,
- token HF,
- URL LM Studio i ComfyUI,
- eksport i import ustawień.

**Animacje (Motion):**
- przejścia widoków 150–200 ms,
- wejście siatki miniatur z opóźnieniem kaskadowym,
- sprężyste dialogi,
- animowane paski postępu i VRAM,
- skeletony podczas ładowania.

`MotionConfig reducedMotion="user"`. Żadna animacja nie blokuje interakcji.

**Edytory canvasowe** (bbox, crop): port jako komponenty React, które
opakowują istniejącą imperatywną logikę przeniesioną do modułów TS
(montowanie w `useEffect`). Nie są przepisywane deklaratywnie, żeby zachować
zachowanie.

**Serwowanie:** FastAPI serwuje `web/dist` pod `/`, stary `frontend/` pod
`/legacy/`. `run.sh` uruchamia `pnpm install --frozen-lockfile && pnpm build`,
gdy `web/dist` nie istnieje albo źródła są nowsze.

**Weryfikacja:** `pnpm build`, `pnpm typecheck` i smoke test Playwright dla
każdego widoku (`web/e2e/*.spec.ts`).

### Lista parytetu (z README v1)

- **Dataset:**
  - źródło z folderu lub wgranych plików (HEIC);
  - siatka miniatur;
  - crop w czterech trybach: centre z centrowaniem, auto, manual, batch
    „Auto-crop all” z potwierdzeniem;
  - fit cover lub contain z kolorem tła;
  - upscale przy małym kropie;
  - wszystkie ustawienia: tryb opisu, styl, format, rozdzielczość, bucket,
    format i jakość pliku, VLM, LM Studio, kwantyzacja, maks. tokeny,
    trigger;
  - przetwarzanie z postępem;
  - przegląd i edycja captionów;
  - eksport do folderu lub `.zip`.
- **Prompt studio:**
  - Expand i Refine;
  - cel FLUX.2 lub Ideogram v15;
  - kontrolki liczby elementów i gęstości;
  - style presets;
  - linter;
  - biblioteka: filtr, kopiuj, otwórz na canvasie, usuń, eksport `.sql`.
- **Bbox editor:**
  - przeciąganie i zmiana rozmiaru;
  - cykl nakładających się boksów;
  - z-order;
  - karty z licznikami słów;
  - żywy linter;
  - Paste JSON (legacy, wrappery, podwójne kodowanie);
  - From image (Florence, VLM, Hybrid);
  - zapis do biblioteki, kopiowanie i pobieranie;
  - render Ideogram 4: presety jakości, megapiksele, seed, scheduler, LoRA,
    podgląd na żywo, siatka wyników.
- **ComfyUI:**
  - URL i test połączenia;
  - test LoRA z wgranym workflow;
  - batch referencji;
  - edytor workflow z widokiem grafu i biblioteką;
  - galeria.
- **Upscale:**
  - modele wbudowane, własne z HF i z folderu lokalnego;
  - tryby native, x2, long-side, a teraz także factor;
  - eksport do folderu lub `.zip`.
- **Górny pasek:**
  - status GPU, VRAM, Release GPU;
  - wybór karty po nazwie, a teraz per rola.

## Co zostaje dla wykonawcy

- Dokładny wygląd: kolory akcentu, typografia i odstępy, w obrębie ciemnego
  motywu i komponentów shadcn/ui.
- Podział komponentów React wewnątrz widoku.
- Teksty pomocnicze w UI (po angielsku).
