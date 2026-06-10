import json
from backend import florence


def test_nearest_aspect_snaps_to_standard():
    assert florence.nearest_aspect(4032, 3024) == "4:3"
    assert florence.nearest_aspect(1080, 1920) == "9:16"
    assert florence.nearest_aspect(1000, 1001) == "1:1"
    assert florence.nearest_aspect(3000, 1000) == "3:1"


def test_norm_bbox_to_v15_order():
    # pixel xyxy -> [y1,x1,y2,x2] on 0-1000
    assert florence.norm_bbox_xyxy([100, 50, 300, 150], 1000, 500) == [100, 100, 300, 300]


def test_norm_bbox_clamps_and_swaps():
    out = florence.norm_bbox_xyxy([900, 400, 100, -50], 1000, 1000)
    y1, x1, y2, x2 = out
    assert y1 <= y2 and x1 <= x2 and all(0 <= c <= 1000 for c in out)


def test_quad_to_xyxy():
    quad = [10, 20, 110, 25, 108, 80, 12, 78]  # 4 x,y points
    assert florence.quad_to_xyxy(quad) == [10, 20, 110, 80]


def test_bbox_iou():
    a = [0, 0, 100, 100]
    assert florence.bbox_iou(a, a) == 1.0
    assert florence.bbox_iou(a, [200, 200, 300, 300]) == 0.0


def test_clean_label_strips_tags():
    assert florence.clean_label("</s><s>red car</s>") == "red car"
    assert florence.clean_label("  ") == "object"


def test_merge_detections_enriches_and_dedupes():
    od = {"labels": ["cat", "cat"], "bboxes": [[0, 0, 500, 500], [2, 2, 500, 500]]}
    dense = {"labels": ["a tabby cat sleeping"], "bboxes": [[0, 0, 500, 500]]}
    ocr = {"labels": ["HELLO"], "quad_boxes": [[600, 600, 900, 610, 898, 700, 602, 695]]}
    els = florence.merge_detections(od, dense, ocr, 1000, 1000)
    objs = [e for e in els if e["type"] == "obj"]
    texts = [e for e in els if e["type"] == "text"]
    assert len(objs) == 1                      # duplicate cut by IoU
    assert objs[0]["desc"] == "a tabby cat sleeping"  # enriched from dense regions
    assert len(texts) == 1 and texts[0]["text"] == "HELLO"


def test_merge_detections_falls_back_to_dense():
    dense = {"labels": ["a red bike"], "bboxes": [[100, 100, 600, 600]]}
    els = florence.merge_detections({}, dense, {}, 1000, 1000)
    assert len(els) == 1 and els[0]["desc"] == "a red bike"


def test_build_v15_draft_shape():
    els = [
        {"type": "obj", "bbox": [100, 100, 900, 500], "desc": "a tabby cat"},
        {"type": "text", "bbox": [50, 600, 120, 950], "desc": 'text "HELLO"', "text": "HELLO"},
    ]
    draft = florence.build_v15_draft("A tabby cat next to a sign.", els, 1600, 1200)
    obj = json.loads(draft)
    assert list(obj.keys()) == ["aspect_ratio", "high_level_description",
                                "compositional_deconstruction"]
    assert obj["aspect_ratio"] == "4:3"
    out_els = obj["compositional_deconstruction"]["elements"]
    assert out_els[0] == {"type": "obj", "bbox": [100, 100, 900, 500], "desc": "a tabby cat"}
    assert out_els[1]["text"] == "HELLO"
    assert "\n" not in draft  # minified


def test_build_v15_draft_caps_hld_at_sentence():
    long_caption = ("The first sentence about a cat. " + "word " * 60).strip()
    draft = json.loads(florence.build_v15_draft(long_caption, [], 1000, 1000))
    hld = draft["high_level_description"]
    assert len(hld.split()) <= 50
    assert hld.startswith("The first sentence")


def test_analyze_endpoint_uses_module(monkeypatch, tmp_path):
    import io
    import asyncio
    from PIL import Image
    from backend import server

    def fake_analyze(img):
        return "A test scene.", [{"type": "obj", "bbox": [0, 0, 500, 500], "desc": "a thing"}]
    monkeypatch.setattr(server.florence, "analyze_image", fake_analyze)

    buf = io.BytesIO()
    Image.new("RGB", (800, 600), "red").save(buf, format="PNG")
    buf.seek(0)

    from starlette.datastructures import UploadFile, Headers
    up = UploadFile(buf, filename="t.png", headers=Headers({"content-type": "image/png"}))
    out = asyncio.run(server.api_ideogram_analyze(up))
    obj = json.loads(out["json"])
    assert obj["aspect_ratio"] == "4:3"
    assert obj["compositional_deconstruction"]["elements"][0]["desc"] == "a thing"
    assert isinstance(out["warnings"], list)
