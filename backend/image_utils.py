"""Image preprocessing for FLUX LoRA datasets.

Handles aspect-ratio aware bucketing, resizing and format/quality conversion.
"""
from __future__ import annotations

from PIL import Image, ImageOps

# Enable HEIC/HEIF read/write (iPhone photos) — optional dependency.
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:  # pragma: no cover - environment without pillow-heif
    pass

# Extensions we accept as input.
SUPPORTED_EXT = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif",
    ".heic", ".heif",
}


def compute_bucket(w: int, h: int, target: int, step: int, square: bool) -> tuple[int, int]:
    """Return target (width, height) snapped to a multiple of ``step``.

    In bucket mode the aspect ratio is preserved while keeping the total pixel
    count close to ``target * target`` (the FLUX/SDXL bucketing convention).
    In square mode the output is simply ``target x target``.
    """
    if square:
        return target, target

    area = float(target) * float(target)
    ar = w / h
    bw = round((area * ar) ** 0.5 / step) * step
    bh = round((area / ar) ** 0.5 / step) * step
    bw = max(step, int(bw))
    bh = max(step, int(bh))
    return bw, bh


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


def save_image(img: Image.Image, path: str, fmt: str, jpg_quality: int = 95) -> None:
    """Persist ``img`` to ``path`` in PNG or JPEG format."""
    if fmt == "jpg":
        img.save(path, format="JPEG", quality=jpg_quality, subsampling=0)
    else:
        img.save(path, format="PNG", optimize=True)


def make_thumbnail(img: Image.Image, max_side: int = 640) -> Image.Image:
    """Return a downscaled copy suitable for the web preview."""
    thumb = img.copy()
    thumb.thumbnail((max_side, max_side), Image.LANCZOS)
    return thumb
