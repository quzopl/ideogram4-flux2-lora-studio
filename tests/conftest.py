"""Suite-wide isolation: no test may read or write the real .work/settings.json
or .work/gpu.json (the legacy GPU choice that settings migrate on read).

``fake_ml`` stands in for torch and transformers, so model-loading tests never
import the real libraries (a bit-flip in torch's cached CUDA library once made
``import torch`` die with SIGILL on the dev box)."""
import os
import sys
import types

import pytest

# Must precede any import of backend.server: TestClient sends "Host: testserver".
os.environ["FLUX_PREP_EXTRA_HOSTS"] = "testserver"

from backend import gpu, settings

ML_MODULES = ("torch", "transformers")


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CONFIG_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")


@pytest.fixture
def fake_ml(monkeypatch):
    """Empty ``torch`` (dtypes only) and ``transformers`` modules in sys.modules;
    tests add the attributes the code under test touches."""
    torch = types.ModuleType("torch")
    torch.float16, torch.float32 = "float16", "float32"
    transformers = types.ModuleType("transformers")
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    return types.SimpleNamespace(torch=torch, transformers=transformers)


@pytest.fixture(scope="module")
def ml_modules_at_start():
    """Which of ML_MODULES were imported before the module's first test (use it
    through ``pytestmark`` so it is taken before any test runs)."""
    return {m for m in ML_MODULES if m in sys.modules}
