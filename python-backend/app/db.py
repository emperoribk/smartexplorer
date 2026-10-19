"""SQLite storage for the SmartSearch index.

Two things are stored per file:
  - metadata + any extracted/OCR'd text, in an FTS5 table for keyword search
  - for images, a CLIP embedding (raw float32 bytes) for semantic search

The DB lives next to the index itself so each indexed root folder gets its
own .smartsearch/index.db (see indexer.py), which keeps things simple and
lets the user "forget" a folder by deleting that hidden directory.
"""
from __future__ import annotations

import sqlite3
import struct
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    ext TEXT,
    size INTEGER,
    mtime REAL,
    kind TEXT NOT NULL,        -- 'text' | 'image' | 'video' | 'other'
    indexed_at REAL NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT          -- sha256 of the file's bytes; see duplicates.py
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    filename,
    content,
    path UNINDEXED,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS embeddings (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    vector BLOB NOT NULL,
    dim INTEGER NOT NULL
);
"""
# Deliberately no "CREATE INDEX ... ON files(content_hash)" up here: this
# script runs unconditionally on every connect(), including against a
# database that already exists from before content_hash was added - and
# CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so an index on
# a column that doesn't exist yet would fail immediately, before _migrate()
# below ever gets a chance to add that column. The index is created in
# _migrate() instead, strictly after the column is guaranteed to exist -
# for a brand new database too, not just an upgraded one.


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    # Every search also kicks off a background reindex pass on a second
    # connection (see indexer.run_index, called from every runSearch on the
    # renderer side) - it's nearly always a fast no-op scan, but it still
    # takes a brief write lock at the end (db.remove_missing), even when
    # nothing actually changed. Without a busy timeout, a search's own read
    # that lands in that narrow window raises "database is locked"
    # immediately; search.py's _text_search swallows that (OperationalError)
    # and quietly falls back to visual-only results - so a real keyword
    # match can vanish from the results with no error shown anywhere. A
    # generous busy_timeout makes SQLite itself wait out that brief lock and
    # retry internally instead, which is what actually fixes it (search.py's
    # try/except stays as a last-resort safety net, not the primary
    # defense).
    conn.execute("PRAGMA busy_timeout = 8000")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Adds columns introduced after a database already existed on someone's
    machine - CREATE TABLE IF NOT EXISTS above only shapes a brand new
    database, so an upgrade needs an explicit ALTER TABLE for anyone who
    already has a .smartsearch/index.db from before this column existed."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()}
    if "content_version" not in cols:
        conn.execute("ALTER TABLE files ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    if "content_hash" not in cols:
        conn.execute("ALTER TABLE files ADD COLUMN content_hash TEXT")
        conn.commit()
    # Safe (and cheap) to run on every connect, fresh database or upgraded -
    # the column is guaranteed to exist by this point either way, and
    # CREATE INDEX IF NOT EXISTS is a no-op once it's already there.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash)")
    conn.commit()


def vector_to_blob(vec) -> bytes:
    return struct.pack(f"<{len(vec)}f", *[float(x) for x in vec])


def blob_to_vector(blob: bytes) -> list:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def upsert_file(
    conn: sqlite3.Connection,
    *,
    path: str,
    filename: str,
    ext: str,
    size: int,
    mtime: float,
    kind: str,
    content_text: Optional[str],
    indexed_at: float,
    content_version: int = 0,
    content_hash: Optional[str] = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO files (path, filename, ext, size, mtime, kind, indexed_at, content_version, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            filename=excluded.filename, ext=excluded.ext, size=excluded.size,
            mtime=excluded.mtime, kind=excluded.kind, indexed_at=excluded.indexed_at,
            content_version=excluded.content_version, content_hash=excluded.content_hash
        """,
        (path, filename, ext, size, mtime, kind, indexed_at, content_version, content_hash),
    )
    row = conn.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
    file_id = row[0]

    conn.execute("DELETE FROM files_fts WHERE path = ?", (path,))
    conn.execute(
        "INSERT INTO files_fts (filename, content, path) VALUES (?, ?, ?)",
        (filename, content_text or "", path),
    )
    return file_id


def upsert_embedding(conn: sqlite3.Connection, file_id: int, vector) -> None:
    conn.execute(
        "INSERT INTO embeddings (file_id, vector, dim) VALUES (?, ?, ?) "
        "ON CONFLICT(file_id) DO UPDATE SET vector=excluded.vector, dim=excluded.dim",
        (file_id, vector_to_blob(vector), len(vector)),
    )


def remove_missing(conn: sqlite3.Connection, seen_paths: Iterable[str]) -> None:
    """Drop files from the index that no longer exist on disk / weren't seen this pass."""
    seen = set(seen_paths)
    rows = conn.execute("SELECT id, path FROM files").fetchall()
    for file_id, path in rows:
        if path not in seen:
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
            conn.execute("DELETE FROM files_fts WHERE path = ?", (path,))
            conn.execute("DELETE FROM embeddings WHERE file_id = ?", (file_id,))


@contextmanager
def transaction(conn: sqlite3.Connection):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
