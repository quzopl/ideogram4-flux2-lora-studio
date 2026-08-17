from PIL import Image

from backend import image_utils


def _make(tmp_path, w, h, color=(10, 20, 30)):
    p = tmp_path / f"img_{w}x{h}.png"
    Image.new("RGB", (w, h), color).save(p)
    return str(p)


def test_clamp_box_inside_image():
    assert image_utils.clamp_box((10, 20, 100, 200), 1000, 1000) == (10, 20, 100, 200)


def test_clamp_box_trims_overflow():
    x, y, w, h = image_utils.clamp_box((900, 900, 500, 500), 1000, 1000)
    assert (x, y) == (900, 900)
    assert (w, h) == (100, 100)


def test_clamp_box_degenerate_returns_whole_image():
    assert image_utils.clamp_box((10, 10, 2, 2), 800, 600) == (0, 0, 800, 600)
    assert image_utils.clamp_box((-50, -50, 1, 1), 800, 600) == (0, 0, 800, 600)


def test_box_around_keeps_aspect_and_contains_bbox():
    x, y, w, h = image_utils.box_around(2000, 1000, (900, 400, 1100, 600), 1.0)
    assert abs(w / h - 1.0) < 0.01
    assert x <= 900 and y <= 400 and x + w >= 1100 and y + h >= 600


def test_box_around_clamped_to_image_edges():
    x, y, w, h = image_utils.box_around(1000, 1000, (0, 0, 100, 100), 1.0, margin=2.0)
    assert x >= 0 and y >= 0
    assert x + w <= 1000 and y + h <= 1000


def test_box_around_min_side_enforced():
    _, _, w, h = image_utils.box_around(
        2000, 2000, (990, 990, 1010, 1010), 1.0, margin=0.0, min_side=800)
    assert w >= 800 and h >= 800


def test_box_around_headroom_moves_box_up():
    _, y_plain, _, _ = image_utils.box_around(2000, 2000, (900, 900, 1100, 1100), 1.0)
    _, y_head, _, _ = image_utils.box_around(
        2000, 2000, (900, 900, 1100, 1100), 1.0, headroom=0.3)
    assert y_head < y_plain


def test_process_image_backwards_compatible(tmp_path):
    src = _make(tmp_path, 2000, 1000)
    img, (w, h) = image_utils.process_image(src, 1024, 64, False)
    assert (img.width, img.height) == (w, h)
    assert w > h                      # landscape bucket, jak dotychczas


def test_process_image_bucket_follows_crop_aspect(tmp_path):
    src = _make(tmp_path, 2000, 1000)          # 2:1
    _, (w, h) = image_utils.process_image(
        src, 1024, 64, False, crop=(0, 0, 500, 1000))   # kadr 1:2
    assert h > w                                 # bucket idzie za kadrem


def test_process_image_square_ignores_crop_aspect(tmp_path):
    src = _make(tmp_path, 2000, 1000)
    _, size = image_utils.process_image(
        src, 1024, 64, True, crop=(0, 0, 500, 1000))
    assert size == (1024, 1024)


def test_process_image_contain_pads_with_colour(tmp_path):
    src = _make(tmp_path, 2000, 1000, color=(255, 0, 0))
    img, (w, h) = image_utils.process_image(
        src, 1024, 64, True, fit="contain", pad_color="#00ff00")
    assert (img.width, img.height) == (1024, 1024)
    assert img.getpixel((w // 2, 2)) == (0, 255, 0)      # pas dopełnienia u góry
    assert img.getpixel((w // 2, h // 2)) == (255, 0, 0)  # obraz w środku


def test_process_image_centering_top_keeps_top_band(tmp_path):
    # górna połowa czerwona, dolna niebieska; kwadratowy kadr z centeringiem "top"
    p = tmp_path / "half.png"
    img = Image.new("RGB", (1000, 2000), (255, 0, 0))
    img.paste(Image.new("RGB", (1000, 1000), (0, 0, 255)), (0, 1000))
    img.save(p)
    out, _ = image_utils.process_image(
        str(p), 512, 64, True, centering=image_utils.centering_pair("center", "top"))
    assert out.getpixel((256, 256)) == (255, 0, 0)


def test_centering_pair_maps_names():
    assert image_utils.centering_pair("left", "top") == (0.0, 0.0)
    assert image_utils.centering_pair("right", "bottom") == (1.0, 1.0)
    assert image_utils.centering_pair("nonsense", "nonsense") == (0.5, 0.5)


def test_process_image_calls_upscale_hook(tmp_path):
    src = _make(tmp_path, 200, 100)
    seen = {}

    def hook(img, target):
        seen["target"] = target
        return img.resize((img.width * 2, img.height * 2))

    _, (w, h) = image_utils.process_image(src, 1024, 64, False, upscale=hook)
    assert seen["target"] == (w, h)
