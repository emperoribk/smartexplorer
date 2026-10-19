"""Keeps a folder's index live while it's open in the app.

Watches a root directory tree for files being added, edited, renamed, or
removed - including changes made outside SmartExplorer entirely (dragged in
from File Explorer, saved by another program, deleted by anything) - and,
a moment after things settle down, re-runs the ordinary indexer on it.

Re-running the *whole* indexer (indexer.run_index) rather than patching in
just the changed file by hand is deliberate: a rescan is already cheap for
everything that hasn't changed (a stat() per file - see
indexer._needs_processing's skip check), which is exactly what already makes
re-indexing an already-indexed folder fast today after a rename/delete made
through the app itself (see App.tsx's refreshAfterMutation). Reusing that
same, already-correct pass means new files, edited files, AND removed files
(db.remove_missing, called at the end of every run_index pass) are all
handled by the one code path this module doesn't have to duplicate or keep
in sync with.

Only one root is ever watched at a time - the folder currently open in
Browse - swapped out by start_watching() whenever a different one is
opened, so a long session never piles up one OS-level watch per folder
ever visited.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import indexer

# How long to wait after the *last* filesystem event before actually
# re-indexing. A single save in most editors/apps is really a burst of
# several events (a temp file created, the real file replaced, the temp
# file removed) within a few hundred ms, and dropping in a folder of files
# fires one event per file - waiting for a quiet gap coalesces a whole
# burst into a single rescan instead of one per event.
DEBOUNCE_SECONDS = 1.0


class _Handler(FileSystemEventHandler):
    def __init__(self, on_change) -> None:
        self._on_change = on_change

    def _handle(self, event) -> None:
        if event.is_directory:
            return
        # Ignore the index's own files - without this, run_index writing
        # index.db/-wal/-shm during a rescan would immediately fire another
        # "something changed" event, forever re-triggering itself.
        if ".smartsearch" in Path(event.src_path).parts:
            return
        self._on_change()

    on_created = _handle
    on_modified = _handle
    on_deleted = _handle
    on_moved = _handle


class RootWatcher:
    """Watches one root directory tree (recursively) and re-runs the
    indexer, debounced, whenever something changes inside it."""

    def __init__(self, root: Path, status: indexer.IndexStatus) -> None:
        self.root = root
        self._status = status
        self._timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()
        self._observer = Observer()
        self._observer.schedule(_Handler(self._schedule_reindex), str(root), recursive=True)
        self._observer.start()

    def _schedule_reindex(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_SECONDS, self._reindex)
            self._timer.daemon = True
            self._timer.start()

    def _reindex(self) -> None:
        # A pass (the initial one from /index/start, or a previous live
        # one) is still running - don't overlap it. Re-arm the same
        # debounce timer instead; once that pass finishes this check will
        # pass and the changes that arrived meanwhile get picked up.
        if self._status.status == "indexing":
            self._schedule_reindex()
            return
        indexer.run_index(self.root, self._status)

    def stop(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        self._observer.stop()
        self._observer.join(timeout=2)


_active: Optional[RootWatcher] = None
_active_lock = threading.Lock()


def start_watching(root: Path, status: indexer.IndexStatus) -> None:
    """Starts live-watching `root`, stopping whatever root was being
    watched before. A no-op if `root` is already the one being watched."""
    global _active
    with _active_lock:
        if _active is not None and _active.root == root:
            return
        if _active is not None:
            _active.stop()
        _active = RootWatcher(root, status)
