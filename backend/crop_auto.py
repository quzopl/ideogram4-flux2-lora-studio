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
