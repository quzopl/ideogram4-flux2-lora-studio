from PIL import Image

from backend import crop_auto


def _img(w=2000, h=1000):
    return Image.new("RGB", (w, h), (0, 0, 0))


def test_largest_box_picks_biggest_area():
    boxes = [[0, 0, 10, 10], [100, 100, 400, 500], [0, 0, 50, 50]]
    assert crop_auto.largest_box(boxes) == [100, 100, 400, 500]


def test_largest_box_empty_is_none():
    assert crop_auto.largest_box([]) is None


def test_suggest_crop_uses_detection():
    img = _img()
    box = crop_auto.suggest_crop(
        img, "person", 1024, 64, True, detect=lambda *_: [[900, 300, 1100, 700]])
    x, y, w, h = box
    assert abs(w - h) <= 1                      # square mode -> 1:1 crop
    assert x <= 900 and x + w >= 1100           # zawiera detekcję


def test_suggest_crop_face_mode_leaves_headroom():
    img = _img(1000, 2000)
    det = lambda *_: [[400, 800, 600, 1000]]
    face = crop_auto.suggest_crop(img, "person", 1024, 64, True, detect=det)
    generic = crop_auto.suggest_crop(img, "generic", 1024, 64, True, detect=det)
    assert face[1] < generic[1]                 # kadr twarzy przesunięty w górę


def test_suggest_crop_bucket_mode_keeps_source_aspect():
    img = _img(2000, 1000)
    x, y, w, h = crop_auto.suggest_crop(
        img, "generic", 1024, 64, False, detect=lambda *_: [[800, 300, 1200, 700]])
    assert abs((w / h) - 2.0) < 0.05            # proporcja oryginału zachowana


def test_suggest_crop_no_detection_returns_none():
    assert crop_auto.suggest_crop(
        _img(), "generic", 1024, 64, True, detect=lambda *_: []) is None


def test_suggest_crop_skips_landscape_and_architecture():
    called = []

    def det(*_):
        called.append(1)
        return [[0, 0, 100, 100]]

    assert crop_auto.suggest_crop(_img(), "landscape", 1024, 64, True, detect=det) is None
    assert crop_auto.suggest_crop(_img(), "architecture", 1024, 64, True, detect=det) is None
    assert called == []                          # detektor nawet nie ruszył


def test_suggest_crop_never_smaller_than_target():
    img = _img(3000, 3000)
    _, _, w, h = crop_auto.suggest_crop(
        img, "generic", 1024, 64, True, detect=lambda *_: [[1490, 1490, 1510, 1510]])
    assert w >= 1024 and h >= 1024


def test_suggest_crop_detection_failure_falls_back_to_none():
    def det(*_):
        raise RuntimeError("model load failed")

    assert crop_auto.suggest_crop(_img(), "generic", 1024, 64, True, detect=det) is None
