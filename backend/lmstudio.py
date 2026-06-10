"""Klient lokalnego API LM Studio (OpenAI-compatible). Tylko biblioteka standardowa."""
from __future__ import annotations

import base64
import io
import json
import urllib.error
import urllib.request

from PIL import Image

DEFAULT_URL = "http://localhost:1234/v1"
_HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer lm-studio"}


class LMStudioError(RuntimeError):
    """Readable LM Studio communication error."""


def _image_data_uri(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _request(url: str, payload: dict | None, timeout: float) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    method = "POST" if payload is not None else "GET"
    req = urllib.request.Request(url, data=data, headers=_HEADERS, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def list_models(base_url: str = DEFAULT_URL, timeout: float = 3.0) -> list[str]:
    """Model ids from LM Studio; empty list when the server is unreachable."""
    try:
        out = _request(f"{base_url.rstrip('/')}/models", None, timeout)
    except (urllib.error.URLError, OSError, ValueError):
        return []
    data = (out.get("data") or []) if isinstance(out, dict) else []
    return [m["id"] for m in data if isinstance(m, dict) and m.get("id")]


def _chat(base_url: str, payload: dict, timeout: float) -> str:
    url = f"{base_url.rstrip('/')}/chat/completions"
    try:
        out = _request(url, payload, timeout)
    except urllib.error.HTTPError as e:
        raise LMStudioError(f"LM Studio HTTP {e.code}.") from e
    except (urllib.error.URLError, OSError) as e:
        raise LMStudioError(f"Cannot connect to LM Studio ({base_url}).") from e
    except ValueError as e:
        raise LMStudioError("Bad LM Studio response (not JSON).") from e
    try:
        content = out["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LMStudioError("LM Studio returned a response without content.") from e
    if content is None:
        raise LMStudioError("LM Studio returned empty content (content=null).")
    return content


def caption_image(base_url: str, model: str, image: Image.Image,
                  instruction: str, max_tokens: int = 256, timeout: float = 180.0) -> str:
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": instruction},
                {"type": "image_url", "image_url": {"url": _image_data_uri(image)}},
            ],
        }],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    return _chat(base_url, payload, timeout)


def generate_text(base_url: str, model: str, system: str, user: str,
                  max_tokens: int = 320, timeout: float = 120.0) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    return _chat(base_url, payload, timeout)
