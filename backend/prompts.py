"""Mode- and style-specific captioning instructions for the VLM.

Captions are natural-language English (best for the FLUX T5 text encoder),
without meta phrases like "the image shows". Two styles are supported:

  - "concise":  3-5 short factual sentences, direct, no hedging, no speculation.
  - "detailed": one rich exhaustive paragraph.
"""
from __future__ import annotations
import json

# Universal FLUX.2 rules: its text encoder is an LLM (Mistral/Qwen3), so it wants
# natural sentences about object relationships, attributes and actions — not tags,
# and no subjective/quality words.
_COMMON = (
    " Write in full, natural sentences, not a list of tags. Describe the spatial "
    "relationships between the elements (what is next to, in front of, or behind "
    "what) and any actions taking place. Do not use subjective or quality words "
    "such as \"beautiful\", \"stunning\", \"dramatic\", \"moody\", \"masterpiece\", "
    "\"high quality\" or \"8k\"."
)

_TAIL = (
    " Do not begin with phrases like \"the image shows\", \"this is a photo of\" "
    "or \"a picture of\". Output only the caption, nothing else."
)

_CONCISE_RULES = (
    " Write 3 to 5 short, factual sentences (about 60-90 words total). Be direct: "
    "never use hedging words such as \"appears to\", \"seems\", \"looks like\", "
    "\"likely\", \"probably\", \"suggesting\" or \"presenting as\". Describe only "
    "what is clearly visible — do not guess materials, age, or hidden/off-frame "
    "details."
)

_DETAILED_RULES = " Write a single rich, detailed paragraph covering every visible attribute."

# --------------------------------------------------------------------------- #
# Per-mode focus (what to cover). Phrased to work for both styles.
# --------------------------------------------------------------------------- #
_FOCUS = {
    "person": (
        "Caption this image for training a FLUX LoRA of a specific person. "
        "Describe ONLY what changes from photo to photo, so the trigger word can "
        "absorb the person's fixed likeness. Refer to the subject generically as "
        "\"the person\", \"the man\" or \"the woman\". Cover, only if visible: the "
        "pose and what the person is doing; the facial expression and the direction "
        "of the gaze; all clothing (type and color) and accessories (glasses, "
        "jewelry, hat); the shot type (close-up, portrait, half-body, full-body) "
        "and the camera angle; the background and setting; the lighting; and the "
        "spatial relationship between the person and surrounding objects. Do NOT "
        "describe the subject's permanent identity — skip facial features, face "
        "shape, eye color, hair color or length, skin tone and body build, and do "
        "not estimate age."
    ),
    "architecture": (
        "Caption this building or structure for FLUX LoRA training. State the "
        "building type and architectural style, the main materials and their "
        "colors, and notable features (facade, windows, roof, ornamentation). "
        "Note the surroundings, the time of day and weather, the viewpoint and "
        "camera angle, and the lighting."
    ),
    "landscape": (
        "Caption this landscape for FLUX LoRA training. State the type of scenery "
        "and the main terrain and landforms, the vegetation and any water, and the "
        "sky and clouds. Note the weather, time of day and season, the dominant "
        "colors, the composition (foreground to background), and the lighting and "
        "mood."
    ),
    "generic": (
        "Caption this image for FLUX LoRA training. State the main subject and its "
        "key attributes, the important secondary objects, the colors and setting, "
        "the framing and camera angle, and the lighting."
    ),
}


def get_prompt(mode: str, style: str = "concise") -> str:
    focus = _FOCUS.get(mode, _FOCUS["generic"])
    rules = _CONCISE_RULES if style != "detailed" else _DETAILED_RULES
    return focus + rules + _COMMON + _TAIL


# Leading meta phrases stripped from model output as a safety net.
_META_PREFIXES = (
    "the image shows", "the image depicts", "the image features",
    "this image shows", "this image depicts", "this is a photo of",
    "this is an image of", "this is a picture of", "a photo of",
    "a picture of", "an image of", "the photo shows", "we see",
    "in this image", "here we see", "the picture shows", "this photo shows",
)


def clean_caption(text: str) -> str:
    """Trim whitespace and remove a leading meta phrase if present."""
    out = " ".join(text.strip().split())
    low = out.lower()
    for pref in _META_PREFIXES:
        if low.startswith(pref):
            out = out[len(pref):].lstrip(" ,:.-")
            if out:
                out = out[0].upper() + out[1:]
            break
    return out


# =========================================================================== #
# FLUX.2 prompt studio — build/refine generation prompts (text-only).
#
# Based on the FLUX.2 prompting guide: the text encoder is an LLM, so it wants
# direct, literal language and a layered scene description, not keyword tags.
# Structure: subject + action -> scene context -> composition -> lighting -> style.
# =========================================================================== #
_STUDIO_BASE = (
    "You are a prompt engineer for the FLUX.2 text-to-image model. FLUX.2's text "
    "encoder is a large language model, so it follows natural, literal language and "
    "detailed scene descriptions, not keyword tags. You turn the user's input into "
    "one strong FLUX.2 prompt written as fluent English prose."
)

_STUDIO_RULES = (
    " Follow this layered structure in a single flowing description: lead with the "
    "main subject and what it is doing, then the location and scene context, then the "
    "composition and camera (shot type, angle, depth of field), then the lighting and "
    "color, and finally the style or material finish. Use concrete nouns, verbs, "
    "materials, textures and colors. Use concrete lighting terms (for example softbox, "
    "rim light, golden hour, warm sunset light). Keep one coherent vision with no "
    "contradictions (do not mix, e.g., night and daylight). Keep any negatives short "
    "and targeted. Do NOT use Stable Diffusion-style quality words or spell tokens "
    "such as \"masterpiece\", \"best quality\", \"8k\", \"ultra-detailed\", \"trending "
    "on artstation\", and do NOT output a comma-separated list of tags."
)

_STUDIO_OUTPUT = (
    " Always write the prompt in English, even if the input is in another language. "
    "Output ONLY the final prompt as one cohesive paragraph — no preamble, no quotation "
    "marks, no headings, no explanations or notes."
)

_STUDIO_ACTION = {
    "expand": (
        " The user gives a short idea. Expand it into a complete, vivid FLUX.2 prompt, "
        "inventing plausible concrete details (setting, composition, lighting, "
        "materials) that fit the idea while staying faithful to it."
    ),
    "refine": (
        " The user gives an existing prompt that may be messy, tag-based, or written "
        "for another model. Rewrite it as a clean FLUX.2 prompt: preserve their intent "
        "and key elements, convert tags into natural sentences, remove quality spell "
        "words and contradictions, and add the missing structural layers (subject, "
        "scene, composition, lighting, style). Do not introduce major new subjects."
    ),
}

_STUDIO_SUBJECT = {
    "auto": "",
    "person": (
        " The subject is a person: describe pose, expression, gaze, wardrobe with "
        "textures and colors, and the depth of the background."
    ),
    "product": (
        " The subject is a product: emphasise the material finish, surface highlights "
        "and reflections, the viewing angle, and a clean studio context."
    ),
    "landscape": (
        " The subject is a landscape or scene: describe the terrain and landforms, "
        "vegetation and water, the sky and weather, the time of day and season, and the "
        "atmospheric light, ordered from foreground to background."
    ),
    "architecture": (
        " The subject is a building or structure: describe its type and architectural "
        "style, the main materials and facade details, the surroundings, the viewpoint "
        "and camera angle, and the light."
    ),
}


def build_studio_system(action: str = "expand", subject: str = "auto") -> str:
    """Assemble the system instruction for the FLUX.2 prompt studio."""
    act = _STUDIO_ACTION.get(action, _STUDIO_ACTION["expand"])
    subj = _STUDIO_SUBJECT.get(subject, "")
    return _STUDIO_BASE + _STUDIO_RULES + act + subj + _STUDIO_OUTPUT


# Leading conversational fillers some models emit despite the output rule.
_STUDIO_PREFIXES = (
    "here is the prompt", "here's the prompt", "here is your prompt",
    "here is a prompt", "here's a prompt", "sure, here is", "sure, here's",
    "certainly", "of course", "prompt:", "flux.2 prompt:", "final prompt:",
)


def clean_prompt(text: str) -> str:
    """Strip wrapping quotes/fences and a leading conversational filler."""
    out = text.strip()
    if out.startswith("```"):
        # Drop a leading fenced-code marker line and any trailing fence.
        lines = out.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        out = "\n".join(lines).strip()
    low = out.lower()
    for pref in _STUDIO_PREFIXES:
        if low.startswith(pref):
            out = out[len(pref):].lstrip(" ,:.-\n")
            break
    out = out.strip().strip('"').strip("'").strip()
    return out


# =========================================================================== #
# Ideogram 4 — strukturalne opisy JSON.
#
# Ideogram 4 był trenowany na opisach JSON o ścisłej kolejności kluczy i
# kompaktowym zapisie. Model (VLM/LLM) generuje treść, a poprawną strukturę
# składamy tutaj, w Pythonie — niezależnie od tego, co dokładnie zwróci model.
# =========================================================================== #
def _extract_json_object(raw: str) -> dict | None:
    """Wyłuskaj i sparsuj pierwszy obiekt {...} z surowego tekstu modelu."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(raw[start:end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _norm_elements(raw_elements) -> list[dict]:
    """Sprowadź listę elementów do {type:obj,description} / {type:text,content}."""
    out: list[dict] = []
    if not isinstance(raw_elements, list):
        return out
    for el in raw_elements:
        if not isinstance(el, dict):
            continue
        if el.get("type") == "text" or "content" in el:
            out.append({"type": "text", "content": str(el.get("content", "")).strip()})
        else:
            desc = el.get("description", el.get("name", ""))
            out.append({"type": "obj", "description": str(desc).strip()})
    return out


def _norm_style(raw_style) -> dict:
    """Złóż style_description w ścisłej kolejności z dokładnie jednym z photo/art_style."""
    raw_style = raw_style if isinstance(raw_style, dict) else {}
    style: dict = {
        "aesthetics": str(raw_style.get("aesthetics", "")).strip(),
        "lighting": str(raw_style.get("lighting", "")).strip(),
    }
    # Dokładnie jedno z photo / art_style. Domyślnie photo (dataset zdjęciowy).
    if "art_style" in raw_style and "photo" not in raw_style:
        style["art_style"] = str(raw_style.get("art_style", "")).strip()
    else:
        style["photo"] = str(raw_style.get("photo", "")).strip()
    style["medium"] = str(raw_style.get("medium", "")).strip()
    return style


def _compact(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def normalize_ideogram(raw: str) -> str:
    """Zamień surowe wyjście modelu na poprawny, kompaktowy JSON-string Ideogram.

    Buduje nowy obiekt o ścisłej kolejności kluczy. Gdy wejście nie zawiera
    poprawnego JSON-a, zawija tekst w minimalny poprawny schemat (fallback).
    """
    obj = _extract_json_object(raw)
    if obj is None:
        text = " ".join(raw.strip().split())
        return _compact({
            "high_level_description": text,
            "compositional_deconstruction": {"background": text, "elements": []},
        })

    comp_raw = obj.get("compositional_deconstruction")
    comp_raw = comp_raw if isinstance(comp_raw, dict) else {}
    result: dict = {
        "high_level_description": str(obj.get("high_level_description", "")).strip(),
    }
    if "style_description" in obj:
        result["style_description"] = _norm_style(obj.get("style_description"))
    result["compositional_deconstruction"] = {
        "background": str(comp_raw.get("background", "")).strip(),
        "elements": _norm_elements(comp_raw.get("elements")),
    }
    return _compact(result)


def inject_trigger_ideogram(json_str: str, trigger: str) -> str:
    """Wstaw trigger na początek high_level_description (nie przed cały JSON).

    Gdy wejście nie jest poprawnym JSON-em lub trigger pusty — zwróć bez zmian.
    """
    trigger = trigger.strip()
    if not trigger:
        return json_str
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return json_str
    if not isinstance(obj, dict):
        return json_str
    hld = str(obj.get("high_level_description", "")).strip()
    obj["high_level_description"] = f"{trigger}, {hld}" if hld else trigger
    return _compact(obj)


def ideogram_pretty(json_str: str) -> str | None:
    """Ładnie sformatowany obiekt JSON do pliku .json. None gdy wejście błędne."""
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    return json.dumps(obj, indent=2, ensure_ascii=False)
