import json
import pytest
from backend import server


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """Świeża baza SQLite per test — podmienia DB_PATH i tworzy schemat."""
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    server._init_db()
    return tmp_path / "test.db"


def test_prompt_category_mapping():
    assert server._prompt_category("flux") == "flux"
    assert server._prompt_category("ideogram") == "ideogram"
    assert server._prompt_category("aitoolkit") == "ideogram"
    assert server._prompt_category("anything-else") == "flux"


def test_save_and_list_newest_first(tmp_db):
    server._save_prompt_to_library("flux", "expand", "a cat", "A tabby cat sits on a windowsill.")
    server._save_prompt_to_library(
        "ideogram", "expand", "a dog",
        '{"aspect_ratio":"1:1","high_level_description":"a dog"}')
    out = server.api_prompt_library("all")
    assert len(out["prompts"]) == 2
    assert out["prompts"][0]["category"] == "ideogram"  # nowszy pierwszy
    assert out["prompts"][1]["prompt"].startswith("A tabby cat")
    assert out["prompts"][0]["id"] > out["prompts"][1]["id"]


def test_list_filters_by_category(tmp_db):
    server._save_prompt_to_library("flux", "expand", "x", "prompt one")
    server._save_prompt_to_library(
        "ideogram", "refine", "y", '{"aspect_ratio":"1:1","high_level_description":"z"}')
    flux = server.api_prompt_library("flux")["prompts"]
    ideo = server.api_prompt_library("ideogram")["prompts"]
    assert len(flux) == 1 and flux[0]["category"] == "flux"
    assert len(ideo) == 1 and ideo[0]["category"] == "ideogram"


def test_ideogram_must_be_json(tmp_db):
    with pytest.raises(ValueError):
        server._save_prompt_to_library("ideogram", "expand", "x", "not a json prompt")


def test_ideogram_json_roundtrip(tmp_db):
    p = '{"aspect_ratio":"16:9","high_level_description":"café in Łódź"}'
    server._save_prompt_to_library("ideogram", "expand", "kawiarnia", p)
    row = server.api_prompt_library("ideogram")["prompts"][0]
    assert json.loads(row["prompt"])["high_level_description"] == "café in Łódź"


def test_delete_prompt(tmp_db):
    pid = server._save_prompt_to_library("flux", "expand", "x", "to delete")
    assert len(server.api_prompt_library("all")["prompts"]) == 1
    server.api_prompt_library_delete(pid)
    assert server.api_prompt_library("all")["prompts"] == []


def test_delete_unknown_id_404(tmp_db):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        server.api_prompt_library_delete(12345)


def test_export_sql_dump(tmp_db):
    server._save_prompt_to_library("flux", "expand", "idea", "it's a prompt with 'quotes'")
    server._save_prompt_to_library(
        "ideogram", "refine", "json", '{"aspect_ratio":"1:1","high_level_description":"x"}')
    resp = server.api_prompt_library_export("all")
    sql = resp.body.decode("utf-8")
    assert "CREATE TABLE IF NOT EXISTS prompt_library" in sql
    assert sql.count("INSERT INTO prompt_library") == 2
    assert "it''s a prompt with ''quotes''" in sql  # poprawne escapowanie SQL
    assert ".sql" in resp.headers["content-disposition"]


def test_export_sql_filtered(tmp_db):
    server._save_prompt_to_library("flux", "expand", "a", "flux prompt")
    server._save_prompt_to_library(
        "ideogram", "expand", "b", '{"aspect_ratio":"1:1","high_level_description":"c"}')
    sql = server.api_prompt_library_export("ideogram").body.decode("utf-8")
    assert sql.count("INSERT INTO prompt_library") == 1
    assert "flux prompt" not in sql
