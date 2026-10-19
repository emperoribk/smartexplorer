"""Computes per-folder disk usage for the storage treemap view.

Deliberately unrelated to the SmartSearch index (indexer.py/db.py) - this
just tallies file sizes, nothing needs OCR'ing, hashing, or CLIP-embedding
to answer "what's using the space in this folder", so it works on ANY
folder the OS will let it read, including ones never opened in Browse
(C:\\Windows, C:\\Program Files, ...), not just already-indexed roots.

Lazy, one level at a time, like a WinDirStat/TreeSize treemap: rather than
eagerly walking an entire drive up front (which could mean touching every
file under C:\\ before showing anything), a scan only computes the size of
EACH IMMEDIATE CHILD of the folder currently on screen - a file counts its
own bytes, a subfolder counts a full recursive walk of everything under it.
Drilling into a subfolder in the UI kicks off a fresh, much smaller scan
scoped to just that subfolder's own children. This is the same trade
run_index.py's two-pass design makes for a different reason: pay the
expensive part only for what's actually being looked at right now.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Optional

from .indexer import SKIP_DIRS


def _dir_size(path: Path) -> int:
    """Recursive byte total of everything under `path`. Tolerant of a messy
    real filesystem the same way indexer.py's _iter_files is: a folder (or
    a single file within it) that errors - permission-denied system
    folders, a broken reparse point, something deleted mid-walk - is
    skipped rather than failing the whole scan; its bytes just don't count,
    the same honest-not-exact trade every size tool like this one makes."""
    total = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.name in SKIP_DIRS:
                        continue
                    # Never follow a symlink/junction: it can point back up
                    # into a parent (an infinite loop) or at another drive
                    # entirely (double-counting bytes that aren't really
                    # "under" this folder at all).
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        total += _dir_size(Path(entry.path))
                    else:
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


@dataclass
class ScanEntry:
    name: str
    path: str
    is_dir: bool
    size: int


@dataclass
class ScanStatus:
    root: str = ""
    status: str = "idle"  # idle | scanning | done | error
    error: Optional[str] = None
    entries: list = field(default_factory=list, repr=False)
    inaccessible: int = 0
    _lock: Lock = field(default_factory=Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "root": self.root,
                "status": self.status,
                "error": self.error,
                "inaccessible": self.inaccessible,
                "entries": (
                    [
                        {"name": e.name, "path": e.path, "is_dir": e.is_dir, "size": e.size}
                        for e in self.entries
                    ]
                    if self.status == "done"
                    else []
                ),
            }


def scan_children(root: Path, status: ScanStatus) -> None:
    """Synchronous scan of `root`'s immediate children; intended to be run
    on a background thread (see main.py's post_disk_usage_start, same
    threading.Thread(..., daemon=True) pattern indexer.run_index uses)."""
    status.status = "scanning"
    status.error = None
    status.entries = []
    status.inaccessible = 0

    try:
        with os.scandir(root) as it:
            children = list(it)
    except OSError as e:
        status.status = "error"
        status.error = str(e)
        return

    entries: list[ScanEntry] = []
    inaccessible = 0
    for entry in children:
        if entry.name in SKIP_DIRS:
            continue
        try:
            if entry.is_symlink():
                continue
            is_dir = entry.is_dir(follow_symlinks=False)
            size = _dir_size(Path(entry.path)) if is_dir else entry.stat(follow_symlinks=False).st_size
            entries.append(ScanEntry(name=entry.name, path=entry.path, is_dir=is_dir, size=size))
        except OSError:
            # Counted, not silently dropped - a Windows system folder often
            # has a handful of these (a locked hiberfil.sys, a permission-
            # denied profile directory for another account); the UI says
            # "N items couldn't be read" rather than just under-reporting
            # the total with no explanation.
            inaccessible += 1

    entries.sort(key=lambda e: e.size, reverse=True)
    status.entries = entries
    status.inaccessible = inaccessible
    status.status = "done"
