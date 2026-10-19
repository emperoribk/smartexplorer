"""Regression test: photo (CLIP) search must still run for a multi-word
query when some text file also matches those words.

Real-world failure: searching "brown bag" in a Downloads folder returned only
a text file that contains the words, and none of the brown-bag photos, because
visual search used to be skipped whenever a multi-word text match existed.
The CLIP text encoder is replaced by a fake that returns a chosen vector.
"""
import time
from pathlib import Path

import numpy as np

from app import db, embeddings, indexer, search

DIM = 64


def _unit(v):
    v = np.asarray(v, dtype=np.float32)
    return (v / np.linalg.norm(v)).tolist()


def _build(root: Path, bag_vec, n_other=60, seed=7):
    rng = np.random.default_rng(seed)
    (root / ".smartsearch").mkdir(parents=True)
    conn = db.connect(indexer.db_path_for(root))

    def add(name, kind, text="", vec=None):
        with db.transaction(conn):
            fid = db.upsert_file(
                conn, path=str(root / name), filename=name, ext=Path(name).suffix,
                size=10, mtime=time.time(), kind=kind, content_text=text,
                indexed_at=time.time(), content_version=indexer.CONTENT_VERSION,
                content_hash=name,
            )
            if vec is not None:
                db.upsert_embedding(conn, fid, vec)

    add("labels.txt", "text", "brown bag, paper bag, shopping bag")
    add("bag1.jpg", "image", "", bag_vec)
    for i in range(n_other):
        add(f"other{i}.jpg", "image", "", _unit(rng.normal(size=DIM)))
    conn.close()


def _search(tmp_path, monkeypatch, query_vec, bag_vec, query="brown bag"):
    root = tmp_path / "Downloads"
    root.mkdir()
    _build(root, bag_vec)
    monkeypatch.setattr(embeddings, "embed_text", lambda q: query_vec)
    results, _ = search.search_with_info(root, query)
    return {r["filename"]: r["match_type"] for r in results}


def test_picture_query_shows_photos_even_when_a_text_file_matches(tmp_path, monkeypatch):
    v = _unit(np.random.default_rng(1).normal(size=DIM))
    found = _search(tmp_path, monkeypatch, query_vec=v, bag_vec=v)
    assert found.get("labels.txt") == "content"
    assert found.get("bag1.jpg") == "visual"


def test_unclear_query_adds_no_photo_noise_next_to_a_text_answer(tmp_path, monkeypatch):
    rng = np.random.default_rng(2)
    q = _unit(rng.normal(size=DIM))
    bag = _unit(rng.normal(size=DIM))  # no image truly stands out for this query
    found = _search(tmp_path, monkeypatch, query_vec=q, bag_vec=bag)
    assert found.get("labels.txt") == "content"
    assert not [n for n, t in found.items() if t == "visual"]
