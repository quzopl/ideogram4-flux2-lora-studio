"""Florence-2: obraz -> szkic promptu Ideogram v15 z realnymi bboxami.

Cztery zadania modelu (szczegółowy opis sceny, detekcja obiektów, opisy
regionów, OCR z pozycjami) sklejone w listę elementów v15: boxy z detekcji
wzbogacane opisami regionów po IoU, duplikaty odcinane, tekst z OCR jako
elementy text z dosłowną treścią. Wymiary znormalizowane do 0-1000 w
porządku [y1,x1,y2,x2] (notacja v15).

Model natywny w transformers >= 5 (bez trust_remote_code); ładowany leniwie,
zwalniany przez unload() razem z resztą modeli (przycisk "Zwolnij GPU").
Czyste funkcje (normalizacja, scalanie, montaż JSON) są niezależne od modelu.
"""
from __future__ import annotations
import json
import math
import os
import re
import threading

# Checkpointy skonwertowane pod natywną implementację w transformers >= 5
# (oryginalne microsoft/Florence-2-* wymagają trust_remote_code i starszych
# transformers). Większy wariant: florence-community/Florence-2-large-ft.
DEFAULT_MODEL = os.environ.get("FLORENCE_MODEL", "florence-community/Florence-2-base-ft")

_LOCK = threading.Lock()
_RUNTIME: dict | None = None   # {"model","processor","torch","device"}

# Standardowe proporcje, do których przyciągamy wymiary zdjęcia.
_ASPECTS = ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2",
            "9:16", "16:9", "21:9", "3:1", "1:3"]

_TAG_RE = re.compile(r"</?s>|<pad>|</?[^>]+>", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Czyste funkcje (testowalne bez modelu)
# --------------------------------------------------------------------------- #
def nearest_aspect(width: int, height: int) -> str:
    """Najbliższe standardowe W:H dla wymiarów obrazu (po logarytmie ilorazu)."""
    ar = width / height if height else 1.0
    best, best_d = "1:1", float("inf")
    for opt in _ASPECTS:
        w, h = (int(x) for x in opt.split(":"))
        d = abs(math.log(ar / (w / h)))
        if d < best_d:
            best, best_d = opt, d
    return best


def clean_label(label: str) -> str:
    label = _TAG_RE.sub(" ", label or "")
    label = re.sub(r"\s+", " ", label).strip()
    label = re.sub(r"^[\W_]+|[\W_]+$", "", label)
    return label or "object"


def norm_bbox_xyxy(box, width: int, height: int) -> list[int]:
    """Pikselowe [x1,y1,x2,y2] -> v15 [y1,x1,y2,x2] na siatce 0-1000."""
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    cx = lambda v: max(0, min(1000, round(v / width * 1000)))   # noqa: E731
    cy = lambda v: max(0, min(1000, round(v / height * 1000)))  # noqa: E731
    return [cy(y1), cx(x1), cy(y2), cx(x2)]


def quad_to_xyxy(coords) -> list[float]:
    """Czworokąt OCR (x,y * 4) -> obejmujący prostokąt [x1,y1,x2,y2]."""
    xs, ys = list(coords[0::2]), list(coords[1::2])
    return [min(xs), min(ys), max(xs), max(ys)]


def bbox_area(b) -> int:
    y1, x1, y2, x2 = b
    return max(0, y2 - y1) * max(0, x2 - x1)


def bbox_iou(a, b) -> float:
    iy1, ix1 = max(a[0], b[0]), max(a[1], b[1])
    iy2, ix2 = min(a[2], b[2]), min(a[3], b[3])
    inter = bbox_area([iy1, ix1, iy2, ix2])
    denom = bbox_area(a) + bbox_area(b) - inter
    return inter / denom if denom else 0.0


def merge_detections(od: dict, dense: dict, ocr: dict,
                     width: int, height: int) -> list[dict]:
    """Sklej OD + opisy regionów + OCR w elementy v15 (max 40)."""
    od = od if isinstance(od, dict) else {}
    dense = dense if isinstance(dense, dict) else {}
    ocr = ocr if isinstance(ocr, dict) else {}

    dense_items = []
    for label, box in zip(dense.get("labels", []), dense.get("bboxes", [])):
        bbox = norm_bbox_xyxy(box, width, height)
        if bbox_area(bbox) > 40:
            dense_items.append({"desc": clean_label(label), "bbox": bbox})

    elements: list[dict] = []
    for label, box in zip(od.get("labels", []), od.get("bboxes", [])):
        bbox = norm_bbox_xyxy(box, width, height)
        if bbox_area(bbox) <= 40:
            continue
        desc = clean_label(label)
        # opis regionu (gęstszy semantycznie) wygrywa z gołą etykietą detekcji
        best = max(dense_items, key=lambda it: bbox_iou(bbox, it["bbox"]), default=None)
        if best and bbox_iou(bbox, best["bbox"]) > 0.2:
            desc = best["desc"]
        elements.append({"type": "obj", "bbox": bbox, "desc": desc})

    if not elements:
        elements = [{"type": "obj", "bbox": it["bbox"], "desc": it["desc"]}
                    for it in dense_items[:20]]

    quads = ocr.get("quad_boxes", []) or ocr.get("bboxes", [])
    for label, box in zip(ocr.get("labels", []), quads):
        coords = [float(v) for v in box]
        xyxy = quad_to_xyxy(coords) if len(coords) >= 8 else coords[:4]
        bbox = norm_bbox_xyxy(xyxy, width, height)
        text = clean_label(label)
        if bbox_area(bbox) > 20 and text and text != "object":
            elements.append({"type": "text", "bbox": bbox, "text": text,
                             "desc": f'text "{text}"'})

    # deduplikacja: prawie identyczny box + ta sama treść = jeden element
    seen: list[dict] = []
    for el in sorted(elements, key=lambda e: (e["bbox"][0], e["bbox"][1])):
        dup = any(bbox_iou(el["bbox"], o["bbox"]) > 0.85 and el["desc"] == o["desc"]
                  for o in seen)
        if not dup:
            seen.append(el)
    return seen[:40]


def _cap_words(text: str, limit: int) -> str:
    """Przytnij do limitu słów na granicy zdania (twardo, gdy zdanie za długie)."""
    words = text.split()
    if len(words) <= limit:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    out: list[str] = []
    for s in sentences:
        if len(" ".join(out + [s]).split()) > limit:
            break
        out.append(s)
    return " ".join(out) if out else " ".join(words[:limit])


def build_v15_draft(caption: str, elements: list[dict],
                    width: int, height: int) -> str:
    """Zmontuj zminifikowany szkic JSON v15 z wyników analizy obrazu."""
    caption = " ".join((caption or "").split()) or "Uploaded image scene."
    out_els = []
    for el in elements:
        new = {"type": el.get("type", "obj")}
        if isinstance(el.get("bbox"), list) and len(el["bbox"]) == 4:
            new["bbox"] = [int(v) for v in el["bbox"]]
        if new["type"] == "text":
            new["text"] = str(el.get("text", ""))
        new["desc"] = str(el.get("desc", ""))
        out_els.append(new)
    obj = {
        "aspect_ratio": nearest_aspect(width, height),
        "high_level_description": _cap_words(caption, 50),
        "compositional_deconstruction": {"background": caption, "elements": out_els},
    }
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# --------------------------------------------------------------------------- #
# Model (leniwie ładowany)
# --------------------------------------------------------------------------- #
def _get_runtime() -> dict:
    global _RUNTIME
    if _RUNTIME is not None:
        return _RUNTIME
    with _LOCK:
        if _RUNTIME is not None:
            return _RUNTIME
        import torch
        from transformers import AutoProcessor, Florence2ForConditionalGeneration

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        model = Florence2ForConditionalGeneration.from_pretrained(
            DEFAULT_MODEL, dtype=dtype).to(device)
        model.eval()
        processor = AutoProcessor.from_pretrained(DEFAULT_MODEL)
        _RUNTIME = {"model": model, "processor": processor,
                    "torch": torch, "device": device}
        return _RUNTIME


def unload() -> None:
    """Zwolnij Florence-2 z pamięci (spinane z przyciskiem 'Zwolnij GPU')."""
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


def _run_task(image, task: str) -> dict | str:
    rt = _get_runtime()
    inputs = rt["processor"](text=task, images=image, return_tensors="pt")
    moved = {}
    for k, v in inputs.items():
        if hasattr(v, "to"):
            v = v.to(rt["device"])
            if k == "pixel_values":
                v = v.to(rt["model"].dtype)
        moved[k] = v
    with rt["torch"].inference_mode():
        ids = rt["model"].generate(
            input_ids=moved["input_ids"],
            pixel_values=moved["pixel_values"],
            max_new_tokens=1024,
            num_beams=3,
        )
    raw = rt["processor"].batch_decode(ids, skip_special_tokens=False)[0]
    parsed = rt["processor"].post_process_generation(
        raw, task=task, image_size=(image.width, image.height))
    return parsed.get(task, next(iter(parsed.values()), None)) if isinstance(parsed, dict) else parsed


def analyze_image(image) -> tuple[str, list[dict]]:
    """PIL.Image -> (opis sceny, elementy v15). Ładuje model przy 1. użyciu."""
    caption = _run_task(image, "<MORE_DETAILED_CAPTION>")
    caption = caption if isinstance(caption, str) else ""
    od = _run_task(image, "<OD>")
    dense = _run_task(image, "<DENSE_REGION_CAPTION>")
    ocr = _run_task(image, "<OCR_WITH_REGION>")
    elements = merge_detections(
        od if isinstance(od, dict) else {},
        dense if isinstance(dense, dict) else {},
        ocr if isinstance(ocr, dict) else {},
        image.width, image.height)
    # Z opisu sceny zdejmujemy tylko tagi specjalne — interpunkcja zostaje.
    caption = re.sub(r"\s+", " ", _TAG_RE.sub(" ", caption)).strip()
    return caption, elements
