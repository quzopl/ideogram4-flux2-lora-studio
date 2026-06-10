"""Mode- and style-specific captioning instructions for the VLM.

Captions are natural-language English (best for the FLUX T5 text encoder),
without meta phrases like "the image shows". Two styles are supported:

  - "concise":  3-5 short factual sentences, direct, no hedging, no speculation.
  - "detailed": one rich exhaustive paragraph.
"""
from __future__ import annotations
import json
import math
import re

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
    "person_detail": (
        "Caption this image of a person for FLUX LoRA training, describing the "
        "person in rich physical detail. Cover, only if visible: the approximate age "
        "and body build; the face (face shape, eyes, eyebrows, nose, lips, "
        "complexion) and EVERY distinguishing mark — scars, moles, beauty marks, "
        "freckles, birthmarks, tattoos and piercings — saying roughly where each one "
        "is (for example \"a small scar above the left eyebrow\", \"a mole on the "
        "right cheek\"); the hair (length, color, texture and style) and any facial "
        "hair; visible body hair such as chest hair or arm hair; and the skin tone "
        "and texture. Then describe the pose and what the person is doing, the facial "
        "expression and gaze, all clothing (type and color) and accessories, the shot "
        "type and camera angle, the background and setting, and the lighting. Be "
        "specific and concrete about the location of each distinguishing feature."
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
# Ideogram 4 — structured JSON captions.
#
# Ideogram 4 was trained on JSON captions with a strict key order and compact
# formatting. The model (VLM/LLM) generates the content; the correct structure
# is assembled here in Python — regardless of what exactly the model returns.
# =========================================================================== #
def _extract_json_object(raw: str) -> dict | None:
    """Extract and parse the first {...} object from the raw model output."""
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
    """Reduce the element list to {type:obj,description} / {type:text,content}."""
    out: list[dict] = []
    if not isinstance(raw_elements, list):
        return out
    for el in raw_elements:
        if not isinstance(el, dict):
            continue
        # An explicit "type" is authoritative; only infer from keys when it's absent.
        etype = el.get("type")
        if etype == "obj":
            is_text = False
        elif etype == "text":
            is_text = True
        else:
            is_text = "content" in el
        if is_text:
            out.append({"type": "text", "content": str(el.get("content") or "").strip()})
        else:
            desc = el.get("description") or el.get("name") or ""
            out.append({"type": "obj", "description": str(desc).strip()})
    return out


def _norm_style(raw_style) -> dict:
    """Assemble style_description in strict order with exactly one of photo/art_style."""
    raw_style = raw_style if isinstance(raw_style, dict) else {}
    style: dict = {
        "aesthetics": str(raw_style.get("aesthetics", "")).strip(),
        "lighting": str(raw_style.get("lighting", "")).strip(),
    }
    # Exactly one of photo / art_style. Defaults to photo (photo dataset).
    if "art_style" in raw_style and "photo" not in raw_style:
        style["art_style"] = str(raw_style.get("art_style", "")).strip()
    else:
        style["photo"] = str(raw_style.get("photo", "")).strip()
    style["medium"] = str(raw_style.get("medium", "")).strip()
    return style


def _compact(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def normalize_ideogram(raw: str) -> str:
    """Turn raw model output into a valid, compact Ideogram JSON string.

    Builds a fresh object with a strict key order. When the input contains no
    valid JSON, wraps the text in a minimal valid schema (fallback).
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
    """Insert the trigger at the start of high_level_description (not before the JSON).

    If the input is not valid JSON or the trigger is empty — return unchanged.
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
    """Pretty-printed JSON object for the .json file. None when the input is invalid."""
    try:
        obj = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    return json.dumps(obj, indent=2, ensure_ascii=False)


# --- Instruction: describe an image as Ideogram 4 JSON --------------------- #
_IDEOGRAM_SCHEMA = (
    " Return ONLY one JSON object, nothing else, with exactly these top-level "
    "keys in this order: \"high_level_description\" (one or two sentences), "
    "\"style_description\" (an object with keys in this order: \"aesthetics\", "
    "\"lighting\", then exactly one of \"photo\" or \"art_style\" — use \"photo\" "
    "for photographs — then \"medium\"), and \"compositional_deconstruction\" "
    "(an object with \"background\" describing the setting and \"elements\", a "
    "list where each item is either {\"type\":\"obj\",\"description\":\"...\"} for "
    "an object or {\"type\":\"text\",\"content\":\"...\"} for visible text). Do not "
    "add any other keys, comments or prose outside the JSON."
)

_IDEOGRAM_FOCUS = {
    "person": (
        "Describe this image of a person as an Ideogram structured caption for "
        "training a LoRA of a specific person. Describe ONLY what varies between "
        "photos — pose, action, facial expression, gaze, all clothing and "
        "accessories, shot type, camera angle, background and lighting — and refer "
        "to the subject generically as \"the person\". Do NOT describe the person's "
        "permanent identity or likeness: skip facial features, face shape, eye and "
        "hair color, skin tone, body build and age, so the trigger word can absorb them."
    ),
    "person_detail": (
        "Describe this image of a person as an Ideogram structured caption with rich "
        "physical detail: the approximate age and body build; the face and EVERY "
        "distinguishing mark — scars, moles, beauty marks, freckles, birthmarks, "
        "tattoos, piercings — and roughly where each one is; hair length, color, "
        "texture and style and any facial hair; visible body hair such as chest hair; "
        "and skin tone. Then the pose and action, facial expression and gaze, all "
        "clothing and accessories, shot type, camera angle, background and lighting."
    ),
    "architecture": (
        "Describe this building or structure as an Ideogram structured caption: the "
        "building type and architectural style, main materials and colors, notable "
        "features, surroundings, time of day, viewpoint and lighting."
    ),
    "landscape": (
        "Describe this landscape as an Ideogram structured caption: the type of "
        "scenery, terrain and landforms, vegetation and water, sky and weather, time "
        "of day and season, dominant colors and lighting."
    ),
    "generic": (
        "Describe this image as an Ideogram structured caption: the main subject and "
        "its key attributes, important secondary objects, colors and setting, framing, "
        "camera angle and lighting."
    ),
}


def get_ideogram_prompt(mode: str) -> str:
    focus = _IDEOGRAM_FOCUS.get(mode, _IDEOGRAM_FOCUS["generic"])
    return focus + _IDEOGRAM_SCHEMA


# --- Instruction: prompt studio in Ideogram mode (text-only) --------------- #
_IDEOGRAM_STUDIO_BASE = (
    "You are a prompt engineer for the Ideogram 4 text-to-image model, which was "
    "trained on structured JSON captions. You turn the user's input into one valid "
    "Ideogram JSON prompt."
)

_IDEOGRAM_STUDIO_ACTION = {
    "expand": (
        " The user gives a short idea. Expand it into a complete Ideogram JSON "
        "prompt, inventing plausible concrete details (setting, composition, "
        "lighting, medium) that fit the idea while staying faithful to it."
    ),
    "refine": (
        " The user gives an existing prompt that may be messy, tag-based, or written "
        "for another model. Rewrite it as a valid Ideogram JSON prompt: preserve "
        "their intent and key elements, and fill the schema fields. Do not introduce "
        "major new subjects."
    ),
}


def build_ideogram_studio_system(action: str = "expand", subject: str = "auto") -> str:
    act = _IDEOGRAM_STUDIO_ACTION.get(action, _IDEOGRAM_STUDIO_ACTION["expand"])
    # Reuse the FLUX studio subject hints — they read as general visual guidance
    # and work fine as extra context for the Ideogram studio system prompt.
    subj = _STUDIO_SUBJECT.get(subject, "")
    return _IDEOGRAM_STUDIO_BASE + act + subj + _IDEOGRAM_SCHEMA


def caption_instruction(mode: str, style: str, fmt: str) -> str:
    """Captioning instruction shared by both engines (local and LM Studio)."""
    if fmt in ("ideogram", "aitoolkit"):
        return get_ideogram_prompt(mode)
    return get_prompt(mode, style)


def postprocess_caption(text: str, fmt: str) -> str:
    """Raw-caption post-processing by format (shared by both engines)."""
    if fmt in ("ideogram", "aitoolkit"):
        return normalize_ideogram(text)
    return clean_caption(text)


# =========================================================================== #
# Ideogram — framework v15 (the studio's text->JSON prompt converter).
# Three keys: aspect_ratio, high_level_description, compositional_deconstruction.
# No style_description/color_palette — style, light and medium go as prose into
# the HLD or background. Separate from normalize_ideogram (kept for dataset captions).
# =========================================================================== #
_ASPECT_RE = re.compile(r"^\s*(\d+)\s*:\s*(\d+)\s*$")
_PX_SIZE_RE = re.compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$")


def _norm_aspect_ratio(value) -> str | None:
    """'W:H' or 'WxH' (px) -> reduced 'W:H'; None when missing/'auto'/invalid."""
    if not isinstance(value, str):
        return None
    m = _ASPECT_RE.match(value) or _PX_SIZE_RE.match(value)
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    if w <= 0 or h <= 0:
        return None
    g = math.gcd(w, h)
    return f"{w // g}:{h // g}"


def _norm_bbox(value):
    """bbox = a list of 4 numbers -> [y1,x1,y2,x2] with y1<y2, x1<x2; else None."""
    if not (isinstance(value, list) and len(value) == 4):
        return None
    try:
        y1, x1, y2, x2 = (int(v) for v in value)
    except (TypeError, ValueError):
        return None
    if y1 > y2:
        y1, y2 = y2, y1
    if x1 > x2:
        x1, x2 = x2, x1
    return [y1, x1, y2, x2]


def _prose(value) -> str:
    """Prose field: strings unchanged; a dict/list from the model -> values as prose."""
    if isinstance(value, dict):
        return ", ".join(_prose(v) for v in value.values() if _prose(v))
    if isinstance(value, list):
        return ", ".join(_prose(v) for v in value if _prose(v))
    return str(value if value is not None else "").strip()


def _norm_elements_v15(raw_elements) -> list:
    """v15 elements in strict key order: obj=type,bbox?,desc;
    text=type,bbox?,text,desc. No color_palette."""
    out: list[dict] = []
    if not isinstance(raw_elements, list):
        return out
    for el in raw_elements:
        if not isinstance(el, dict):
            continue
        etype = el.get("type")
        is_text = etype == "text" or (etype != "obj" and "text" in el)
        new: dict = {"type": "text" if is_text else "obj"}
        bbox = _norm_bbox(el.get("bbox"))
        if bbox is not None:
            new["bbox"] = bbox
        if is_text:
            new["text"] = str(el.get("text") or el.get("content") or "").strip()
        new["desc"] = _prose(el.get("desc", el.get("description", "")))
        out.append(new)
    return out


def _unwrap_v15(obj: dict) -> dict:
    """Unwrap double-encoded JSON and caption/data wrappers (section 13.1)."""
    for key in ("caption", "data"):
        inner = obj.get(key)
        if isinstance(inner, dict) and (
            "high_level_description" in inner or "compositional_deconstruction" in inner
        ):
            obj = inner
        elif isinstance(inner, str):
            parsed = _extract_json_object(inner)
            if parsed is not None:
                obj = parsed
    # Double-encoded JSON inside the hld — possibly fenced in ```json``` by the model.
    # Real prose never contains the schema key names.
    hld = obj.get("high_level_description")
    if isinstance(hld, str) and (
        "high_level_description" in hld or "compositional_deconstruction" in hld
    ):
        parsed = _extract_json_object(hld)
        if parsed is not None and (
            "high_level_description" in parsed or "compositional_deconstruction" in parsed
        ):
            obj = parsed
    return obj


def normalize_ideogram_v15(raw: str, default_ratio: str = "1:1") -> str:
    """Raw model output -> compact Ideogram JSON compliant with framework v15.

    Enforces the structure (key order, aspect_ratio format, element shape) and
    strips legacy-schema fields (style_description etc.). When the input has no
    valid JSON, wraps the text in a minimal valid schema.
    """
    obj = _extract_json_object(raw)
    if obj is None:
        text = " ".join(raw.strip().split())
        return _compact({
            "aspect_ratio": default_ratio,
            "high_level_description": text,
            "compositional_deconstruction": {"background": text, "elements": []},
        })
    obj = _unwrap_v15(obj)
    ratio = (_norm_aspect_ratio(obj.get("aspect_ratio"))
             or _norm_aspect_ratio(obj.get("size"))
             or default_ratio)
    comp_raw = obj.get("compositional_deconstruction")
    comp_raw = comp_raw if isinstance(comp_raw, dict) else {}
    return _compact({
        "aspect_ratio": ratio,
        "high_level_description": _prose(obj.get("high_level_description", "")),
        "compositional_deconstruction": {
            "background": _prose(comp_raw.get("background", "")),
            "elements": _norm_elements_v15(comp_raw.get("elements")),
        },
    })


_IDEOGRAM_V15_BASE = (
    "You are a prompt engineer for the Ideogram 4 text-to-image model. You convert a "
    "natural-language idea into ONE structured JSON caption (framework v15) consumed by "
    "the image renderer."
)

_IDEOGRAM_V15_CONTRACT = (
    " OUTPUT CONTRACT: emit a SINGLE MINIFIED one-line JSON object with exactly these "
    "three top-level keys in this order: \"aspect_ratio\", \"high_level_description\", "
    "\"compositional_deconstruction\" (an object with \"background\" then \"elements\"). "
    "No code fences, no comments, no other top-level keys. The old fields "
    "style_description, aesthetics, lighting, photo, color_palette, medium and art_style "
    "DO NOT EXIST anymore — style, lighting, medium and mood are woven as prose into "
    "high_level_description or background. Keep non-ASCII characters as-is (CJK, "
    "Cyrillic, diacritics); never \\uNNNN-escape or transliterate. Use single quotes for "
    "quoted names in prose fields ('Joe's Diner'); the \"text\" field of a text element "
    "carries the user's literal content."
)

_IDEOGRAM_V15_ASPECT = (
    " ASPECT_RATIO: a \"W:H\" string of positive integers, chosen FIRST — it drives every "
    "bbox decision. If the user gives W:H, copy it; if they give pixel dimensions "
    "(768x1024), reduce to a fraction (3:4); otherwise pick by medium and composition: "
    "panorama 16:9 or 3:1, portrait subject 9:16 or 4:5, book cover 2:3, poster 3:4, "
    "ambiguous 1:1. NEVER emit the literal \"auto\"."
)

_IDEOGRAM_V15_HLD = (
    " HIGH_LEVEL_DESCRIPTION: an observational summary, HARD LIMIT 50 words, one long "
    "sentence (max two), reading like a short prompt. Start with the subject — never "
    "'this image shows', 'depicts' or 'captures'. Identify the subject(s), the medium and "
    "the overall composition; name recognizable brands and characters in full ('Nike Air "
    "Jordan 1', 'Eiffel Tower'). Do not enumerate granular details — those go to element "
    "desc or background. Post-processing effects (film grain, halation, Kodak Portra, "
    "lens diffusion, bokeh) are described HERE as prose, only if the user asked for them. "
    "For a transparent background, weave in the literal phrase 'on a transparent "
    "background'."
)

_IDEOGRAM_V15_ELEMENTS = (
    " ELEMENTS: each element is {\"type\":\"obj\",\"bbox\":[y1,x1,y2,x2],\"desc\":\"...\"}"
    " or {\"type\":\"text\",\"bbox\":[y1,x1,y2,x2],\"text\":\"LINE 1\\nLINE 2\","
    "\"desc\":\"...\"}; bbox is optional per element. ONE SUBJECT = ONE ELEMENT "
    "(critical): a coherent subject — one animal, person, vehicle, building, plant, "
    "instrument, machine — is exactly ONE obj element; anatomical and structural parts, "
    "worn items (watch, jacket, jewelry) and held props are attributes inside its desc, "
    "NEVER separate elements. Multiple distinct subjects (a person AND a dog; three "
    "runners) get one element each. A transparent container plus its contents is ONE "
    "element; an opened car/machine with exposed interior is ONE element. DESC: 30-60 "
    "words, hard cap 60; identity first, then the key attributes, then one "
    "distinguishing detail; each desc is a standalone catalog entry. For people always "
    "name: skin tone, hair (color + style), every visible garment with its color, facial "
    "expression and gaze, pose, one distinguishing feature. For objects: shape, material, "
    "color, characteristic parts. NEVER put in desc: shadows of any kind; camera/render "
    "language (depth of field, sharpness, bokeh, exposure, motion blur, lens flare, "
    "chromatic aberration, grain) — render properties go to high_level_description or "
    "background as prose and ONLY when the user named them; the one exception is a "
    "viewpoint/angle ('low-angle', \"bird's-eye view\"), allowed once, usually on the "
    "main subject. No impression words (luminous, radiant, vibrant, gorgeous, stunning, "
    "breathtaking) — use observable properties instead. Do not repeat scene-wide light, "
    "weather or surroundings per element — describe them ONCE in background. Anchor "
    "positions to named references ('resting on the lower-right corner of the table in "
    "front of the laptop', not 'sitting on the surface')."
)

_IDEOGRAM_V15_BACKGROUND = (
    " BACKGROUND describes only the scene's SHELL: walls and finishes, floor/ground and "
    "its condition, ceiling and architecture, windows as architecture, atmosphere (sky, "
    "clouds, fog), the scene-wide ambient light, and distant out-of-focus context. NO "
    "DOUBLE COUNTING: every component lives in exactly one field — anything described in "
    "background must NOT also be an obj element. ALWAYS-BACKGROUND (never an obj): sky, "
    "clouds, horizon, distant mountains/hills/treelines, weather haze, distant skylines "
    "and blurred crowds, the surface the scene stands on, ambient walls or a studio "
    "backdrop. The floor/ground/pavement and its condition — wet, rain-slicked, puddles, "
    "reflections, snow, frost, spilled water, oil stains, footprints, tire marks, its "
    "material and texture — lives ONLY in background, zero tolerance, even if the input "
    "lists it as a foreground item; otherwise the renderer treats the floor obj as a "
    "flat 2D strip and buries the subject's feet. Discrete objects ON the floor (glass "
    "shards, crushed cans, leaves, stones, dropped tools) are still elements. Furniture, "
    "vehicles, equipment, people, decorations and freestanding lamps are obj elements, "
    "never background — do not smuggle them in as receding arrangements ('rows of desks "
    "recede', 'cars parked along the street'). Objects BUILT INTO the architecture "
    "(chalkboard on the back wall, fireplace, large mounted TV, stage, built-in "
    "bookshelf, fixed reception desk, permanent signage) get a DUAL MENTION: (1) mention "
    "in background as part of the shell, (2) emit as an obj whose desc starts with 'the "
    "primary background element', (3) place it FIRST in the elements list. No "
    "medium/post-processing effects in background (film grain, lens flare, vignetting, "
    "bokeh, paper or canvas texture, halftone) — those belong in high_level_description."
)

_IDEOGRAM_V15_BBOX = (
    " BBOX STRATEGY: add a bbox where precise position matters (portrait subjects, "
    "products on a surface, logos, wall signs, distinct placeable objects); omit it for "
    "dense or innumerable content (crowds, flower fields, scattered particles, starry "
    "skies). Coordinates are normalized 0-1000 in BOTH axes relative to the image shape: "
    "x left-to-right, y top-to-bottom, origin top-left, format [y1,x1,y2,x2] with y1<y2 "
    "and x1<x2. SHAPE WARNING: [0,0,500,500] is square only on a square frame — for "
    "round or square objects scale the spans so (x2-x1)/(y2-y1) approximates W/H; on "
    "wide frames prefer narrower x spans for a single subject; with several subjects "
    "give each a tight bbox so none dominates. A main portrait subject should have y2 "
    "near 1000 (reaching the bottom of the frame) and y1 just under the top edge — do "
    "not strand the figure with y2 around 760-800."
)

_IDEOGRAM_V15_SPECIFIC = (
    " SPECIFICITY — commit to one value; this JSON feeds a diffusion model, leave "
    "nothing to imagine. Banned hedges in elements and background: 'things like', 'such "
    "as', 'e.g.', 'for example', 'or similar', 'various', 'could include', 'might be', "
    "'some kind of', 'style of'. Banned alternatives for a single property ('oak or "
    "walnut', 'cream or ivory') — pick ONE; 'or' is reserved for literal choice idioms "
    "like 'YES' or 'NO'. Typography: name ONE typeface category, ONE weight, ONE style. "
    "Banned implied language: implied, suggested, hinted, barely visible, possibly, "
    "perhaps, maybe, reads as, almost — if it is in the scene, paint it concretely; if "
    "not, omit it. EXHAUSTIVE CONTENT: when the user supplies enumerable content "
    "(schedules, lists, menu items, steps, names, times), EVERY item must appear — as "
    "many text elements as needed. Every explicitly named visual unit MUST be its own "
    "element: each quoted string is a text element verbatim; a speech bubble is a text "
    "element for the quote AND an obj for the bubble; named decorative elements, badges, "
    "chips, CTAs each get their own obj. Before emitting, count the named visual units "
    "in the prompt — the elements list must have at least that many. No placeholder "
    "enumeration: a sequentially numbered set (stones 1-50, seats A1-A20, 31 calendar "
    "days) gets EVERY item, no 'etc.'. Do not invent concepts the user did not ask for "
    "(glitch art, wireframe overlay, digital artifacts)."
)

_IDEOGRAM_V15_PLANNING = (
    " PLANNING: choose the medium — photograph, illustration, 3D render or graphic "
    "design — as natural prose in high_level_description/background, not as a "
    "structural slot. Graphic design covers posters, covers, flyers, banners, stickers, "
    "logos, packaging, app icons, UI mockups, infographics, menus, cards, tickets, "
    "signage. Default to photograph when silent or ambiguous — fantastical subjects in "
    "a photo are fine; leading imperative verbs ('Illustrate a…', 'Paint a…', 'Draw "
    "a…', 'Render a…') do NOT signal a medium. Name the style ONCE in prose ('Studio "
    "Ghibli animation', '35mm film photograph', 'flat vector'). A 'professional "
    "picture/photo/portrait' of a person means a corporate/LinkedIn-style headshot: "
    "neutral business attire, soft even daylight, neutral backdrop, friendly expression "
    "— not dramatic studio rim-lighting or creamy DSLR bokeh. PHOTOREAL DEFAULTS: "
    "default to a phone-snapshot iPhone aesthetic — ambient natural light, neutral "
    "white balance, faithful (not beautified) skin tones, casual framing; avoid "
    "DSLR-magazine markers (creamy bokeh, telephoto compression, dramatic rim light, "
    "cinematic grade) — they signal AI generation. Default light: 'natural daylight', "
    "'overcast daylight', 'diffused daylight', 'cool-neutral white balance'. The word "
    "'warm' is BANNED as a grading adjective ('warm light', 'warm tone', 'warm "
    "grading') — when the scene physically has a warm source, name the SOURCE "
    "('candle flame', 'sodium streetlamp') and the local pool of light ('amber pool "
    "from the candle') while the global grade stays neutral. Prefer off-center, "
    "rule-of-thirds composition; centered ONLY when explicitly requested or the genre "
    "is inherently symmetrical. No motion blur in candid/realistic shots. Mention "
    "saturation at most once and only if asked. POPULATE underspecified scenes: real "
    "scenes are inhabited — add plausible secondary subjects, micro-props implying the "
    "subject's life, environmental texture and small narrative moments, layered across "
    "foreground (a blurred leaf in the corner, a bowl rim), midground and background. "
    "Commit to a specific cultural/regional identity ('Vietnamese pho stall outside "
    "Hoi An', not 'Southeast Asian village'). Built environments need text everywhere: "
    "shop name, sub-signs ('OPEN', \"TODAY'S SPECIAL\"), menu boards with handwritten "
    "items, price tags, jar labels, posters — concrete content, never 'various labels'. "
    "OVERRIDE: when the brief says minimal, sparse, empty, lonely, isolated, quiet, "
    "still, negative space, alone, single subject or in the middle of nowhere — respect "
    "the restraint and skip populating. Fantasy/sci-fi briefs get a population bonus: "
    "stacked sky drama (galaxies, ringed planets, several moons, nebulae), opposing "
    "focal points, midground scale anchors, light/energy effects, exotic architecture, "
    "deeply saturated palettes."
)

_IDEOGRAM_V15_TEXT = (
    " TEXT ELEMENTS: \"text\" carries the literal characters visible in the image — "
    "preserve diacritics, case and punctuation, never transliterate. Text sources: text "
    "the user quoted (verbatim); text the format requires (headlines, taglines, names, "
    "dates, CTAs, brands); contextual in-scene text (signs, labels, license plates, "
    "jersey numbers, neon); numeric content (bib numbers, dates, prices, scores — "
    "numbers ARE text); product brands (if an element names a product without a brand, "
    "invent a full brand identity and list every label). Be exhaustive: if a viewer "
    "could read it, it goes on the list. Each text element appears once; do not restate "
    "its characters in any desc — refer to it by role or position. Use \\n for line "
    "breaks WITHIN one element and separate list items for visually distinct blocks; "
    "for stylized hero typography stack \\n at word boundaries ('ENTRE\\nVERSOS E\\n"
    "CONTOS') — long single-line titles produce typos. LANGUAGE SCOPING: all prose "
    "(high_level_description, background, desc) is ALWAYS in English regardless of the "
    "brief's language; only the literal \"text\" field stays in the brief's language. "
    "POP CULTURE: when the idea names or clearly implies a brand, product, public "
    "figure, fictional character, film, game or team, the output MUST carry the "
    "explicit name in the proper element's desc — never a generic stand-in ('Nike Dunk "
    "Low Panda', not 'black and white retro sneakers'). TRANSPARENT BACKGROUND: if the "
    "idea calls for a transparent background, alpha channel, cutout or sticker style, "
    "the background field MUST be exactly the string 'transparent background' — no "
    "paraphrase. Keep any LoRA trigger token exactly as given, at the start of "
    "high_level_description. Output ONLY the JSON object."
)

_IDEOGRAM_V15_ACTION = {
    "expand": (
        " The user gives a short idea plus optionally a target aspect ratio. Expand it "
        "into a complete v15 JSON caption, inventing plausible concrete details "
        "(setting, populated depth layers, composition, light as prose) that fit the "
        "idea while staying faithful to it."
    ),
    "refine": (
        " The user gives an existing prompt — possibly messy, tag-based, written for "
        "another model, or an older Ideogram JSON. Repair and migrate it: unwrap "
        "double-encoded JSON and 'caption'/'data' wrappers; derive aspect_ratio from a "
        "pixel 'size' when no explicit ratio exists; the legacy style_description "
        "fields (aesthetics, lighting, photo, color_palette, medium, art_style) do not "
        "exist in v15 — rewrite their content as prose into high_level_description "
        "(medium, style, post-processing) and/or background (scene light, atmosphere), "
        "dropping the color palette (weave important colors into element descs); merge "
        "over-split subjects into one element each, parts into desc; move floor, "
        "shadows and camera language to the proper fields or cut them; cut 'warm' "
        "grading and beautifying DSLR markers from photoreal prompts unless a cinematic "
        "look was explicitly requested; recompute bboxes for the target ratio (main "
        "subject y2 near 1000, narrower x spans on wide frames). Preserve the user's "
        "intent and key elements; do not introduce major new subjects."
    ),
}


# Detail controls (pattern: Ideogrammar) — override the default element count
# and description density. Appended LAST so they win over the other rules.
_V15_ELEMENT_LEVELS = {
    "few": "Decompose the scene into only 2 to 3 elements — just the most important subjects.",
    "balanced": "",  # the framework's default behavior — no override
    "detailed": "Decompose the scene into 6 to 10 elements, breaking it into more distinct parts.",
    "maximal": "Decompose the scene into 10 to 16 elements, breaking it very finely into many distinct parts.",
}
_V15_DESC_LEVELS = {
    "brief": "Keep each element's desc to a tight 15-30 words.",
    "balanced": "",
    "rich": "Write each element's desc close to the 60-word cap, covering materials, colors and spatial anchors.",
}


def _detail_directive(elements_detail: str, desc_detail: str) -> str:
    e = _V15_ELEMENT_LEVELS.get(elements_detail, "")
    d = _V15_DESC_LEVELS.get(desc_detail, "")
    if not e and not d:
        return ""
    parts = [p for p in (e, d) if p]
    return (" DETAIL SETTINGS (override any element-count or description-length "
            "guidance above): " + " ".join(parts))


# --- Image -> v15: instructions for vision models (Qwen-VL / LM Studio) ---- #
_IDEOGRAM_V15_IMAGE_ACTION = (
    " IMAGE MODE: you are given an actual IMAGE. Look at it carefully and "
    "reconstruct it as ONE v15 JSON caption: the overall subject, medium and "
    "composition in high_level_description; the scene shell (walls, ground, sky, "
    "ambient light, distant context) in background; and every distinct subject, "
    "placeable object and piece of LEGIBLE text as its own element. Estimate each "
    "element's bbox from where it actually sits in the image, mapped onto the "
    "0-1000 grid ([y1,x1,y2,x2], origin top-left). Put the exact visible "
    "characters into the \"text\" field of text elements. PRESERVE THE COMPOSITION "
    "AND LAYOUT exactly — describe what is there, do not invent content that is "
    "not visible. Pick aspect_ratio closest to the image's real proportions."
)


def build_image_v15_instruction() -> str:
    """Instruction for a vision model: image -> full v15 JSON draft."""
    return (_IDEOGRAM_V15_BASE + _IDEOGRAM_V15_IMAGE_ACTION + _IDEOGRAM_V15_CONTRACT
            + _IDEOGRAM_V15_ASPECT + _IDEOGRAM_V15_HLD + _IDEOGRAM_V15_ELEMENTS
            + _IDEOGRAM_V15_BACKGROUND + _IDEOGRAM_V15_BBOX + _IDEOGRAM_V15_SPECIFIC
            + _IDEOGRAM_V15_TEXT)


def build_hybrid_v15_instruction(draft_json: str) -> str:
    """Instruction for a vision model: enrich a Florence draft, keeping its bboxes.

    The draft carries MEASURED bboxes and OCR text; the vision model only
    rewrites the prose (HLD, background, descs) to full v15 quality.
    """
    return (
        _IDEOGRAM_V15_BASE
        + " You are given an IMAGE and a machine-generated DRAFT of its v15 JSON "
        "caption. The draft's bboxes were MEASURED by an object detector and its "
        "text elements come from OCR — they are accurate. Your job is to look at "
        "the image and rewrite ONLY the prose: write a proper high_level_description "
        "(max 50 words, starts with the subject), a proper background (the scene "
        "shell: walls, ground, sky, ambient light), and a full desc for every "
        "element (identity first, then key attributes, one distinguishing detail; "
        "30-60 words for main subjects). KEEP every element's bbox, type, order and "
        "literal \"text\" value exactly as in the draft. You may drop an element "
        "only if it clearly duplicates another one or is part of an already-listed "
        "subject (one subject = one element). Do not add elements that are not in "
        "the draft. DRAFT: " + draft_json
        + _IDEOGRAM_V15_CONTRACT
    )


def build_ideogram_studio_v15(action: str = "expand", subject: str = "auto",
                              elements_detail: str = "balanced",
                              desc_detail: str = "balanced") -> str:
    """System prompt of the text->Ideogram JSON converter per framework v15."""
    act = _IDEOGRAM_V15_ACTION.get(action, _IDEOGRAM_V15_ACTION["expand"])
    subj = _STUDIO_SUBJECT.get(subject, "")
    return (_IDEOGRAM_V15_BASE + act + subj + _IDEOGRAM_V15_CONTRACT
            + _IDEOGRAM_V15_ASPECT + _IDEOGRAM_V15_HLD + _IDEOGRAM_V15_ELEMENTS
            + _IDEOGRAM_V15_BACKGROUND + _IDEOGRAM_V15_BBOX + _IDEOGRAM_V15_SPECIFIC
            + _IDEOGRAM_V15_PLANNING + _IDEOGRAM_V15_TEXT
            + _detail_directive(elements_detail, desc_detail))
