"""Local vision-language captioner built on Qwen2.5-VL.

The model is loaded lazily and cached process-wide so that switching jobs does
not reload weights unless the chosen model/quantisation changes.
"""
from __future__ import annotations

import threading

from PIL import Image

from . import prompts

# Models exposed in the UI. Keep the lighter one first for safe defaults.
AVAILABLE_MODELS = {
    "Qwen/Qwen2.5-VL-3B-Instruct": "Qwen2.5-VL 3B (fp16, szybki, ~7 GB VRAM)",
    "Qwen/Qwen2.5-VL-7B-Instruct": "Qwen2.5-VL 7B (4-bit, najlepszy opis, ~9 GB VRAM)",
}
DEFAULT_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct"

_lock = threading.Lock()
_state: dict = {"model": None, "processor": None, "key": None}


def _device():
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def ensure_loaded(model_name: str, quant: str) -> None:
    """Load the requested model if it is not already the active one."""
    import torch
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    key = (model_name, quant)
    with _lock:
        if _state["key"] == key:
            return

        # Free any previously loaded model before swapping.
        _state["model"] = None
        _state["processor"] = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        # transformers 5.x renamed torch_dtype -> dtype.
        load_kwargs: dict = {"dtype": torch.float16}
        on_cuda = torch.cuda.is_available()

        if quant == "4bit" and on_cuda:
            from transformers import BitsAndBytesConfig

            load_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
            )
            load_kwargs["device_map"] = "cuda"
        elif on_cuda:
            load_kwargs["device_map"] = "cuda"

        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_name, **load_kwargs
        )
        model.eval()

        # Cap the visual token budget to keep VRAM/latency predictable.
        processor = AutoProcessor.from_pretrained(
            model_name,
            min_pixels=256 * 28 * 28,
            max_pixels=1024 * 28 * 28,
        )

        _state["model"] = model
        _state["processor"] = processor
        _state["key"] = key


def unload() -> None:
    """Drop the loaded model/processor and free GPU memory."""
    import gc

    import torch

    with _lock:
        _state["model"] = None
        _state["processor"] = None
        _state["key"] = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()


def is_loaded() -> bool:
    return _state["model"] is not None


def gpu_status() -> dict:
    """Report whether a model is loaded and current VRAM usage."""
    import torch

    key = _state["key"]
    info: dict = {
        "loaded": _state["model"] is not None,
        "model": key[0] if key else None,
        "quant": key[1] if key else None,
        "cuda": torch.cuda.is_available(),
    }
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        info["vram_used_gb"] = round((total - free) / 1e9, 2)
        info["vram_total_gb"] = round(total / 1e9, 2)
    return info


def caption_image(
    image: Image.Image,
    mode: str,
    style: str = "concise",
    max_new_tokens: int = 256,
    fmt: str = "flux",
) -> str:
    """Generate a cleaned caption for a single PIL image.

    fmt="flux" -> natural-language caption; fmt="ideogram"/"aitoolkit" -> compact JSON caption.
    """
    import torch

    model = _state["model"]
    processor = _state["processor"]
    if model is None or processor is None:
        raise RuntimeError("Model nie jest załadowany — wywołaj ensure_loaded() najpierw.")

    instruction = prompts.caption_instruction(mode, style, fmt)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": instruction},
            ],
        }
    ]
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = processor(text=[text], images=[image], padding=True, return_tensors="pt")
    inputs = inputs.to(model.device)

    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=None,
            top_p=None,
            top_k=None,
        )

    trimmed = generated[:, inputs.input_ids.shape[1]:]
    decoded = processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
    )[0]
    return prompts.postprocess_caption(decoded, fmt)


def generate_text(
    system: str,
    user: str,
    max_new_tokens: int = 320,
    temperature: float = 0.7,
) -> str:
    """Text-only generation reusing the loaded VLM (no image input).

    Used by the FLUX.2 prompt studio to expand or refine generation prompts.
    """
    import torch

    model = _state["model"]
    processor = _state["processor"]
    if model is None or processor is None:
        raise RuntimeError("Model nie jest załadowany — wywołaj ensure_loaded() najpierw.")

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = processor(text=[text], return_tensors="pt").to(model.device)

    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=temperature > 0,
            temperature=temperature if temperature > 0 else None,
            top_p=0.9 if temperature > 0 else None,
        )

    trimmed = generated[:, inputs.input_ids.shape[1]:]
    decoded = processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
    )[0]
    return decoded.strip()
