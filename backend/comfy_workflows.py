"""Load ComfyUI API-format workflows and auto-detect the editable node slots.

ComfyUI has two workflow formats:

  - **UI format** (the one in `workflow.json`): nested {"nodes": [...], "links": [...]}.
    Cannot be submitted to the /prompt API as-is.
  - **API format** (saved via "Save (API Format)" in dev mode, AND embedded in
    every generated PNG under the `prompt` tEXt chunk): a flat dict
    {"<id>": {"class_type": str, "inputs": {...}}, ...}.

We only accept API format and reject UI format with a helpful error.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from PIL import Image

# Node class_types we recognise. ComfyUI ships many; users add more via custom
# nodes. We use loose substring matching to stay robust across forks.
SAMPLER_TYPES = {
    "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
}
LATENT_TYPES = {
    "EmptyLatentImage", "EmptySD3LatentImage", "ModelSamplingFlux",
}
TEXT_ENCODER_HINTS = ("CLIPTextEncode", "TextEncode", "T5Encode", "PromptEncode")
LORA_HINTS = ("LoraLoader", "LoRALoader", "Lora_Loader")


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #
def extract_from_json(data: str | bytes | dict | Path) -> dict:
    """Parse a workflow from a JSON string/bytes/dict/path. Must be API format."""
    if isinstance(data, (str, Path)) and Path(str(data)).is_file():
        text = Path(str(data)).read_text(encoding="utf-8")
        obj = json.loads(text)
    elif isinstance(data, (str, bytes)):
        obj = json.loads(data)
    elif isinstance(data, dict):
        obj = data
    else:
        raise TypeError(f"Nieobsługiwany typ: {type(data)}")

    return _ensure_api_format(obj)


def extract_from_png(data: bytes | str | Path) -> dict:
    """Pull the API-format workflow out of a ComfyUI PNG's tEXt metadata."""
    if isinstance(data, (str, Path)):
        img = Image.open(str(data))
    else:
        img = Image.open(io.BytesIO(data))
    img.load()  # force metadata parse

    info = img.info or {}
    raw = info.get("prompt") or info.get("Prompt")
    if not raw:
        # Some forks store under "workflow" but that's typically UI format.
        if info.get("workflow"):
            raise ValueError(
                "Ten PNG ma zapisany tylko workflow w formacie UI — potrzebny "
                "format API. Spróbuj innego obrazka z ComfyUI lub wyeksportuj "
                "workflow ręcznie (Save → API Format)."
            )
        raise ValueError(
            "PNG nie zawiera workflow ComfyUI (brak metadanych 'prompt'). "
            "Czy ten obrazek na pewno został wygenerowany w ComfyUI?"
        )
    return _ensure_api_format(json.loads(raw))


def extract_auto(name: str, data: bytes) -> dict:
    """Dispatch by filename extension."""
    n = name.lower()
    if n.endswith(".png"):
        return extract_from_png(data)
    if n.endswith(".json"):
        return extract_from_json(data)
    # Last resort: try JSON, then PNG.
    try:
        return extract_from_json(data)
    except Exception:
        return extract_from_png(data)


def _ensure_api_format(obj: Any) -> dict:
    if not isinstance(obj, dict):
        raise ValueError("Workflow musi być obiektem JSON.")
    # UI format has nodes + links arrays at the top level.
    if "nodes" in obj and "links" in obj:
        raise ValueError(
            "To workflow w formacie UI (z polami 'nodes' i 'links'), a potrzebny "
            "jest format API. Najprościej: po prostu upuść w aplikacji dowolny "
            "obrazek wygenerowany w ComfyUI — workflow jest zaszyty w jego "
            "metadanych. Albo w ComfyUI: ustawienia → Enable Dev Mode → "
            "Save (API Format)."
        )
    if not obj:
        raise ValueError("Pusty workflow.")
    # API format: each value is {"class_type": ..., "inputs": {...}}.
    sample = next(iter(obj.values()))
    if not isinstance(sample, dict) or "class_type" not in sample:
        raise ValueError("To nie wygląda na format API ComfyUI.")
    return obj


# --------------------------------------------------------------------------- #
# Auto-detection of editable slots
# --------------------------------------------------------------------------- #
def _link_target(inputs: dict, field: str) -> str | None:
    """If inputs[field] is a link [node_id, slot], return the node_id. Else None."""
    val = inputs.get(field)
    if isinstance(val, list) and len(val) >= 1:
        return str(val[0])
    return None


def _find_sampler(workflow: dict) -> str | None:
    # Prefer KSamplers; fall back to any node with positive/negative inputs.
    for node_id, node in workflow.items():
        if node.get("class_type") in SAMPLER_TYPES:
            return node_id
    for node_id, node in workflow.items():
        ins = node.get("inputs", {})
        if "positive" in ins and "negative" in ins:
            return node_id
    return None


def _find_text_field(workflow: dict, node_id: str) -> str | None:
    """Pick the most likely 'text' input field on a text-encoder node."""
    node = workflow.get(node_id, {})
    ins = node.get("inputs", {})
    # Preference order. CLIPTextEncodeFlux uses 'clip_l' + 't5xxl' (two strings),
    # we treat 't5xxl' as the main prompt since it carries the long description.
    for f in ("text", "t5xxl", "prompt", "clip_l", "string"):
        if isinstance(ins.get(f), str):
            return f
    # Otherwise the first string-valued input.
    for k, v in ins.items():
        if isinstance(v, str):
            return k
    return None


def _resolve_text_node(workflow: dict, start_id: str | None) -> str | None:
    """Follow a chain until we find a node that has an actual text string input."""
    seen = set()
    node_id = start_id
    while node_id and node_id not in seen and node_id in workflow:
        seen.add(node_id)
        node = workflow[node_id]
        ins = node.get("inputs", {})
        # If any input is a literal string, this is our text encoder.
        if any(isinstance(v, str) for v in ins.values()):
            return node_id
        # Otherwise hop via the first link.
        for v in ins.values():
            if isinstance(v, list) and len(v) >= 1:
                node_id = str(v[0])
                break
        else:
            return None
    return None


def autodetect_mapping(workflow: dict) -> dict:
    """Return a best-guess mapping of editable slots in this workflow."""
    mapping: dict = {
        "sampler_node": None,
        "positive_node": None,
        "positive_field": None,
        "negative_node": None,
        "negative_field": None,
        "seed_node": None,
        "seed_field": None,
        "width_node": None,
        "width_field": "width",
        "height_node": None,
        "height_field": "height",
        "steps_node": None,
        "steps_field": "steps",
        "cfg_node": None,
        "cfg_field": "cfg",
        "lora_nodes": [],
        "checkpoint_nodes": [],
        "unet_nodes": [],
    }

    sampler = _find_sampler(workflow)
    mapping["sampler_node"] = sampler
    if sampler:
        ins = workflow[sampler].get("inputs", {})
        # Seed: KSampler uses 'seed', KSamplerAdvanced/SamplerCustomAdvanced often 'noise_seed'.
        for f in ("seed", "noise_seed"):
            if f in ins:
                mapping["seed_node"] = sampler
                mapping["seed_field"] = f
                break
        if "steps" in ins:
            mapping["steps_node"] = sampler
        if "cfg" in ins:
            mapping["cfg_node"] = sampler

        pos_target = _link_target(ins, "positive")
        neg_target = _link_target(ins, "negative")
        pos_node = _resolve_text_node(workflow, pos_target)
        neg_node = _resolve_text_node(workflow, neg_target)
        if pos_node:
            mapping["positive_node"] = pos_node
            mapping["positive_field"] = _find_text_field(workflow, pos_node)
        if neg_node and neg_node != pos_node:
            mapping["negative_node"] = neg_node
            mapping["negative_field"] = _find_text_field(workflow, neg_node)

    # Latent (dimensions)
    for node_id, node in workflow.items():
        ctype = node.get("class_type", "")
        ins = node.get("inputs", {})
        if any(t in ctype for t in LATENT_TYPES) or (
            "width" in ins and "height" in ins and "EmptyLatent" in ctype
        ):
            if "width" in ins and "height" in ins:
                mapping["width_node"] = node_id
                mapping["height_node"] = node_id
                break
    # Generic fallback: any node with width+height integer inputs.
    if mapping["width_node"] is None:
        for node_id, node in workflow.items():
            ins = node.get("inputs", {})
            if isinstance(ins.get("width"), int) and isinstance(ins.get("height"), int):
                mapping["width_node"] = node_id
                mapping["height_node"] = node_id
                break

    # LoRA loaders (zero or many)
    for node_id, node in workflow.items():
        ctype = node.get("class_type", "")
        ins = node.get("inputs", {})
        if any(h in ctype for h in LORA_HINTS) or "lora_name" in ins:
            field = "lora_name" if "lora_name" in ins else next(
                (k for k in ins if "lora" in k.lower() and isinstance(ins[k], str)),
                None,
            )
            if field:
                mapping["lora_nodes"].append({
                    "node": node_id,
                    "field": field,
                    "current": ins[field],
                    "class_type": ctype,
                })
        if ctype.startswith("CheckpointLoader") and "ckpt_name" in ins:
            mapping["checkpoint_nodes"].append({
                "node": node_id, "field": "ckpt_name", "current": ins["ckpt_name"],
            })
        if ctype.startswith("UNETLoader") and "unet_name" in ins:
            mapping["unet_nodes"].append({
                "node": node_id, "field": "unet_name", "current": ins["unet_name"],
            })

    return mapping


# --------------------------------------------------------------------------- #
# Patching values into the workflow before submission
# --------------------------------------------------------------------------- #
def extract_current_prompt(workflow: dict, mapping: dict) -> str:
    """Return the text currently sitting in the workflow's positive prompt node."""
    nid = mapping.get("positive_node")
    field = mapping.get("positive_field")
    if not nid or not field:
        return ""
    node = workflow.get(nid)
    if not node:
        return ""
    val = node.get("inputs", {}).get(field)
    return val if isinstance(val, str) else ""


def apply_overrides_multi_lora(
    workflow: dict,
    mapping: dict,
    lora_names: list[str],
    **overrides,
) -> dict:
    """Like apply_overrides, but assigns multiple LoRAs across the detected nodes.

    `lora_names[i]` goes into the i-th detected LoRA node; empty/None → leave as-is.
    """
    wf = apply_overrides(workflow, mapping, **overrides)
    loras = mapping.get("lora_nodes") or []
    for i, name in enumerate(lora_names):
        if not name or i >= len(loras):
            continue
        slot = loras[i]
        wf.setdefault(slot["node"], {}).setdefault("inputs", {})[slot["field"]] = name
    return wf


def apply_overrides(
    workflow: dict,
    mapping: dict,
    *,
    prompt: str | None = None,
    negative: str | None = None,
    seed: int | None = None,
    width: int | None = None,
    height: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    lora_name: str | None = None,
    lora_index: int = 0,
) -> dict:
    """Return a deep-copied workflow with the requested fields overridden."""
    wf = json.loads(json.dumps(workflow))  # cheap deep copy

    def set_field(node_id: str | None, field: str | None, value: Any) -> None:
        if not node_id or not field or value is None:
            return
        node = wf.get(node_id)
        if not node:
            return
        node.setdefault("inputs", {})[field] = value

    if prompt is not None:
        set_field(mapping.get("positive_node"), mapping.get("positive_field"), prompt)
    if negative is not None:
        set_field(mapping.get("negative_node"), mapping.get("negative_field"), negative)
    set_field(mapping.get("seed_node"), mapping.get("seed_field"), seed)
    set_field(mapping.get("width_node"), mapping.get("width_field"), width)
    set_field(mapping.get("height_node"), mapping.get("height_field"), height)
    set_field(mapping.get("steps_node"), mapping.get("steps_field"), steps)
    set_field(mapping.get("cfg_node"), mapping.get("cfg_field"), cfg)

    if lora_name is not None:
        loras = mapping.get("lora_nodes") or []
        if loras and 0 <= lora_index < len(loras):
            lora = loras[lora_index]
            set_field(lora["node"], lora["field"], lora_name)

    return wf
