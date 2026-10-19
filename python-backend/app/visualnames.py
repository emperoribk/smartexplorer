"""Smart naming for PHOTOS: a short, descriptive filename built from what the
picture actually shows, e.g. `Brown-bag-on-yellow-background.jpg`.

namegen.py names a file from the text OCR found inside it - right for a
screenshot, ticket or scan, useless for a photo (OCR on a photo of a bag
returns random fragments like "cen cet spr", which is exactly what became
"Cen-cet-spr-nnncetantet-pee.jpg"). Here the image's own CLIP embedding - the
one search already stores - is compared against a vocabulary of everyday
nouns, the same zero-shot technique CLIP is built for. Colour comes from CLIP
too ("a photo of a {colour} bag"), and the background colour is read straight
from the pixels around the edge.

Nothing new is indexed: this only does a little maths on a stored vector.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

# Things that have a colour worth putting in the name.
OBJECTS = [
    "bag", "handbag", "backpack", "tote bag", "suitcase", "wallet", "purse", "shoes", "sneakers", "boots",
    "sandals", "high heels", "hat", "cap", "scarf", "glasses", "sunglasses", "watch", "ring", "necklace",
    "jacket", "coat", "dress", "shirt", "t-shirt", "sweater", "hoodie", "jeans", "pants", "skirt", "suit",
    "belt", "gloves", "umbrella", "headphones", "earbuds", "speaker", "phone", "smartphone", "laptop",
    "computer", "keyboard", "mouse", "monitor", "television", "camera", "tablet", "smartwatch", "console",
    "game controller", "drone", "lamp", "light bulb", "clock", "chair", "armchair", "sofa", "couch", "table",
    "desk", "bed", "bookshelf", "cabinet", "mirror", "vase", "pillow", "blanket", "rug", "curtains",
    "candle", "bottle", "cup", "mug", "glass", "plate", "bowl", "fork", "knife", "spoon", "teapot", "kettle",
    "pot", "pan", "bicycle", "motorcycle", "scooter", "car", "sports car", "truck", "van", "bus", "taxi",
    "train", "airplane", "helicopter", "boat", "sailboat", "ship", "skateboard", "helmet", "ball", "football",
    "basketball", "tennis racket", "guitar", "piano", "violin", "drum", "microphone", "book", "notebook",
    "pen", "pencil", "paper", "envelope", "box", "package", "gift", "toy", "teddy bear", "doll", "balloon",
    "flower", "bouquet", "rose", "tulip", "sunflower", "plant", "cactus", "tree", "leaf", "apple", "banana",
    "orange", "lemon", "strawberry", "grapes", "watermelon", "avocado", "tomato", "carrot", "pizza",
    "burger", "sandwich", "salad", "pasta", "sushi", "cake", "cupcake", "cookie", "bread", "croissant",
    "donut", "ice cream", "chocolate", "coffee", "tea", "wine", "beer", "cocktail", "juice", "egg", "cheese",
    "soup", "steak", "chicken", "fish", "rice", "key", "lock", "coin", "money", "credit card", "ticket",
    "logo", "icon", "sticker", "poster", "painting", "sculpture", "statue", "tool", "hammer", "screwdriver",
    "scissors", "brush", "paint", "bucket", "ladder", "fan", "remote control", "battery", "cable", "charger",
    "dog", "cat", "bird", "horse", "cow", "sheep", "rabbit", "fish", "butterfly", "bee", "lion", "tiger",
    "elephant", "bear", "monkey", "fox", "wolf", "deer", "parrot", "owl", "duck", "turtle", "snake",
    "spider", "robot", "rocket", "tent", "house", "door", "window", "bridge",
]

# Scenes, places and people: colour in the name would be noise.
SCENES = [
    "mountain", "mountains", "snowy mountain", "lake", "river", "waterfall", "ocean", "beach", "sunset",
    "sunrise", "forest", "jungle", "desert", "field", "meadow", "valley", "canyon", "hill", "island",
    "glacier", "volcano", "cave", "sky", "clouds", "night sky", "stars", "milky way", "storm", "rain",
    "snow", "fog", "city", "skyline", "skyscraper", "street", "road", "highway", "village", "castle",
    "church", "temple", "mosque", "building", "architecture", "stadium", "airport", "train station",
    "kitchen", "living room", "bedroom", "bathroom", "office", "classroom", "restaurant", "cafe", "market",
    "shop", "park", "garden", "playground", "swimming pool", "gym", "farm", "harbor", "bridge at night",
    "person", "portrait", "woman", "man", "child", "baby", "people", "crowd", "couple", "family", "group of friends",
    "wedding", "party", "concert", "festival", "sports match", "runner", "swimmer", "cyclist", "dancer",
    "selfie", "chart", "graph", "map", "diagram", "illustration", "cartoon", "pattern", "texture",
    "abstract art", "wallpaper", "landscape", "cityscape", "seascape",
]

COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "beige", "black",
          "white", "gray", "gold", "silver"]

# An image counts as a photograph (named from what it shows) at or above this
# probability; below it, it is a screenshot/document and is named from its text.
# Calibrated on a real Downloads folder: photos scored 0.62-1.0, screenshots
# mostly under 0.5.
PHOTO_THRESHOLD = 0.55
MIN_CONFIDENCE = 0.20  # top noun's share of the probability
TEMPERATURE = 100.0    # CLIP's own logit scale

_cache: dict = {}


def _text_matrix(key: str, prompts: list[str]) -> Optional[np.ndarray]:
    if key in _cache:
        return _cache[key]
    from . import embeddings

    mat = embeddings.embed_texts_raw(prompts)
    if mat is None:
        return None
    _cache[key] = mat
    return mat


def _unit(v) -> np.ndarray:
    a = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(a))
    return a / n if n > 0 else a


def _softmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max()
    e = np.exp(x)
    return e / e.sum()


def warm() -> None:
    """Build the label vectors now (a few seconds on first use) so the first
    "Suggest a name" click is instant. Safe to call any time the model is up."""
    _text_matrix("nouns", [f"a photo of a {w}" for w in OBJECTS + SCENES])
    _text_matrix("kind", _KIND_PROMPTS)


_KIND_PROMPTS = [
    "a photograph",
    "a product photo on a plain background",
    "a screenshot of an app, website or chat",
    "a scanned document or a page of text",
]


def classify_photo(img_vec) -> Optional[float]:
    """Probability that the image is a photograph / picture (rather than a
    screenshot or a page of text) - decides whether to name it from what it
    shows or from the text inside it."""
    mat = _text_matrix("kind", _KIND_PROMPTS)
    if mat is None:
        return None
    probs = _softmax(TEMPERATURE * (mat @ _unit(img_vec)))
    return float(probs[0] + probs[1])


def _nouns(img_vec) -> Optional[tuple[str, float, bool]]:
    vocab = OBJECTS + SCENES
    mat = _text_matrix("nouns", [f"a photo of a {w}" for w in vocab])
    if mat is None:
        return None
    probs = _softmax(TEMPERATURE * (mat @ _unit(img_vec)))
    i = int(probs.argmax())
    return vocab[i], float(probs[i]), i < len(OBJECTS)


def _colour(img_vec, noun: str) -> Optional[str]:
    mat = _text_matrix(f"colour:{noun}", [f"a photo of a {c} {noun}" for c in COLORS])
    if mat is None:
        return None
    probs = _softmax(TEMPERATURE * (mat @ _unit(img_vec)))
    return COLORS[int(probs.argmax())]


def _rgb_to_name(r: float, g: float, b: float) -> str:
    import colorsys

    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if v < 0.18:
        return "black"
    if s < 0.12:
        return "white" if v > 0.85 else "gray" if v > 0.35 else "black"
    deg = h * 360
    if s < 0.35 and 20 <= deg < 50 and v > 0.6:
        return "beige"
    if deg < 15 or deg >= 345:
        return "red" if v > 0.45 else "brown"
    if deg < 40:
        return "orange" if (v > 0.7 and s > 0.6) else "brown"
    if deg < 68:
        return "yellow"
    if deg < 160:
        return "green"
    if deg < 255:
        return "blue"
    if deg < 295:
        return "purple"
    return "pink"


def plain_background(path: Path) -> Optional[str]:
    """Colour name of the border of the picture IF it is a fairly uniform
    backdrop (a studio shot on yellow, a product on white); None for busy
    scenes, where "on a X background" would not mean anything."""
    try:
        from PIL import Image

        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((96, 96))
            w, h = im.size
            if w < 16 or h < 16:
                return None
            px = np.asarray(im, dtype=np.float32)
        m = max(2, int(min(w, h) * 0.10))
        ring = np.concatenate([
            px[:m].reshape(-1, 3), px[-m:].reshape(-1, 3),
            px[m:-m, :m].reshape(-1, 3), px[m:-m, -m:].reshape(-1, 3),
        ])
        # Uniform enough: the ring's colours sit close to their median.
        med = np.median(ring, axis=0)
        spread = float(np.mean(np.linalg.norm(ring - med, axis=1)))
        if spread > 28:
            return None
        return _rgb_to_name(*med)
    except Exception:
        return None


def suggest_photo_name(img_vec, path: Path) -> Optional[str]:
    """`Brown-bag-on-yellow-background` (no extension), or None when the
    picture doesn't clearly show anything in the vocabulary."""
    found = _nouns(img_vec)
    if found is None:
        return None
    noun, conf, is_object = found
    if conf < MIN_CONFIDENCE:
        return None
    parts = [noun.replace(" ", "-")]
    if is_object:
        colour = _colour(img_vec, noun)
        bg = plain_background(path)
        if colour and colour != bg:
            parts.insert(0, colour)
        if bg:
            parts += ["on", bg, "background"]
    slug = "-".join(parts)
    return slug[0].upper() + slug[1:]
