"""Walks a folder tree and builds/updates the SmartSearch index for it."""
from __future__ import annotations

import hashlib
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Optional

from . import db, embeddings, extract, ocr

# How many files run_index's expensive extraction step (hash + OCR +
# CLIP embed) works on at once. Previously this ran one file fully to
# completion before starting the next - on a folder that picks up new
# files constantly (a Downloads folder, say), opening it meant waiting
# out that whole backlog strictly sequentially every time. Hashing is a
# plain file read, OCR shells out to Tesseract as a subprocess, and
# CLIP's forward pass runs in C++ via torch - all three release the
# GIL for the bulk of their work, so a small thread pool here lets them
# genuinely overlap instead of just taking turns. Capped at 4 (not,
# say, os.cpu_count()) so this doesn't itself eat every core on a
# modest laptop while the person is also trying to use the app.
_INDEX_WORKERS = 4

VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
SKIP_DIRS = {".smartsearch", ".git", "node_modules", "__pycache__", "$RECYCLE.BIN", "System Volume Information"}
MAX_FILE_MB = 200  # don't try to OCR/embed absurdly large files

# Bump this whenever extract.py/ocr.py's extraction logic changes in a way
# that should reach files that are already indexed - the mtime/size skip in
# _index_one_file below only tells us a file hasn't changed, not that it was
# indexed with the current logic, so a version bump here forces one more
# pass over already-indexed files (cheap for anything that doesn't actually
# need re-extracting) the next time each folder is opened or searched.
# v2: OCR fallback for scanned/image-only PDF pages, plus a sparse-text OCR
# retry for images that are mostly a single number/code.
# v3: multi-pass OCR (a few upscaled/normalized versions of each image,
# combined) - a single pass at the original resolution was missing text in
# stylized graphics (e.g. a glowing/outlined number on a dark background,
# like a trading app's summary card) that a modest upscale reads correctly.
# v4: no extraction logic changed here, but ocr.py got better at *finding*
# an already-installed Tesseract (it used to only check PATH, and a process
# that was already running when Tesseract got installed keeps a stale PATH
# until restarted - see ocr.py's _configure_tesseract). Every image indexed
# before that fix landed with permanently empty OCR text, at content_version
# 3, on a machine where Tesseract genuinely is installed - so the ordinary
# skip check (unchanged file + content_version already current) would leave
# those files silently empty forever without one more forced pass here.
# v5: every file now gets a content hash computed and stored (see
# _hash_file below) - what powers duplicate detection (duplicates.py). Files
# indexed before this version have no hash yet, so this forces one more
# pass to backfill it.
CONTENT_VERSION = 5

# Read/hash files in chunks rather than loading them whole - keeps memory
# flat regardless of file size (a multi-GB video hashes the same way as a
# 10KB text file).
_HASH_CHUNK_BYTES = 1024 * 1024


def index_dir_for(root: Path) -> Path:
    return root / ".smartsearch"


def db_path_for(root: Path) -> Path:
    return index_dir_for(root) / "index.db"


@dataclass
class IndexStatus:
    root: str = ""
    status: str = "idle"  # idle | indexing | done | error
    total: int = 0
    processed: int = 0
    current_file: str = ""
    error: Optional[str] = None
    _lock: Lock = field(default_factory=Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "root": self.root,
                "status": self.status,
                "total": self.total,
                "processed": self.processed,
                "current_file": self.current_file,
                "error": self.error,
            }


def _kind_for(ext: str) -> str:
    if ext in extract.TEXT_EXTS or ext in extract.PDF_EXTS or ext in extract.DOCX_EXTS:
        return "text"
    if ext in ocr.IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return "other"


def _iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            yield Path(dirpath) / name


def _hash_file(path: Path) -> Optional[str]:
    """A streaming sha256 of the file's bytes - what duplicate detection
    (duplicates.py) groups files by. Deliberately not gated by MAX_FILE_MB
    the way OCR/CLIP extraction below is: this is a plain sequential read,
    not an ML model call, so it stays cheap even for a large video or
    installer - exactly the kind of file duplicate detection most wants to
    catch (two copies of the same 150MB installer, say)."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(_HASH_CHUNK_BYTES)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def run_index(root: Path, status: IndexStatus) -> None:
    """Synchronous indexing pass; intended to be run on a background thread.

    Two passes over `files`, not one - deliberately. The first is a cheap
    stat() + one indexed lookup per file, single-threaded, deciding what's
    actually new or changed; that's what makes re-indexing an unchanged
    folder near-free, and it isn't worth parallelizing on its own. The
    second pass is just the files that first pass flagged as needing real
    work (hash + OCR + CLIP), run concurrently across a small thread pool
    (see _INDEX_WORKERS) - that's the part that used to make opening a
    folder with even a handful of new files feel like it stalled the app,
    since it ran one full file at a time with nothing overlapping."""
    status.root = str(root)
    status.status = "indexing"
    status.processed = 0
    status.error = None

    try:
        files = list(_iter_files(root))
        status.total = len(files)

        conn = db.connect(db_path_for(root))
        seen_paths: list[str] = []
        to_process: list[tuple[Path, "os.stat_result"]] = []

        for f in files:
            status.current_file = str(f)
            try:
                st = f.stat()
            except OSError:
                # Gone before we got to it - just don't count it as seen;
                # remove_missing() below will drop any stale row for it.
                continue
            try:
                if _needs_processing(conn, f, st):
                    to_process.append((f, st))
                else:
                    seen_paths.append(str(f))
                    status.processed += 1
            except Exception as e:  # noqa: BLE001 - keep indexing on single-file failure
                status.error = f"{f}: {e}"
                status.processed += 1

        if to_process:
            with ThreadPoolExecutor(max_workers=_INDEX_WORKERS) as pool:
                futures = {
                    pool.submit(_compute_file_work, f, st): f for f, st in to_process
                }
                for future in as_completed(futures):
                    f = futures[future]
                    status.current_file = str(f)
                    try:
                        work = future.result()
                        _write_file_work(conn, work)
                        seen_paths.append(str(f))
                    except Exception as e:  # noqa: BLE001
                        status.error = f"{f}: {e}"
                    status.processed += 1

        with db.transaction(conn):
            db.remove_missing(conn, seen_paths)

        status.status = "done"
    except Exception as e:  # noqa: BLE001
        status.status = "error"
        status.error = str(e)


def _needs_processing(conn, path: Path, stat: "os.stat_result") -> bool:
    """True if `path` is new, changed, or was last indexed with older
    extraction logic (see CONTENT_VERSION) - same skip condition
    run_index always used, just split out so the cheap stat+lookup pass
    can run single-threaded ahead of the expensive parallel one below."""
    existing = conn.execute(
        "SELECT mtime, size, content_version FROM files WHERE path = ?", (str(path),)
    ).fetchone()
    if (
        existing is not None
        and existing[0] == stat.st_mtime
        and existing[1] == stat.st_size
        and (existing[2] or 0) >= CONTENT_VERSION
    ):
        return False
    return True


@dataclass
class _FileWork:
    """Everything _compute_file_work figured out for one file, with no DB
    access of its own - safe to produce on a worker thread. _write_file_work
    then does the actual insert back on the main thread/connection."""

    path: Path
    stat: "os.stat_result"
    ext: str
    kind: str
    content_hash: Optional[str]
    content_text: str
    embedding: Optional[list]


def _compute_file_work(path: Path, stat: "os.stat_result") -> _FileWork:
    """The expensive, DB-free part of indexing one file: hashing, then
    OCR/text-extraction/CLIP-embedding depending on kind. Runs on a worker
    thread (see run_index) - every call in here (file reads, the Tesseract
    subprocess, CLIP's torch ops) releases the GIL for the bulk of its
    work, which is what lets several of these actually run at once instead
    of just taking turns."""
    ext = path.suffix.lower()
    kind = _kind_for(ext)

    # OCR/CLIP/text-extraction stay capped at MAX_FILE_MB (they're the
    # expensive, ML-driven part of indexing) - but hashing is a plain
    # sequential read, so it runs regardless of size. That matters here
    # specifically: a large installer or video is exactly the kind of file
    # duplicate detection (duplicates.py) is most useful for, and it would
    # otherwise never get indexed - or hashed - at all.
    too_big_for_extraction = stat.st_size > MAX_FILE_MB * 1024 * 1024
    content_hash = _hash_file(path)

    content_text = ""
    embedding = None
    if not too_big_for_extraction:
        if kind == "text":
            content_text = extract.extract_text(path)
        elif kind == "image":
            content_text = ocr.ocr_image(path)
            vec = embeddings.embed_image(path)
            if vec is not None:
                embedding = vec

    return _FileWork(
        path=path,
        stat=stat,
        ext=ext,
        kind=kind,
        content_hash=content_hash,
        content_text=content_text,
        embedding=embedding,
    )


def _write_file_work(conn, work: "_FileWork") -> None:
    """The DB-writing half of indexing one file - always called from the
    main thread on run_index's single shared connection, never from a
    worker thread, so there's no concurrent access to `conn` to worry
    about."""
    with db.transaction(conn):
        file_id = db.upsert_file(
            conn,
            path=str(work.path),
            filename=work.path.name,
            ext=work.ext,
            size=work.stat.st_size,
            mtime=work.stat.st_mtime,
            kind=work.kind,
            content_text=work.content_text,
            indexed_at=time.time(),
            content_version=CONTENT_VERSION,
            content_hash=work.content_hash,
        )
        if work.embedding is not None:
            db.upsert_embedding(conn, file_id, work.embedding)
