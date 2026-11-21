"""Which GPU each local model runs on, chosen by card name rather than number.

CUDA numbers cards with a driver heuristic (CUDA_DEVICE_ORDER=FASTEST_FIRST by
default) that can disagree with nvidia-smi's PCI order — on a 5080 + 4070 Ti
box it puts the 4070 Ti at cuda:0. So the choice is stored by the card's UUID
and translated to the current cuda:N every time a model loads; the numbering
never reaches the user.

Each role in ``settings.ROLES`` (the VLM, Florence-2, the upscaler) has its own
choice in the settings doc: a card's UUID, "cpu", or "auto" — the card with
most memory. A stored card that is gone (pulled out, another
CUDA_VISIBLE_DEVICES) also falls back to that default, so a stale setting never
stops a model from loading.

``probe`` reads the cards through torch and ``empty_cache`` frees torch memory;
everything else works on the plain device dicts ``probe`` returns and is
testable without a GPU. VRAM is read from nvidia-smi (``smi_stats``), never
from torch.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from . import settings  # settings imports this module lazily, so no cycle

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


def normalize_uuid(uuid: str) -> str:
    """nvidia-smi prints 'GPU-1e5c…', torch's ``props.uuid`` prints '1e5c…';
    both reduce to the bare lowercase form so the two can be joined."""
    return uuid.strip().lower().removeprefix("gpu-")


def smi_stats() -> dict[str, tuple[float, float]]:
    """(used, total) GB per card, keyed by ``normalize_uuid``; {} without nvidia-smi.

    Not torch: ``torch.cuda.mem_get_info(i)`` opens a CUDA context (~200 MB,
    see ``empty_cache``) on card i, and the topbar polls this every 2 s — every
    card would end up holding one, including those no role uses. nvidia-smi
    reads the driver's counters without a context. It reports MiB; GB here are
    GiB, like the size in ``label``. Cards it does not report — all of them
    when the binary is missing, fails or hangs; one whose memory reads "[N/A]"
    — have no entry, so callers show unknown VRAM instead of failing.
    """
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=uuid,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    stats = {}
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        try:
            used, total = float(parts[1]), float(parts[2])
        except ValueError:
            continue
        stats[normalize_uuid(parts[0])] = (round(used / 1024, 2), round(total / 1024, 2))
    return stats


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


def device_for(role: str, doc: dict | None = None,
               devices: list[dict] | None = None) -> str:
    """'cuda:N' or 'cpu' for one role's model, read fresh at every load.

    ``doc`` is the settings doc and ``devices`` the ``probe`` result; both are
    read when not given, so callers resolving several roles pass them once.
    """
    if doc is None:
        doc = settings.load()
    if devices is None:
        devices = probe()
    value = doc["gpu"][role]
    if value == "cpu":
        return "cpu"
    return device_string(resolve(value, devices))


def assign_value_ok(value: str, devices: list[dict]) -> bool:
    """What a role may be set to: "auto", "cpu" or the UUID of a card present now."""
    return value in ("auto", "cpu") or any(d["uuid"] == value for d in devices)


def current_device() -> str:
    """The VLM role's device; kept for callers from before per-role GPUs."""
    return device_for("vlm")
