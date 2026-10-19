"""Background indexing of the user's main folders.

Without this, a folder only gets indexed the first time somebody opens or
searches it, so a fresh install meant waiting through a long first pass.
This module indexes a fixed list of folders (Documents, Pictures, Desktop,
Downloads, Videos - chosen by the app, see /autoindex/start) one after the
other on a single background thread, as soon as the app starts. After the
first pass it re-sweeps every so often; because the indexer skips every file
whose mtime/size/extraction-version is unchanged, a sweep only does real work
for files that arrived since the last one - the small day-to-day trickle.

The same per-root IndexStatus objects as /index/start are used on purpose: if
someone opens a folder while it is being auto-indexed, the normal progress UI
simply picks up the run that is already in flight instead of starting a
second one.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from . import embeddings, indexer

SWEEP_SECONDS = 15 * 60
MODEL_RETRY_SECONDS = 60


def count_files(root: Path) -> int:
    """Cheap upper-bound-ish file count (no stat calls) used only to give
    the first-run progress bar a meaningful total across all folders."""
    n = 0
    try:
        for _dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames if d not in indexer.SKIP_DIRS and not d.startswith(".")
            ]
            n += len(filenames)
    except OSError:
        pass
    return n


class AutoIndex:
    def __init__(
        self,
        status_for: Callable[[str], "indexer.IndexStatus"],
        sweep_seconds: float = SWEEP_SECONDS,
        model_retry_seconds: float = MODEL_RETRY_SECONDS,
        model_ready: Optional[Callable[[], bool]] = None,
        index_root: Optional[Callable[[Path, "indexer.IndexStatus"], None]] = None,
        on_model_ready: Optional[Callable[[], None]] = None,
    ):
        self._status_for = status_for
        self._sweep_seconds = sweep_seconds
        self._model_retry_seconds = model_retry_seconds
        self._model_ready = model_ready or embeddings.ensure_ready
        self._index_root = index_root or indexer.run_index
        self._on_model_ready = on_model_ready
        self._warmed = False

        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._enabled = False
        self._roots: list[str] = []
        self._state = "idle"  # idle | indexing | waiting_model | paused
        self._current_root = ""
        self._counts: dict[str, int] = {}  # root -> estimated total files
        self._results: dict[str, dict] = {}  # root -> {status, processed, total}
        self._first_pass_done = False
        self._last_finished: Optional[float] = None
        self._error: Optional[str] = None

    # ---- control ----

    def start(self, roots: list[str]) -> dict:
        clean: list[str] = []
        for r in roots:
            try:
                p = Path(r).expanduser().resolve()
            except OSError:
                continue
            if p.is_dir() and str(p) not in clean:
                clean.append(str(p))
        with self._lock:
            self._roots = clean
            self._enabled = True
            was_running = self._thread is not None and self._thread.is_alive()
            if not was_running:
                self._wake.clear()
                self._thread = threading.Thread(target=self._run, daemon=True, name="autoindex")
                self._thread.start()
        if was_running:
            # Already sleeping between sweeps (or paused): sweep now. A brand
            # new worker doesn't need the nudge - it begins with a pass.
            self._wake.set()
        return self.snapshot()

    def stop(self) -> dict:
        with self._lock:
            self._enabled = False
        self._wake.set()
        return self.snapshot()

    # ---- progress ----

    def snapshot(self) -> dict:
        with self._lock:
            roots = list(self._roots)
            state = self._state if self._enabled or self._state == "indexing" else "paused"
            current = self._current_root
            counts = dict(self._counts)
            results = dict(self._results)
            enabled = self._enabled
            first_done = self._first_pass_done
            last = self._last_finished
            error = self._error

        rows = []
        overall_total = 0
        overall_processed = 0
        for r in roots:
            if r == current and state == "indexing":
                s = self._status_for(r).snapshot()
                total = max(s["total"], counts.get(r, 0)) if s["status"] == "indexing" else counts.get(r, 0)
                rows.append({"root": r, "status": s["status"], "processed": s["processed"], "total": total})
                overall_processed += s["processed"]
                overall_total += total
            elif r in results:
                res = results[r]
                rows.append({"root": r, **res})
                overall_processed += res["processed"]
                overall_total += res["total"]
            else:
                total = counts.get(r, 0)
                rows.append({"root": r, "status": "queued", "processed": 0, "total": total})
                overall_total += total
        return {
            "enabled": enabled,
            "state": state,
            "current_root": current,
            "roots": rows,
            "overall_total": overall_total,
            "overall_processed": min(overall_processed, overall_total) if overall_total else 0,
            "first_pass_done": first_done,
            "last_finished": last,
            "error": error,
        }

    # ---- worker ----

    def _set_state(self, state: str, current: str = "") -> None:
        with self._lock:
            self._state = state
            self._current_root = current

    def _run(self) -> None:
        while True:
            with self._lock:
                enabled = self._enabled
                roots = list(self._roots)
            if not enabled:
                self._set_state("paused")
                self._wake.wait()
                self._wake.clear()
                continue

            # Photos indexed while the CLIP model is unavailable would be
            # stored without an embedding and - being "unchanged" - never
            # revisited, so wait for the model rather than index around it.
            if not self._model_ready():
                self._set_state("waiting_model")
                self._wake.wait(self._model_retry_seconds)
                self._wake.clear()
                continue

            if self._on_model_ready and not self._warmed:
                self._warmed = True
                try:
                    self._on_model_ready()
                except Exception:  # noqa: BLE001 - a warm-up must never stop indexing
                    pass

            self._set_state("indexing")
            if not self._first_pass_done:
                for r in roots:
                    n = count_files(Path(r))
                    with self._lock:
                        self._counts[r] = n
            for r in roots:
                with self._lock:
                    if not self._enabled:
                        break
                self._index_one(r)
            with self._lock:
                self._first_pass_done = True
                self._last_finished = time.time()
            self._set_state("idle")

            self._wake.wait(self._sweep_seconds)
            self._wake.clear()

    def _index_one(self, root: str) -> None:
        self._set_state("indexing", root)
        status = self._status_for(root)
        # Someone opened this folder and its own indexing run is going -
        # let it finish instead of racing it.
        while status.status == "indexing":
            time.sleep(1)
        try:
            self._index_root(Path(root), status)
        except Exception as e:  # noqa: BLE001 - one bad folder must not stop the rest
            with self._lock:
                self._error = f"{root}: {e}"
        snap = status.snapshot()
        with self._lock:
            self._results[root] = {
                "status": snap["status"],
                "processed": snap["processed"],
                "total": snap["total"],
            }
            if snap["status"] == "error" and snap["error"]:
                self._error = f"{root}: {snap['error']}"
