# Spec: kadrowanie zdjęć (crop) i modele powiększania (upscale)

Data: 2026-08-16

## Cel

Dwie powiązane funkcje w przygotowaniu datasetu:

1. **Kadrowanie (crop)** — pełna kontrola nad tym, *który fragment* zdjęcia trafia
   do datasetu, zamiast dzisiejszego sztywnego centralnego przycięcia
   (`ImageOps.fit`, `centering=(0.5, 0.5)`). Cztery tryby wybierane przełącznikiem:
   ręczny kadr per zdjęcie, automat oparty na detekcji (Florence‑2), globalne
   centrowanie + tryb dopasowania, oraz kadrowanie wsadowe przed startem joba.
2. **Powiększanie (upscale)** — wybieralne modele super‑rozdzielczości pobierane
   z Hugging Face (plus modele z lokalnego folderu), używane automatycznie, gdy
   kadr jest mniejszy od docelowego bucketa, oraz jako samodzielne narzędzie
   „powiększ te zdjęcia" w osobnej zakładce.

Dodatkowo: pole na **token Hugging Face**, żeby pobierać modele z repozytoriów
wymagających logowania (dotyczy też VLM‑a i Florence‑2).

## Stan obecny (punkt wyjścia)

- `backend/image_utils.py`:
  - `compute_bucket(w, h, target, step, square)` — bucket z proporcji **oryginału**,
  - `process_image(path, target, step, square)` — EXIF → RGB → `ImageOps.fit`
    (cover + centralny crop) → zwraca obraz i rozmiar,
  - `save_image`, `make_thumbnail`.
- `backend/server.py`: `ProcessRequest` (bez pól kadru), `_run_job()` woła
  `image_utils.process_image(...)` w pętli po plikach, wyniki lądują w `JOBS`.
- Krok 1 UI pokazuje tylko licznik plików (`srcInfo`) — **brak miniatur źródłowych**,
  czyli nie ma dziś w co kliknąć, żeby kadrować.
- Krok 4 (Review) pokazuje miniatury przetworzonych plików + edycję captionów.
- `backend/florence.py` — Florence‑2 z zadaniami `<OD>`, `<DENSE_REGION_CAPTION>`,
  `<OCR_WITH_REGION>`, `<MORE_DETAILED_CAPTION>`; runtime modułowy + `unload()`.
- Konfiguracje trzymane jako JSON w `.work/` (`comfy_config.json`, `lmstudio.json`);
  `.work/` jest w `.gitignore`.

## Decyzje architektoniczne (zatwierdzone)

- **A1** — plan kadrów żyje w przeglądarce (stan JS + `localStorage` pod kluczem
  ścieżki folderu) i jest wysyłany razem z `/api/process`. Backend nie przechowuje
  planu kadrów.
- **B1** — upscaler jest **etapem wewnątrz** `_run_job`, a nie osobnym pre‑passem.
  Ten sam moduł obsługuje samodzielną zakładkę „🔍 Upscale".

## Część 1 — kadrowanie

### Model danych

Kadr = `[x, y, w, h]` w pikselach **oryginału po korekcie EXIF** (bo wszystkie
wymiary w UI i backendzie liczymy po `exif_transpose`). Plan kadrów:

```json
{ "IMG_001.jpg": [120, 40, 900, 1200], "IMG_002.heic": [0, 0, 3000, 3000] }
```

Klucz = nazwa pliku (`Path.name`), bo job i tak operuje na jednym folderze.

Nowe pola `ProcessRequest`:

| pole | typ | domyślnie | znaczenie |
|---|---|---|---|
| `crop_mode` | `str` | `"center"` | `center` \| `auto` \| `manual` |
| `fit` | `str` | `"cover"` | `cover` (przycinaj) \| `contain` (dopełnij tłem) |
| `pad_color` | `str` | `"#000000"` | kolor dopełnienia dla `contain` |
| `centering_x` | `str` | `"center"` | `left` \| `center` \| `right` |
| `centering_y` | `str` | `"center"` | `top` \| `center` \| `bottom` |
| `crops` | `dict[str, list[int]]` | `{}` | plan kadrów |

### `backend/image_utils.py`

```python
def load_source(path: str) -> Image.Image
    # open + exif_transpose + convert("RGB") — wspólne dla kadrowania i miniatur

def clamp_box(box, w, h) -> tuple[int, int, int, int]
    # przycięcie kadru do granic obrazu; box zdegenerowany -> cały obraz

def box_for_focus(w, h, ar, focus, headroom=0.0) -> tuple[int, int, int, int]
    # największy prostokąt o proporcji `ar` wokół punktu ostrości `focus` (0..1),
    # z opcjonalnym zapasem nad punktem (headroom) — do kadrów twarzy

def process_image(path, target, step, square, *,
                  crop=None, centering=(0.5, 0.5), fit="cover",
                  pad_color="#000000", upscale=None)
```

Kolejność w `process_image()`:

1. `load_source()`,
2. jeśli `crop` → `img.crop(clamp_box(...))`,
3. `compute_bucket()` **z proporcji kadru**, nie oryginału — dzięki temu ręczny
   kadr sam wyznacza bucket; w trybie `square` bucket to nadal `target × target`,
4. jeśli podano `upscale` i `bucket / kadr > próg` → powiększenie modelem
   (część 2),
5. dopasowanie: `cover` → `ImageOps.fit(..., centering=centering)`;
   `contain` → skalowanie z zachowaniem proporcji + wklejenie na tło `pad_color`.

Sygnatura pozostaje kompatybilna wstecz (wszystkie nowe argumenty są keyword‑only
z domyślnymi wartościami = dzisiejsze zachowanie).

### Tryby kadru

- **`center`** — brak kadru per plik; `centering` z UI. `top` rozwiązuje typowy
  problem „centralny crop ucina głowę".
- **`auto`** (Florence‑2, `backend/crop_auto.py`):
  - tryby `person`, `person_detail` → grounding na twarz/głowę
    (`<CAPTION_TO_PHRASE_GROUNDING>` z frazą `face`, fallback `person`),
  - `generic`, `style` → największy obiekt z `<OD>` (w trybie `style` nie ma
    z góry znanego tematu, więc twarz nie jest właściwym kotwiczeniem),
  - `landscape`, `architecture` → brak sensownego obiektu, fallback na `center`,
  - z bboxa liczymy punkt ostrości (środek), kadr = `box_for_focus()` z proporcją
    docelową i `headroom` dla twarzy,
  - brak detekcji → fallback na `center` (nigdy błąd joba).
- **`manual`** — kadr z `crops[nazwa]`; brak wpisu → fallback na `center`.

### Endpointy

| endpoint | opis |
|---|---|
| `GET /api/src/thumb?folder=&name=` | miniatura pliku źródłowego (JPEG, dłuższy bok 640), cache w `.work/srcthumbs/<sha1(folder)>/<name>.jpg` |
| `GET /api/src/image?folder=&name=` | pełny obraz źródłowy dla edytora kadru (JPEG, dłuższy bok 1600) + nagłówki `X-Src-Width`/`X-Src-Height` z prawdziwymi wymiarami po EXIF |
| `POST /api/crop/auto` | job auto‑kadrowania: `{folder, mode, resolution, step, square, names?}` → `{job_id, total}` |
| `GET /api/crop/auto/{job_id}` | postęp + gotowe kadry `{name: [x,y,w,h]}` |

Auto‑kadrowanie jest jobem (wzorzec `JOBS` z `server.py`), bo Florence‑2 na 50+
zdjęciach to kilkadziesiąt sekund — żądanie synchroniczne by się rozjechało.

Ścieżki w `folder`/`name` walidowane jak w istniejącym `_list_images`
(`name` musi być nazwą pliku bez separatorów, plik musi leżeć w `folder`).

### UI

**Krok 1 (Source)** zyskuje siatkę miniatur źródłowych po skanie/uploadzie.
Nad siatką: **✂ Auto‑kadruj wszystkie** (job z paskiem postępu) i
**Wyczyść kadry**. Miniatura z ustawionym kadrem dostaje znacznik ✂ i podgląd
ramki narysowanej na miniaturze.

**Krok 2 (Settings)** — nowe pola: `Kadrowanie` (`Środek | Auto (Florence‑2) |
Ręcznie`), `Dopasowanie` (`Cover | Contain`), kolor dopełnienia (aktywny przy
`contain`), `Centrowanie` (poziom + pion, aktywne przy `Środek`). Dzisiejszy
select `Cropping: Buckets / Square` zostaje bez zmian — to osobna oś (kształt
wyjścia), a nowa oś opisuje *skąd* bierzemy kadr.

**Modal edytora kadru** (klik w miniaturę): obraz w skali dopasowanej do okna,
ramka z 8 uchwytami, przeciąganie wnętrza, strzałki = 1 px, Shift+strzałki = 10 px.
Blokada proporcji: `Wolny | 1:1 | 3:4 | 4:3 | 16:9`, wymuszone `1:1` gdy włączony
tryb Square. Przyciski: **Auto (Florence)** (pojedyncze zdjęcie, synchronicznie),
**Reset**, **Zastosuj do wszystkich o tych proporcjach**, **Zapisz**, **Anuluj**.
Pod obrazem podgląd wynikowego bucketa (`np. 896 × 1152`).

Nowe pliki: `frontend/crop_editor.js`, `frontend/crop_editor.css`
(`app.js` ma ~1900 linii — edytor tam nie trafia).

## Część 2 — powiększanie (upscale)

### `backend/upscaler.py` (nowy)

- `BUILTIN_MODELS` — lista danych na górze modułu:
  `{id, label, repo_id, filename, scale, note}`. Kandydaci: RealESRGAN x4plus,
  RealESRGAN x2plus, 4x‑UltraSharp, 4x‑NMKD‑Siax, 4x‑Nomos8kSC. **Dokładne
  `repo_id` i nazwy plików weryfikowane przy implementacji** (realne pobranie
  każdego wpisu); wpis, którego nie da się pobrać, wypada z listy.
- Ładowanie wag: **`spandrel`** (ta sama biblioteka, której używa ComfyUI) —
  rozpoznaje architekturę i skalę z pliku `.pth`/`.safetensors`, więc obsługuje
  też modele zeskanowane z dysku.
- Pobieranie: `huggingface_hub.hf_hub_download` do standardowego cache HF
  (jak Qwen i Florence), z tokenem jeśli ustawiony.
- `upscale(img, model_ref, target_scale=None) -> Image` — inferencja kafelkowa
  (tile 512, overlap 32), fp16 na CUDA; przy OOM automatycznie mniejszy kafelek
  (256 → 128), w ostateczności CPU.
- Runtime modułowy + `unload()` — jak `florence.py`; podpięty pod istniejący
  przycisk **⏏ Release GPU** i pod status GPU w topbarze.
- `scan_folder(path) -> list[dict]` — `*.pth`, `*.safetensors` z lokalnego folderu.
- Konfiguracja: `.work/upscaler.json` — `{"folder": "...", "custom": [{repo_id, filename}]}`.

Modele ESRGAN to kilkadziesiąt MB wag, więc obok 4‑bitowego Qwena mieszczą się
w 12 GB VRAM bez zabiegów.

### Token Hugging Face

- Plik `.work/hf.json` — `{"token": "hf_..."}` (`.work/` jest w `.gitignore`).
- `GET /api/hf/token` → `{"set": true, "tail": "abcd"}` — **nigdy nie zwraca
  pełnego tokenu**.
- `POST /api/hf/token` `{token}` → zapis; `DELETE /api/hf/token` → usunięcie.
- Token przekazywany do `hf_hub_download(token=...)` oraz ustawiany w env
  `HF_TOKEN` przy starcie serwera i po zapisie, dzięki czemu działa też dla
  `transformers` (VLM, Florence‑2) i repozytoriów bramkowanych.
- UI: pole `password` w kroku 2, obok URL LM Studio, z przyciskami Zapisz/Usuń
  i statusem `ustawiony (…abcd)`.

### Endpointy modeli upscale

| endpoint | opis |
|---|---|
| `GET /api/upscale/models` | wbudowane + własne + zeskanowane z folderu; każdy wpis z `cached: bool` |
| `POST /api/upscale/models/scan` | `{folder}` → zapis folderu w configu + lista znalezionych plików |
| `POST /api/upscale/models/custom` | `{repo_id, filename}` → dopisanie własnego modelu z HF |
| `DELETE /api/upscale/models/custom` | `{repo_id, filename}` |
| `POST /api/upscale/download` | `{model_id}` → pobranie wag (job z postępem, bo to setki MB) |

### Integracja z pipeline datasetu

Nowe pola `ProcessRequest`:

| pole | typ | domyślnie | znaczenie |
|---|---|---|---|
| `upscale_model` | `str` | `""` | pusty = wyłączone |
| `upscale_min_ratio` | `float` | `1.05` | próg, od którego uruchamiamy model |

W `_run_job()`, po wyznaczeniu kadru i bucketa: jeśli
`max(bw / kadr_w, bh / kadr_h) > upscale_min_ratio` → powiększ modelem
(maks. 2 przebiegi, żeby osiągnąć lub przekroczyć docelowy rozmiar), potem
LANCZOS w dół do bucketa. Model ładowany raz, przed pętlą (stan `loading_model`).

Wynik pojedynczego zdjęcia dostaje `upscaled: bool` i `src_width`/`src_height`;
`_job_public()` je przepuszcza, a Review pokazuje ✨ przy zdjęciach, które
przeszły przez model — od razu widać, które źródła były za małe.

Błąd upscalera dla pojedynczego pliku nie zabija joba: log w wyniku + zwykły
LANCZOS jako fallback.

### Zakładka „🔍 Upscale"

Piąta zakładka w `topnav`. Źródło = folder lub upload (reużywa `/api/scan`
i `/api/upload`), wybór modelu, tryb docelowy (`natywna skala modelu` | `x2` |
`dłuższy bok = N px`), format wyjścia (PNG/JPG + jakość), job z paskiem postępu
i podglądem przed/po, eksport do folderu albo `.zip` — wzorzec jobów i eksportu
istnieje już w `server.py`.

Endpointy: `POST /api/upscale/run` → `{job_id}`, `GET /api/upscale/job/{id}`,
`POST /api/upscale/export`, `GET /api/upscale/zip/{id}`.

Nowy plik: `frontend/upscale.js`.

## Testy

Katalog `tests/`, uruchamiane przez `pytest` (konfiguracja w `pytest.ini`).

- `tests/test_image_utils_crop.py` — bucket liczony z proporcji kadru;
  `clamp_box` dla kadru wychodzącego poza obraz i kadru zdegenerowanego;
  `contain` (rozmiar wynikowy = bucket, tło w zadanym kolorze);
  `centering` `top`/`bottom` (sprawdzenie, który fragment przetrwał);
  brak regresji: wywołanie bez nowych argumentów daje dzisiejszy wynik.
- `tests/test_crop_auto.py` — mapowanie detekcji → kadr z **zamockowaną**
  detekcją Florence: headroom nad twarzą, clamping przy krawędzi, fallback na
  `center` przy braku detekcji, fallback dla `landscape`/`architecture`.
- `tests/test_upscaler.py` — rejestr modeli; `scan_folder` na `tmp_path` z
  fałszywymi `.pth`; decyzja „czy powiększać" wobec `min_ratio`; liczba
  przebiegów dla modelu x2 i x4. Pobierania z HF i ładowania wag **nie testujemy**
  — mock.
- `tests/test_server_crop_upscale.py` — `/api/process` przyjmuje `crops`,
  `crop_mode`, `upscale_model`; `/api/hf/token` po zapisie nie oddaje pełnego
  tokenu; `/api/src/thumb` odrzuca `name` ze ścieżką (`../`).

## Dokumentacja

README: opis kadrowania w sekcji Dataset, nowa zakładka Upscale, wzmianka o
tokenie HF, aktualizacja listy wymagań (`spandrel`, `huggingface_hub`).
Odświeżone screenshoty w `docs/screenshots/` — zgodnie ze zwyczajem repo.

## Poza zakresem (YAGNI)

- Upscale przez serwer ComfyUI (odrzucone — wybrane pobieranie z HF).
- Detekcja twarzy przez OpenCV (odrzucone — używamy Florence‑2, który już jest).
- Trwały zapis planu kadrów na serwerze (świadomie: `localStorage`).
- Kadrowanie już przetworzonych zdjęć w kroku Review (traci rozdzielczość).
- Rotacja / prostowanie horyzontu w edytorze kadru.

## Ryzyka

1. **Przenoszone repozytoria HF** — rejestr modeli to lista danych łatwa do
   edycji; błąd pobrania musi być czytelnym komunikatem w UI, nie wywróconym jobem.
2. **`spandrel` jako nowa zależność** — alternatywą jest ręczne pisanie
   architektur ESRGAN, co odrzucam. Ryzyko: kilka MB i jeszcze jeden pakiet
   związany z torchem.
3. **Czas auto‑kadrowania** — Florence‑2 to ~0,3–1 s/zdjęcie; stąd job z paskiem
   postępu i możliwość kadrowania tylko wybranych zdjęć.
4. **VRAM przy `contain` + x4 na dużych zdjęciach** — kafelkowanie plus fallback
   na CPU; przy 12 GB nie przewiduję problemu, ale fallback musi być przetestowany
   ścieżką „mniejszy kafelek".
