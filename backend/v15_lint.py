"""Linter promptów Ideogram v15 — wykrywa typowe naruszenia wytycznych.

Czysta funkcja: JSON-string -> lista znalezisk {"level": "err"|"warn", "msg": str}.
Reguły odpowiadają sekcjom frameworku v15 (HLD, desc, background, bbox,
specyficzność). Lustrzany walidator działa też w edytorze bbox po stronie
przeglądarki — ten tutaj obsługuje studio promptów i bibliotekę.
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
    """Sprawdź prompt v15; zwraca listę znalezisk (pusta = czysto)."""
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return [{"level": "err", "msg": "Prompt nie jest poprawnym JSON-em."}]
    if not isinstance(obj, dict):
        return [{"level": "err", "msg": "Prompt nie jest obiektem JSON."}]

    v: list[dict] = []
    warn = lambda m: v.append({"level": "warn", "msg": m})  # noqa: E731
    err = lambda m: v.append({"level": "err", "msg": m})    # noqa: E731

    if "style_description" in obj:
        warn("Stary format: style_description nie istnieje w v15 — przepisz styl "
             "prozą do high_level_description lub background.")

    ar = obj.get("aspect_ratio")
    if not (isinstance(ar, str) and _ASPECT_RE.match(ar.strip())):
        err("aspect_ratio musi być stringiem w formacie W:H (np. 4:5).")

    hld = str(obj.get("high_level_description") or "")
    comp = obj.get("compositional_deconstruction")
    comp = comp if isinstance(comp, dict) else {}
    bg = str(comp.get("background") or "")

    if not hld.strip():
        warn("high_level_description jest puste.")
    else:
        n = _words(hld)
        if n > 50:
            warn(f"HLD przekracza 50 słów ({n}).")
        if _META_RE.search(hld):
            warn("HLD nie powinno zaczynać się od shows/depicts/captures — "
                 "zacznij od podmiotu.")
    if _WARM_RE.search(hld) or _WARM_RE.search(bg):
        warn("Słowo \"warm\" jako gradacja jest odradzane w fotorealizmie "
             "(amber/AI look) — opisz źródło światła konkretnie.")
    if _POSTFX_RE.search(bg):
        warn("background zawiera efekt medium/post-processingu — "
             "przenieś do high_level_description.")
    if _ARRANGE_RE.search(bg):
        err("background opisuje rozmieszczone meble/ludzi — to treść pierwszego "
            "planu, zrób z tego elementy obj.")

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
                warn(tag + "pusty text — element text musi nieść dosłowną treść.")
        n = _words(desc)
        if n > 60:
            warn(tag + f"desc przekracza 60 słów ({n}).")
        if _RENDER_RE.search(desc):
            err(tag + "desc zawiera język kamery/cienia (bokeh, DOF, shadow…) — "
                      "przenieś do HLD/background albo usuń.")
        if _WARM_RE.search(desc):
            warn(tag + "\"warm\" w desc — odradzane.")
        if etype == "obj" and _PART_RE.search(desc):
            warn(tag + "desc wygląda na pojedynczą część podmiotu — "
                       "jeden podmiot = jeden element, części do desc.")
        if _FLOOR_RE.search(desc):
            err(tag + "opis nawierzchni/podłogi/kałuży jako element — przenieś do "
                      "background (inaczej renderer wkopie nogi postaci w grunt).")
        if _HEDGE_RE.search(desc):
            warn(tag + "hedging (such as/various/implied…) — commit do "
                       "konkretnej wartości.")
        bbox = el.get("bbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            try:
                y1, x1, y2, x2 = (float(x) for x in bbox)
                if not (y1 < y2 and x1 < x2):
                    err(tag + "bbox: wymagane y1<y2 oraz x1<x2 ([y1,x1,y2,x2]).")
                elif not all(0 <= c <= 1000 for c in (y1, x1, y2, x2)):
                    err(tag + "bbox: współrzędne muszą mieścić się w 0–1000.")
            except (TypeError, ValueError):
                err(tag + "bbox: cztery liczby [y1,x1,y2,x2].")

    if text_count == 0 and _BUILTENV_RE.search(hld + " " + bg):
        warn("Scena wygląda na built environment / designed artifact, a nie ma "
             "elementów text — realne sceny niosą tekst niemal wszędzie.")
    return v
