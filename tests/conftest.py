"""Suite-wide isolation: no test may read or write the real .work/settings.json."""
import pytest

from backend import settings


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CONFIG_PATH", tmp_path / "settings.json")
