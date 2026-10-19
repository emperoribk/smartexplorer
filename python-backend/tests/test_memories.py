"""Tests for app/memories.py - run from python-backend/ with:
    python -m tests.test_memories      (or: pytest tests/test_memories.py)

Builds real per-folder index databases (same db.py the app uses) in a temp
directory, so this exercises the actual SQL, not a mock of it.
"""
from __future__ import annotations

import datetime as dt
import tempfile
import time
from pathlib import Path

from app import db, indexer, memories

DAY = 86400.0


def _make_root(tmp: Path, name: str, files: list[tuple[str, str, float]]) -> str:
    """files: (relative path, kind, mtime). Creates the index DB only - the
    files themselves needn't exist on disk, memories.py only reads the index."""
    root = tmp / name
    root.mkdir(parents=True, exist_ok=True)
    conn = db.connect(indexer.db_path_for(root))
    for rel, kind, mtime in files:
        p = str(root / rel)
        db.upsert_file(
            conn, path=p, filename=Path(rel).name, ext=Path(rel).suffix.lower(),
            size=1000, mtime=mtime, kind=kind, content_text="", indexed_at=time.time(),
        )
    conn.commit()
    conn.close()
    return str(root)


def test_timeline_orders_mixes_kinds_and_pages_without_gaps_or_repeats():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        a = _make_root(tmp, "a", [(f"p{i}.jpg", "image", now - i * DAY) for i in range(0, 10, 2)])
        b = _make_root(tmp, "b", [(f"d{i}.pdf", "text", now - i * DAY) for i in range(1, 10, 2)])
        full = memories.timeline([a, b], limit=100)["items"]
        assert [i["kind"] for i in full[:4]] == ["image", "text", "image", "text"]  # interleaved
        assert [i["mtime"] for i in full] == sorted((i["mtime"] for i in full), reverse=True)

        seen, cursor, pages = [], {}, 0
        while True:
            page = memories.timeline([a, b], limit=3, **cursor)
            seen += [i["path"] for i in page["items"]]
            pages += 1
            if not page["has_more"]:
                break
            cursor = {"before": page["next_before"], "before_path": page["next_before_path"]}
        assert seen == [i["path"] for i in full], "paging must reproduce the full order exactly"
        assert len(set(seen)) == len(seen) == 10 and pages == 4


def test_timeline_paging_survives_identical_mtimes_at_a_page_boundary():
    ts = time.time() - 5 * DAY
    with tempfile.TemporaryDirectory() as t:
        a = _make_root(Path(t), "a", [(f"burst{i}.jpg", "image", ts) for i in range(7)])
        seen, cursor = [], {}
        while True:
            page = memories.timeline([a], limit=3, **cursor)
            seen += [i["path"] for i in page["items"]]
            if not page["has_more"]:
                break
            cursor = {"before": page["next_before"], "before_path": page["next_before_path"]}
        assert len(seen) == len(set(seen)) == 7


def test_timeline_filters_noise_kinds_and_dedupes_overlapping_roots():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        parent = tmp / "docs"
        parent.mkdir()
        # the same file indexed from two overlapping roots (parent + child)
        child = parent / "taxes"
        for root in (parent, child):
            conn = db.connect(indexer.db_path_for(root))
            db.upsert_file(conn, path=str(child / "return.pdf"), filename="return.pdf", ext=".pdf",
                           size=1, mtime=now - DAY, kind="text", content_text="", indexed_at=now)
            conn.commit(); conn.close()
        conn = db.connect(indexer.db_path_for(parent))
        for name, kind in [("setup.exe", "other"), ("x.dll", "other"), ("clip.mp4", "video")]:
            db.upsert_file(conn, path=str(parent / name), filename=name, ext=Path(name).suffix,
                           size=1, mtime=now - 2 * DAY, kind=kind, content_text="", indexed_at=now)
        db.upsert_file(conn, path=str(parent / "node_modules" / "x" / "a.jpg"), filename="a.jpg", ext=".jpg",
                       size=1, mtime=now, kind="image", content_text="", indexed_at=now)
        conn.commit(); conn.close()

        names = [i["filename"] for i in memories.timeline([str(parent), str(child)])["items"]]
        assert names.count("return.pdf") == 1
        assert "setup.exe" not in names and "x.dll" not in names and "a.jpg" not in names
        assert "clip.mp4" in names
        only_video = memories.timeline([str(parent)], kinds=["video"])["items"]
        assert [i["filename"] for i in only_video] == ["clip.mp4"]


def test_timeline_skips_missing_roots_quietly():
    with tempfile.TemporaryDirectory() as t:
        assert memories.timeline([str(Path(t) / "nope")])["items"] == []


def test_stale_folder_card_requires_age_and_size_and_prefers_media():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        r = _make_root(tmp, "r", (
            [(f"Spain 2022/img{i}.jpg", "image", now - 900 * DAY) for i in range(12)]       # old + photos -> yes
            + [(f"Old notes/n{i}.txt", "text", now - 800 * DAY) for i in range(6)]          # old docs -> yes
            + [(f"Recent/r{i}.jpg", "image", now - 10 * DAY) for i in range(20)]             # recent -> no
            + [(f"Tiny/t{i}.jpg", "image", now - 900 * DAY) for i in range(2)]               # too small -> no
            + [(f"AppData/Local/c{i}.jpg", "image", now - 900 * DAY) for i in range(9)]      # program data -> no
        ))
        cards = memories.memories([r], now=now)["cards"]
        stale = [c for c in cards if c["type"] == "stale_folder"]
        assert [c["title"] for c in stale] == ["Spain 2022", "Old notes"]
        assert stale[0]["count"] == 12 and len(stale[0]["sample"]) == 4
        assert stale[0]["subtitle"].startswith("Nothing here has changed in")
        assert all(c["id"].startswith("stale:") for c in stale)


def test_on_this_day_picks_best_year_and_needs_enough_items():
    today = dt.date.today()
    def ts(year, dd=0):
        try:
            d = dt.date(year, today.month, today.day) + dt.timedelta(days=dd)
        except ValueError:  # Feb 29
            d = dt.date(year, today.month, 28)
        return dt.datetime(d.year, d.month, d.day, 12).timestamp()
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        r = _make_root(Path(t), "r", (
            [(f"a{i}.jpg", "image", ts(today.year - 3, dd)) for i, dd in enumerate((-1, 0, 1, 2))]   # 4 photos, 3y ago
            + [(f"b{i}.pdf", "text", ts(today.year - 1)) for i in range(3)]                          # 3 docs, 1y ago
            + [("c.jpg", "image", ts(today.year - 2))]                                               # too few
        ))
        otd = [c for c in memories.memories([r], now=now)["cards"] if c["type"] == "on_this_day"]
        assert len(otd) == 1
        assert otd[0]["subtitle"].startswith("3 years ago") and otd[0]["count"] == 4
        # a lone file from another year is not enough to make a card
        r2 = _make_root(Path(t), "r2", [("solo.jpg", "image", ts(today.year - 2))])
        assert memories.memories([r2], now=now)["cards"] == []


def test_memories_are_capped_and_empty_when_nothing_qualifies():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        r = _make_root(Path(t), "r", [(f"x{i}.jpg", "image", now - i) for i in range(30)])
        assert memories.memories([r], now=now) == {"cards": []}
        assert memories.memories([], now=now) == {"cards": []}


def test_ext_allow_list_hides_other_extensions_in_timeline_and_cards():
    now = time.time()
    allowed = ["jpg", "pdf", "docx"]
    with tempfile.TemporaryDirectory() as t:
        r = _make_root(Path(t), "r", (
            [("a.jpg", "image", now - DAY), ("b.PDF", "text", now - 2 * DAY), ("c.docx", "text", now - 3 * DAY),
             ("d.json", "text", now - 4 * DAY), ("e.log2", "other", now - 5 * DAY), ("f.zzz", "other", now - 6 * DAY)]
            # an old folder where only half the files are an allowed type
            + [(f"Old/p{i}.jpg", "image", now - 900 * DAY) for i in range(5)]
            + [(f"Old/c{i}.docx", "text", now - 900 * DAY) for i in range(3)]
        ))
        everything = [i["filename"] for i in memories.timeline([r])["items"]]
        assert "d.json" in everything and "f.zzz" in everything          # no allow-list: only noise is dropped
        got = [i["filename"] for i in memories.timeline([r], exts=allowed)["items"]]
        assert "d.json" not in got and "e.log2" not in got and "f.zzz" not in got
        assert {"a.jpg", "b.PDF", "c.docx"} <= set(got)                  # case-insensitive match
        assert [i["filename"] for i in memories.timeline([r], exts=[".JPG"])["items"]][:1] == ["a.jpg"]  # '.JPG' normalised
        assert memories.timeline([r], exts=[])["items"] == []            # empty list = nothing, not everything
        assert memories.timeline([r], exts=["x'; DROP TABLE files;--"])["items"] == []  # junk is dropped, never interpolated
        # the stale-folder card counts only files that would actually be shown
        card = [c for c in memories.memories([r], now=now, exts=["jpg"])["cards"] if c["type"] == "stale_folder"]
        assert [c["count"] for c in card] == [5], card                    # only the 5 .jpg count; the 3 .docx are filtered out
        card = [c for c in memories.memories([r], now=now)["cards"] if c["type"] == "stale_folder"]
        assert [c["count"] for c in card] == [8], card                    # no allow-list: jpg + docx


def test_timeline_paging_is_exact_when_one_root_is_full_of_filtered_rows():
    """Regression: noise-directory rows used to be dropped AFTER each root's
    SQL LIMIT, so a root whose newest rows were all node_modules/AppData junk
    contributed too few real rows and the merge skipped real files (found by
    walking a real multi-folder index: ~0.6% of files never appeared)."""
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        a = _make_root(tmp, "a", (
            [(f"node_modules/pkg/n{i}.jpg", "image", now - d * DAY) for i, d in enumerate((0.5, 1.5, 2.5, 3.5))]
            + [(f"real_a{d}.jpg", "image", now - d * DAY) for d in (1, 4, 7, 10)]
        ))
        b = _make_root(tmp, "b", [(f"real_b{d}.jpg", "image", now - d * DAY) for d in (2, 5, 8, 11)])
        expected = sorted([f"real_a{d}.jpg" for d in (1, 4, 7, 10)] + [f"real_b{d}.jpg" for d in (2, 5, 8, 11)],
                          key=lambda n: int(n.split("real_")[1][1:].split(".")[0]))
        for limit in (1, 2, 3, 5):
            seen, cursor = [], {}
            while True:
                page = memories.timeline([a, b], limit=limit, **cursor)
                seen += [i["filename"] for i in page["items"]]
                if not page["has_more"]:
                    break
                cursor = {"before": page["next_before"], "before_path": page["next_before_path"]}
            assert seen == expected, (limit, seen)


def test_stale_folders_group_windows_style_paths_on_any_platform():
    now = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "w"; root.mkdir()
        conn = db.connect(indexer.db_path_for(root))
        folder = "C:\\Users\\u\\Pictures\\Spain 2022"
        for i in range(6):
            db.upsert_file(conn, path=f"{folder}\\img{i}.jpg", filename=f"img{i}.jpg", ext=".jpg", size=1,
                           mtime=now - 900 * DAY, kind="image", content_text="", indexed_at=now)
        conn.commit(); conn.close()
        cards = memories.memories([str(root)], now=now)["cards"]
        assert len(cards) == 1, cards
        assert cards[0]["title"] == "Spain 2022" and cards[0]["count"] == 6
        assert cards[0]["folder"] == folder   # native separators kept, so the app can open it


def test_stale_card_needs_the_whole_subtree_untouched():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        stale = [(f"Trip/a{i}.jpg", "image", now - 900 * DAY) for i in range(6)]
        active_child = [("Trip/edits/new.jpg", "image", now - 3 * DAY)]            # something changed below
        r = _make_root(Path(t), "r", stale + active_child + [(f"Quiet/q{i}.jpg", "image", now - 900 * DAY) for i in range(6)])
        titles = [c["title"] for c in memories.memories([r], now=now)["cards"] if c["type"] == "stale_folder"]
        assert titles == ["Quiet"], titles   # Trip has an active subfolder, so "nothing here has changed" would be false


def test_stale_card_ignores_installer_leftovers_and_config_files():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        r = _make_root(Path(t), "r", (
            [(f"Setup/conf{i}.json", "text", now - 900 * DAY) for i in range(8)]       # config only
            + [(f"Setup2/x{i}.zip", "other", now - 900 * DAY) for i in range(8)]       # archives only
            + [("Mixed/banner.jpg", "image", now - 900 * DAY), ("Mixed/readme.txt", "text", now - 900 * DAY)]
            + [(f"Mixed/c{i}.json", "text", now - 900 * DAY) for i in range(6)]        # 2 memorable + 6 config
        ))
        assert [c for c in memories.memories([r], now=now)["cards"] if c["type"] == "stale_folder"] == []


def test_cards_skip_an_apps_own_logs_cache_and_temp_folders():
    now = time.time()
    with tempfile.TemporaryDirectory() as t:
        r = _make_root(Path(t), "r", (
            [(f"App/Logs/l{i}.txt", "text", now - 900 * DAY) for i in range(7)]
            + [(f"App/cache/c{i}.jpg", "image", now - 900 * DAY) for i in range(7)]
            + [(f"Holiday/h{i}.jpg", "image", now - 900 * DAY) for i in range(7)]
        ))
        titles = [c["title"] for c in memories.memories([r], now=now)["cards"] if c["type"] == "stale_folder"]
        assert titles == ["Holiday"], titles
        # ...but the timeline still lists them: they're real files
        assert len(memories.timeline([r], limit=100)["items"]) == 21


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print("ok  ", fn.__name__)
    print(f"{len(tests)} passed")
