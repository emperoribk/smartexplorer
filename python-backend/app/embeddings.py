"""CLIP embeddings: the thing that lets you type 'bag' and get a photo of a bag
back even though the filename is IMG_6154.jpeg and there's no text in it.

Model is loaded once, lazily, and cached for the life of the process. First
call downloads the pretrained weights (~350MB) to the user's torch cache.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import List, Optional

_lock = threading.Lock()
_model = None
_preprocess = None
_tokenizer = None
_device = "cpu"
# "bundled" when the weights came from the installer's models folder,
# "download" when open_clip fetched them - the build script checks this.
model_source = ""

MODEL_NAME = "ViT-B-32"
PRETRAINED = "openai"

# The installer ships the CLIP weights here (see build-installer.ps1) so the
# app works offline and indexing never has to wait on a ~350MB download. In a
# source checkout this folder is simply absent and open_clip falls back to its
# usual download-on-first-use cache.
BUNDLED_MODEL_DIR = Path(__file__).resolve().parent.parent / "models"


def _bundled_weights() -> Optional[str]:
    """Path of the bundled CLIP weights, if the installer shipped them.
    open_clip stores a downloaded model in a Hugging Face cache layout
    (models--timm--...\\snapshots\\<hash>\\open_clip_model.safetensors), so
    look for the file instead of assuming a fixed path."""
    try:
        for f in BUNDLED_MODEL_DIR.rglob("open_clip_model.safetensors"):
            if f.is_file():
                return str(f)
    except OSError:
        pass
    return None


def _ensure_loaded():
    global _model, _preprocess, _tokenizer, _device, model_source
    if _model is not None:
        return
    with _lock:
        if _model is not None:
            return
        import open_clip
        import torch

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        model = preprocess = None
        weights = _bundled_weights()
        if weights:
            try:
                # Same architecture and weights as pretrained="openai" (that
                # tag is ViT-B-32 with QuickGELU), loaded from the local file
                # so no network is involved.
                model, _, preprocess = open_clip.create_model_and_transforms(
                    MODEL_NAME + "-quickgelu", pretrained=weights
                )
                model_source = "bundled"
            except Exception:
                model = preprocess = None
        if model is None:
            model, _, preprocess = open_clip.create_model_and_transforms(
                MODEL_NAME, pretrained=PRETRAINED
            )
            model_source = "download"
        model.eval().to(_device)
        tokenizer = open_clip.get_tokenizer(MODEL_NAME)
        _model, _preprocess, _tokenizer = model, preprocess, tokenizer


def ensure_ready() -> bool:
    """Load the model now (downloading it if it isn't bundled/cached yet).
    True when embeddings will actually work - used by the background
    indexer, which must not index photos while this is False."""
    try:
        _ensure_loaded()
        return True
    except Exception:
        return False


def embed_image(path: Path) -> Optional[List[float]]:
    try:
        import torch
        from PIL import Image

        _ensure_loaded()
        with Image.open(path) as img:
            img = img.convert("RGB")
            tensor = _preprocess(img).unsqueeze(0).to(_device)
        with torch.no_grad():
            feats = _model.encode_image(tensor)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        return feats.squeeze(0).cpu().tolist()
    except Exception:
        return None


def embed_text(query: str) -> Optional[List[float]]:
    try:
        import torch

        _ensure_loaded()
        # CLIP's text side was trained on real photo captions - natural
        # sentences describing a whole scene ("a photo of two people playing
        # chess in a park"), not bare keyword lists. Wrapping a search like
        # "trading pnl card" or "a music studio" into that same sentence
        # shape puts it back in the kind of text CLIP actually learned from,
        # which measurably improves how well it recognizes a *concept* a
        # picture represents - not just literal objects in it. This is a
        # standard, well-established technique for CLIP specifically (the
        # model's own paper uses the same "a photo of a {}" template for
        # exactly this reason), not something specific to this app's data.
        prompt = f"a photo of {query.strip()}"
        tokens = _tokenizer([prompt]).to(_device)
        with torch.no_grad():
            feats = _model.encode_text(tokens)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        return feats.squeeze(0).cpu().tolist()
    except Exception:
        return None


def embed_texts_raw(prompts: List[str]):
    """Unit-length CLIP text vectors for a list of prompts, used as-is (no
    "a photo of" wrapper added), as a float32 numpy array - or None if the
    model can't be loaded. For zero-shot labelling (see visualnames.py)."""
    try:
        import numpy as np
        import torch

        _ensure_loaded()
        out = []
        with torch.no_grad():
            for i in range(0, len(prompts), 64):
                tokens = _tokenizer(prompts[i : i + 64]).to(_device)
                feats = _model.encode_text(tokens)
                feats = feats / feats.norm(dim=-1, keepdim=True)
                out.append(feats.cpu().numpy())
        return np.concatenate(out).astype("float32")
    except Exception:
        return None


def cosine_similarity(a: List[float], b: List[float]) -> float:
    import numpy as np

    va, vb = np.array(a, dtype=np.float32), np.array(b, dtype=np.float32)
    denom = (np.linalg.norm(va) * np.linalg.norm(vb)) or 1e-8
    return float(np.dot(va, vb) / denom)
