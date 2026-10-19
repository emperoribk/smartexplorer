"""Tests for the background indexer (app/autoindex.py).

The real indexing pass and the CLIP model are swapped for fakes - what is
under test here is the orchestration: order, waiting for the model, progress
numbers, pausing, and sharing a folder's IndexStatus with /index/start.
"""
import threading
import time
from pathlib import Path

from app import autoindex, indexer


def _wait_for(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _make_roots(tmp_path, names=("Documents", "Pictures")):
    roots = []
    for n in names:
        d = tmp_path / n
        d.mkdir()
        for i in range(3):
            (d / f"f{i}.txt").write_text("x")
        (d / ".smartsearch").mkdir()
        (d / ".smartsearch" / "ignored.txt").write_text("x")
        roots.append(str(d.resolve()))
    return roots


def _manager(statuses, calls, **kw):
    def status_for(root):
        return statuses.setdefault(root, indexer.IndexStatus(root=root))

    def fake_index(root: Path, status):
        calls.append(str(root))
        status.status = "indexing"
        status.total = 3
        status.processed = 3
        status.status = "done"

    return autoindex.AutoIndex(
        status_for,
        sweep_seconds=kw.pop("sweep_seconds", 3600),
        model_retry_seconds=kw.pop("model_retry_seconds", 0.05),
        model_ready=kw.pop("model_ready", lambda: True),
        index_root=kw.pop("index_root", fake_index),
    )


def test_count_files_skips_hidden_index_dir(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    assert autoindex.count_files(Path(roots[0])) == 3


def test_indexes_each_root_once_in_order_then_reports_done(tmp_path):
    roots = _make_roots(tmp_path)
    calls = []
    m = _manager({}, calls)
    m.start(roots)
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    snap = m.snapshot()
    assert calls == roots
    assert snap["state"] == "idle"
    assert snap["overall_total"] == 6 and snap["overall_processed"] == 6
    assert [r["status"] for r in snap["roots"]] == ["done", "done"]
    assert snap["last_finished"] is not None
    m.stop()


def test_ignores_missing_folders_and_duplicates(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    calls = []
    m = _manager({}, calls)
    m.start([roots[0], roots[0], str(tmp_path / "nope")])
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    assert calls == roots
    m.stop()


def test_waits_for_model_before_indexing_anything(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    calls = []
    ready = {"ok": False}
    m = _manager({}, calls, model_ready=lambda: ready["ok"])
    m.start(roots)
    assert _wait_for(lambda: m.snapshot()["state"] == "waiting_model")
    time.sleep(0.2)
    assert calls == []  # nothing indexed without the model
    ready["ok"] = True
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    assert calls == roots
    m.stop()


def test_stop_pauses_and_start_resumes_with_a_new_sweep(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    calls = []
    m = _manager({}, calls)
    m.start(roots)
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    m.stop()
    assert _wait_for(lambda: m.snapshot()["state"] == "paused")
    n = len(calls)
    time.sleep(0.2)
    assert len(calls) == n
    m.start(roots)
    assert _wait_for(lambda: len(calls) == n + 1)
    m.stop()


def test_periodic_sweep_runs_again(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    calls = []
    m = _manager({}, calls, sweep_seconds=0.1)
    m.start(roots)
    assert _wait_for(lambda: len(calls) >= 3)
    m.stop()


def test_waits_for_a_run_started_by_the_user_instead_of_racing_it(tmp_path):
    roots = _make_roots(tmp_path, ("A",))
    statuses = {}
    st = indexer.IndexStatus(root=roots[0])
    st.status = "indexing"
    statuses[roots[0]] = st
    calls = []
    m = _manager(statuses, calls)
    m.start(roots)
    time.sleep(0.4)
    assert calls == []  # still waiting on the user-started pass
    st.status = "done"
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    assert calls == roots
    m.stop()


def test_one_failing_root_does_not_stop_the_rest(tmp_path):
    roots = _make_roots(tmp_path)
    seen = []

    def flaky(root, status):
        seen.append(str(root))
        if str(root) == roots[0]:
            raise RuntimeError("boom")
        status.status = "done"
        status.total = status.processed = 3

    m = _manager({}, [], index_root=flaky)
    m.start(roots)
    assert _wait_for(lambda: m.snapshot()["first_pass_done"])
    assert seen == roots
    assert "boom" in (m.snapshot()["error"] or "")
    m.stop()
