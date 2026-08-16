# Kadrowanie (crop) i modele upscale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dać pełną kontrolę nad kadrem zdjęć w datasecie (ręcznie / auto Florence-2 / centrowanie / wsadowo) oraz wybieralne modele super-rozdzielczości z Hugging Face i z lokalnego folderu — automatycznie w pipelinie i jako osobne narzędzie.

**Architecture:** Kadr to `[x,y,w,h]` w pikselach oryginału po EXIF; plan kadrów żyje w przeglądarce (`localStorage`) i jedzie w `POST /api/process`. `image_utils.process_image()` dostaje keyword-only argumenty (`crop`, `centering`, `fit`, `pad_color`, `upscale`) i liczy bucket **z proporcji kadru**. Nowy `backend/crop_auto.py` zamienia detekcje Florence-2 na kadr, nowy `backend/upscaler.py` ładuje modele przez `spandrel` i robi inferencję kafelkową, nowy `backend/hf_auth.py` trzyma token HF. Front dostaje siatkę miniatur źródłowych, modal edytora kadru (`crop_editor.js`) i piątą zakładkę „🔍 Upscale" (`upscale.js`).

**Tech Stack:** FastAPI, Pydantic, Pillow, PyTorch, `spandrel`, `huggingface_hub`, transformers (Florence-2), vanilla JS; testy: `.venv/bin/python -m pytest`.

**Spec:** `docs/superpowers/specs/2026-08-16-crop-i-upscale-design.md`

## Global Constraints

- Python: venv z `run.sh` (`uv venv --python 3.12 .venv`); testy uruchamiamy `.venv/bin/python -m pytest`.
- Nowe zależności dopisujemy do `requirements.txt`: `spandrel>=0.3.4`, `huggingface_hub>=0.23.0`. Nic więcej.
- Kadr = `[x, y, w, h]` w **pikselach oryginału po `ImageOps.exif_transpose`**. Nigdy w procentach, nigdy przed EXIF.
- `image_utils.process_image()` musi zostać **kompatybilne wstecz**: wywołanie z dotychczasowymi 4 argumentami pozycyjnymi daje dokładnie dzisiejszy wynik. Wszystkie nowe argumenty są keyword-only z domyślnymi.
- Żaden błąd kadru/upscalera nie może wywalić joba: fallback na dotychczasowe zachowanie + komunikat w wyniku.
- `GET /api/hf/token` **nigdy** nie zwraca pełnego tokenu — tylko `{"set": bool, "tail": "4 znaki"}`.
- Komentarze w kodzie po angielsku (jak reszta backendu), teksty UI po angielsku (jak reszta `index.html`), dokumentacja i plan po polsku.
- Cache modeli HF idzie do `HF_HOME` ustawianego przez `run.sh` — nie nadpisujemy tego w kodzie.

## Uwagi do specyfikacji (doprecyzowania na etapie planu)

1. Spec przewidywał `box_for_focus()` (największy prostokąt o zadanej proporcji wokół punktu). W trybie **bucketów** proporcja docelowa ≈ proporcja oryginału, więc taki prostokąt to *cały obraz* i auto-kadr nie robiłby nic. Zamiast tego implementujemy **`box_around()`** — najmniejszy prostokąt o zadanej proporcji zawierający wykryty bbox powiększony o margines, z dolnym ograniczeniem rozmiaru (żeby nie zejść poniżej docelowej rozdzielczości). Działa sensownie i w trybie kwadratu, i w bucketach („dosuń kadr do tematu").
2. `process_image()` zwraca nadal 2-elementową krotkę. Informację „czy użyto upscalera" przenosi obiekt-hook przekazany w `upscale=` (patrz Task 8), żeby nie zmieniać sygnatury zwrotu.

---

### Task 1: `image_utils` — kadr, centrowanie, `contain`

**Files:**
- Modify: `backend/image_utils.py`
- Test: `tests/test_image_utils_crop.py` (nowy)

**Interfaces:**
- Consumes: istniejące `compute_bucket(w, h, target, step, square)`.
- Produces:
  - `load_source(path: str) -> Image.Image`
  - `clamp_box(box, w: int, h: int) -> tuple[int, int, int, int]` (x, y, w, h)
  - `box_around(w, h, bbox, ar, margin=0.6, headroom=0.0, min_side=0) -> tuple[int,int,int,int]`
  - `CENTERING: dict[str, float]`
  - `centering_pair(x_name: str, y_name: str) -> tuple[float, float]`
  - `process_image(path, target, step, square, *, crop=None, centering=(0.5,0.5), fit="cover", pad_color="#000000", upscale=None) -> tuple[Image.Image, tuple[int,int]]`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_image_utils_crop.py`:

```python
from PIL import Image

from backend import image_utils


def _make(tmp_path, w, h, color=(10, 20, 30)):
    p = tmp_path / f"img_{w}x{h}.png"
    Image.new("RGB", (w, h), color).save(p)
    return str(p)


def test_clamp_box_inside_image():
    assert image_utils.clamp_box((10, 20, 100, 200), 1000, 1000) == (10, 20, 100, 200)


def test_clamp_box_trims_overflow():
    x, y, w, h = image_utils.clamp_box((900, 900, 500, 500), 1000, 1000)
    assert (x, y) == (900, 900)
    assert (w, h) == (100, 100)


def test_clamp_box_degenerate_returns_whole_image():
    assert image_utils.clamp_box((10, 10, 2, 2), 800, 600) == (0, 0, 800, 600)
    assert image_utils.clamp_box((-50, -50, 1, 1), 800, 600) == (0, 0, 800, 600)


def test_box_around_keeps_aspect_and_contains_bbox():
    x, y, w, h = image_utils.box_around(2000, 1000, (900, 400, 1100, 600), 1.0)
    assert abs(w / h - 1.0) < 0.01
    assert x <= 900 and y <= 400 and x + w >= 1100 and y + h >= 600


def test_box_around_clamped_to_image_edges():
    x, y, w, h = image_utils.box_around(1000, 1000, (0, 0, 100, 100), 1.0, margin=2.0)
    assert x >= 0 and y >= 0
    assert x + w <= 1000 and y + h <= 1000


def test_box_around_min_side_enforced():
    _, _, w, h = image_utils.box_around(
        2000, 2000, (990, 990, 1010, 1010), 1.0, margin=0.0, min_side=800)
    assert w >= 800 and h >= 800


def test_box_around_headroom_moves_box_up():
    _, y_plain, _, _ = image_utils.box_around(2000, 2000, (900, 900, 1100, 1100), 1.0)
    _, y_head, _, _ = image_utils.box_around(
        2000, 2000, (900, 900, 1100, 1100), 1.0, headroom=0.3)
    assert y_head < y_plain


def test_process_image_backwards_compatible(tmp_path):
    src = _make(tmp_path, 2000, 1000)
    img, (w, h) = image_utils.process_image(src, 1024, 64, False)
    assert (img.width, img.height) == (w, h)
    assert w > h                      # landscape bucket, jak dotychczas


def test_process_image_bucket_follows_crop_aspect(tmp_path):
    src = _make(tmp_path, 2000, 1000)          # 2:1
    _, (w, h) = image_utils.process_image(
        src, 1024, 64, False, crop=(0, 0, 500, 1000))   # kadr 1:2
    assert h > w                                 # bucket idzie za kadrem


def test_process_image_square_ignores_crop_aspect(tmp_path):
    src = _make(tmp_path, 2000, 1000)
    _, size = image_utils.process_image(
        src, 1024, 64, True, crop=(0, 0, 500, 1000))
    assert size == (1024, 1024)


def test_process_image_contain_pads_with_colour(tmp_path):
    src = _make(tmp_path, 2000, 1000, color=(255, 0, 0))
    img, (w, h) = image_utils.process_image(
        src, 1024, 64, True, fit="contain", pad_color="#00ff00")
    assert (img.width, img.height) == (1024, 1024)
    assert img.getpixel((w // 2, 2)) == (0, 255, 0)      # pas dopełnienia u góry
    assert img.getpixel((w // 2, h // 2)) == (255, 0, 0)  # obraz w środku


def test_process_image_centering_top_keeps_top_band(tmp_path):
    # górna połowa czerwona, dolna niebieska; kwadratowy kadr z centeringiem "top"
    p = tmp_path / "half.png"
    img = Image.new("RGB", (1000, 2000), (255, 0, 0))
    img.paste(Image.new("RGB", (1000, 1000), (0, 0, 255)), (0, 1000))
    img.save(p)
    out, _ = image_utils.process_image(
        str(p), 512, 64, True, centering=image_utils.centering_pair("center", "top"))
    assert out.getpixel((256, 256)) == (255, 0, 0)


def test_centering_pair_maps_names():
    assert image_utils.centering_pair("left", "top") == (0.0, 0.0)
    assert image_utils.centering_pair("right", "bottom") == (1.0, 1.0)
    assert image_utils.centering_pair("nonsense", "nonsense") == (0.5, 0.5)


def test_process_image_calls_upscale_hook(tmp_path):
    src = _make(tmp_path, 200, 100)
    seen = {}

    def hook(img, target):
        seen["target"] = target
        return img.resize((img.width * 2, img.height * 2))

    _, (w, h) = image_utils.process_image(src, 1024, 64, False, upscale=hook)
    assert seen["target"] == (w, h)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_image_utils_crop.py -v`
Expected: FAIL — `AttributeError: module 'backend.image_utils' has no attribute 'clamp_box'`

- [ ] **Step 3: Write minimal implementation**

W `backend/image_utils.py` dopisz przed `process_image` i podmień `process_image`:

```python
# Named centering positions used by the UI ("top" fixes the classic
# "centre crop cuts the head off" problem).
CENTERING = {
    "left": 0.0, "center": 0.5, "right": 1.0,
    "top": 0.0, "bottom": 1.0,
}


def centering_pair(x_name: str, y_name: str) -> tuple[float, float]:
    """Map the UI's centering names to Pillow's 0..1 centering tuple."""
    return (CENTERING.get(x_name, 0.5), CENTERING.get(y_name, 0.5))


def load_source(path: str) -> Image.Image:
    """Open an image, honour the EXIF orientation and convert it to RGB."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def clamp_box(box, w: int, h: int) -> tuple[int, int, int, int]:
    """Clamp an (x, y, w, h) crop to the image; degenerate boxes -> whole image."""
    x, y, bw, bh = (int(round(float(v))) for v in box)
    x = max(0, min(x, max(0, w - 1)))
    y = max(0, min(y, max(0, h - 1)))
    bw = max(0, min(bw, w - x))
    bh = max(0, min(bh, h - y))
    if bw < 8 or bh < 8:
        return 0, 0, w, h
    return x, y, bw, bh


def box_around(w: int, h: int, bbox, ar: float, margin: float = 0.6,
               headroom: float = 0.0, min_side: int = 0) -> tuple[int, int, int, int]:
    """Smallest ``ar``-shaped crop containing ``bbox`` grown by ``margin``.

    ``bbox`` is pixel [x1, y1, x2, y2]. ``headroom`` shifts the box up by that
    fraction of its height (leaves room above a face). ``min_side`` keeps the
    crop from going below the target resolution. The result is clamped to the
    image, so a huge margin simply yields the largest ``ar``-shaped box.
    """
    if ar <= 0:
        ar = (w / h) if h else 1.0
    x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    x1, x2 = min(x1, x2), max(x1, x2)
    y1, y2 = min(y1, y2), max(y1, y2)
    bw, bh = max(1.0, x2 - x1), max(1.0, y2 - y1)
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0

    gw, gh = bw * (1.0 + 2.0 * margin), bh * (1.0 + 2.0 * margin)
    if gw / gh < ar:
        gw = gh * ar
    else:
        gh = gw / ar
    if min_side:
        s = max(1.0, min_side / gw, min_side / gh)
        gw, gh = gw * s, gh * s
    # Clamp to the image while keeping the aspect ratio.
    s = min(1.0, w / gw, h / gh)
    gw, gh = gw * s, gh * s

    cy -= headroom * gh
    x = int(round(cx - gw / 2.0))
    y = int(round(cy - gh / 2.0))
    gw_i, gh_i = int(round(gw)), int(round(gh))
    x = max(0, min(x, w - gw_i))
    y = max(0, min(y, h - gh_i))
    return x, y, gw_i, gh_i


def _contain(img: Image.Image, bw: int, bh: int, pad_color: str) -> Image.Image:
    """Fit the whole image inside (bw, bh), padding the rest with ``pad_color``."""
    scale = min(bw / img.width, bh / img.height)
    nw, nh = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    fitted = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (bw, bh), pad_color)
    canvas.paste(fitted, ((bw - nw) // 2, (bh - nh) // 2))
    return canvas


def process_image(
    path: str,
    target: int,
    step: int,
    square: bool,
    *,
    crop=None,
    centering: tuple[float, float] = (0.5, 0.5),
    fit: str = "cover",
    pad_color: str = "#000000",
    upscale=None,
) -> tuple[Image.Image, tuple[int, int]]:
    """Load an image, apply the crop and resize it to its bucket.

    ``crop`` is an (x, y, w, h) box in source pixels *after* the EXIF fix; the
    bucket is then computed from the crop's aspect ratio, so a hand-drawn crop
    decides the output shape. ``upscale`` is an optional callable
    ``(image, (bw, bh)) -> image`` invoked before the final resize.
    """
    img = load_source(path)
    if crop:
        x, y, cw, ch = clamp_box(crop, img.width, img.height)
        img = img.crop((x, y, x + cw, y + ch))
    bw, bh = compute_bucket(img.width, img.height, target, step, square)
    if upscale is not None:
        img = upscale(img, (bw, bh))
    if fit == "contain":
        return _contain(img, bw, bh, pad_color), (bw, bh)
    fitted = ImageOps.fit(img, (bw, bh), method=Image.LANCZOS, centering=centering)
    return fitted, (bw, bh)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_image_utils_crop.py -v`
Expected: PASS (13 testów)

Run: `.venv/bin/python -m pytest -q`
Expected: cała dotychczasowa sucha przechodzi (regresja `process_image` byłaby tu widoczna).

- [ ] **Step 5: Commit**

```bash
git add backend/image_utils.py tests/test_image_utils_crop.py
git commit -m "feat: crop, centering and contain-fit support in image_utils"
```

---

### Task 2: Serwer — pola kadru w `ProcessRequest` + miniatury źródłowe

**Files:**
- Modify: `backend/server.py` (`ProcessRequest` ~142-156, `_run_job` ~273-284, `api_upload` ~501-513, nowe endpointy przy `/api/scan`)
- Test: `tests/test_server_crop.py` (nowy)

**Interfaces:**
- Consumes: `image_utils.clamp_box`, `image_utils.centering_pair`, `image_utils.process_image` (Task 1).
- Produces:
  - `ProcessRequest` z polami `crop_mode`, `fit`, `pad_color`, `centering_x`, `centering_y`, `crops`
  - `_safe_source_path(folder: str, name: str) -> Path`
  - `_crop_for(req: ProcessRequest, name: str) -> list[int] | None`
  - `GET /api/src/thumb?folder=&name=`, `GET /api/src/image?folder=&name=`
  - `POST /api/upload` zwraca dodatkowo `files: list[str]`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_server_crop.py`:

```python
import pytest
from fastapi import HTTPException
from PIL import Image

from backend import server


def _req(**kw):
    base = dict(folder="/tmp/x")
    base.update(kw)
    return server.ProcessRequest(**base)


def test_process_request_crop_defaults():
    r = _req()
    assert r.crop_mode == "center"
    assert r.fit == "cover"
    assert r.crops == {}
    assert (r.centering_x, r.centering_y) == ("center", "center")


def test_process_request_accepts_crops():
    r = _req(crop_mode="manual", crops={"a.jpg": [1, 2, 3, 4]})
    assert r.crops["a.jpg"] == [1, 2, 3, 4]


def test_crop_for_manual_returns_box():
    r = _req(crop_mode="manual", crops={"a.jpg": [1, 2, 30, 40]})
    assert server._crop_for(r, "a.jpg") == [1, 2, 30, 40]


def test_crop_for_manual_missing_entry_is_none():
    r = _req(crop_mode="manual", crops={})
    assert server._crop_for(r, "a.jpg") is None


def test_crop_for_center_mode_ignores_plan():
    r = _req(crop_mode="center", crops={"a.jpg": [1, 2, 30, 40]})
    assert server._crop_for(r, "a.jpg") is None


def test_safe_source_path_rejects_traversal(tmp_path):
    (tmp_path / "ok.png").write_bytes(b"x")
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "../secret.png")
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "sub/ok.png")


def test_safe_source_path_rejects_missing_file(tmp_path):
    with pytest.raises(HTTPException):
        server._safe_source_path(str(tmp_path), "nope.png")


def test_safe_source_path_accepts_real_file(tmp_path):
    Image.new("RGB", (10, 10)).save(tmp_path / "ok.png")
    assert server._safe_source_path(str(tmp_path), "ok.png").name == "ok.png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_server_crop.py -v`
Expected: FAIL — `ProcessRequest` nie ma pola `crop_mode`, brak `server._crop_for`

- [ ] **Step 3: Write minimal implementation**

W `ProcessRequest` (po `caption_format`) dopisz:

```python
    # Cropping
    crop_mode: str = "center"        # "center" | "auto" | "manual"
    fit: str = "cover"               # "cover" (crop) | "contain" (pad)
    pad_color: str = "#000000"
    centering_x: str = "center"      # left | center | right
    centering_y: str = "center"      # top | center | bottom
    crops: dict[str, list[int]] = {} # source file name -> [x, y, w, h]
```

W sekcji Helpers dopisz:

```python
def _safe_source_path(folder: str, name: str) -> Path:
    """Resolve ``name`` inside ``folder``, rejecting traversal and missing files."""
    if not name or name != Path(name).name:
        raise HTTPException(400, "Invalid file name.")
    base = Path(folder).expanduser().resolve()
    target = (base / name).resolve()
    if base not in target.parents or not target.is_file():
        raise HTTPException(404, "No such source image.")
    return target


def _crop_for(req: "ProcessRequest", name: str) -> list[int] | None:
    """Crop box for a source file, or None when the mode has no per-file box."""
    if req.crop_mode == "manual":
        box = req.crops.get(name)
        return list(box) if box and len(box) == 4 else None
    return None


SRC_THUMBS = WORK / "srcthumbs"


def _src_thumb_path(folder: str, name: str) -> Path:
    key = hashlib.sha1(str(Path(folder).expanduser().resolve()).encode()).hexdigest()[:16]
    return SRC_THUMBS / key / (name + ".jpg")
```

Dopisz `import hashlib` do bloku importów.

W `_run_job()` podmień wywołanie `process_image` na:

```python
                img, (w, h) = image_utils.process_image(
                    str(src), req.resolution, req.step, req.square,
                    crop=_crop_for(req, src.name),
                    centering=image_utils.centering_pair(req.centering_x, req.centering_y),
                    fit=req.fit,
                    pad_color=req.pad_color,
                )
```

Dopisz endpointy (obok `/api/scan`):

```python
@app.get("/api/src/thumb")
def api_src_thumb(folder: str, name: str):
    """Cached JPEG thumbnail of a source image (for the crop grid)."""
    src = _safe_source_path(folder, name)
    cache = _src_thumb_path(folder, name)
    if not cache.exists() or cache.stat().st_mtime < src.stat().st_mtime:
        cache.parent.mkdir(parents=True, exist_ok=True)
        img = image_utils.load_source(str(src))
        thumb = image_utils.make_thumbnail(img, 480)
        thumb.save(str(cache), format="JPEG", quality=80)
    return FileResponse(str(cache), media_type="image/jpeg")


@app.get("/api/src/image")
def api_src_image(folder: str, name: str):
    """Down-scaled source image for the crop editor, with the true source size."""
    src = _safe_source_path(folder, name)
    img = image_utils.load_source(str(src))
    full_w, full_h = img.width, img.height
    preview = image_utils.make_thumbnail(img, 1600)
    buf = io.BytesIO()
    preview.save(buf, format="JPEG", quality=88)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers={"X-Src-Width": str(full_w), "X-Src-Height": str(full_h)},
    )
```

W `api_upload` zwróć też nazwy plików:

```python
    saved_names: list[str] = []
    for f in files:
        if Path(f.filename).suffix.lower() not in image_utils.SUPPORTED_EXT:
            continue
        target = dest / Path(f.filename).name
        with open(target, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved_names.append(target.name)
    return {"folder": str(dest), "count": len(saved_names), "files": sorted(saved_names)}
```

(usuń dotychczasowy licznik `saved`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_server_crop.py -q && .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/server.py tests/test_server_crop.py
git commit -m "feat: crop fields in ProcessRequest and source thumbnail endpoints"
```

---

### Task 3: `crop_auto.py` — auto-kadr z Florence-2 + job wsadowy

**Files:**
- Create: `backend/crop_auto.py`
- Modify: `backend/server.py` (import, endpointy `/api/crop/auto`)
- Test: `tests/test_crop_auto.py` (nowy)

**Interfaces:**
- Consumes: `image_utils.box_around`, `image_utils.compute_bucket`, `florence._run_task`, `florence.unload`.
- Produces:
  - `FACE_MODES: set[str]`, `NO_AUTO_MODES: set[str]`
  - `largest_box(boxes: list[list[float]]) -> list[float] | None`
  - `suggest_crop(image, mode, target, step, square, detect=None) -> list[int] | None`
  - `detect_boxes(image, mode) -> list[list[float]]`
  - `POST /api/crop/auto` → `{"job_id": str, "total": int}`, `GET /api/crop/auto/{job_id}`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_crop_auto.py`:

```python
from PIL import Image

from backend import crop_auto


def _img(w=2000, h=1000):
    return Image.new("RGB", (w, h), (0, 0, 0))


def test_largest_box_picks_biggest_area():
    boxes = [[0, 0, 10, 10], [100, 100, 400, 500], [0, 0, 50, 50]]
    assert crop_auto.largest_box(boxes) == [100, 100, 400, 500]


def test_largest_box_empty_is_none():
    assert crop_auto.largest_box([]) is None


def test_suggest_crop_uses_detection(monkeypatch):
    img = _img()
    box = crop_auto.suggest_crop(
        img, "person", 1024, 64, True, detect=lambda *_: [[900, 300, 1100, 700]])
    x, y, w, h = box
    assert abs(w - h) <= 1                      # square mode -> 1:1 crop
    assert x <= 900 and x + w >= 1100           # zawiera detekcję


def test_suggest_crop_face_mode_leaves_headroom():
    img = _img(1000, 2000)
    det = lambda *_: [[400, 800, 600, 1000]]
    face = crop_auto.suggest_crop(img, "person", 1024, 64, True, detect=det)
    generic = crop_auto.suggest_crop(img, "generic", 1024, 64, True, detect=det)
    assert face[1] < generic[1]                 # kadr twarzy przesunięty w górę


def test_suggest_crop_bucket_mode_keeps_source_aspect():
    img = _img(2000, 1000)
    x, y, w, h = crop_auto.suggest_crop(
        img, "generic", 1024, 64, False, detect=lambda *_: [[800, 300, 1200, 700]])
    assert abs((w / h) - 2.0) < 0.05            # proporcja oryginału zachowana


def test_suggest_crop_no_detection_returns_none():
    assert crop_auto.suggest_crop(
        _img(), "generic", 1024, 64, True, detect=lambda *_: []) is None


def test_suggest_crop_skips_landscape_and_architecture():
    called = []

    def det(*_):
        called.append(1)
        return [[0, 0, 100, 100]]

    assert crop_auto.suggest_crop(_img(), "landscape", 1024, 64, True, detect=det) is None
    assert crop_auto.suggest_crop(_img(), "architecture", 1024, 64, True, detect=det) is None
    assert called == []                          # detektor nawet nie ruszył


def test_suggest_crop_never_smaller_than_target():
    img = _img(3000, 3000)
    _, _, w, h = crop_auto.suggest_crop(
        img, "generic", 1024, 64, True, detect=lambda *_: [[1490, 1490, 1510, 1510]])
    assert w >= 1024 and h >= 1024
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_crop_auto.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.crop_auto'`

- [ ] **Step 3: Write minimal implementation**

Utwórz `backend/crop_auto.py`:

```python
"""Automatic crop suggestions driven by Florence-2 detections.

The pure part (picking the subject box, turning it into a crop) is model-free
and unit-tested; ``detect_boxes`` is the only function that touches the model.
"""
from __future__ import annotations

from . import florence, image_utils

# Modes where the subject is a person -> ground on the face, keep headroom.
FACE_MODES = {"person", "person_detail"}
# Modes with no meaningful "subject" -> auto crop falls back to centring.
NO_AUTO_MODES = {"landscape", "architecture"}

FACE_HEADROOM = 0.12
MARGIN_FACE = 1.2      # a face box needs a lot of room to become a portrait crop
MARGIN_OBJECT = 0.5


def largest_box(boxes) -> list[float] | None:
    """Biggest detection by area, or None for an empty list."""
    if not boxes:
        return None
    return max(boxes, key=lambda b: abs(b[2] - b[0]) * abs(b[3] - b[1]))


def _boxes_from_task(result) -> list[list[float]]:
    """Pull pixel [x1,y1,x2,y2] boxes out of a Florence task result."""
    if isinstance(result, dict):
        return [list(b) for b in result.get("bboxes", []) if len(b) >= 4]
    return []


def detect_boxes(image, mode: str) -> list[list[float]]:
    """Run Florence-2 and return candidate subject boxes for ``mode``."""
    if mode in FACE_MODES:
        for phrase in ("face", "person"):
            boxes = _boxes_from_task(
                florence._run_task_grounding(image, phrase))
            if boxes:
                return boxes
        return []
    return _boxes_from_task(florence._run_task(image, "<OD>"))


def suggest_crop(image, mode: str, target: int, step: int, square: bool,
                 detect=None) -> list[int] | None:
    """Suggested crop [x, y, w, h] for one image, or None to keep centring.

    ``step`` is accepted (and ignored) so callers can pass the same bucket
    parameters they hand to ``image_utils.process_image``.
    """
    if mode in NO_AUTO_MODES:
        return None
    detect = detect or detect_boxes
    box = largest_box(detect(image, mode))
    if box is None:
        return None
    ar = 1.0 if square else (image.width / image.height)
    margin = MARGIN_FACE if mode in FACE_MODES else MARGIN_OBJECT
    headroom = FACE_HEADROOM if mode in FACE_MODES else 0.0
    x, y, w, h = image_utils.box_around(
        image.width, image.height, box, ar,
        margin=margin, headroom=headroom, min_side=target)
    return [x, y, w, h]
```

W `backend/florence.py` dopisz (obok `_run_task`) pomocnicze zadanie groundingu:

```python
def _run_task_grounding(image, phrase: str) -> dict | str:
    """<CAPTION_TO_PHRASE_GROUNDING> for a single phrase (used by auto-crop)."""
    rt = _get_runtime()
    task = "<CAPTION_TO_PHRASE_GROUNDING>"
    inputs = rt["processor"](text=task + phrase, images=image, return_tensors="pt")
    moved = {}
    for k, v in inputs.items():
        if hasattr(v, "to"):
            v = v.to(rt["device"])
            if k == "pixel_values":
                v = v.to(rt["model"].dtype)
        moved[k] = v
    with rt["torch"].inference_mode():
        ids = rt["model"].generate(
            input_ids=moved["input_ids"], pixel_values=moved["pixel_values"],
            max_new_tokens=512, num_beams=3)
    raw = rt["processor"].batch_decode(ids, skip_special_tokens=False)[0]
    parsed = rt["processor"].post_process_generation(
        raw, task=task, image_size=(image.width, image.height))
    return parsed.get(task, {}) if isinstance(parsed, dict) else {}
```

W `backend/server.py` dodaj `crop_auto` do importu z `.` i dopisz endpointy oraz worker:

```python
class CropAutoRequest(BaseModel):
    folder: str
    mode: str = "person"
    resolution: int = 1024
    step: int = 64
    square: bool = False
    names: list[str] = []       # empty = all images in the folder


def _run_crop_auto(job_id: str, req: CropAutoRequest, files: list[Path]) -> None:
    job = JOBS[job_id]
    try:
        job["state"] = "processing"
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                box = crop_auto.suggest_crop(
                    img, req.mode, req.resolution, req.step, req.square)
                if box:
                    job["crops"][src.name] = box
            except Exception as e:  # noqa: BLE001 - one bad file must not kill the job
                job["skipped"].append(f"{src.name}: {e}")
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/crop/auto")
def api_crop_auto(req: CropAutoRequest):
    files = _list_images(req.folder)
    if req.names:
        wanted = set(req.names)
        files = [f for f in files if f.name in wanted]
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "state": "pending", "total": len(files),
            "processed": 0, "current": "", "error": "",
            "crops": {}, "skipped": [],
        }
    threading.Thread(target=_run_crop_auto, args=(job_id, req, files),
                     daemon=True).start()
    return {"job_id": job_id, "total": len(files)}


@app.get("/api/crop/auto/{job_id}")
def api_crop_auto_job(job_id: str):
    job = JOBS.get(job_id)
    if not job or "crops" not in job:
        raise HTTPException(404, "Unknown job.")
    return {
        "state": job["state"], "total": job["total"],
        "processed": job["processed"], "current": job["current"],
        "error": job["error"], "crops": job["crops"], "skipped": job["skipped"],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_crop_auto.py -v && .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/crop_auto.py backend/florence.py backend/server.py tests/test_crop_auto.py
git commit -m "feat: Florence-2 driven automatic crop suggestions"
```

---

### Task 4: Front — siatka miniatur źródłowych i ustawienia kadru

**Files:**
- Modify: `frontend/index.html` (krok 1 po `#srcInfo`, krok 2 grid)
- Create: `frontend/crop_editor.js`, `frontend/crop_editor.css`
- Modify: `frontend/app.js` (scan/upload wołają `CropPlan.setSource`, `processBtn` wysyła pola kadru)
- Modify: `frontend/index.html` (`<script src="/crop_editor.js">` **po** `app.js`, `<link ... crop_editor.css>`)

**Interfaces:**
- Consumes: `GET /api/src/thumb`, `POST /api/crop/auto`, `GET /api/crop/auto/{id}` (Task 2, 3).
- Produces: globalny obiekt `window.CropPlan` z API:
  - `CropPlan.setSource(folder, files)` — przerysowuje siatkę, wczytuje plan z `localStorage`
  - `CropPlan.get(name) -> [x,y,w,h] | null`
  - `CropPlan.set(name, box)` / `CropPlan.clear()`
  - `CropPlan.all() -> {name: [x,y,w,h]}`
  - `CropPlan.settings() -> {crop_mode, fit, pad_color, centering_x, centering_y}`

- [ ] **Step 1: HTML — siatka i pola ustawień**

W `index.html` w `<head>` dopisz `<link rel="stylesheet" href="/crop_editor.css" />`,
a **po** linii `<script src="/app.js"></script>` (obecnie 618) dopisz
`<script src="/crop_editor.js"></script>`. Kolejność jest istotna: `crop_editor.js`
korzysta z `api()` zdefiniowanego w `app.js`.

Po `<p id="srcInfo" class="info"></p>` w kroku 1 wstaw:

```html
      <div id="cropBar" class="row hidden">
        <button type="button" id="autoCropBtn" class="mini">✂ Auto-crop all</button>
        <button type="button" id="clearCropsBtn" class="mini">Clear crops</button>
        <span id="cropInfo" class="info"></span>
      </div>
      <div id="srcGrid" class="srcgrid"></div>
```

W kroku 2, w `<div class="grid">`, po polu „Cropping" dopisz:

```html
        <div class="field">
          <label>Crop source</label>
          <select id="cropMode">
            <option value="center" selected>Centre (whole frame)</option>
            <option value="auto">Auto (Florence-2 subject)</option>
            <option value="manual">Manual (per-image crops)</option>
          </select>
        </div>

        <div class="field">
          <label>Fit</label>
          <select id="fitMode">
            <option value="cover" selected>Cover (crop to fill)</option>
            <option value="contain">Contain (pad with colour)</option>
          </select>
        </div>

        <div class="field">
          <label>Pad colour</label>
          <input type="color" id="padColor" value="#000000" />
        </div>

        <div class="field">
          <label>Centering (horizontal / vertical)</label>
          <div class="row">
            <select id="centeringX">
              <option value="left">Left</option>
              <option value="center" selected>Centre</option>
              <option value="right">Right</option>
            </select>
            <select id="centeringY">
              <option value="top">Top</option>
              <option value="center" selected>Centre</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
        </div>
```

- [ ] **Step 2: `crop_editor.css`**

```css
/* Source image grid + crop badges (step 1) */
.srcgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.srcgrid .cell {
  position: relative;
  border: 1px solid #2c3444;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  background: #11151d;
}
.srcgrid .cell img { display: block; width: 100%; height: 120px; object-fit: cover; }
.srcgrid .cell .name {
  font-size: 11px; padding: 3px 5px; color: #9aa4b5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.srcgrid .cell.cropped { border-color: #4c8bf5; }
.srcgrid .cell .badge {
  position: absolute; top: 4px; right: 4px;
  background: #4c8bf5; color: #fff; border-radius: 4px;
  font-size: 11px; padding: 1px 4px;
}
```

- [ ] **Step 3: `crop_editor.js` — plan kadrów i siatka**

```javascript
"use strict";

// Crop plan: {fileName: [x, y, w, h]} in ORIGINAL pixels (after the EXIF fix).
// Lives in the browser only and travels with POST /api/process.
window.CropPlan = (function () {
  const $ = (id) => document.getElementById(id);
  let folder = null;
  let files = [];
  let plan = {};

  const storageKey = () => "cropPlan:" + (folder || "");

  function load() {
    plan = {};
    try {
      plan = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    } catch (e) {
      plan = {};
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(plan));
    } catch (e) {
      console.warn("Crop plan not saved:", e);
    }
  }

  function info() {
    const n = Object.keys(plan).length;
    $("cropInfo").textContent = n ? `${n} of ${files.length} images have a crop.` : "";
  }

  function render() {
    const grid = $("srcGrid");
    grid.innerHTML = "";
    $("cropBar").classList.toggle("hidden", files.length === 0);
    for (const name of files) {
      const cell = document.createElement("div");
      cell.className = "cell" + (plan[name] ? " cropped" : "");
      cell.innerHTML =
        `<img loading="lazy" src="/api/src/thumb?folder=${encodeURIComponent(folder)}` +
        `&name=${encodeURIComponent(name)}" />` +
        (plan[name] ? `<span class="badge">✂</span>` : "") +
        `<div class="name">${name}</div>`;
      cell.addEventListener("click", () => window.CropEditor.open(folder, name));
      grid.appendChild(cell);
    }
    info();
  }

  return {
    setSource(f, list) {
      folder = f;
      files = list || [];
      load();
      render();
    },
    files: () => files.slice(),
    folder: () => folder,
    get: (name) => plan[name] || null,
    set(name, box) { plan[name] = box; save(); render(); },
    remove(name) { delete plan[name]; save(); render(); },
    merge(boxes) { Object.assign(plan, boxes); save(); render(); },
    clear() { plan = {}; save(); render(); },
    all: () => Object.assign({}, plan),
    settings: () => ({
      crop_mode: $("cropMode").value,
      fit: $("fitMode").value,
      pad_color: $("padColor").value,
      centering_x: $("centeringX").value,
      centering_y: $("centeringY").value,
    }),
  };
})();

// ---- Batch auto-crop -------------------------------------------------------
document.getElementById("autoCropBtn").addEventListener("click", async () => {
  const btn = document.getElementById("autoCropBtn");
  const info = document.getElementById("cropInfo");
  btn.disabled = true;
  info.textContent = "Auto-cropping…";
  try {
    const { job_id, total } = await api("/api/crop/auto", {
      folder: CropPlan.folder(),
      mode: document.getElementById("mode").value,
      resolution: parseInt(document.getElementById("resolution").value, 10),
      step: parseInt(document.getElementById("step").value, 10),
      square: document.getElementById("square").value === "true",
    });
    await pollAutoCrop(job_id, total);
    document.getElementById("cropMode").value = "manual";
  } catch (e) {
    info.textContent = "Auto-crop error: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

function pollAutoCrop(jobId, total) {
  const info = document.getElementById("cropInfo");
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const j = await api("/api/crop/auto/" + jobId);
        info.textContent = `Auto-crop: ${j.processed}/${total} — ${j.current || ""}`;
        if (j.state === "done") { CropPlan.merge(j.crops); resolve(); return; }
        if (j.state === "error") { reject(new Error(j.error)); return; }
        setTimeout(tick, 800);
      } catch (e) { reject(e); }
    };
    tick();
  });
}

document.getElementById("clearCropsBtn").addEventListener("click", () => {
  CropPlan.clear();
});
```

- [ ] **Step 4: `app.js` — podłączenie**

W `$("scanBtn")` po `state.count = r.count;` dopisz `CropPlan.setSource(r.folder, r.files);`
W `uploadFiles()` po `state.count = r.count;` dopisz `CropPlan.setSource(r.folder, r.files || []);`
W obiekcie `req` w `$("processBtn")` dopisz na końcu:

```javascript
    ...CropPlan.settings(),
    crops: CropPlan.all(),
```

- [ ] **Step 5: Manual verification**

```bash
./run.sh
```
1. Otwórz http://127.0.0.1:8123, wskaż folder ze zdjęciami, kliknij **Scan** →
   pod polem pojawia się siatka miniatur, a nad nią pasek z przyciskami.
2. Kliknij **✂ Auto-crop all** → licznik postępu rośnie, po zakończeniu część
   kafelków dostaje niebieską ramkę i ✂, a `Crop source` przeskakuje na `Manual`.
3. Odśwież stronę i ponownie zeskanuj ten sam folder → znaczniki ✂ wracają
   (plan wczytany z `localStorage`).
4. Uruchom przetwarzanie i sprawdź w kroku 4, że kadry są zastosowane.
5. **Clear crops** czyści znaczniki.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/crop_editor.js frontend/crop_editor.css
git commit -m "feat: source image grid, crop settings and batch auto-crop in the UI"
```

---

### Task 5: Front — modal edytora kadru

**Files:**
- Modify: `frontend/index.html` (markup modala przed `</main>`)
- Modify: `frontend/crop_editor.js` (obiekt `window.CropEditor`)
- Modify: `frontend/crop_editor.css` (style modala)

**Interfaces:**
- Consumes: `GET /api/src/image` (nagłówki `X-Src-Width`/`X-Src-Height`), `CropPlan` (Task 4).
- Produces: `window.CropEditor.open(folder, name)`.

- [ ] **Step 1: HTML modala**

Przed `</main>` w `index.html`:

```html
    <div id="cropModal" class="cropmodal hidden">
      <div class="cropbox">
        <div class="crophead">
          <strong id="cropTitle">crop</strong>
          <select id="cropRatio">
            <option value="free" selected>Free</option>
            <option value="1">1:1</option>
            <option value="0.75">3:4</option>
            <option value="1.3333">4:3</option>
            <option value="1.7778">16:9</option>
          </select>
          <span id="cropSize" class="info"></span>
          <span class="spacer"></span>
          <button type="button" id="cropAutoBtn" class="mini">Auto (Florence)</button>
          <button type="button" id="cropResetBtn" class="mini">Reset</button>
          <button type="button" id="cropApplyAllBtn" class="mini">Apply to same ratio</button>
          <button type="button" id="cropSaveBtn" class="primary">Save</button>
          <button type="button" id="cropCancelBtn" class="mini">Cancel</button>
        </div>
        <div class="cropstage" id="cropStage">
          <img id="cropImg" alt="" />
          <div id="cropRect" class="croprect">
            <i data-h="nw"></i><i data-h="n"></i><i data-h="ne"></i>
            <i data-h="w"></i><i data-h="e"></i>
            <i data-h="sw"></i><i data-h="s"></i><i data-h="se"></i>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: CSS modala** (dopisz do `crop_editor.css`)

```css
.cropmodal {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(4, 7, 12, .82);
  display: flex; align-items: center; justify-content: center;
}
.cropmodal.hidden { display: none; }
.cropbox {
  background: #141a24; border: 1px solid #2c3444; border-radius: 10px;
  padding: 12px; max-width: 94vw; max-height: 94vh; display: flex; flex-direction: column; gap: 10px;
}
.crophead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.crophead .spacer { flex: 1; }
.cropstage { position: relative; line-height: 0; overflow: hidden; }
.cropstage img { max-width: 88vw; max-height: 76vh; user-select: none; -webkit-user-drag: none; }
.croprect {
  position: absolute; border: 2px solid #4c8bf5; cursor: move;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, .45);
}
.croprect i {
  position: absolute; width: 12px; height: 12px; background: #4c8bf5; border-radius: 2px;
}
.croprect i[data-h="nw"] { left: -7px; top: -7px; cursor: nwse-resize; }
.croprect i[data-h="n"]  { left: calc(50% - 6px); top: -7px; cursor: ns-resize; }
.croprect i[data-h="ne"] { right: -7px; top: -7px; cursor: nesw-resize; }
.croprect i[data-h="w"]  { left: -7px; top: calc(50% - 6px); cursor: ew-resize; }
.croprect i[data-h="e"]  { right: -7px; top: calc(50% - 6px); cursor: ew-resize; }
.croprect i[data-h="sw"] { left: -7px; bottom: -7px; cursor: nesw-resize; }
.croprect i[data-h="s"]  { left: calc(50% - 6px); bottom: -7px; cursor: ns-resize; }
.croprect i[data-h="se"] { right: -7px; bottom: -7px; cursor: nwse-resize; }
```

- [ ] **Step 3: `CropEditor` w `crop_editor.js`**

```javascript
// ---- Crop editor modal -----------------------------------------------------
window.CropEditor = (function () {
  const $ = (id) => document.getElementById(id);
  let cur = { folder: null, name: null, srcW: 0, srcH: 0, viewW: 0, viewH: 0 };
  let box = { x: 0, y: 0, w: 0, h: 0 };   // in SOURCE pixels
  let drag = null;

  const scale = () => cur.viewW / cur.srcW;          // source px -> screen px
  const forcedRatio = () =>
    $("square").value === "true" ? 1 : ($("cropRatio").value === "free"
      ? null : parseFloat($("cropRatio").value));

  function clampBox() {
    box.w = Math.max(16, Math.min(box.w, cur.srcW));
    box.h = Math.max(16, Math.min(box.h, cur.srcH));
    box.x = Math.max(0, Math.min(box.x, cur.srcW - box.w));
    box.y = Math.max(0, Math.min(box.y, cur.srcH - box.h));
  }

  function applyRatio(anchorRight, anchorBottom) {
    const r = forcedRatio();
    if (!r) return;
    if (box.w / box.h > r) {
      const w = box.h * r;
      if (anchorRight) box.x += box.w - w;
      box.w = w;
    } else {
      const h = box.w / r;
      if (anchorBottom) box.y += box.h - h;
      box.h = h;
    }
  }

  function draw() {
    clampBox();
    const s = scale();
    const rect = $("cropRect");
    rect.style.left = box.x * s + "px";
    rect.style.top = box.y * s + "px";
    rect.style.width = box.w * s + "px";
    rect.style.height = box.h * s + "px";
    $("cropSize").textContent =
      `crop ${Math.round(box.w)} × ${Math.round(box.h)} px`;
  }

  function defaultBox() {
    const r = forcedRatio() || cur.srcW / cur.srcH;
    let w = cur.srcW, h = w / r;
    if (h > cur.srcH) { h = cur.srcH; w = h * r; }
    box = { x: (cur.srcW - w) / 2, y: (cur.srcH - h) / 2, w, h };
  }

  // Pointer handling: dragging the rect moves it, dragging a handle resizes it.
  function onDown(e) {
    const handle = e.target.dataset ? e.target.dataset.h : null;
    drag = { handle: handle || null, x: e.clientX, y: e.clientY, start: Object.assign({}, box) };
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onMove(e) {
    if (!drag) return;
    const s = scale();
    const dx = (e.clientX - drag.x) / s;
    const dy = (e.clientY - drag.y) / s;
    const b = drag.start;
    if (!drag.handle) {
      box = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
    } else {
      box = Object.assign({}, b);
      if (drag.handle.includes("w")) { box.x = b.x + dx; box.w = b.w - dx; }
      if (drag.handle.includes("e")) { box.w = b.w + dx; }
      if (drag.handle.includes("n")) { box.y = b.y + dy; box.h = b.h - dy; }
      if (drag.handle.includes("s")) { box.h = b.h + dy; }
      applyRatio(drag.handle.includes("w"), drag.handle.includes("n"));
    }
    draw();
  }

  function onUp() {
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  function onKey(e) {
    if ($("cropModal").classList.contains("hidden")) return;
    const stepPx = e.shiftKey ? 10 : 1;
    const map = { ArrowLeft: [-stepPx, 0], ArrowRight: [stepPx, 0], ArrowUp: [0, -stepPx], ArrowDown: [0, stepPx] };
    if (map[e.key]) {
      box.x += map[e.key][0];
      box.y += map[e.key][1];
      draw();
      e.preventDefault();
    }
    if (e.key === "Escape") close();
  }

  function close() { $("cropModal").classList.add("hidden"); }

  async function open(folder, name) {
    cur.folder = folder;
    cur.name = name;
    $("cropTitle").textContent = name;
    const url = `/api/src/image?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) { alert("Cannot load the image."); return; }
    cur.srcW = parseInt(res.headers.get("X-Src-Width"), 10);
    cur.srcH = parseInt(res.headers.get("X-Src-Height"), 10);
    const blob = await res.blob();
    const img = $("cropImg");
    await new Promise((resolve) => {
      img.onload = resolve;
      img.src = URL.createObjectURL(blob);
    });
    cur.viewW = img.clientWidth;
    cur.viewH = img.clientHeight;
    const saved = CropPlan.get(name);
    if (saved) { box = { x: saved[0], y: saved[1], w: saved[2], h: saved[3] }; }
    else { defaultBox(); }
    $("cropModal").classList.remove("hidden");
    draw();
  }

  $("cropRect").addEventListener("pointerdown", onDown);
  window.addEventListener("keydown", onKey);
  $("cropRatio").addEventListener("change", () => { applyRatio(false, false); draw(); });
  $("cropResetBtn").addEventListener("click", () => { defaultBox(); draw(); });
  $("cropCancelBtn").addEventListener("click", close);

  $("cropSaveBtn").addEventListener("click", () => {
    CropPlan.set(cur.name, [Math.round(box.x), Math.round(box.y),
                            Math.round(box.w), Math.round(box.h)]);
    document.getElementById("cropMode").value = "manual";
    close();
  });

  $("cropApplyAllBtn").addEventListener("click", () => {
    // Same crop (as fractions) for every image with the same source aspect ratio.
    const fx = box.x / cur.srcW, fy = box.y / cur.srcH;
    const fw = box.w / cur.srcW, fh = box.h / cur.srcH;
    const ar = cur.srcW / cur.srcH;
    const jobs = CropPlan.files().map(async (name) => {
      const url = `/api/src/image?folder=${encodeURIComponent(CropPlan.folder())}&name=${encodeURIComponent(name)}`;
      const res = await fetch(url, { method: "HEAD" }).catch(() => null);
      const head = res && res.ok ? res : await fetch(url);
      const w = parseInt(head.headers.get("X-Src-Width"), 10);
      const h = parseInt(head.headers.get("X-Src-Height"), 10);
      if (!w || !h || Math.abs(w / h - ar) > 0.02) return;
      CropPlan.set(name, [Math.round(fx * w), Math.round(fy * h),
                          Math.round(fw * w), Math.round(fh * h)]);
    });
    Promise.all(jobs).then(() => { document.getElementById("cropMode").value = "manual"; close(); });
  });

  $("cropAutoBtn").addEventListener("click", async () => {
    const btn = $("cropAutoBtn");
    btn.disabled = true;
    try {
      const { job_id, total } = await api("/api/crop/auto", {
        folder: CropPlan.folder(),
        mode: document.getElementById("mode").value,
        resolution: parseInt(document.getElementById("resolution").value, 10),
        step: parseInt(document.getElementById("step").value, 10),
        square: document.getElementById("square").value === "true",
        names: [cur.name],
      });
      await pollAutoCrop(job_id, total);
      const b = CropPlan.get(cur.name);
      if (b) { box = { x: b[0], y: b[1], w: b[2], h: b[3] }; draw(); }
    } catch (e) {
      alert("Auto-crop error: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  return { open };
})();
```

- [ ] **Step 4: Manual verification**

```bash
./run.sh
```
1. Zeskanuj folder, kliknij dowolną miniaturę → otwiera się modal z ramką.
2. Przeciągnij wnętrze ramki i uchwyty — ramka nie wychodzi poza obraz.
3. Ustaw `Cropping = Square` w kroku 2, otwórz modal ponownie → ramka jest
   wymuszona na 1:1 i taka zostaje przy zmianie rozmiaru.
4. Strzałki przesuwają o 1 px, Shift+strzałki o 10 px, Esc zamyka.
5. **Auto (Florence)** ustawia ramkę na temacie zdjęcia.
6. **Save** → kafelek dostaje ✂; ponowne otwarcie pokazuje zapisany kadr.
7. **Apply to same ratio** przenosi kadr na zdjęcia o tej samej proporcji.
8. Przetwórz dataset i sprawdź w kroku 4, że wynik odpowiada narysowanym kadrom.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/crop_editor.js frontend/crop_editor.css
git commit -m "feat: interactive per-image crop editor"
```

---

### Task 6: `upscaler.py` — rejestr modeli i czysta logika (bez GPU)

**Files:**
- Create: `backend/upscaler.py`
- Modify: `requirements.txt`
- Test: `tests/test_upscaler.py` (nowy)

**Interfaces:**
- Consumes: nic z wcześniejszych tasków.
- Produces:
  - `BUILTIN_MODELS: list[dict]` (klucze: `id`, `label`, `repo_id`, `filename`, `scale`, `note`)
  - `plan_passes(src_size, target_size, scale, min_ratio=1.05) -> int`
  - `scan_folder(folder: str) -> list[dict]`
  - `load_config(path: Path) -> dict` / `save_config(path: Path, cfg: dict) -> None`
  - `registry(cfg: dict) -> list[dict]`
  - `resolve(model_id: str, cfg: dict) -> dict | None`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_upscaler.py`:

```python
import json

from backend import upscaler


def test_builtin_models_shape():
    assert upscaler.BUILTIN_MODELS
    for m in upscaler.BUILTIN_MODELS:
        assert set(["id", "label", "repo_id", "filename", "scale"]) <= set(m)
        assert m["scale"] in (2, 4)


def test_plan_passes_zero_when_target_is_smaller():
    assert upscaler.plan_passes((2000, 1000), (1024, 512), 4) == 0


def test_plan_passes_zero_below_min_ratio():
    assert upscaler.plan_passes((1000, 1000), (1024, 1024), 4, min_ratio=1.05) == 0


def test_plan_passes_one_for_moderate_gap():
    assert upscaler.plan_passes((512, 512), (1024, 1024), 4) == 1
    assert upscaler.plan_passes((512, 512), (1024, 1024), 2) == 1


def test_plan_passes_two_when_one_is_not_enough():
    assert upscaler.plan_passes((256, 256), (1024, 1024), 2) == 2


def test_plan_passes_capped_at_two():
    assert upscaler.plan_passes((64, 64), (2048, 2048), 2) == 2


def test_scan_folder_lists_weight_files(tmp_path):
    (tmp_path / "4x-Foo.pth").write_bytes(b"x")
    (tmp_path / "2x-Bar.safetensors").write_bytes(b"x")
    (tmp_path / "readme.txt").write_text("nope")
    found = upscaler.scan_folder(str(tmp_path))
    names = sorted(m["filename"] for m in found)
    assert names == ["2x-Bar.safetensors", "4x-Foo.pth"]
    assert all(m["id"].startswith("local:") for m in found)


def test_scan_folder_missing_folder_is_empty():
    assert upscaler.scan_folder("/definitely/not/here") == []


def test_config_roundtrip(tmp_path):
    p = tmp_path / "upscaler.json"
    upscaler.save_config(p, {"folder": "/models", "custom": []})
    assert upscaler.load_config(p)["folder"] == "/models"
    assert upscaler.load_config(tmp_path / "missing.json") == {"folder": "", "custom": []}


def test_registry_merges_builtin_custom_and_local(tmp_path):
    (tmp_path / "4x-Local.pth").write_bytes(b"x")
    cfg = {"folder": str(tmp_path),
           "custom": [{"repo_id": "me/up", "filename": "my.pth", "scale": 4}]}
    reg = upscaler.registry(cfg)
    ids = [m["id"] for m in reg]
    assert any(m["id"] == upscaler.BUILTIN_MODELS[0]["id"] for m in reg)
    assert "hf:me/up/my.pth" in ids
    assert any(i.startswith("local:") for i in ids)
    assert all("cached" in m for m in reg)


def test_resolve_finds_model(tmp_path):
    cfg = {"folder": "", "custom": []}
    m = upscaler.resolve(upscaler.BUILTIN_MODELS[0]["id"], cfg)
    assert m and m["filename"] == upscaler.BUILTIN_MODELS[0]["filename"]
    assert upscaler.resolve("nope", cfg) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_upscaler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.upscaler'`

- [ ] **Step 3: Write minimal implementation**

Utwórz `backend/upscaler.py` (na razie bez części GPU — dochodzi w Task 8):

```python
"""Super-resolution models for the dataset pipeline and the Upscale tab.

Weights come from three places: a small built-in list downloaded from Hugging
Face, user-added HF repos, and a local folder scan (e.g. ComfyUI's
models/upscale_models). Files are loaded by spandrel, which detects the
architecture and scale on its own.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

WEIGHT_EXT = {".pth", ".safetensors"}
MAX_PASSES = 2

# NOTE: repo ids are verified by an actual download in the last task of the
# plan; an entry that cannot be fetched is removed from this list.
BUILTIN_MODELS = [
    {"id": "realesrgan-x4", "label": "Real-ESRGAN x4 (photos, general)",
     "repo_id": "ai-forever/Real-ESRGAN", "filename": "RealESRGAN_x4.pth",
     "scale": 4, "note": "Solid default for photographic sources."},
    {"id": "realesrgan-x2", "label": "Real-ESRGAN x2 (photos, gentle)",
     "repo_id": "ai-forever/Real-ESRGAN", "filename": "RealESRGAN_x2.pth",
     "scale": 2, "note": "Less aggressive, keeps grain."},
    {"id": "ultrasharp-x4", "label": "4x-UltraSharp (crisp detail)",
     "repo_id": "lokCX/4x-Ultrasharp", "filename": "4x-UltraSharp.pth",
     "scale": 4, "note": "Sharper, can exaggerate texture."},
]

_LOCK = threading.Lock()
_RUNTIME: dict | None = None      # {"model", "torch", "device", "key", "scale"}


# --------------------------------------------------------------------------- #
# Pure helpers (no torch, no network)
# --------------------------------------------------------------------------- #
def plan_passes(src_size, target_size, scale: int, min_ratio: float = 1.05) -> int:
    """How many model passes to reach ``target_size`` (0 = skip the upscaler)."""
    sw, sh = src_size
    tw, th = target_size
    if sw <= 0 or sh <= 0 or scale <= 1:
        return 0
    ratio = max(tw / sw, th / sh)
    if ratio <= min_ratio:
        return 0
    passes, cur = 0, 1.0
    while cur < ratio and passes < MAX_PASSES:
        cur *= scale
        passes += 1
    return passes


def scan_folder(folder: str) -> list[dict]:
    """Weight files found in a local folder, as registry entries."""
    if not folder:
        return []
    p = Path(folder).expanduser()
    if not p.is_dir():
        return []
    out: list[dict] = []
    for f in sorted(p.iterdir()):
        if f.is_file() and f.suffix.lower() in WEIGHT_EXT:
            out.append({
                "id": f"local:{f}",
                "label": f"Local: {f.name}",
                "repo_id": "",
                "filename": f.name,
                "path": str(f),
                "scale": 0,          # spandrel reports the real scale on load
                "note": str(p),
            })
    return out


def load_config(path) -> dict:
    """Read .work/upscaler.json ({} defaults when the file is missing)."""
    p = Path(path)
    if not p.exists():
        return {"folder": "", "custom": []}
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"folder": "", "custom": []}
    cfg.setdefault("folder", "")
    cfg.setdefault("custom", [])
    return cfg


def save_config(path, cfg: dict) -> None:
    Path(path).write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _hf_cached(repo_id: str, filename: str) -> bool:
    """True when the file is already in the local HF cache (no network call)."""
    try:
        from huggingface_hub import try_to_load_from_cache
        return isinstance(try_to_load_from_cache(repo_id, filename), str)
    except Exception:  # noqa: BLE001 - hub missing or cache unreadable
        return False


def registry(cfg: dict) -> list[dict]:
    """Built-in + user HF models + local folder scan, each with a cached flag."""
    out: list[dict] = []
    for m in BUILTIN_MODELS:
        entry = dict(m)
        entry["cached"] = _hf_cached(m["repo_id"], m["filename"])
        entry["source"] = "builtin"
        out.append(entry)
    for c in cfg.get("custom", []):
        repo_id, filename = c.get("repo_id", ""), c.get("filename", "")
        if not repo_id or not filename:
            continue
        out.append({
            "id": f"hf:{repo_id}/{filename}",
            "label": f"HF: {repo_id}/{filename}",
            "repo_id": repo_id, "filename": filename,
            "scale": int(c.get("scale") or 0), "note": "",
            "cached": _hf_cached(repo_id, filename), "source": "custom",
        })
    for m in scan_folder(cfg.get("folder", "")):
        entry = dict(m)
        entry["cached"] = os.path.exists(m["path"])
        entry["source"] = "local"
        out.append(entry)
    return out


def resolve(model_id: str, cfg: dict) -> dict | None:
    """Registry entry for an id, or None when it is unknown."""
    for m in registry(cfg):
        if m["id"] == model_id:
            return m
    return None
```

Dopisz do `requirements.txt` (sekcja Image processing):

```
# Super-resolution (upscale models loaded the same way ComfyUI does it)
spandrel>=0.3.4
huggingface_hub>=0.23.0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_upscaler.py -v`
Expected: PASS (11 testów)

- [ ] **Step 5: Commit**

```bash
git add backend/upscaler.py tests/test_upscaler.py requirements.txt
git commit -m "feat: upscale model registry, local folder scan and pass planning"
```

---

### Task 7: `hf_auth.py` — token Hugging Face

**Files:**
- Create: `backend/hf_auth.py`
- Modify: `backend/server.py` (import, `HF_TOKEN_PATH`, endpointy, wywołanie `apply_env` przy starcie)
- Test: `tests/test_hf_auth.py` (nowy)

**Interfaces:**
- Consumes: nic.
- Produces:
  - `load_token(path) -> str`, `save_token(path, token) -> None`, `clear_token(path) -> None`
  - `status(token: str) -> dict` → `{"set": bool, "tail": str}`
  - `apply_env(token: str) -> None`
  - `GET/POST/DELETE /api/hf/token`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_hf_auth.py`:

```python
import os

from backend import hf_auth


def test_status_masks_token():
    st = hf_auth.status("hf_abcdefgh1234")
    assert st == {"set": True, "tail": "1234"}


def test_status_empty_token():
    assert hf_auth.status("") == {"set": False, "tail": ""}


def test_status_short_token_is_not_leaked():
    st = hf_auth.status("hf_x")
    assert st["set"] is True
    assert len(st["tail"]) <= 4
    assert "hf_x" not in st["tail"] or st["tail"] == "hf_x"[-4:]


def test_save_and_load_roundtrip(tmp_path):
    p = tmp_path / "hf.json"
    hf_auth.save_token(p, "  hf_secret  ")
    assert hf_auth.load_token(p) == "hf_secret"


def test_load_missing_file_is_empty(tmp_path):
    assert hf_auth.load_token(tmp_path / "nope.json") == ""


def test_clear_token(tmp_path):
    p = tmp_path / "hf.json"
    hf_auth.save_token(p, "hf_secret")
    hf_auth.clear_token(p)
    assert hf_auth.load_token(p) == ""


def test_apply_env_sets_and_unsets(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    hf_auth.apply_env("hf_secret")
    assert os.environ["HF_TOKEN"] == "hf_secret"
    hf_auth.apply_env("")
    assert "HF_TOKEN" not in os.environ
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_hf_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.hf_auth'`

- [ ] **Step 3: Write minimal implementation**

Utwórz `backend/hf_auth.py`:

```python
"""Hugging Face access token storage (.work/hf.json, never leaves the machine).

The token unlocks gated repositories for every downloader in the app: the
upscale models, the VLM and Florence-2 (transformers reads HF_TOKEN from env).
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def load_token(path) -> str:
    p = Path(path)
    if not p.exists():
        return ""
    try:
        return str(json.loads(p.read_text(encoding="utf-8")).get("token", "")).strip()
    except (OSError, json.JSONDecodeError):
        return ""


def save_token(path, token: str) -> None:
    Path(path).write_text(
        json.dumps({"token": (token or "").strip()}, indent=2), encoding="utf-8")


def clear_token(path) -> None:
    p = Path(path)
    if p.exists():
        p.unlink()


def status(token: str) -> dict:
    """Public view of the token: whether it is set plus its last 4 characters."""
    token = (token or "").strip()
    return {"set": bool(token), "tail": token[-4:] if token else ""}


def apply_env(token: str) -> None:
    """Export/remove HF_TOKEN so huggingface_hub and transformers pick it up."""
    token = (token or "").strip()
    if token:
        os.environ["HF_TOKEN"] = token
    else:
        os.environ.pop("HF_TOKEN", None)
```

W `backend/server.py`: dodaj `hf_auth` i `upscaler` do importu z `.`, dopisz ścieżki i endpointy:

```python
HF_TOKEN_PATH = WORK / "hf.json"
UPSCALER_CONFIG_PATH = WORK / "upscaler.json"

hf_auth.apply_env(hf_auth.load_token(HF_TOKEN_PATH))   # at import time


class HFTokenRequest(BaseModel):
    token: str


@app.get("/api/hf/token")
def api_hf_token_get():
    return hf_auth.status(hf_auth.load_token(HF_TOKEN_PATH))


@app.post("/api/hf/token")
def api_hf_token_set(req: HFTokenRequest):
    hf_auth.save_token(HF_TOKEN_PATH, req.token)
    hf_auth.apply_env(req.token)
    return hf_auth.status(req.token)


@app.delete("/api/hf/token")
def api_hf_token_clear():
    hf_auth.clear_token(HF_TOKEN_PATH)
    hf_auth.apply_env("")
    return {"set": False, "tail": ""}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_hf_auth.py -v && .venv/bin/python -m pytest -q`
Expected: PASS

Ręcznie: `./run.sh`, a potem
```bash
curl -s -X POST localhost:8123/api/hf/token -H 'Content-Type: application/json' -d '{"token":"hf_test123456"}'
curl -s localhost:8123/api/hf/token
```
Expected: oba zwracają `{"set":true,"tail":"3456"}` — nigdy pełnego tokenu.
Na koniec `curl -s -X DELETE localhost:8123/api/hf/token`.

- [ ] **Step 5: Commit**

```bash
git add backend/hf_auth.py backend/server.py tests/test_hf_auth.py
git commit -m "feat: Hugging Face token storage and API"
```

---

### Task 8: Upscaler na GPU + wpięcie w pipeline datasetu

**Files:**
- Modify: `backend/upscaler.py` (`weights_path`, `load`, `upscale`, `unload`, `_run_tiled`)
- Modify: `backend/server.py` (`ProcessRequest`, `_run_job`, `_job_public`, `/api/unload`, endpointy modeli)
- Test: `tests/test_upscaler_pipeline.py` (nowy)

**Interfaces:**
- Consumes: `upscaler.plan_passes`, `upscaler.resolve`, `upscaler.registry` (Task 6); `hf_auth.load_token` (Task 7); `image_utils.process_image(upscale=...)` (Task 1).
- Produces:
  - `upscaler.weights_path(entry: dict, token: str = "") -> str`
  - `upscaler.upscale(img, entry: dict, passes: int) -> Image`
  - `upscaler.unload() -> None`
  - `server._UpscaleHook` (callable, atrybuty `.used: bool`, `.error: str`)
  - `ProcessRequest.upscale_model: str`, `ProcessRequest.upscale_min_ratio: float`
  - wyniki joba mają `upscaled: bool`
  - `GET /api/upscale/models`, `POST /api/upscale/models/scan`, `POST|DELETE /api/upscale/models/custom`, `POST /api/upscale/download`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_upscaler_pipeline.py`:

```python
from PIL import Image

from backend import server


def test_process_request_upscale_defaults():
    r = server.ProcessRequest(folder="/tmp/x")
    assert r.upscale_model == ""
    assert r.upscale_min_ratio == 1.05


def test_upscale_hook_skips_when_target_is_smaller():
    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05,
                               run=lambda img, entry, passes: img)
    img = Image.new("RGB", (2000, 1000))
    out = hook(img, (1024, 512))
    assert out is img
    assert hook.used is False


def test_upscale_hook_runs_and_marks_used():
    calls = {}

    def run(img, entry, passes):
        calls["passes"] = passes
        return img.resize((img.width * 4, img.height * 4))

    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05, run=run)
    out = hook(Image.new("RGB", (256, 256)), (1024, 1024))
    assert calls["passes"] == 1
    assert out.size == (1024, 1024)
    assert hook.used is True


def test_upscale_hook_falls_back_on_error():
    def boom(img, entry, passes):
        raise RuntimeError("CUDA out of memory")

    hook = server._UpscaleHook({"id": "x", "scale": 4}, min_ratio=1.05, run=boom)
    img = Image.new("RGB", (256, 256))
    out = hook(img, (1024, 1024))
    assert out is img                  # obraz przechodzi dalej nietknięty
    assert hook.used is False
    assert "CUDA out of memory" in hook.error


def test_job_public_exposes_upscaled_flag():
    job = {
        "id": "j", "state": "done", "total": 1, "processed": 1, "current": "",
        "error": "", "config": {},
        "results": [{"idx": 0, "src_name": "a.png", "out_name": "person_0000.png",
                     "width": 1024, "height": 1024, "caption": "x",
                     "upscaled": True}],
    }
    pub = server._job_public(job)
    assert pub["results"][0]["upscaled"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_upscaler_pipeline.py -v`
Expected: FAIL — brak `server._UpscaleHook`, brak pól `upscale_model`

- [ ] **Step 3: Write minimal implementation**

Dopisz do `backend/upscaler.py` część GPU:

```python
def weights_path(entry: dict, token: str = "") -> str:
    """Local path to the weights, downloading them from HF when needed."""
    if entry.get("path"):
        return entry["path"]
    from huggingface_hub import hf_hub_download
    return hf_hub_download(
        repo_id=entry["repo_id"], filename=entry["filename"],
        token=token or None)


def _load(entry: dict, token: str = "") -> dict:
    """Load (and cache) the spandrel descriptor for one registry entry."""
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is not None and _RUNTIME["key"] == entry["id"]:
            return _RUNTIME
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        path = weights_path(entry, token)
        model = ModelLoader().load_from_file(path)
        if not isinstance(model, ImageModelDescriptor):
            raise RuntimeError(f"{entry['filename']} is not an image upscaler.")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device).eval()
        _RUNTIME = {"model": model, "torch": torch, "device": device,
                    "key": entry["id"], "scale": int(model.scale)}
        return _RUNTIME


def unload() -> None:
    """Release the upscaler from memory (wired to the 'Release GPU' button)."""
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is None:
            return
        torch = _RUNTIME["torch"]
        _RUNTIME = None
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def is_loaded() -> bool:
    return _RUNTIME is not None


def loaded_key() -> str:
    return _RUNTIME["key"] if _RUNTIME else ""


def _to_tensor(img, torch):
    import numpy as np
    arr = np.asarray(img.convert("RGB"), dtype="float32") / 255.0
    return torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)


def _to_image(tensor, torch):
    import numpy as np
    from PIL import Image as PILImage
    arr = tensor.squeeze(0).clamp(0, 1).permute(1, 2, 0).cpu().float().numpy()
    return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8))


def _run_once(rt: dict, img, tile: int = 512, overlap: int = 32):
    """One model pass, tiled so a 12 GB card survives x4 on large photos."""
    torch = rt["torch"]
    model, device, scale = rt["model"], rt["device"], rt["scale"]
    src = _to_tensor(img, torch).to(device)
    _, _, h, w = src.shape
    out = torch.zeros((1, 3, h * scale, w * scale), device=device)
    weight = torch.zeros_like(out)
    step = max(16, tile - overlap)
    with torch.no_grad():
        for y in range(0, h, step):
            for x in range(0, w, step):
                y2, x2 = min(y + tile, h), min(x + tile, w)
                patch = src[:, :, y:y2, x:x2]
                res = model(patch)
                out[:, :, y * scale:y2 * scale, x * scale:x2 * scale] += res
                weight[:, :, y * scale:y2 * scale, x * scale:x2 * scale] += 1.0
    out = out / weight.clamp(min=1.0)
    return _to_image(out, torch)


def upscale(img, entry: dict, passes: int, token: str = ""):
    """Run ``passes`` model passes over the image, shrinking tiles on OOM."""
    if passes <= 0:
        return img
    rt = _load(entry, token)
    for _ in range(passes):
        for tile in (512, 256, 128):
            try:
                img = _run_once(rt, img, tile=tile)
                break
            except Exception as e:  # noqa: BLE001 - OOM -> smaller tile, then CPU
                if "out of memory" not in str(e).lower() or tile == 128:
                    raise
                rt["torch"].cuda.empty_cache()
    return img
```

W `backend/server.py`:

```python
    # Upscaling
    upscale_model: str = ""          # empty = disabled
    upscale_min_ratio: float = 1.05
```
(dopisz do `ProcessRequest`)

```python
class _UpscaleHook:
    """Callable passed to process_image(upscale=...); records what it did.

    Keeps the pipeline honest: a broken upscaler degrades to plain LANCZOS
    instead of killing the job.
    """

    def __init__(self, entry: dict, min_ratio: float = 1.05, token: str = "", run=None):
        self.entry = entry
        self.min_ratio = min_ratio
        self.token = token
        self.used = False
        self.error = ""
        self._run = run or (lambda img, entry, passes: upscaler.upscale(
            img, entry, passes, token=self.token))

    def reset(self) -> None:
        self.used = False
        self.error = ""

    def __call__(self, img, target):
        scale = int(self.entry.get("scale") or 0) or 4
        passes = upscaler.plan_passes(
            (img.width, img.height), target, scale, self.min_ratio)
        if passes <= 0:
            return img
        try:
            out = self._run(img, self.entry, passes)
        except Exception as e:  # noqa: BLE001 - fall back to plain resizing
            self.error = str(e)
            return img
        self.used = True
        return out
```

W `_run_job()`, przed pętlą po plikach:

```python
        hook = None
        if req.upscale_model:
            entry = upscaler.resolve(
                req.upscale_model, upscaler.load_config(UPSCALER_CONFIG_PATH))
            if entry:
                job["state"] = "loading_model"
                job["current"] = "Loading the upscale model…"
                hook = _UpscaleHook(entry, req.upscale_min_ratio,
                                    hf_auth.load_token(HF_TOKEN_PATH))
```

w pętli, przed `process_image`: `if hook: hook.reset()`, w wywołaniu dopisz `upscale=hook`,
a do słownika wyniku dopisz:

```python
                    "upscaled": bool(hook and hook.used),
                    "upscale_error": hook.error if hook else "",
```

W `_job_public()` dopisz do słownika wyniku `"upscaled": r.get("upscaled", False)`.

W `/api/unload` dopisz `upscaler.unload()`.

Endpointy modeli:

```python
class UpscaleScanRequest(BaseModel):
    folder: str


class UpscaleCustomRequest(BaseModel):
    repo_id: str
    filename: str
    scale: int = 0


class UpscaleDownloadRequest(BaseModel):
    model_id: str


@app.get("/api/upscale/models")
def api_upscale_models():
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    return {"models": upscaler.registry(cfg), "folder": cfg.get("folder", "")}


@app.post("/api/upscale/models/scan")
def api_upscale_scan(req: UpscaleScanRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    cfg["folder"] = req.folder.strip()
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg), "folder": cfg["folder"]}


@app.post("/api/upscale/models/custom")
def api_upscale_custom_add(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    entry = {"repo_id": req.repo_id.strip(), "filename": req.filename.strip(),
             "scale": req.scale}
    if not entry["repo_id"] or not entry["filename"]:
        raise HTTPException(400, "repo_id and filename are required.")
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (entry["repo_id"], entry["filename"])] + [entry]
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


@app.delete("/api/upscale/models/custom")
def api_upscale_custom_del(req: UpscaleCustomRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    cfg["custom"] = [c for c in cfg["custom"]
                     if (c.get("repo_id"), c.get("filename")) !=
                     (req.repo_id, req.filename)]
    upscaler.save_config(UPSCALER_CONFIG_PATH, cfg)
    return {"models": upscaler.registry(cfg)}


@app.post("/api/upscale/download")
def api_upscale_download(req: UpscaleDownloadRequest):
    cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
    entry = upscaler.resolve(req.model_id, cfg)
    if not entry:
        raise HTTPException(404, "Unknown upscale model.")
    try:
        path = upscaler.weights_path(entry, hf_auth.load_token(HF_TOKEN_PATH))
    except Exception as e:  # noqa: BLE001 - surface a readable message in the UI
        raise HTTPException(400, f"Download failed: {e}") from e
    return {"ok": True, "path": path, "models": upscaler.registry(cfg)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_upscaler_pipeline.py -v && .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/upscaler.py backend/server.py tests/test_upscaler_pipeline.py
git commit -m "feat: tiled GPU upscaling wired into the dataset pipeline"
```

---

### Task 9: Front — wybór modelu upscale w datasecie, token HF, znacznik ✨

**Files:**
- Modify: `frontend/index.html` (krok 2: pola upscale i tokenu)
- Modify: `frontend/app.js` (ładowanie listy modeli, wysyłka pól, znacznik w Review)

**Interfaces:**
- Consumes: `GET /api/upscale/models`, `POST /api/upscale/models/scan`, `POST /api/upscale/models/custom`, `POST /api/upscale/download`, `GET|POST|DELETE /api/hf/token` (Task 7, 8).
- Produces: `window.loadUpscaleModels()` (używane też przez zakładkę Upscale w Task 11).

- [ ] **Step 1: HTML**

W kroku 2, w `<div class="grid">`, po polu „Quantization" dopisz:

```html
        <div class="field">
          <label>Upscale model (used when the crop is smaller than the target)</label>
          <select id="upscaleModel"></select>
          <button type="button" id="upDownloadBtn" class="mini">⬇ Download weights</button>
          <span id="upModelInfo" class="info"></span>
        </div>

        <div class="field">
          <label>Local upscale model folder</label>
          <div class="row">
            <input type="text" id="upFolder" placeholder="/home/user/ComfyUI/models/upscale_models" />
            <button type="button" id="upScanBtn" class="mini">Scan</button>
          </div>
          <div class="row">
            <input type="text" id="upCustomRepo" placeholder="HF repo id, e.g. me/my-upscaler" />
            <input type="text" id="upCustomFile" placeholder="file.pth" />
            <button type="button" id="upCustomAddBtn" class="mini">Add</button>
          </div>
        </div>

        <div class="field">
          <label>Hugging Face token (for gated repos)</label>
          <div class="row">
            <input type="password" id="hfToken" placeholder="hf_…" />
            <button type="button" id="hfSaveBtn" class="mini">Save</button>
            <button type="button" id="hfClearBtn" class="mini">Remove</button>
          </div>
          <span id="hfInfo" class="info"></span>
        </div>
```

- [ ] **Step 2: `app.js` — lista modeli i token**

Dopisz w sekcji init (po `populateModels`):

```javascript
// --------------------------------------------------------------------------- //
// Upscale models + Hugging Face token
// --------------------------------------------------------------------------- //
window.loadUpscaleModels = async function loadUpscaleModels(selected) {
  const { models, folder } = await api("/api/upscale/models");
  for (const selId of ["upscaleModel", "uModel"]) {
    const sel = $(selId);
    if (!sel) continue;
    const prev = selected || sel.value;
    sel.innerHTML = "";
    if (selId === "upscaleModel") {
      const off = document.createElement("option");
      off.value = "";
      off.textContent = "Off (plain LANCZOS)";
      sel.appendChild(off);
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = (m.cached ? "✓ " : "⬇ ") + m.label;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }
  if ($("upFolder") && folder && !$("upFolder").value) $("upFolder").value = folder;
  return models;
};

async function refreshHfToken() {
  const st = await api("/api/hf/token");
  $("hfInfo").textContent = st.set ? `Token set (…${st.tail})` : "No token.";
}

$("hfSaveBtn").addEventListener("click", async () => {
  await api("/api/hf/token", { token: $("hfToken").value });
  $("hfToken").value = "";
  refreshHfToken();
});

$("hfClearBtn").addEventListener("click", async () => {
  await fetch("/api/hf/token", { method: "DELETE" });
  refreshHfToken();
});

$("upScanBtn").addEventListener("click", async () => {
  await api("/api/upscale/models/scan", { folder: $("upFolder").value.trim() });
  loadUpscaleModels();
});

$("upCustomAddBtn").addEventListener("click", async () => {
  await api("/api/upscale/models/custom", {
    repo_id: $("upCustomRepo").value.trim(),
    filename: $("upCustomFile").value.trim(),
  });
  $("upCustomRepo").value = "";
  $("upCustomFile").value = "";
  loadUpscaleModels();
});

$("upDownloadBtn").addEventListener("click", async () => {
  const id = $("upscaleModel").value;
  if (!id) return;
  const btn = $("upDownloadBtn");
  btn.disabled = true;
  $("upModelInfo").textContent = "Downloading the weights…";
  try {
    await api("/api/upscale/download", { model_id: id });
    $("upModelInfo").textContent = "Weights ready.";
    loadUpscaleModels(id);
  } catch (e) {
    $("upModelInfo").textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
  }
});
```

W `init()` dopisz `loadUpscaleModels(); refreshHfToken();` (w `try`).

W obiekcie `req` (`processBtn`) dopisz:

```javascript
    upscale_model: $("upscaleModel").value,
```

W `renderResults()` (`frontend/app.js`, ok. linii 286) podmień linię z rozmiarem:

```javascript
          <span>${r.width}×${r.height}</span>
```

na:

```javascript
          <span>${r.width}×${r.height}${r.upscaled ? ' <span title="Upscaled with the selected model">✨</span>' : ""}</span>
```

- [ ] **Step 3: Manual verification**

```bash
./run.sh
```
1. W kroku 2 lista `Upscale model` pokazuje wbudowane modele z ⬇/✓.
2. Wpisz token HF → **Save** → status `Token set (…1234)`, pole czyści się;
   po odświeżeniu strony status pozostaje.
3. Wskaż folder z modelami ComfyUI → **Scan** → w liście pojawiają się `Local: …`.
4. Wybierz model → **Download weights** → po chwili prefiks zmienia się na ✓.
5. Przetwórz folder z małymi zdjęciami (np. 512 px) przy `Target resolution 1024`
   → w kroku 4 karty tych zdjęć mają ✨.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: upscale model picker, HF token field and upscaled badge"
```

---

### Task 10: Backend samodzielnego narzędzia „Upscale"

**Files:**
- Modify: `backend/server.py` (`UpscaleRunRequest`, `_run_upscale_job`, endpointy)
- Test: `tests/test_upscale_job.py` (nowy)

**Interfaces:**
- Consumes: `upscaler.resolve`, `upscaler.upscale`, `image_utils.save_image`, `image_utils.make_thumbnail`.
- Produces:
  - `server._upscale_target(size, mode, value, scale) -> tuple[int, int]`
  - `POST /api/upscale/run` → `{"job_id", "total"}`
  - `GET /api/upscale/job/{id}`, `GET /api/upscale/thumb/{id}/{idx}`
  - `POST /api/upscale/export` → `{"written": int}`, `GET /api/upscale/zip/{id}`

- [ ] **Step 1: Write the failing test**

Utwórz `tests/test_upscale_job.py`:

```python
from backend import server


def test_upscale_target_native_scale():
    assert server._upscale_target((500, 250), "native", 0, 4) == (2000, 1000)


def test_upscale_target_fixed_x2():
    assert server._upscale_target((500, 250), "x2", 0, 4) == (1000, 500)


def test_upscale_target_long_side():
    assert server._upscale_target((500, 250), "long_side", 2000, 4) == (2000, 1000)


def test_upscale_target_long_side_uses_taller_edge():
    assert server._upscale_target((250, 500), "long_side", 2000, 4) == (1000, 2000)


def test_upscale_target_never_shrinks_below_source():
    assert server._upscale_target((2000, 1000), "long_side", 500, 4) == (2000, 1000)


def test_upscale_run_request_defaults():
    r = server.UpscaleRunRequest(folder="/tmp/x", model_id="m")
    assert r.mode == "native"
    assert r.fmt == "png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_upscale_job.py -v`
Expected: FAIL — brak `server._upscale_target`

- [ ] **Step 3: Write minimal implementation**

W `backend/server.py`:

```python
class UpscaleRunRequest(BaseModel):
    folder: str
    model_id: str
    mode: str = "native"     # "native" | "x2" | "long_side"
    long_side: int = 2048
    fmt: str = "png"         # "png" | "jpg"
    jpg_quality: int = 95


class UpscaleExportRequest(BaseModel):
    job_id: str
    output_folder: str


def _upscale_target(size, mode: str, value: int, scale: int) -> tuple[int, int]:
    """Target pixel size for the standalone upscale tool (never shrinks)."""
    w, h = size
    if mode == "x2":
        factor = 2.0
    elif mode == "long_side":
        factor = max(1.0, value / max(w, h))
    else:
        factor = float(scale or 4)
    return (max(w, int(round(w * factor))), max(h, int(round(h * factor))))


def _run_upscale_job(job_id: str, req: UpscaleRunRequest, files: list[Path]) -> None:
    job = JOBS[job_id]
    out_dir = WORK / job_id / "upscaled"
    thumb_dir = WORK / job_id / "thumbs"
    out_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    ext = "jpg" if req.fmt == "jpg" else "png"
    try:
        cfg = upscaler.load_config(UPSCALER_CONFIG_PATH)
        entry = upscaler.resolve(req.model_id, cfg)
        if not entry:
            raise RuntimeError(f"Unknown upscale model: {req.model_id}")
        token = hf_auth.load_token(HF_TOKEN_PATH)
        job["state"] = "loading_model"
        job["current"] = "Loading the upscale model…"
        scale = int(entry.get("scale") or 0) or 4
        job["state"] = "processing"
        for i, src in enumerate(files):
            job["current"] = src.name
            try:
                img = image_utils.load_source(str(src))
                target = _upscale_target((img.width, img.height), req.mode,
                                         req.long_side, scale)
                passes = upscaler.plan_passes((img.width, img.height), target,
                                              scale, min_ratio=1.0)
                big = upscaler.upscale(img, entry, passes, token=token)
                if (big.width, big.height) != target:
                    big = big.resize(target, Image.LANCZOS)
                out_name = f"{src.stem}_up.{ext}"
                image_utils.save_image(big, str(out_dir / out_name),
                                       req.fmt, req.jpg_quality)
                image_utils.make_thumbnail(big, 480).save(
                    str(thumb_dir / f"{i:04d}.jpg"), format="JPEG", quality=80)
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": out_name,
                    "width": big.width, "height": big.height, "error": "",
                })
            except Exception as e:  # noqa: BLE001 - keep going on per-file errors
                job["results"].append({
                    "idx": i, "src_name": src.name, "out_name": "",
                    "width": 0, "height": 0, "error": str(e),
                })
            job["processed"] = i + 1
        job["current"] = ""
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        job["state"] = "error"
        job["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/api/upscale/run")
def api_upscale_run(req: UpscaleRunRequest):
    files = _list_images(req.folder)
    if not files:
        raise HTTPException(400, "No supported images in the folder.")
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "state": "pending", "total": len(files),
            "processed": 0, "current": "", "error": "", "config": req.model_dump(),
            "results": [], "kind": "upscale",
        }
    threading.Thread(target=_run_upscale_job, args=(job_id, req, files),
                     daemon=True).start()
    return {"job_id": job_id, "total": len(files)}


@app.get("/api/upscale/job/{job_id}")
def api_upscale_job(job_id: str):
    job = JOBS.get(job_id)
    if not job or job.get("kind") != "upscale":
        raise HTTPException(404, "Unknown job.")
    return {
        "state": job["state"], "total": job["total"], "processed": job["processed"],
        "current": job["current"], "error": job["error"], "results": job["results"],
    }


@app.get("/api/upscale/thumb/{job_id}/{idx}")
def api_upscale_thumb(job_id: str, idx: int):
    path = WORK / job_id / "thumbs" / f"{idx:04d}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail.")
    return FileResponse(str(path), media_type="image/jpeg")


@app.post("/api/upscale/export")
def api_upscale_export(req: UpscaleExportRequest):
    job = JOBS.get(req.job_id)
    if not job or job.get("kind") != "upscale":
        raise HTTPException(404, "Unknown job.")
    dest = Path(req.output_folder).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    src_dir = WORK / req.job_id / "upscaled"
    written = 0
    for r in job["results"]:
        if not r["out_name"]:
            continue
        shutil.copy2(src_dir / r["out_name"], dest / r["out_name"])
        written += 1
    return {"written": written, "folder": str(dest)}


@app.get("/api/upscale/zip/{job_id}")
def api_upscale_zip(job_id: str):
    job = JOBS.get(job_id)
    if not job or job.get("kind") != "upscale":
        raise HTTPException(404, "Unknown job.")
    src_dir = WORK / job_id / "upscaled"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in job["results"]:
            if r["out_name"]:
                zf.write(src_dir / r["out_name"], r["out_name"])
    buf.seek(0)
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="upscaled_{job_id[:8]}.zip"'},
    )
```

Dodaj `from PIL import Image` do importów `server.py` (używane w `_run_upscale_job`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_upscale_job.py -v && .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/server.py tests/test_upscale_job.py
git commit -m "feat: standalone upscale job, export and zip endpoints"
```

---

### Task 11: Front — zakładka „🔍 Upscale"

**Files:**
- Modify: `frontend/index.html` (nowa zakładka w `topnav`, nowy `div#view-upscale`, `<script src="/upscale.js">`)
- Create: `frontend/upscale.js`
- Modify: `frontend/app.js` (hook w `switchView`)

**Interfaces:**
- Consumes: `POST /api/upscale/run`, `GET /api/upscale/job/{id}`, `GET /api/upscale/thumb/{id}/{idx}`, `POST /api/upscale/export`, `GET /api/upscale/zip/{id}`, `window.loadUpscaleModels()` (Task 9, 10).
- Produces: `window.UpscaleView.onShow()`.

- [ ] **Step 1: HTML**

W `<nav class="topnav">` po zakładce ComfyUI dopisz:

```html
      <button class="navtab" data-view="upscale">🔍 Upscale</button>
```

Przed `</main>` (obok innych `view-*`):

```html
    <div id="view-upscale" class="hidden">
      <section class="card">
        <h2><span class="num">1</span> Images to upscale</h2>
        <div class="row">
          <input type="text" id="uFolder" placeholder="/home/user/photos/small" />
          <button id="uScanBtn">Scan</button>
        </div>
        <div class="dropzone" id="uDropzone">Drop images…</div>
        <input type="file" id="uFileInput" multiple accept="image/*,.heic,.heif" hidden />
        <p id="uSrcInfo" class="info"></p>
      </section>

      <section class="card">
        <h2><span class="num">2</span> Model and target size</h2>
        <div class="grid">
          <div class="field">
            <label>Upscale model</label>
            <select id="uModel"></select>
          </div>
          <div class="field">
            <label>Target</label>
            <select id="uMode">
              <option value="native" selected>Model's native scale</option>
              <option value="x2">x2</option>
              <option value="long_side">Long side = N px</option>
            </select>
          </div>
          <div class="field">
            <label>Long side (px)</label>
            <input type="number" id="uLongSide" value="2048" min="256" max="8192" step="64" />
          </div>
          <div class="field">
            <label>Output format</label>
            <select id="uFmt">
              <option value="png" selected>PNG (lossless)</option>
              <option value="jpg">JPG</option>
            </select>
          </div>
        </div>
        <button id="uRunBtn" class="primary" disabled>Upscale images</button>
      </section>

      <section class="card hidden" id="uProgressCard">
        <h2><span class="num">3</span> Progress</h2>
        <div class="progress"><div id="uProgressBar"></div></div>
        <p id="uProgressText" class="info"></p>
        <div id="uResults" class="srcgrid"></div>
      </section>

      <section class="card hidden" id="uExportCard">
        <h2><span class="num">4</span> Save</h2>
        <div class="row">
          <input type="text" id="uOutFolder" placeholder="/home/user/photos/upscaled" />
          <button id="uExportBtn" class="primary">Save to folder</button>
        </div>
        <div class="orline"><span>or</span></div>
        <button id="uZipBtn" class="primary">⬇ Download .zip</button>
        <p id="uExportInfo" class="info"></p>
      </section>
    </div>
```

Po `<script src="/app.js"></script>` (razem z `crop_editor.js`):
`<script src="/upscale.js"></script>` — `upscale.js` używa `api()` i `refreshGpu()`
z `app.js`.

- [ ] **Step 2: `frontend/upscale.js`**

```javascript
"use strict";

// Standalone "🔍 Upscale" tab: pick images, pick a model, run, save.
window.UpscaleView = (function () {
  const $ = (id) => document.getElementById(id);
  let folder = null;
  let jobId = null;

  function info(msg, cls) {
    const el = $("uSrcInfo");
    el.textContent = msg;
    el.className = "info" + (cls ? " " + cls : "");
  }

  $("uScanBtn").addEventListener("click", async () => {
    const f = $("uFolder").value.trim();
    if (!f) return;
    try {
      const r = await api("/api/scan", { folder: f });
      folder = r.folder;
      info(`Found ${r.count} images.`, "ok");
      $("uRunBtn").disabled = r.count === 0;
    } catch (e) {
      info("Error: " + e.message, "err");
    }
  });

  $("uDropzone").addEventListener("click", () => $("uFileInput").click());
  $("uFileInput").addEventListener("change", (e) => upload(e.target.files));
  ["dragover", "dragenter"].forEach((ev) =>
    $("uDropzone").addEventListener(ev, (e) => { e.preventDefault(); $("uDropzone").classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    $("uDropzone").addEventListener(ev, (e) => { e.preventDefault(); $("uDropzone").classList.remove("drag"); }));
  $("uDropzone").addEventListener("drop", (e) => upload(e.dataTransfer.files));

  async function upload(list) {
    if (!list || !list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append("files", f);
    info("Uploading…");
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const r = await res.json();
    folder = r.folder;
    info(`Uploaded ${r.count} images.`, "ok");
    $("uRunBtn").disabled = r.count === 0;
  }

  $("uRunBtn").addEventListener("click", async () => {
    if (!folder) return;
    $("uRunBtn").disabled = true;
    $("uProgressCard").classList.remove("hidden");
    $("uExportCard").classList.add("hidden");
    $("uResults").innerHTML = "";
    try {
      const { job_id, total } = await api("/api/upscale/run", {
        folder,
        model_id: $("uModel").value,
        mode: $("uMode").value,
        long_side: parseInt($("uLongSide").value, 10),
        fmt: $("uFmt").value,
      });
      jobId = job_id;
      poll(job_id, total);
    } catch (e) {
      $("uProgressText").textContent = "Error: " + e.message;
      $("uRunBtn").disabled = false;
    }
  });

  async function poll(id, total) {
    try {
      const j = await api("/api/upscale/job/" + id);
      const pct = total ? Math.round((j.processed / total) * 100) : 0;
      $("uProgressBar").style.width = pct + "%";
      $("uProgressText").textContent =
        j.state === "loading_model" ? j.current : `${j.processed}/${total} — ${j.current || ""}`;
      render(j, id);
      if (j.state === "done") {
        $("uProgressText").textContent = `Done: ${j.processed} images.`;
        $("uExportCard").classList.remove("hidden");
        $("uRunBtn").disabled = false;
        refreshGpu();
        return;
      }
      if (j.state === "error") {
        $("uProgressText").textContent = "Error: " + j.error;
        $("uRunBtn").disabled = false;
        return;
      }
      setTimeout(() => poll(id, total), 1000);
    } catch (e) {
      $("uProgressText").textContent = "Error: " + e.message;
      $("uRunBtn").disabled = false;
    }
  }

  function render(job, id) {
    for (const r of job.results) {
      if (document.getElementById("ures-" + r.idx)) continue;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = "ures-" + r.idx;
      cell.innerHTML = r.error
        ? `<div class="name err">${r.src_name}: ${r.error}</div>`
        : `<img loading="lazy" src="/api/upscale/thumb/${id}/${r.idx}" />` +
          `<div class="name">${r.out_name} — ${r.width}×${r.height}</div>`;
      $("uResults").appendChild(cell);
    }
  }

  $("uExportBtn").addEventListener("click", async () => {
    if (!jobId) return;
    try {
      const r = await api("/api/upscale/export", {
        job_id: jobId, output_folder: $("uOutFolder").value.trim(),
      });
      $("uExportInfo").textContent = `Saved ${r.written} files to ${r.folder}.`;
      $("uExportInfo").className = "info ok";
    } catch (e) {
      $("uExportInfo").textContent = "Error: " + e.message;
      $("uExportInfo").className = "info err";
    }
  });

  $("uZipBtn").addEventListener("click", () => {
    if (jobId) window.location.href = "/api/upscale/zip/" + jobId;
  });

  return {
    onShow() { if (window.loadUpscaleModels) window.loadUpscaleModels(); },
  };
})();
```

- [ ] **Step 3: `app.js` — hook widoku**

W `switchView()` dopisz:

```javascript
  if (view === "upscale" && window.UpscaleView) window.UpscaleView.onShow();
```

- [ ] **Step 4: Manual verification**

```bash
./run.sh
```
1. Zakładka **🔍 Upscale** — lista modeli wypełniona.
2. Wskaż folder z małymi zdjęciami → **Scan** → licznik.
3. **Upscale images** z trybem `Model's native scale` → pasek postępu, miniatury
   z rozmiarem wynikowym.
4. **Save to folder** zapisuje pliki `*_up.png`; **Download .zip** pobiera archiwum.
5. Sprawdź tryb `Long side = N px` (np. 3000) i format JPG.
6. **⏏ Release GPU** zwalnia pamięć po zakończeniu (status w topbarze).

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/upscale.js frontend/app.js
git commit -m "feat: standalone Upscale tab"
```

---

### Task 12: Weryfikacja modeli HF, README i screenshoty

**Files:**
- Modify: `backend/upscaler.py` (poprawione wpisy `BUILTIN_MODELS`)
- Modify: `README.md`
- Modify: `docs/screenshots/*.png`

- [ ] **Step 1: Zweryfikuj każdy wbudowany model realnym pobraniem**

```bash
.venv/bin/python - <<'PY'
from backend import upscaler
for m in upscaler.BUILTIN_MODELS:
    try:
        p = upscaler.weights_path(m)
        print("OK  ", m["id"], p)
    except Exception as e:
        print("FAIL", m["id"], e)
PY
```

Wpisy z `FAIL` usuń z `BUILTIN_MODELS` albo popraw `repo_id`/`filename`
(np. szukając pliku przez `huggingface_hub.list_repo_files(repo_id)`).
Lista musi mieć co najmniej **dwa** działające modele: jeden x4 i jeden x2.

- [ ] **Step 2: Sprawdź, że wagi faktycznie się ładują i skalują**

```bash
.venv/bin/python - <<'PY'
from PIL import Image
from backend import upscaler
entry = upscaler.BUILTIN_MODELS[0]
img = Image.new("RGB", (128, 96), (120, 60, 30))
out = upscaler.upscale(img, entry, 1)
print(entry["id"], img.size, "->", out.size)
upscaler.unload()
PY
```
Expected: rozmiar wyjściowy = `entry["scale"]` × rozmiar wejściowy.

- [ ] **Step 3: Test end-to-end w przeglądarce**

```bash
./run.sh
```
Przejdź pełną ścieżkę: skan folderu → ręczny kadr na 2 zdjęciach → auto-kadr
reszty → model upscale włączony → przetwarzanie → Review (✂ i ✨) → eksport do
folderu. Sprawdź wymiary plików wyjściowych (`identify` lub `Image.open`).

- [ ] **Step 4: Uzupełnij README**

- W liście funkcji (sekcja **📸 Dataset**) dopisz zdanie o kadrowaniu: cztery
  tryby (środek z wyborem centrowania, auto Florence‑2, ręczny kadr, wsadowy),
  `cover`/`contain` oraz o automatycznym powiększaniu za małych zdjęć.
- Dodaj punkt listy **🔍 Upscale** opisujący zakładkę (modele z HF, własne repo,
  skan lokalnego folderu, tryby docelowe, eksport).
- W **Requirements** dopisz `spandrel` i wzmiankę o tokenie HF dla repozytoriów
  bramkowanych.
- W **How it works → Dataset** dopisz krok „Kadrowanie" między *Source* a *Settings*.

- [ ] **Step 5: Odśwież screenshoty**

Zrób nowe zrzuty `docs/screenshots/01-dataset.png` (z siatką miniatur i polami
kadru) oraz dodaj `docs/screenshots/05-upscale.png`; wstaw ten drugi do README
w sekcji **Screenshots** z podpisem.

- [ ] **Step 6: Uruchom pełny zestaw testów**

Run: `.venv/bin/python -m pytest -q`
Expected: wszystko na zielono.

- [ ] **Step 7: Commit**

```bash
git add backend/upscaler.py README.md docs/screenshots
git commit -m "docs: document cropping and the upscale tab; verify model registry"
```

---

## Kolejność i zależności

```
Task 1 (image_utils) ──► Task 2 (server: crop) ──► Task 3 (crop_auto)
                                   │                     │
                                   └────────► Task 4 (front: grid) ──► Task 5 (front: editor)

Task 6 (upscaler core) ──► Task 7 (hf_auth) ──► Task 8 (GPU + pipeline) ──► Task 9 (front: picker)
                                                        │
                                                        └──► Task 10 (upscale job) ──► Task 11 (front: tab)

Task 12 (weryfikacja modeli + docs) — na końcu
```

Tasks 1–5 (kadrowanie) i 6–11 (upscale) to dwie niezależne gałęzie — mogą być
robione równolegle, o ile Task 8 poczeka na Task 1 (używa `upscale=` hooka).
