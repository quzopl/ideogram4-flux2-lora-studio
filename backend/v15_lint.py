"""Ideogram v15 prompt linter — flags common guideline violations.

Pure function: JSON string -> list of findings {"level": "err"|"warn", "msg": str}.
The rules mirror the v15 framework sections (HLD, desc, background, bbox,
specificity). A mirrored validator also runs in the browser-side bbox editor —
this one serves the prompt studio and the library.
"""
from __future__ import annotations
import json
import re

_ASPECT_RE = re.compile(r"^\d+:\d+$")
_WARM_RE = re.compile(r"\bwarm(\b|ly)", re.I)
_META_RE = re.compile(r"\b(this image (shows|depicts)|depicts|captures)\b", re.I)
_RENDER_RE = re.compile(
    r"\b(bokeh|depth of field|shallow focus|f/\d|mm lens|telephoto|chromatic aberration"
    r"|lens flare|vignett|film grain|motion blur|iso \d|drop shadow|cast shadow"
    r"|casts a shadow)\b", re.I)
_PART_RE = re.compile(
    r"\b(thorax|abdomen|wingtip|left leg|right leg|left arm|right arm|windshield"
    r"|wheels?|petals?|stem only|each limb|forearm only)\b", re.I)
_FLOOR_RE = re.compile(
    r"\b(pavement|puddles?|wet ground|rain-slicked|asphalt|cobblestones?|sidewalk"
    r"|the floor|the ground|turf|grass surface|snow on the ground|tile floor"
    r"|hardwood floor|reflective ground)\b", re.I)
_HEDGE_RE = re.compile(
    r"\b(things like|such as|e\.g\.|for example|or similar|various|could include"
    r"|might be|implied|suggested|hinted|barely visible|perhaps|reads as)\b", re.I)
_POSTFX_RE = re.compile(
    r"\b(film grain|kodak|portra|tri-x|iso noise|lens flare|chromatic aberration"
    r"|vignett|bokeh|halftone|risograph|brushstrokes?|paper texture|canvas texture)\b", re.I)
_ARRANGE_RE = re.compile(
    r"\b(rows of desks|grid of desks|chairs arranged|cars parked|customers seated"
    r"|room is filled with people|seated at the (desks|tables)|desks reced)\b", re.I)
_BUILTENV_RE = re.compile(
    r"\b(shop|stall|restaurant|store(front)?|sign|market|cafe|bar|workshop|poster"
    r"|cover|banner|menu)\b", re.I)


def _words(s: str) -> int:
    s = (s or "").strip()
    return len(s.split()) if s else 0


def lint_v15(json_str: str) -> list[dict]:
    """Check a v15 prompt; returns the findings list (empty = clean)."""
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return [{"level": "err", "msg": "The prompt is not valid JSON."}]
    if not isinstance(obj, dict):
        return [{"level": "err", "msg": "The prompt is not a JSON object."}]

    v: list[dict] = []
    warn = lambda m: v.append({"level": "warn", "msg": m})  # noqa: E731
    err = lambda m: v.append({"level": "err", "msg": m})    # noqa: E731

    if "style_description" in obj:
        warn("Legacy format: style_description does not exist in v15 — rewrite the "
             "style as prose into high_level_description or background.")

    ar = obj.get("aspect_ratio")
    if not (isinstance(ar, str) and _ASPECT_RE.match(ar.strip())):
        err("aspect_ratio must be a string in W:H format (e.g. 4:5).")

    hld = str(obj.get("high_level_description") or "")
    comp = obj.get("compositional_deconstruction")
    comp = comp if isinstance(comp, dict) else {}
    bg = str(comp.get("background") or "")

    if not hld.strip():
        warn("high_level_description is empty.")
    else:
        n = _words(hld)
        if n > 50:
            warn(f"HLD exceeds 50 words ({n}).")
        if _META_RE.search(hld):
            warn("HLD should not open with shows/depicts/captures — "
                 "start with the subject.")
    if _WARM_RE.search(hld) or _WARM_RE.search(bg):
        warn("The word \"warm\" as grading is discouraged in photorealism "
             "(amber/AI look) — name the light source concretely.")
    if _POSTFX_RE.search(bg):
        warn("background contains a medium/post-processing effect — "
             "move it to high_level_description.")
    if _ARRANGE_RE.search(bg):
        err("background describes placed furniture/people — that is foreground "
            "content, turn them into obj elements.")

    elements = comp.get("elements")
    elements = elements if isinstance(elements, list) else []
    text_count = 0
    for i, el in enumerate(elements, start=1):
        if not isinstance(el, dict):
            continue
        etype = el.get("type", "obj")
        tag = f"({etype} #{i}) "
        desc = str(el.get("desc") or "")
        if etype == "text":
            text_count += 1
            if not str(el.get("text") or "").strip():
                warn(tag + "empty text — a text element must carry literal content.")
        n = _words(desc)
        if n > 60:
            warn(tag + f"desc exceeds 60 words ({n}).")
        if _RENDER_RE.search(desc):
            err(tag + "desc contains camera/shadow language (bokeh, DOF, shadow…) — "
                      "move it to the HLD/background or cut it.")
        if _WARM_RE.search(desc):
            warn(tag + "\"warm\" in desc — discouraged.")
        if etype == "obj" and _PART_RE.search(desc):
            warn(tag + "desc looks like a single body/structural part — "
                       "one subject = one element, parts go into desc.")
        if _FLOOR_RE.search(desc):
            err(tag + "floor/ground/puddle described as an element — move it to "
                      "background (otherwise the renderer buries the subject's feet).")
        if _HEDGE_RE.search(desc):
            warn(tag + "hedging (such as/various/implied…) — commit to one "
                       "concrete value.")
        bbox = el.get("bbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            try:
                y1, x1, y2, x2 = (float(x) for x in bbox)
                if not (y1 < y2 and x1 < x2):
                    err(tag + "bbox: y1<y2 and x1<x2 required ([y1,x1,y2,x2]).")
                elif not all(0 <= c <= 1000 for c in (y1, x1, y2, x2)):
                    err(tag + "bbox: coordinates must fall within 0-1000.")
            except (TypeError, ValueError):
                err(tag + "bbox: four numbers [y1,x1,y2,x2].")

    if text_count == 0 and _BUILTENV_RE.search(hld + " " + bg):
        warn("The scene looks like a built environment / designed artifact but has "
             "no text elements — real scenes carry text almost everywhere.")
    return v
