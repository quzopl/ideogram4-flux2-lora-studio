"""Suite-wide isolation: no test may read or write the real .work/settings.json
or .work/gpu.json (the legacy GPU choice that settings migrate on read)."""
import os

import pytest

# Must precede any import of backend.server: TestClient sends "Host: testserver".
os.environ["FLUX_PREP_EXTRA_HOSTS"] = "testserver"

from backend import gpu, settings


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CONFIG_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(gpu, "CONFIG_PATH", tmp_path / "gpu.json")
