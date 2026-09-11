"""Which GPU the local models run on, chosen by card name rather than number.

CUDA numbers cards with a driver heuristic (CUDA_DEVICE_ORDER=FASTEST_FIRST by
default) that can disagree with nvidia-smi's PCI order — on a 5080 + 4070 Ti
box it puts the 4070 Ti at cuda:0. So the choice is stored by the card's UUID
and translated to the current cuda:N every time a model loads; the numbering
never reaches the user. With nothing stored, the card with most memory wins.

``probe`` is the only function that touches torch; everything else works on
the plain device dicts it returns and is testable without a GPU.
"""
from __future__ import annotations

import json
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / ".work" / "gpu.json"

_VENDOR_PREFIXES = ("NVIDIA GeForce ", "NVIDIA ")


def probe() -> list[dict]:
    """Visible CUDA devices: index, uuid, name, total_bytes, pci_bus."""
    try:
        import torch
    except ImportError:  # pragma: no cover - torch is a hard dependency
        return []
    if not torch.cuda.is_available():
        return []
    out = []
    for i in range(torch.cuda.device_count()):
        p = torch.cuda.get_device_properties(i)
        out.append({"index": i, "uuid": str(p.uuid), "name": p.name,
                    "total_bytes": int(p.total_memory), "pci_bus": int(p.pci_bus_id)})
    return out


def short_name(name: str) -> str:
    """'NVIDIA GeForce RTX 5080' -> 'RTX 5080'."""
    for prefix in _VENDOR_PREFIXES:
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def label(dev: dict, devices: list[dict]) -> str:
    """Human label, e.g. 'RTX 5080 · 16 GB'; the PCI bus is appended only when
    another card has the same name, so two identical cards never look alike."""
    name = short_name(dev["name"])
    text = f"{name} · {round(dev['total_bytes'] / 2 ** 30)} GB"
    if sum(short_name(d["name"]) == name for d in devices) > 1:
        text += f" · PCI {dev['pci_bus']:02x}"
    return text


def default_uuid(devices: list[dict]) -> str | None:
    """The card with the most memory (lowest PCI bus on a tie)."""
    if not devices:
        return None
    return max(devices, key=lambda d: (d["total_bytes"], -d["pci_bus"]))["uuid"]


def resolve(selected: str | None, devices: list[dict]) -> dict | None:
    """The stored card if it is present, otherwise the default; None without CUDA."""
    for d in devices:
        if d["uuid"] == selected:
            return d
    fallback = default_uuid(devices)
    return next((d for d in devices if d["uuid"] == fallback), None)


def device_string(dev: dict | None) -> str:
    return f"cuda:{dev['index']}" if dev else "cpu"


def is_cuda(device: str) -> bool:
    """True for 'cuda' and 'cuda:N' — a bare == "cuda" misses indexed devices."""
    return device == "cuda" or device.startswith("cuda:")


def vram_gb(dev: dict) -> tuple[float, float]:
    """(used, total) GB on one card, measured on that card specifically."""
    import torch
    free, total = torch.cuda.mem_get_info(dev["index"])
    return round((total - free) / 1e9, 2), round(total / 1e9, 2)


def empty_cache() -> None:
    """Return cached allocator memory on every card that holds some — after a
    switch the model being released lives on the previous card. Cards with
    nothing reserved are skipped: entering one would create a ~200 MB CUDA
    context on a card the user did not pick (memory_reserved does not)."""
    import torch
    if not torch.cuda.is_available():
        return
    for i in range(torch.cuda.device_count()):
        if torch.cuda.memory_reserved(i):
            with torch.cuda.device(i):
                torch.cuda.empty_cache()


def listing(devices: list[dict], selected: str | None) -> list[dict]:
    """Rows for the UI select, in physical PCI-slot order (as nvidia-smi shows)."""
    chosen = resolve(selected, devices)
    return [
        {"uuid": d["uuid"], "label": label(d, devices), "name": d["name"],
         "total_bytes": d["total_bytes"], "pci_bus": d["pci_bus"],
         "selected": chosen is not None and d["uuid"] == chosen["uuid"]}
        for d in sorted(devices, key=lambda d: d["pci_bus"])
    ]


def load_selected(path) -> str | None:
    p = Path(path)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    uuid = data.get("uuid") if isinstance(data, dict) else None
    return uuid if isinstance(uuid, str) and uuid else None


def save_selected(path, uuid: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps({"uuid": uuid}, indent=2), encoding="utf-8")


def current() -> dict | None:
    """The device dict models should load on right now (None = CPU)."""
    return resolve(load_selected(CONFIG_PATH), probe())


def current_device() -> str:
    """'cuda:N' for the chosen card, or 'cpu' when CUDA is unavailable."""
    return device_string(current())
