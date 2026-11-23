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

from backend import crop_store, gpu, settings

ML_MODULES = ("torch", "transformers")


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CONFIG_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
    monkeypatch.setattr(crop_store, "PATH", tmp_path / "crop_plans.json")


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


@pytest.fixture
def prompt_db(tmp_path, monkeypatch):
    """Fresh prompt-library database (not autouse): tests that reach
    ``_save_prompt_to_library`` take it so they never touch the real one."""
    from backend import core
    monkeypatch.setattr(core, "DB_PATH", tmp_path / "flux_prep.db")
    core._init_db()
    return tmp_path / "flux_prep.db"


@pytest.fixture
def comfy_store(tmp_path, monkeypatch):
    """Every ComfyUI store under ``tmp_path`` (not autouse): config, mapping and
    prompt libraries, the gallery, the SQLite DB (workflow library) and the
    Ideogram render params; the object_info cache and the job table start empty."""
    from backend import api_comfy, core
    gallery = tmp_path / "comfy_gallery"
    gallery.mkdir()
    monkeypatch.setattr(core, "COMFY_CONFIG_PATH", tmp_path / "comfy_config.json")
    monkeypatch.setattr(core, "COMFY_MAPPINGS_PATH", tmp_path / "comfy_mappings.json")
    monkeypatch.setattr(core, "COMFY_PROMPTS_PATH", tmp_path / "comfy_prompts.json")
    monkeypatch.setattr(core, "COMFY_WORKFLOWS_PATH", tmp_path / "comfy_workflows.json")
    monkeypatch.setattr(core, "IDEOGRAM_RENDER_CFG_PATH", tmp_path / "ideogram_render.json")
    monkeypatch.setattr(core, "COMFY_GALLERY_DIR", gallery)
    monkeypatch.setattr(core, "DB_PATH", tmp_path / "flux_prep.db")
    core._init_db()
    monkeypatch.setattr(api_comfy, "_OBJECT_INFO_CACHE", {"url": None, "data": None, "ts": 0.0})
    core.COMFY_JOBS.clear()
    yield tmp_path
    core.COMFY_JOBS.clear()
