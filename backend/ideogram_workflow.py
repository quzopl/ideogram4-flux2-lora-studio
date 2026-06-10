"""Workflow ComfyUI dla Ideogram 4 — budowany w Pythonie, bez plików .json.

Graf odtworzony z analizy działającego setupu (Ideogram4Scheduler +
DualModelGuider + presety jakości); wymiary i parametry presetów liczymy
tutaj, więc graf nie potrzebuje nodów matematycznych. Tekst promptu dostaje
na początku jawną wskazówkę orientacji + dokładne wymiary — bez niej model
potrafi obrócić wynik o 90° albo zgnieść layout.

Wariant "ideogram4" = oryginalny scheduler; "simple" = społecznościowy
(ModelSamplingAuraFlow shift + BasicScheduler "simple" + euler).
Wymaga ComfyUI z nodami Ideogram 4 (Ideogram4Scheduler, DualModelGuider,
CFGOverride, EmptyFlux2LatentImage).
"""
from __future__ import annotations
import json
import math
import re

# Presety jakości Ideogram 4 (kroki + parametry mu/std schedulera).
PRESETS = {
    "Quality": {"steps": 48, "mu": 0.0, "std": 1.5},
    "Default": {"steps": 20, "mu": 0.0, "std": 1.75},
    "Turbo": {"steps": 12, "mu": 0.5, "std": 1.75},
}

DEFAULTS = {
    "preset": "Turbo",
    "megapixels": 2.0,
    "seed": 0,
    "variant": "simple",          # "simple" | "ideogram4"
    "cfg": 3.0,
    "cfg_override": 3.0,
    "start_percent": 0.9,
    "end_percent": 1.0,
    "sampler": "",                # puste = domyślny dla wariantu
    "batch_size": 1,
    "shift": 5.0,
    "lora_enabled": False,
    "lora_name": "",
    "lora_strength": 1.0,
    "diff_model": "ideogram4_fp8_scaled.safetensors",
    "uncond_model": "ideogram4_unconditional_fp8_scaled.safetensors",
    "vae_name": "flux2-vae.safetensors",
    "clip_name": "qwen3vl_8b_fp8_scaled.safetensors",
    "clip_type": "ideogram4",
}

_RATIO_RE = re.compile(r"^\s*(\d+)\s*:\s*(\d+)\s*$")


def _clampf(v, lo: float, hi: float, dflt: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return dflt
    return n if lo <= n <= hi else dflt


def merge_params(params: dict | None) -> dict:
    """DEFAULTS + parametry użytkownika, z sanityzacją zakresów."""
    p = dict(DEFAULTS)
    p.update({k: v for k, v in (params or {}).items() if k in DEFAULTS})
    if p["preset"] not in PRESETS:
        p["preset"] = DEFAULTS["preset"]
    if p["variant"] not in ("simple", "ideogram4"):
        p["variant"] = DEFAULTS["variant"]
    p["megapixels"] = _clampf(p["megapixels"], 0.1, 4, 2.0)
    p["cfg"] = _clampf(p["cfg"], 0, 100, 3.0)
    p["cfg_override"] = _clampf(p["cfg_override"], 0, 100, 3.0)
    p["start_percent"] = _clampf(p["start_percent"], 0, 1, 0.9)
    p["end_percent"] = _clampf(p["end_percent"], 0, 1, 1.0)
    p["shift"] = _clampf(p["shift"], 0, 100, 5.0)
    p["lora_strength"] = _clampf(p["lora_strength"], -10, 10, 1.0)
    try:
        p["batch_size"] = max(1, min(16, int(p["batch_size"])))
    except (TypeError, ValueError):
        p["batch_size"] = 1
    try:
        p["seed"] = max(0, int(p["seed"]))
    except (TypeError, ValueError):
        p["seed"] = 0
    p["lora_enabled"] = bool(p["lora_enabled"])
    return p


def compute_dims(aspect_ratio: str, megapixels: float) -> tuple[int, int]:
    """Wymiary wyjściowe: area=MP*1024^2, boki ~sqrt(area*ar) do wielokrotności
    8, potem latent zaokrągla w górę do 16 (podłoga 256). 3:2 @ 2MP -> 1776x1184."""
    m = _RATIO_RE.match(aspect_ratio or "")
    ar = (int(m.group(1)) / int(m.group(2))) if m and int(m.group(2)) else 1.0
    area = megapixels * 1024 * 1024
    rs8 = lambda x: round(x / 8) * 8                       # noqa: E731
    lat = lambda x: max(256, math.floor((x + 15) / 16) * 16)  # noqa: E731
    return lat(rs8(math.sqrt(area * ar))), lat(rs8(math.sqrt(area / ar)))


def orientation_lead(ratio: str, width: int, height: int) -> str:
    """Jawna deklaracja orientacji + układu współrzędnych przed JSON-em."""
    coord = (
        f" Element bboxes are [ymin,xmin,ymax,xmax] on a 0-1000 normalized grid "
        f"(each axis 0-1000 independent of the {width}x{height} pixel size), "
        f"origin top-left, x right, y down; place each element exactly there, "
        f"do not rotate or mirror the layout."
    )
    m = _RATIO_RE.match(ratio or "")
    ar = (int(m.group(1)) / int(m.group(2))) if m and int(m.group(2)) else 1.0
    if ar > 1.02:
        return (f"LANDSCAPE orientation: a wide horizontal {ratio} image, "
                f"{width}x{height} pixels (wider than tall).") + coord
    if ar < 0.98:
        return (f"PORTRAIT orientation: a tall vertical {ratio} image, "
                f"{width}x{height} pixels (taller than wide).") + coord
    return f"SQUARE {ratio} image, {width}x{height} pixels." + coord


def _prompt_ratio(prompt_json: str) -> str:
    try:
        obj = json.loads(prompt_json)
        ar = obj.get("aspect_ratio")
        if isinstance(ar, str) and _RATIO_RE.match(ar):
            return ar.strip()
    except (json.JSONDecodeError, ValueError, AttributeError):
        pass
    return "1:1"


def build_render_text(prompt_json: str, megapixels: float = 2.0) -> str:
    """Tekst do CLIPTextEncode: wskazówka orientacji + JSON v15 bez zmian."""
    ratio = _prompt_ratio(prompt_json)
    w, h = compute_dims(ratio, megapixels)
    return orientation_lead(ratio, w, h) + "\n\n" + prompt_json


def build_workflow(prompt_json: str, params: dict | None) -> dict:
    """Zbuduj graf API ComfyUI renderujący prompt v15."""
    p = merge_params(params)
    ratio = _prompt_ratio(prompt_json)
    width, height = compute_dims(ratio, p["megapixels"])
    preset = PRESETS[p["preset"]]
    sampler = p["sampler"] or ("euler" if p["variant"] == "simple" else "res_multistep")

    wf: dict = {
        "vae": {"inputs": {"vae_name": p["vae_name"]},
                "class_type": "VAELoader", "_meta": {"title": "Load VAE"}},
        "clip": {"inputs": {"clip_name": p["clip_name"], "type": p["clip_type"],
                            "device": "default"},
                 "class_type": "CLIPLoader", "_meta": {"title": "Load CLIP"}},
        "diff": {"inputs": {"unet_name": p["diff_model"], "weight_dtype": "default"},
                 "class_type": "UNETLoader", "_meta": {"title": "Ideogram 4 (cond)"}},
        "uncond": {"inputs": {"unet_name": p["uncond_model"], "weight_dtype": "default"},
                   "class_type": "UNETLoader", "_meta": {"title": "Ideogram 4 (uncond)"}},
        "pos": {"inputs": {"text": build_render_text(prompt_json, p["megapixels"]),
                           "clip": ["clip", 0]},
                "class_type": "CLIPTextEncode", "_meta": {"title": "Prompt (v15)"}},
        "neg": {"inputs": {"conditioning": ["pos", 0]},
                "class_type": "ConditioningZeroOut", "_meta": {"title": "Zero negative"}},
        "latent": {"inputs": {"width": width, "height": height,
                              "batch_size": p["batch_size"]},
                   "class_type": "EmptyFlux2LatentImage", "_meta": {"title": "Latent"}},
        "noise": {"inputs": {"noise_seed": p["seed"]},
                  "class_type": "RandomNoise", "_meta": {"title": "Noise"}},
        "samplersel": {"inputs": {"sampler_name": sampler},
                       "class_type": "KSamplerSelect", "_meta": {"title": "Sampler"}},
        "cfgover": {"inputs": {"cfg": p["cfg_override"],
                               "start_percent": p["start_percent"],
                               "end_percent": p["end_percent"], "model": ["diff", 0]},
                    "class_type": "CFGOverride", "_meta": {"title": "CFG Override"}},
        "guider": {"inputs": {"cfg": p["cfg"], "model": ["cfgover", 0],
                              "positive": ["pos", 0], "model_negative": ["uncond", 0],
                              "negative": ["neg", 0]},
                   "class_type": "DualModelGuider", "_meta": {"title": "Dual Model Guider"}},
        "sample": {"inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                              "sampler": ["samplersel", 0], "sigmas": ["sigmas", 0],
                              "latent_image": ["latent", 0]},
                   "class_type": "SamplerCustomAdvanced", "_meta": {"title": "Sample"}},
        "decode": {"inputs": {"samples": ["sample", 0], "vae": ["vae", 0]},
                   "class_type": "VAEDecode", "_meta": {"title": "Decode"}},
        "out": {"inputs": {"images": ["decode", 0]},
                "class_type": "PreviewImage", "_meta": {"title": "Preview"}},
    }

    if p["variant"] == "simple":
        wf["shift"] = {"inputs": {"shift": p["shift"], "model": ["diff", 0]},
                       "class_type": "ModelSamplingAuraFlow",
                       "_meta": {"title": "AuraFlow shift"}}
        wf["cfgover"]["inputs"]["model"] = ["shift", 0]
        wf["sigmas"] = {"inputs": {"model": ["shift", 0], "scheduler": "simple",
                                   "steps": preset["steps"], "denoise": 1},
                        "class_type": "BasicScheduler",
                        "_meta": {"title": "Scheduler (simple)"}}
    else:
        wf["sigmas"] = {"inputs": {"steps": preset["steps"], "width": width,
                                   "height": height, "mu": preset["mu"],
                                   "std": preset["std"]},
                        "class_type": "Ideogram4Scheduler",
                        "_meta": {"title": "Ideogram 4 Scheduler"}}

    # LoRA (model-only): wpięta między model dyfuzyjny a jego konsumenta;
    # ścieżka bezwarunkowa (uncond) zostaje nietknięta.
    if p["lora_enabled"] and p["lora_name"]:
        for node in wf.values():
            m = node["inputs"].get("model")
            if isinstance(m, list) and m and m[0] == "diff":
                node["inputs"]["model"] = ["lora", 0]
        wf["lora"] = {"inputs": {"lora_name": p["lora_name"],
                                 "strength_model": p["lora_strength"],
                                 "model": ["diff", 0]},
                      "class_type": "LoraLoaderModelOnly",
                      "_meta": {"title": "LoRA (model only)"}}
    return wf
