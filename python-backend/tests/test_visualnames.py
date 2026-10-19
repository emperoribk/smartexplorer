"""Tests for photo naming (app/visualnames.py). The CLIP text encoder is
replaced by deterministic fake vectors so the tests need no model."""
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app import embeddings, visualnames as vn

DIM = 128


def _vec(prompt: str) -> np.ndarray:
    rng = np.random.default_rng(zlib.crc32(prompt.encode()))
    v = rng.normal(size=DIM).astype("float32")
    return v / np.linalg.norm(v)


@pytest.fixture(autouse=True)
def fake_clip(monkeypatch):
    vn._cache.clear()
    monkeypatch.setattr(embeddings, "embed_texts_raw", lambda prompts: np.stack([_vec(p) for p in prompts]))
    yield
    vn._cache.clear()


def _image_of(*prompts_and_weights):
    v = sum(w * _vec(p) for p, w in prompts_and_weights)
    return (v / np.linalg.norm(v)).tolist()


def test_names_the_object_and_its_colour():
    img = _image_of(("a photo of a red handbag", 1.0), ("a photo of a handbag", 0.8))
    assert vn.suggest_photo_name(img, Path("/nope.jpg")) == "Red-handbag"


def test_scene_gets_no_colour():
    img = _image_of(("a photo of a lake", 1.0))
    assert vn.suggest_photo_name(img, Path("/nope.jpg")) == "Lake"


def test_unrecognisable_picture_gets_no_name():
    # No label stands out (equal similarity to everything) -> no name rather than a wrong one.
    assert vn.suggest_photo_name(np.zeros(DIM).tolist(), Path("/nope.jpg")) is None


def test_photo_vs_screenshot_decision():
    photo = _image_of(("a photograph", 1.0))
    shot = _image_of(("a screenshot of an app, website or chat", 1.0))
    assert vn.classify_photo(photo) >= vn.PHOTO_THRESHOLD
    assert vn.classify_photo(shot) < vn.PHOTO_THRESHOLD


def test_plain_background_is_detected(tmp_path):
    im = Image.new("RGB", (200, 300), (235, 240, 90))  # yellow-green backdrop
    im.paste((20, 20, 25), (70, 100, 130, 220))
    p = tmp_path / "studio.jpg"
    im.save(p)
    assert vn.plain_background(p) == "yellow"


def test_busy_background_is_not_called_plain(tmp_path):
    rng = np.random.default_rng(1)
    arr = rng.integers(0, 255, size=(200, 300, 3), dtype=np.uint8)
    p = tmp_path / "busy.png"
    Image.fromarray(arr).save(p)
    assert vn.plain_background(p) is None


def test_background_is_appended_when_plain_and_different_from_subject(tmp_path):
    im = Image.new("RGB", (200, 300), (250, 250, 250))
    p = tmp_path / "x.jpg"
    im.save(p)
    img = _image_of(("a photo of a black backpack", 1.0), ("a photo of a backpack", 0.8))
    assert vn.suggest_photo_name(img, p) == "Black-backpack-on-white-background"


@pytest.mark.parametrize(
    "rgb,name",
    [((220, 30, 30), "red"), ((30, 30, 220), "blue"), ((240, 240, 60), "yellow"),
     ((250, 250, 250), "white"), ((10, 10, 10), "black"), ((120, 120, 120), "gray"),
     ((110, 70, 40), "brown")],
)
def test_colour_names(rgb, name):
    assert vn._rgb_to_name(*rgb) == name
