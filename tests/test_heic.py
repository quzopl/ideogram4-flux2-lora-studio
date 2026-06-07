from pathlib import Path
from PIL import Image
from backend import image_utils


def test_supported_ext_includes_heic():
    assert ".heic" in image_utils.SUPPORTED_EXT
    assert ".heif" in image_utils.SUPPORTED_EXT


def test_process_heic_file(tmp_path: Path):
    src = tmp_path / "sample.heic"
    Image.new("RGB", (1200, 800), (120, 60, 30)).save(src, format="HEIF")
    img, (w, h) = image_utils.process_image(str(src), 512, 64, square=True)
    assert img.mode == "RGB"
    assert (w, h) == (512, 512)
