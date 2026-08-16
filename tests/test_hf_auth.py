import os
import stat

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


def test_apply_env_sets_and_unsets():
    prev = os.environ.get("HF_TOKEN")
    try:
        hf_auth.apply_env("hf_secret")
        assert os.environ["HF_TOKEN"] == "hf_secret"
        hf_auth.apply_env("")
        assert "HF_TOKEN" not in os.environ
    finally:
        if prev is not None:
            os.environ["HF_TOKEN"] = prev
        else:
            os.environ.pop("HF_TOKEN", None)


def test_load_token_handles_malformed_json_array(tmp_path):
    p = tmp_path / "hf.json"
    p.write_text("[]", encoding="utf-8")
    assert hf_auth.load_token(p) == ""


def test_load_token_handles_malformed_json_null(tmp_path):
    p = tmp_path / "hf.json"
    p.write_text("null", encoding="utf-8")
    assert hf_auth.load_token(p) == ""


def test_load_token_handles_malformed_json_number(tmp_path):
    p = tmp_path / "hf.json"
    p.write_text("123", encoding="utf-8")
    assert hf_auth.load_token(p) == ""


def test_load_token_handles_non_string_token_value(tmp_path):
    p = tmp_path / "hf.json"
    p.write_text('{"token": 123}', encoding="utf-8")
    assert hf_auth.load_token(p) == ""


def test_save_token_file_permissions(tmp_path):
    p = tmp_path / "hf.json"
    hf_auth.save_token(p, "hf_secret")
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600
