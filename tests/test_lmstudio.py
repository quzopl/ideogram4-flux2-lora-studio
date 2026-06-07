import base64
import json
import pytest
from PIL import Image
from backend import lmstudio


class _FakeResp:
    def __init__(self, obj):
        self._b = json.dumps(obj).encode("utf-8")
    def read(self):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_image_data_uri_is_png():
    uri = lmstudio._image_data_uri(Image.new("RGB", (4, 4), (1, 2, 3)))
    assert uri.startswith("data:image/png;base64,")
    raw = base64.b64decode(uri.split(",", 1)[1])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"


def test_list_models_parses(monkeypatch):
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp({"data": [{"id": "a"}, {"id": "b"}]}))
    assert lmstudio.list_models("http://x/v1") == ["a", "b"]


def test_list_models_offline_returns_empty(monkeypatch):
    def boom(req, timeout=0):
        raise OSError("refused")
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", boom)
    assert lmstudio.list_models("http://x/v1") == []


def test_caption_image_payload_and_parse(monkeypatch):
    captured = {}
    def fake(req, timeout=0):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp({"choices": [{"message": {"content": "a caption"}}]})
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", fake)
    out = lmstudio.caption_image("http://x/v1", "m", Image.new("RGB", (4, 4)), "describe", 100)
    assert out == "a caption"
    assert captured["url"].endswith("/chat/completions")
    assert captured["body"]["model"] == "m"
    content = captured["body"]["messages"][0]["content"]
    assert any(b.get("type") == "image_url"
               and b["image_url"]["url"].startswith("data:image/png;base64,")
               for b in content)
    assert any(b.get("type") == "text" and b["text"] == "describe" for b in content)


def test_generate_text_parse(monkeypatch):
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp({"choices": [{"message": {"content": "txt"}}]}))
    assert lmstudio.generate_text("http://x/v1", "m", "sys", "usr") == "txt"


def test_chat_network_error_raises(monkeypatch):
    def boom(req, timeout=0):
        raise OSError("refused")
    monkeypatch.setattr(lmstudio.urllib.request, "urlopen", boom)
    with pytest.raises(lmstudio.LMStudioError):
        lmstudio.generate_text("http://x/v1", "m", "s", "u")


from backend import server


def test_lmstudio_model_id():
    assert server._lmstudio_model_id("lmstudio:foo") == "foo"
    assert server._lmstudio_model_id("Qwen/Qwen2.5-VL-7B-Instruct") is None


def test_lmstudio_url_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LMSTUDIO_CONFIG_PATH", tmp_path / "lm.json")
    assert server._lmstudio_url() == lmstudio.DEFAULT_URL
    assert server._set_lmstudio_url("http://host:9/v1") == "http://host:9/v1"
    assert server._lmstudio_url() == "http://host:9/v1"


def test_all_models_includes_lmstudio(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    monkeypatch.setattr(server.lmstudio, "list_models", lambda url, timeout=3.0: ["vl-7b"])
    models = server._all_models()
    assert models["lmstudio:vl-7b"] == "LM Studio: vl-7b"
