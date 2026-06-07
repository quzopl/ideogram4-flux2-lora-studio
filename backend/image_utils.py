"""Image preprocessing for FLUX LoRA datasets.

Handles aspect-ratio aware bucketing, resizing and format/quality conversion.
"""
from __future__ import annotations

from PIL import Image, ImageOps

# Extensions we accept as input.
SUPPORTED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"}


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


def process_image(
    path: str,
    target: int,
    step: int,
    square: bool,
) -> tuple[Image.Image, tuple[int, int]]:
    """Load an image, fix EXIF orientation and resize/crop it to its bucket.

    Uses a cover-fit + centre crop so the output exactly matches the bucket
    dimensions without distortion. Returns the processed RGB image and its size.
    """
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)  # honour camera orientation
    img = img.convert("RGB")
    bw, bh = compute_bucket(img.width, img.height, target, step, square)
    fitted = ImageOps.fit(img, (bw, bh), method=Image.LANCZOS, centering=(0.5, 0.5))
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
