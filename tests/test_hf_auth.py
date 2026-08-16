import os

from backend import hf_auth


def test_status_masks_token():
    st = hf_auth.status("hf_abcdefgh1234")
    assert st == {"set": True, "tail": "1234"}


def test_status_empty_token():
    assert hf_auth.status("") == {"set": False, "tail": ""}


def test_status_short_token_is_not_leaked():
    st = hf_auth.status("hf_x")
    assert st["set"] is True
    assert len(st["tail"]) <= 4
    assert "hf_x" not in st["tail"] or st["tail"] == "hf_x"[-4:]


def test_save_and_load_roundtrip(tmp_path):
    p = tmp_path / "hf.json"
    hf_auth.save_token(p, "  hf_secret  ")
    assert hf_auth.load_token(p) == "hf_secret"


def test_load_missing_file_is_empty(tmp_path):
    assert hf_auth.load_token(tmp_path / "nope.json") == ""


def test_clear_token(tmp_path):
    p = tmp_path / "hf.json"
    hf_auth.save_token(p, "hf_secret")
    hf_auth.clear_token(p)
    assert hf_auth.load_token(p) == ""


def test_apply_env_sets_and_unsets(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    hf_auth.apply_env("hf_secret")
    assert os.environ["HF_TOKEN"] == "hf_secret"
    hf_auth.apply_env("")
    assert "HF_TOKEN" not in os.environ
