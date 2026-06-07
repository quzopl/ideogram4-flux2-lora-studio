"""Thin HTTP client for a running ComfyUI instance.

ComfyUI exposes a small REST API:
  GET  /system_stats        - basic info (we use this for the connection test)
  GET  /object_info         - metadata about all node types incl. enum values
                              (e.g. the list of available LoRA filenames)
  POST /prompt              - enqueue an API-format workflow; returns prompt_id
  GET  /history/{prompt_id} - poll the result (status + output filenames)
  GET  /view                - fetch a generated image by filename/subfolder/type
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid


DEFAULT_URL = "http://127.0.0.1:8188"


class ComfyError(RuntimeError):
    pass


def _request(url: str, *, data: bytes | None = None, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:600]
        raise ComfyError(f"HTTP {e.code} z {url}: {body}") from None
    except urllib.error.URLError as e:
        raise ComfyError(f"Brak połączenia z {url}: {e.reason}") from None


def _join(base: str, path: str) -> str:
    return base.rstrip("/") + path


def system_stats(base_url: str) -> dict:
    """Used as a connection test. Returns ComfyUI's own status payload."""
    raw = _request(_join(base_url, "/system_stats"), timeout=5)
    return json.loads(raw)


def object_info(base_url: str) -> dict:
    raw = _request(_join(base_url, "/object_info"), timeout=15)
    return json.loads(raw)


def list_loras(base_url: str) -> list[str]:
    """Pull the LoRA filename enum from /object_info."""
    info = object_info(base_url)
    candidates = ("LoraLoader", "LoraLoaderModelOnly", "LoRALoader")
    for key in candidates:
        node = info.get(key)
        if not node:
            continue
        # Shape: {"input": {"required": {"lora_name": [[<filenames>], {...}]}}}
        try:
            entry = node["input"]["required"]["lora_name"]
            values = entry[0]
            if isinstance(values, list):
                return list(values)
        except (KeyError, IndexError, TypeError):
            continue
    return []


def queue_prompt(base_url: str, workflow: dict, client_id: str | None = None) -> str:
    """Submit a workflow and return the prompt_id."""
    payload = {"prompt": workflow, "client_id": client_id or uuid.uuid4().hex}
    raw = _request(_join(base_url, "/prompt"), data=json.dumps(payload).encode("utf-8"), timeout=30)
    res = json.loads(raw)
    pid = res.get("prompt_id")
    if not pid:
        raise ComfyError(f"Nieoczekiwana odpowiedź: {res}")
    return pid


def history(base_url: str, prompt_id: str) -> dict:
    """Returns {} while still running; populated once finished."""
    raw = _request(_join(base_url, f"/history/{prompt_id}"), timeout=10)
    return json.loads(raw)


def queue_info(base_url: str) -> dict:
    raw = _request(_join(base_url, "/queue"), timeout=5)
    return json.loads(raw)


def fetch_image(base_url: str, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
    """Pull a generated image's bytes via the /view endpoint."""
    qs = urllib.parse.urlencode(
        {"filename": filename, "subfolder": subfolder, "type": type_}
    )
    return _request(_join(base_url, f"/view?{qs}"), timeout=60)


def stream_events(base_url: str, client_id: str, prompt_id: str, on_event):
    """Open a sync WebSocket to ComfyUI and dispatch events for `prompt_id`.

    Calls on_event(kind, payload) where kind is one of:
      - 'progress'  payload={'value': int, 'max': int}
      - 'executing' payload={'node': str | None}
      - 'preview'   payload=<png bytes>
      - 'done'      payload=None
      - 'error'     payload=<str>

    Returns when 'done' or 'error' fires, or after `timeout_total` seconds.
    """
    import websocket  # provided by websocket-client

    ws_url = base_url.replace("http://", "ws://").replace("https://", "wss://")
    ws = websocket.create_connection(
        f"{ws_url.rstrip('/')}/ws?clientId={client_id}", timeout=10
    )
    try:
        while True:
            ws.settimeout(60)
            try:
                msg = ws.recv()
            except websocket.WebSocketTimeoutException:
                # Heartbeat: keep waiting silently. The caller's own deadline applies.
                continue
            if isinstance(msg, (bytes, bytearray)):
                # ComfyUI binary messages: 4 bytes event_type + 4 bytes format + PNG bytes
                if len(msg) > 8:
                    on_event("preview", bytes(msg[8:]))
                continue
            try:
                evt = json.loads(msg)
            except Exception:
                continue
            etype = evt.get("type")
            data = evt.get("data") or {}
            pid = data.get("prompt_id")
            if pid and pid != prompt_id:
                continue
            if etype == "progress":
                on_event("progress", {"value": data.get("value"), "max": data.get("max")})
            elif etype == "executing":
                node = data.get("node")
                on_event("executing", {"node": node})
                if node is None and pid == prompt_id:
                    on_event("done", None)
                    return
            elif etype == "execution_error":
                on_event("error", str(data))
                return
    finally:
        try:
            ws.close()
        except Exception:
            pass


def collect_output_images(hist: dict, prompt_id: str) -> list[dict]:
    """Extract the list of saved images from a history entry.

    Returns items shaped {filename, subfolder, type, node}.
    """
    entry = hist.get(prompt_id) or next(iter(hist.values()), {})
    outputs = entry.get("outputs", {}) if entry else {}
    items: list[dict] = []
    for node_id, out in outputs.items():
        for img in out.get("images", []) or []:
            items.append({
                "filename": img.get("filename"),
                "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
                "node": node_id,
            })
    return items
