"""Memories layer: a chronological timeline of every indexed file, plus
gentle resurfacing ("nothing in this folder has changed in two years",
"on this day, a few years ago").

Both are pure reads of the per-folder indexes that already exist (see
db.py / indexer.py) - no new scanning, no new tables, no state written
anywhere. Dismissing or snoozing a resurfaced card is the renderer's job
(localStorage, same as the recent-folders list), which keeps this module
stateless and trivially testable.

A note on dates: everything here is based on a file's modified time
(`mtime`), because that is what the index stores and what Windows keeps
reliably. A photo's EXIF "date taken" and a folder's true "last opened"
time are both better signals in theory, but the first isn't indexed and
the second is unreliable (NTFS last-access updates are routinely turned
off), so "last changed" is deliberately the honest wording used in the
cards rather than pretending to know when something was last viewed.
"""
from __future__ import annotations

import datetime as dt
import math
import sqlite3
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from . import db, indexer

# Files that exist but that nobody thinks of as a "memory" - installers,
# caches, config, binaries. Leaving them in would bury photos and documents
# under pages of .dll/.tmp entries from whichever indexed folder happens to
# contain an app's data.
NOISE_EXTS = (
    "exe", "msi", "dll", "sys", "tmp", "ini", "lnk", "db", "log", "pyc",
    "map", "crdownload", "part", "cache", "dat", "bin", "iso", "torrent",
)

# Path segments that mean "this lives inside some program's own data", so a
# folder there is never a good "you haven't opened this in a while" card.
_NOISE_DIR_PARTS = {
    "appdata", "program files", "program files (x86)", "windows",
    "node_modules", ".venv", "venv", "site-packages", "__pycache__",
    "$recycle.bin", "system volume information", ".git", ".smartsearch",
}

# Config/data formats the indexer classes as "text": real files, but never
# something a person remembers. They are kept out of the resurfacing cards
# (not the timeline, where "Show all files" can legitimately want them) so a
# folder of installer internals can't pass as a "memory".
_CONFIG_EXTS = {"json", "xml", "yaml", "yml", "toml", "cfg", "conf", "ini", "log"}

# Folders an app writes to for itself. Fine in the timeline (they are real
# files), but a "you haven't opened this folder in a year" card for an app's
# Logs folder is noise - found on a real index (DS4Windows\Logs).
_CARD_SKIP_DIRS = {"log", "logs", "cache", "caches", "temp", "crashdumps", "crash reports"}

VALID_KINDS = {"image", "video", "text", "other"}

# --- resurfacing tuning ---
STALE_DAYS = 365          # a folder must be this untouched to be worth mentioning
MIN_FOLDER_FILES = 5      # ...and hold at least this many indexed files
MAX_STALE_CARDS = 2
MAX_CARDS = 3
OTD_WINDOW_DAYS = 3       # "on this day" matches +/- this many days
OTD_MIN_ITEMS = 3


def _open(root: str) -> Optional[sqlite3.Connection]:
    try:
        path = Path(root).expanduser().resolve()
        db_path = indexer.db_path_for(path)
    except OSError:
        return None
    if not db_path.exists():
        return None
    return db.connect(db_path)


def _clean_exts(exts: Optional[Iterable[str]]) -> List[str]:
    """Normalises an allow-list of extensions ('.JPG', 'pdf') to bare
    lowercase, dropping anything that isn't a plain extension."""
    out: List[str] = []
    for e in exts or []:
        e = str(e).strip().lower().lstrip(".")
        if e and e.isalnum() and e not in out:
            out.append(e)
    return out


def _ext_filter(exts: Optional[Iterable[str]] = None) -> tuple:
    """(sql, params) for the extension rules every query here shares:
    never the NOISE_EXTS, and - when `exts` is given - only those. `exts` is
    how the app's "Show all files" toggle reaches this module: the normal
    folder view hides everything but photos, videos, PDFs, documents and zips
    by default, and the timeline/cards must hide the same files."""
    col = "lower(ltrim(coalesce(ext, ''), '.'))"
    sql = f"{col} NOT IN ({','.join('?' for _ in NOISE_EXTS)})"
    params: list = list(NOISE_EXTS)
    # Program-data directories are filtered HERE, in SQL, not after the
    # fetch: timeline() applies LIMIT per root before merging, so rows
    # dropped afterwards would leave a root with fewer real rows than its
    # LIMIT promises and the merge would silently skip real files between
    # pages (a real bug this fixed - see the regression test). Matches a
    # whole path segment with either slash style; '!' escapes LIKE's wildcards.
    for part in sorted(_NOISE_DIR_PARTS):
        esc = part.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        sql += " AND path NOT LIKE ? ESCAPE '!' AND path NOT LIKE ? ESCAPE '!'"
        params += [f"%/{esc}/%", f"%\\{esc}\\%"]
    allowed = _clean_exts(exts)
    if exts is not None:
        # An explicit but empty/invalid allow-list matches nothing, rather
        # than silently falling back to "everything".
        sql += f" AND {col} IN ({','.join('?' for _ in allowed) or 'NULL'})"
        params += allowed
    return sql, params


def _dirname(path: str) -> str:
    """Parent folder of a stored path, splitting on EITHER slash. The index
    keeps whatever style the OS gave it (backslashes on Windows), and
    os.path.dirname only understands the host's own style - so grouping by it
    would silently fail for Windows paths read on any other platform (and in
    tests). The returned string keeps the original separators, so the
    renderer can still open it."""
    i = max(path.rfind("/"), path.rfind("\\"))
    return path[:i] if i > 0 else ""


def _basename(path: str) -> str:
    return path[max(path.rfind("/"), path.rfind("\\")) + 1:]


def _is_memorable(kind: str, filename: str) -> bool:
    """A photo, video or document - what a resurfacing card should be built from."""
    if kind not in ("image", "video", "text"):
        return False
    dot = filename.rfind(".")
    return not (dot >= 0 and filename[dot + 1:].lower() in _CONFIG_EXTS)


def _in_card_skip_dir(path: str) -> bool:
    parts = {p.lower() for p in path.replace("\\", "/").split("/")[:-1] if p}
    return not parts.isdisjoint(_CARD_SKIP_DIRS)


def _in_noise_dir(path: str) -> bool:
    parts = {p.lower() for p in path.replace("\\", "/").split("/") if p}
    return not parts.isdisjoint(_NOISE_DIR_PARTS)


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

def timeline(
    roots: Sequence[str],
    *,
    limit: int = 200,
    before: Optional[float] = None,
    before_path: Optional[str] = None,
    kinds: Optional[Iterable[str]] = None,
    exts: Optional[Iterable[str]] = None,
) -> dict:
    """One newest-first page of every indexed file across `roots`, all file
    types mixed together.

    Paging is keyset-based on (mtime, path), not offset-based: the next
    page is "everything strictly older than the last row you got", so a
    reindex that adds or removes files between page requests can't make
    rows repeat or get skipped. Pass back `next_before` / `next_before_path`
    from the previous response as `before` / `before_path`.
    """
    limit = max(1, min(int(limit), 1000))
    kind_list = [k for k in (kinds or []) if k in VALID_KINDS]

    merged: dict[str, dict] = {}
    for root in roots:
        conn = _open(root)
        if conn is None:
            continue
        try:
            ext_sql, ext_params = _ext_filter(exts)
            sql = (
                "SELECT path, filename, kind, size, mtime FROM files "
                "WHERE mtime IS NOT NULL AND " + ext_sql
            )
            params: list = list(ext_params)
            if kind_list:
                sql += " AND kind IN (" + ",".join("?" for _ in kind_list) + ")"
                params += kind_list
            if before is not None:
                if before_path is not None:
                    sql += " AND (mtime < ? OR (mtime = ? AND path < ?))"
                    params += [before, before, before_path]
                else:
                    sql += " AND mtime < ?"
                    params.append(before)
            sql += " ORDER BY mtime DESC, path DESC LIMIT ?"
            params.append(limit + 1)
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                continue
        finally:
            conn.close()
        for path, filename, kind, size, mtime in rows:
            if _in_noise_dir(path):
                continue
            # Two indexed roots can overlap (a folder and its parent both
            # indexed) - the same file must still appear once.
            if path not in merged:
                merged[path] = {
                    "path": path,
                    "filename": filename,
                    "kind": kind,
                    "size": size,
                    "mtime": mtime,
                    "root": str(root),
                }

    ordered = sorted(merged.values(), key=lambda r: (r["mtime"], r["path"]), reverse=True)
    has_more = len(ordered) > limit
    page = ordered[:limit]
    result = {"items": page, "has_more": has_more, "next_before": None, "next_before_path": None}
    if page and has_more:
        result["next_before"] = page[-1]["mtime"]
        result["next_before_path"] = page[-1]["path"]
    return result


# ---------------------------------------------------------------------------
# Resurfacing
# ---------------------------------------------------------------------------

def _fmt_age(days: float) -> str:
    years = days / 365.0
    if years >= 1.5:
        return f"{int(years)} years"
    if days >= 365:
        return "a year"
    return f"{int(days // 30)} months"


def _sample(rows: List[tuple], n: int) -> List[dict]:
    """Up to n preview files from (path, filename, kind, mtime) rows -
    photos and videos first (they make the best thumbnails), then
    documents, newest first within each."""
    rank = {"image": 0, "video": 1, "text": 2}
    picked = sorted(rows, key=lambda r: (rank.get(r[2], 3), -(r[3] or 0)))[:n]
    return [{"path": p, "filename": f, "kind": k} for p, f, k, _ in picked]


def _stale_folders(roots: Sequence[str], now: float, exts: Optional[Iterable[str]] = None) -> List[dict]:
    # dirpath -> list of (path, filename, kind, mtime) for files directly in it
    folders: dict[str, List[tuple]] = {}
    # dirpath -> newest mtime of ANYTHING at or below it. A folder only counts
    # as untouched if its subfolders are untouched too - otherwise "nothing
    # here has changed" would be false for a parent whose child is active.
    subtree_newest: dict[str, float] = {}
    for root in roots:
        conn = _open(root)
        if conn is None:
            continue
        try:
            ext_sql, ext_params = _ext_filter(exts)
            cur = conn.execute(
                "SELECT path, filename, kind, mtime FROM files "
                "WHERE mtime IS NOT NULL AND " + ext_sql,
                ext_params,
            )
            for path, filename, kind, mtime in cur:
                if _in_noise_dir(path) or _in_card_skip_dir(path):
                    continue
                folder = _dirname(path)
                folders.setdefault(folder, []).append((path, filename, kind, mtime))
                anc = folder
                while anc:
                    if subtree_newest.get(anc, 0.0) >= mtime:
                        break  # this ancestor, and so all above it, already has something newer
                    subtree_newest[anc] = mtime
                    anc = _dirname(anc)
        except sqlite3.OperationalError:
            continue
        finally:
            conn.close()

    candidates = []
    for folder, rows in folders.items():
        # A path can show up from two overlapping roots - count it once.
        unique = {r[0]: r for r in rows}
        # Only photos/videos/documents count toward "is this folder worth a
        # card" - not installers' leftovers, archives or config files.
        rows = [r for r in unique.values() if _is_memorable(r[2], r[1])]
        if len(rows) < MIN_FOLDER_FILES:
            continue
        newest = subtree_newest.get(folder, max(r[3] for r in rows))
        age_days = (now - newest) / 86400.0
        if age_days < STALE_DAYS:
            continue
        has_media = any(r[2] in ("image", "video") for r in rows)
        # Older is more interesting, but a folder untouched for ten years
        # isn't ten times as worth surfacing as one untouched for three -
        # cap the age term so size and photo-ness still matter.
        score = (min(age_days, 1095) / 365.0) * math.log(1 + len(rows)) * (1.5 if has_media else 1.0)
        candidates.append((score, folder, rows, newest, age_days))

    candidates.sort(key=lambda c: c[0], reverse=True)
    cards: List[dict] = []
    chosen: List[str] = []
    for score, folder, rows, newest, age_days in candidates:
        norm = folder.replace("\\", "/").lower().rstrip("/")
        # Don't suggest a folder and its own parent/child side by side.
        if any(norm.startswith(c + "/") or c.startswith(norm + "/") for c in chosen):
            continue
        chosen.append(norm)
        last = dt.datetime.fromtimestamp(newest)
        cards.append({
            "id": f"stale:{norm}",
            "type": "stale_folder",
            "title": _basename(folder) or folder,
            "subtitle": f"Nothing here has changed in {_fmt_age(age_days)}",
            "detail": f"{len(rows)} files · last changed {last.strftime('%b %Y')}",
            "folder": folder,
            "count": len(rows),
            "date": newest,
            "sample": _sample(rows, 4),
        })
        if len(cards) >= MAX_STALE_CARDS:
            break
    return cards


def _on_this_day(roots: Sequence[str], now: float, exts: Optional[Iterable[str]] = None) -> Optional[dict]:
    today = dt.datetime.fromtimestamp(now).date()
    md = []
    for offset in range(-OTD_WINDOW_DAYS, OTD_WINDOW_DAYS + 1):
        d = today + dt.timedelta(days=offset)
        md.append(d.strftime("%m-%d"))

    by_year: dict[int, dict[str, tuple]] = {}
    for root in roots:
        conn = _open(root)
        if conn is None:
            continue
        try:
            ext_sql, ext_params = _ext_filter(exts)
            sql = (
                "SELECT path, filename, kind, mtime FROM files "
                "WHERE mtime IS NOT NULL AND kind IN ('image','video','text') AND "
                + ext_sql
                + " AND strftime('%m-%d', mtime, 'unixepoch', 'localtime') IN ("
                + ",".join("?" for _ in md)
                + ") AND CAST(strftime('%Y', mtime, 'unixepoch', 'localtime') AS INTEGER) < ?"
            )
            rows = conn.execute(sql, ext_params + md + [today.year]).fetchall()
        except sqlite3.OperationalError:
            continue
        finally:
            conn.close()
        for path, filename, kind, mtime in rows:
            if _in_noise_dir(path):
                continue
            if not _is_memorable(kind, filename) or _in_card_skip_dir(path):
                continue
            year = dt.datetime.fromtimestamp(mtime).year
            by_year.setdefault(year, {})[path] = (path, filename, kind, mtime)

    best_year, best_score, best_rows = None, 0.0, []
    for year, rows_by_path in by_year.items():
        rows = list(rows_by_path.values())
        media = sum(1 for r in rows if r[2] in ("image", "video"))
        # Photos/videos are what make an "on this day" card feel like a
        # memory rather than a list of old documents, so they count double.
        score = media * 2 + (len(rows) - media)
        if len(rows) >= OTD_MIN_ITEMS and score > best_score:
            best_year, best_score, best_rows = year, score, rows
    if best_year is None:
        return None

    years_ago = today.year - best_year
    anchor = dt.datetime(best_year, today.month, min(today.day, 28), 23, 59, 59)
    return {
        "id": f"otd:{today.isoformat()}:{best_year}",
        "type": "on_this_day",
        "title": "On this day",
        "subtitle": f"{years_ago} year{'s' if years_ago != 1 else ''} ago · {best_year}",
        "detail": f"{len(best_rows)} files from around {today.strftime('%b')} {today.day}",
        "folder": None,
        "count": len(best_rows),
        # Lets the Timeline jump straight to this period.
        "date": anchor.timestamp(),
        "sample": _sample(best_rows, 6),
    }


def memories(roots: Sequence[str], now: Optional[float] = None, exts: Optional[Iterable[str]] = None) -> dict:
    """Up to MAX_CARDS resurfacing cards. Deliberately few: this is meant
    to be a small, occasional "oh, I forgot about that" - not a feed."""
    import time

    now = now if now is not None else time.time()
    cards: List[dict] = []
    otd = _on_this_day(roots, now, exts)
    if otd:
        cards.append(otd)
    cards.extend(_stale_folders(roots, now, exts))
    return {"cards": cards[:MAX_CARDS]}
