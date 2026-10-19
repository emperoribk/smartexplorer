"""SmartSearch local backend.

Runs as a small HTTP service on 127.0.0.1 that the Electron app talks to.
It never touches the network beyond that - all indexing/search/AI runs
on-device. Electron spawns this process on startup and kills it on quit.
"""
from __future__ import annotations

import re
import tempfile
import threading
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import autoindex, convert, db, diskusage, duplicates, embeddings, extract, indexer, memories, namegen, ocr, query_parse, search, sensitive, vault, visualnames, watcher

app = FastAPI(title="SmartSearch Backend")

# The renderer talks to us over http://127.0.0.1:<port>; Electron pages are
# served from file:// or a local dev server, so we allow both.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# One IndexStatus + lock per root folder the user has indexed this session.
_statuses: dict[str, indexer.IndexStatus] = {}
_statuses_lock = threading.Lock()


def _status_for(root: str) -> indexer.IndexStatus:
    with _statuses_lock:
        if root not in _statuses:
            _statuses[root] = indexer.IndexStatus(root=root)
        return _statuses[root]


# Same one-status-object-per-root pattern as _statuses above, for the
# storage treemap's lazy per-folder scans (diskusage.py) - a different
# cache because these are keyed by ANY folder someone drills into, not
# just the folders opened in Browse/indexed.
_disk_usage_statuses: dict[str, diskusage.ScanStatus] = {}
_disk_usage_statuses_lock = threading.Lock()


def _disk_usage_status_for(root: str) -> diskusage.ScanStatus:
    with _disk_usage_statuses_lock:
        if root not in _disk_usage_statuses:
            _disk_usage_statuses[root] = diskusage.ScanStatus(root=root)
        return _disk_usage_statuses[root]


class IndexRequest(BaseModel):
    root_path: str


class AutoIndexRequest(BaseModel):
    roots: list[str]


class DiskUsageRequest(BaseModel):
    root_path: str
    # True only for an explicit "rescan" action (see StorageView.tsx's
    # refresh button) - bypasses a cached "done" result and walks the
    # folder again, for when files have changed since the last scan and
    # someone actually wants an up to date picture rather than a fast one.
    force: bool = False


class SearchAllRequest(BaseModel):
    roots: list[str]
    q: str


class SuggestNameRequest(BaseModel):
    root_path: str
    path: str


class ConvertRequest(BaseModel):
    path: str
    target_ext: str


class VaultSetupRequest(BaseModel):
    method: str  # "pin" | "dpapi"
    pin: Optional[str] = None
    windows_password: Optional[str] = None


class VaultUnlockRequest(BaseModel):
    pin: Optional[str] = None
    windows_password: Optional[str] = None


class VaultFileRequest(BaseModel):
    root_path: str
    entry_id: str
    pin: Optional[str] = None
    windows_password: Optional[str] = None
    # Only meaningful to /vault/restore (ignored by /vault/open, which
    # always goes to a temp dir) - an arbitrary folder the entry was
    # drag-and-dropped onto (a Sidebar row, a Breadcrumb segment, a
    # FileGrid directory tile), restoring there under the entry's original
    # filename instead of back to its original location. Deliberately not
    # containment-checked against root_path the way /vault/lock's source
    # path is: this is a destination the person picked, just like
    # fs:moveItems lets a plain move land anywhere.
    dest_dir: Optional[str] = None


class VaultLockRequest(BaseModel):
    # Manually sending a file INTO Your Eyes Only - the sensitive-scan path
    # (see get_sensitive_scan above) does this automatically; this is the
    # same vault.lock_file() call, just triggered by a person's own choice
    # from the file browser instead of a detected SSN/card/key.
    root_path: str
    path: str


@app.get("/health")
def health():
    # ocr_available tells the app whether "find text inside a photo/
    # screenshot" is actually working - Tesseract is a separate native
    # install (see README), not something pip installs, so it's easy for it
    # to be silently missing on a given machine. Checked once and cached in
    # ocr.py; cheap to include on every health poll.
    return {"ok": True, "ocr_available": ocr.tesseract_available()}


@app.post("/index/start")
def start_index(req: IndexRequest):
    root = Path(req.root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")

    status = _status_for(str(root))
    # Keeps this folder's index live for as long as it's the one open in
    # Browse (see watcher.py) - a file added, edited, or removed from
    # outside the app updates the index without anyone needing to search
    # or make a change through the app first. A no-op if this root is
    # already the one being watched, so calling it on every navigation -
    # even back to a folder that was already open a moment ago - is cheap.
    watcher.start_watching(root, status)

    if status.status == "indexing":
        return status.snapshot()

    thread = threading.Thread(target=indexer.run_index, args=(root, status), daemon=True)
    thread.start()
    return status.snapshot()


# Background indexing of the main folders (Documents, Pictures, ...) from the
# moment the app first opens - see autoindex.py.
_autoindex = autoindex.AutoIndex(_status_for, on_model_ready=visualnames.warm)


@app.post("/autoindex/start")
def start_autoindex(req: AutoIndexRequest):
    return _autoindex.start(req.roots)


@app.post("/autoindex/stop")
def stop_autoindex():
    return _autoindex.stop()


@app.get("/autoindex/status")
def autoindex_status():
    return _autoindex.snapshot()


@app.get("/index/status")
def index_status(root_path: str = Query(...)):
    root = str(Path(root_path).expanduser().resolve())
    return _status_for(root).snapshot()


@app.post("/disk-usage/start")
def start_disk_usage(req: DiskUsageRequest):
    # Storage treemap (see diskusage.py) - one level at a time: this scans
    # ONLY req.root_path's immediate children, not the whole drive, so
    # drilling into a subfolder is its own fast, separate call rather than
    # waiting on an upfront whole-drive walk.
    root = Path(req.root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")

    status = _disk_usage_status_for(str(root))
    # A scan already running, or one already finished, is reused rather
    # than restarted - this is what makes warming the drive's top level up
    # front (App.tsx kicks this off the moment it learns the drive root,
    # well before anyone actually opens the storage view) actually pay
    # off: without this, clicking "Local Disk" would re-walk the whole
    # thing from scratch every time regardless of how early it was warmed.
    # `force` is the deliberate escape hatch for "I changed things, scan
    # again" - the one case a cached result is actively wrong to reuse.
    if not req.force and status.status in ("scanning", "done"):
        return status.snapshot()

    thread = threading.Thread(target=diskusage.scan_children, args=(root, status), daemon=True)
    thread.start()
    return status.snapshot()


@app.get("/disk-usage/status")
def disk_usage_status(root_path: str = Query(...)):
    root = str(Path(root_path).expanduser().resolve())
    return _disk_usage_status_for(root).snapshot()


@app.get("/search")
def do_search(root_path: str = Query(...), q: str = Query(...)):
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    results, parsed = search.search_with_info(root, q)
    # query_info tells the UI what the natural-language query parser
    # actually understood - the content words it searched for once filler
    # was stripped, and a short label for any kind/date filter it inferred
    # from the phrasing (e.g. "that ticket screenshot from last week" ->
    # ["photos/screenshots", "last week"]) - so narrowing results down is
    # always visible, never a silent guess (see query_parse.py, search.py).
    return {
        "results": results,
        "query_info": {"content_query": parsed.content_query, "filter_labels": parsed.filter_labels},
    }


def _existing_roots(root_paths: list) -> list:
    # Same forgiving rule as /search/all: an indexed-folders list kept on the
    # renderer side can drift from disk (a folder renamed or deleted), and
    # that shouldn't fail the whole request - just skip what's gone.
    roots = []
    for r in root_paths:
        p = Path(r).expanduser().resolve()
        if p.is_dir():
            roots.append(str(p))
    return roots


@app.get("/timeline")
def get_timeline(
    root_path: list[str] = Query(...),
    limit: int = Query(200, ge=1, le=1000),
    before: Optional[float] = Query(None),
    before_path: Optional[str] = Query(None),
    kinds: Optional[str] = Query(None),
    exts: Optional[str] = Query(None),
):
    # Memories layer, part 1: every indexed file from every given root,
    # newest first, all types mixed - see memories.py. Purely a read of the
    # existing indexes (nothing is scanned or written), paged by a
    # (before, before_path) cursor so a reindex between pages can't repeat
    # or skip rows. `kinds` is an optional comma list of image/video/text/other.
    kind_list = [k for k in (kinds or "").split(",") if k]
    # `exts` (comma list, e.g. "jpg,pdf,docx") restricts to those extensions -
    # how the app's "Show all files" toggle being off reaches here. Absent =
    # no restriction beyond the built-in noise filter.
    ext_list = None if exts is None else [e for e in exts.split(",") if e]
    return memories.timeline(
        _existing_roots(root_path), limit=limit, before=before, before_path=before_path,
        kinds=kind_list, exts=ext_list,
    )


@app.get("/memories")
def get_memories(
    root_path: list[str] = Query(...),
    now: Optional[float] = Query(None),
    exts: Optional[str] = Query(None),
):
    # Memories layer, part 2: a handful of gentle resurfacing cards (a
    # folder nothing has touched in a year+, "on this day" from earlier
    # years). `now` exists only so this can be tested at a fixed point in
    # time; the app never sends it. Dismiss/snooze state lives in the
    # renderer, so this stays stateless.
    ext_list = None if exts is None else [e for e in exts.split(",") if e]
    return memories.memories(_existing_roots(root_path), now=now, exts=ext_list)


@app.get("/similar")
def get_similar(root_path: str = Query(...), path: str = Query(...)):
    # "Find similar" - a right-click action on one already-indexed file,
    # not a typed query. Same response shape as /search (a list of
    # SearchResult) so the renderer can reuse the exact same result-grid
    # rendering it already has for search mode (see search.find_similar).
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    results = search.find_similar(root, path)
    return {"results": results}


@app.get("/duplicates")
def get_duplicates(root_path: str = Query(...)):
    # Purely a read of the existing index - see duplicates.py. Nothing here
    # deletes anything; that's a separate, explicit action from the UI.
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    db_path = indexer.db_path_for(root)
    if not db_path.exists():
        return {"exact_groups": [], "near_duplicate_groups": [], "near_duplicate_document_groups": []}
    conn = db.connect(db_path)
    exact = duplicates.find_exact_duplicates(conn)
    near = duplicates.find_near_duplicate_images(conn)
    near_docs = duplicates.find_near_duplicate_documents(conn)
    return {
        "exact_groups": [
            {
                "paths": g.paths,
                "filenames": g.filenames,
                "size": g.size,
                "kind": g.kind,
            }
            for g in exact
        ],
        "near_duplicate_groups": [
            {
                "paths": g.paths,
                "filenames": g.filenames,
                "min_similarity": g.min_similarity,
                "max_similarity": g.max_similarity,
            }
            for g in near
        ],
        "near_duplicate_document_groups": [
            {
                "paths": g.paths,
                "filenames": g.filenames,
                "min_similarity": g.min_similarity,
                "max_similarity": g.max_similarity,
            }
            for g in near_docs
        ],
    }


@app.get("/sensitive-scan")
def get_sensitive_scan(root_path: str = Query(...)):
    # Report-only. Files are NEVER moved into Your Eyes Only from here: the
    # only things in the vault are files the person sent there themselves
    # (/vault/lock). Because the result names files that look sensitive, it
    # is only given out while the vault is unlocked.
    if not vault.is_unlocked_for_session():
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    db_path = indexer.db_path_for(root)
    if not db_path.exists():
        return {"flagged_files": [], "vault_status": _vault_status_summary()}
    conn = db.connect(db_path)
    flagged = sensitive.scan_folder(conn)
    return {
        "flagged_files": [
            {
                "path": f.path,
                "filename": f.filename,
                "kind": f.kind,
                "findings": [
                    {"kind": fi.kind, "masked": fi.masked, "count": fi.count} for fi in f.findings
                ],
            }
            for f in flagged
        ],
        "newly_vaulted": [],
        "vault_status": _vault_status_summary(),
    }


def _vault_status_summary() -> dict:
    windows_has_password: Optional[bool]
    try:
        windows_has_password = vault.windows_account_has_password()
    except vault.VaultError:
        windows_has_password = None
    return {
        "set_up": vault.is_set_up(),
        "method": vault.vault_method(),
        "unlocked_for_locking": vault.get_key_for_locking() is not None,
        "windows_has_password": windows_has_password,
    }


@app.get("/vault/status")
def get_vault_status():
    return _vault_status_summary()


@app.post("/vault/setup")
def post_vault_setup(req: VaultSetupRequest):
    try:
        if req.method == "pin":
            if not req.pin:
                raise HTTPException(400, "A PIN is required.")
            vault.setup_with_pin(req.pin)
            vault.set_session_key(vault.unlock_vault_key(pin=req.pin))
        elif req.method == "dpapi":
            if not req.windows_password:
                raise HTTPException(400, "Your Windows password is required.")
            vault.setup_with_windows_account(req.windows_password)
            vault.set_session_key(vault.unlock_vault_key(windows_password=req.windows_password))
        else:
            raise HTTPException(400, f"Unknown method: {req.method!r}")
    except vault.VaultError as e:
        raise HTTPException(400, str(e))
    return _vault_status_summary()


@app.post("/vault/unlock")
def post_vault_unlock(req: VaultUnlockRequest):
    # Unlocking for the SESSION (see vault.py's session-key section) - just
    # enough to browse Your Eyes Only's list. Opening or restoring a
    # specific file still re-checks fresh every time, regardless of this.
    try:
        key = vault.unlock_vault_key(pin=req.pin, windows_password=req.windows_password)
    except vault.VaultError as e:
        raise HTTPException(401, str(e))
    vault.set_session_key(key)
    return _vault_status_summary()


@app.post("/vault/lock-now")
def post_vault_lock_now():
    vault.clear_session_key()
    return _vault_status_summary()


@app.post("/vault/lock")
def post_vault_lock(req: VaultLockRequest):
    # Deliberately the LOOSE side of the asymmetry, same as the automatic
    # sensitive-scan path: locking a file in only needs a key that's
    # already available this session (see vault.py's get_key_for_locking
    # doc comment), never a freshly-retyped PIN/password. Sending a file
    # back OUT (post_vault_open / post_vault_restore, above) is the strict
    # side and always re-checks fresh - that asymmetry is the whole point,
    # not something to "fix" by tightening this endpoint too.
    if not vault.is_set_up():
        raise HTTPException(400, "Set up Your Eyes Only first.")
    key = vault.get_key_for_locking()
    if key is None:
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    root = Path(req.root_path).expanduser().resolve()
    target = Path(req.path).expanduser().resolve()
    # A whole folder is allowed here too (vault.lock_file zips it into one
    # blob) - only a path that's neither a file nor a directory (doesn't
    # exist, or something stranger like a broken symlink/device) is refused.
    if not target.is_file() and not target.is_dir():
        raise HTTPException(400, f"Not found: {target}")
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(400, "That isn't inside the current folder.")
    try:
        entry = vault.lock_file(key, root, target, ["manual"])
    except (OSError, vault.VaultError) as e:
        raise HTTPException(400, str(e))
    return {"id": entry.id, "filename": entry.original_filename}


@app.get("/vault/list-all")
def get_vault_list_all(extra_roots: List[str] = Query(default=[])):
    """Everything in Your Eyes Only, across every folder that holds a vault -
    each entry says which folder (`root`) it lives under, which is what
    /vault/open and /vault/restore need. `extra_roots` are folders the app
    has seen; any that already hold a vault are picked up and remembered."""
    if not vault.is_unlocked_for_session():
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    key = vault.get_key_for_locking()
    if key is None:
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    out = []
    for root in vault.known_roots([Path(r) for r in extra_roots if r]):
        try:
            entries = vault.list_vault(key, root)
        except vault.VaultError:
            continue  # one unreadable folder must not hide all the others
        for e in entries:
            out.append(
                {
                    "id": e.id,
                    "filename": e.original_filename,
                    "size": e.size,
                    "locked_at": e.locked_at,
                    "reasons": e.reasons,
                    "is_folder": e.is_folder,
                    "root": str(root),
                    "original_path": e.original_path,
                }
            )
    out.sort(key=lambda x: x["locked_at"], reverse=True)
    return {"entries": out}


@app.get("/vault/list")
def get_vault_list(root_path: str = Query(...)):
    if not vault.is_unlocked_for_session():
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    key = vault.get_key_for_locking()
    if key is None:
        raise HTTPException(401, "Unlock Your Eyes Only first.")
    try:
        entries = vault.list_vault(key, root)
    except vault.VaultError as e:
        raise HTTPException(400, str(e))
    return {
        "entries": [
            {
                "id": e.id,
                "filename": e.original_filename,
                "size": e.size,
                "locked_at": e.locked_at,
                "reasons": e.reasons,
                "is_folder": e.is_folder,
            }
            for e in entries
        ]
    }


@app.post("/vault/open")
def post_vault_open(req: VaultFileRequest):
    # A FRESH check, deliberately never satisfied by the session cache -
    # see vault.py's module docstring for why: this is the specific step
    # that has to stop someone who's merely sitting at an already-unlocked,
    # already-logged-in session.
    try:
        key = vault.unlock_vault_key(pin=req.pin, windows_password=req.windows_password)
    except vault.VaultError as e:
        raise HTTPException(401, str(e))
    root = Path(req.root_path).expanduser().resolve()
    tmp_dir = Path(tempfile.gettempdir()) / "smartexplorer-vault"
    try:
        temp_path = vault.unlock_to_temp(key, root, req.entry_id, tmp_dir)
    except vault.VaultError as e:
        raise HTTPException(400, str(e))
    return {"temp_path": str(temp_path)}


@app.post("/vault/restore")
def post_vault_restore(req: VaultFileRequest):
    try:
        key = vault.unlock_vault_key(pin=req.pin, windows_password=req.windows_password)
    except vault.VaultError as e:
        raise HTTPException(401, str(e))
    root = Path(req.root_path).expanduser().resolve()
    dest_dir = Path(req.dest_dir).expanduser().resolve() if req.dest_dir else None
    try:
        restored = vault.restore_file(key, root, req.entry_id, dest_dir=dest_dir)
    except vault.VaultError as e:
        raise HTTPException(400, str(e))
    return {"restored_path": str(restored)}


# Matches a trailing "-<number>" on a filename stem, e.g. the "-2" in
# "quanto-entry-2" - used to recognize files already numbered by a previous
# suggestion (see _next_available_stem below).
_TRAILING_NUM_RE = re.compile(r"-(\d+)$")


def _next_available_stem(directory: Path, base_stem: str, exclude_path: Path) -> str:
    """Looks at the other files already sitting in `directory` and, if one
    of them is already using `base_stem` (the name this suggestion is about
    to propose), returns the next free "<base_stem>-<N>" instead - so a
    batch of visually-similar screenshots that each independently OCR down
    to the same words (a shared template - the same trading-card layout
    with only the dollar figure differing, say) land as
    `name.jpg`, `name-2.jpg`, `name-3.jpg`, ... instead of every one of
    them silently proposing the exact same name.

    The very first file to use a name keeps it plain, with no "-1" - only
    the second and later ones get numbered. Comparison is case-insensitive
    and ignores extension, since the two files being compared don't have to
    share one.
    """
    try:
        entries = list(directory.iterdir())
    except OSError:
        return base_stem

    exclude_resolved = exclude_path.resolve()
    base_lower = base_stem.lower()
    highest = 0
    matched_any = False
    for entry in entries:
        try:
            if entry.resolve() == exclude_resolved:
                continue
        except OSError:
            pass
        if not entry.is_file():
            continue
        stem = entry.stem
        m = _TRAILING_NUM_RE.search(stem)
        if m:
            candidate_base, num = stem[: m.start()], int(m.group(1))
        else:
            candidate_base, num = stem, 1
        if candidate_base.lower() != base_lower:
            continue
        matched_any = True
        highest = max(highest, num)

    if not matched_any:
        return base_stem
    return f"{base_stem}-{highest + 1}"


@app.post("/suggest-name")
def suggest_name(req: SuggestNameRequest):
    # Purely a read of text indexing already extracted (files_fts.content -
    # see db.py, namegen.py) - no OCR/CLIP work happens here, so this is
    # cheap enough to call on every "Suggest a name" click without a
    # separate loading/progress state in the UI.
    root = Path(req.root_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    db_path = indexer.db_path_for(root)
    if not db_path.exists():
        return {"suggested": None, "reason": None}
    conn = db.connect(db_path)
    row = conn.execute(
        "SELECT content FROM files_fts WHERE path = ?", (req.path,)
    ).fetchone()
    content_text = row[0] if row else None
    target_ext = Path(req.path).suffix
    ext = target_ext.lower()

    # A PHOTO has no text of its own - OCR on it only returns noise ("cen cet
    # spr"), which used to become names like Cen-cet-spr-nnncetantet.jpg. So an
    # image that CLIP sees as a photograph is named from what it SHOWS
    # (Brown-bag-on-yellow-background.jpg, see visualnames.py); screenshots,
    # tickets and scans are still named from the text inside them.
    is_photo = False
    suggested = None
    if ext in ocr.IMAGE_EXTS:
        vec_row = conn.execute(
            "SELECT e.vector FROM embeddings e JOIN files f ON f.id = e.file_id WHERE f.path = ?",
            (req.path,),
        ).fetchone()
        img_vec = db.blob_to_vector(vec_row[0]) if vec_row else embeddings.embed_image(Path(req.path))
        if img_vec is not None:
            photo_like = visualnames.classify_photo(img_vec)
            if photo_like is not None and photo_like >= visualnames.PHOTO_THRESHOLD:
                is_photo = True
                slug = visualnames.suggest_photo_name(img_vec, Path(req.path))
                if slug:
                    suggested = f"{slug}{ext}"
    if not suggested and not is_photo:
        suggested = namegen.suggest_filename(content_text, target_ext)

    reason = None
    if not suggested and not is_photo:
        # A scanned PDF or a photo/screenshot has no usable text of its own
        # to begin with - everything it has comes from OCR at index time.
        # If Tesseract isn't installed, that text was never extracted (and
        # can't be, right now, no matter how many times this gets clicked),
        # so say so specifically instead of the same generic "nothing to
        # suggest from" a plain empty file or a genuinely-blank page would
        # also produce - that's the difference between "there's nothing
        # here" and "there's probably something here, but I can't read it
        # yet". Necessarily a heuristic, not a certainty: this can't tell a
        # file that was actually OCR'd and still came up empty from one
        # that was indexed before Tesseract was ever installed - either way,
        # installing Tesseract and re-indexing is the right next step.
        needs_ocr_text = ext in extract.PDF_EXTS or ext in ocr.IMAGE_EXTS
        if needs_ocr_text and not ocr.tesseract_available():
            reason = "ocr_unavailable"

    if suggested:
        target = Path(req.path)
        suggested_path = Path(suggested)
        final_stem = _next_available_stem(target.parent, suggested_path.stem, target)
        suggested = f"{final_stem}{suggested_path.suffix}"
    return {"suggested": suggested, "reason": reason}


@app.post("/search/all")
def do_search_all(req: SearchAllRequest):
    # Folders that don't (or no longer) exist are quietly skipped rather
    # than failing the whole search - the person's local "indexed folders"
    # list can drift from disk (a folder gets renamed/deleted) and that
    # shouldn't break searching everything else.
    roots = []
    for r in req.roots:
        p = Path(r).expanduser().resolve()
        if p.is_dir():
            roots.append(p)
    parsed = query_parse.parse(req.q)
    return {
        "results": search.search_multi(roots, req.q),
        "query_info": {"content_query": parsed.content_query, "filter_labels": parsed.filter_labels},
    }



@app.get("/convert/targets")
def convert_targets(path: str = Query(...)):
    """What this file could be converted to, e.g. [".docx", ".txt"] for a
    PDF - an empty list means "no conversion" belongs in the menu for it at
    all, rather than the frontend guessing from the extension itself."""
    return {"targets": convert.supported_targets(Path(path).suffix)}


@app.get("/preview/text")
def preview_text(path: str = Query(...)):
    """Plain-text preview for Quick Look (see QuickLookOverlay.tsx) - the
    exact same best-effort extraction already used to make these files'
    contents searchable in the first place (extract.py), just handed back
    directly here instead of into the search index. Covers real text files
    and .docx (the only binary-ish format extract_text actually knows how
    to read) - anything else (.xlsx, .pptx, .rtf, .odt, ...) comes back
    empty, same as it already does for indexing, and the frontend falls
    back to "no preview available" there rather than claiming support that
    isn't really there.
    """
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise HTTPException(400, f"Not a file: {p}")
    text = extract.extract_text(p)
    images: list[str] = []
    images_truncated = False
    if p.suffix.lower() in extract.DOCX_EXTS:
        # A Word file can be a scanned/screenshotted page with no typed text
        # at all - show its pictures so the preview isn't blank.
        try:
            images, images_truncated = extract.docx_images(p)
        except Exception:  # noqa: BLE001 - a broken package just means no pictures
            images = []
    return {
        "text": text,
        "truncated": len(text) >= extract.MAX_CHARS,
        "images": images,
        "images_truncated": images_truncated,
    }


@app.post("/convert")
def convert_file(req: ConvertRequest):
    path = Path(req.path).expanduser().resolve()
    if not path.is_file():
        raise HTTPException(400, f"Not a file: {path}")
    try:
        dest = convert.convert(path, req.target_ext)
    except convert.ConversionError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001 - surface it, don't crash the backend
        raise HTTPException(500, f"Conversion failed: {e}")
    return {"path": str(dest)}
