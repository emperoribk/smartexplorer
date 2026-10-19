"""\"Your Eyes Only\" - a hidden, encrypted holding area for files
sensitive.py's scan flags (an SSN, a credit card number, a bank routing
number, a private-key file). The moment a file is flagged, it's moved here
and encrypted; it disappears from its normal folder entirely until someone
proves they're allowed to see it again.

Why this exists instead of just the read-only warning sensitive.py started
as: a warning a stranger holding your unlocked laptop will never see,
because they're not the one running the scan - and even if they were, a
warning doesn't stop them opening the file directly in File Explorer or
copying it to a flash drive. Actually scrambling the file's bytes on disk
does: whoever opens SSN_2026.pdf outside this app, with this machine
unlocked or not, gets ciphertext. Only this module, after the identity
check below passes, turns it back into the real document.

THE IDENTITY CHECK (not a password this app invents and you can forget):
  - If the Windows account already has a password, that password IS the
    check - re-typed and verified fresh against Windows itself (see
    verify_windows_password) every time, not just trusted because the
    session happens to already be logged in. That's the specific gap a
    stranger holding an already-unlocked laptop would otherwise walk
    through: being logged in already proves nothing on its own here.
  - If the account has no password at all, there's nothing Windows-side to
    check against, so the app asks once for a PIN of its own ("Your Eyes
    Only" PIN) and uses that from then on instead.
  - The vault's real encryption key is wrapped two different ways
    depending on which path is active: via Windows DPAPI (CryptProtectData/
    CryptUnprotectData - cryptographically tied to this Windows user
    profile, nothing this app stores or could leak on its own) for the
    password path, or via a PIN-derived key (scrypt, this app's own code,
    works on any platform) for the PIN path. Verifying the typed password/
    PIN and successfully unwrapping the key are two independent checks -
    both have to pass.

HONEST LIMITS, stated rather than glossed over:
  - This stops a stranger using normal means on this machine - File
    Explorer, another installed program, copying the raw file to a flash
    drive, logging into the SAME machine as a different Windows account.
    It does not stop someone with the technical means to pull the raw disk
    out and read it with different tooling entirely (booting another OS
    off a USB drive, say) - that tier is what whole-disk encryption
    (BitLocker) is for, a Windows setting, not something an app can retrofit
    on top.
  - Only local Windows accounts are handled (LogonUserW works for domain
    accounts too in principle, but a Microsoft/Azure-AD-joined account's
    password flow hasn't been tried against this code) - a known gap for a
    later version, not silently assumed to work.
  - Opening a locked file hands a decrypted temp copy to its real app (Word,
    Acrobat, whatever) so it can be edited normally - the alternative
    (view-only inside this app, nothing ever decrypted to a real file on
    disk) is more airtight but was traded away on purpose so editing still
    works like normal. The temp copy is this module's responsibility to
    clean up (see unlock_to_temp's caller contract), not a permanent extra
    plaintext copy left lying around.
"""
from __future__ import annotations

import ctypes
import io
import hashlib
import json
import os
import shutil
import sys
import threading
import uuid
import zipfile
from dataclasses import dataclass, field
from hashlib import scrypt
from pathlib import Path
from typing import List, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VAULT_KEY_BYTES = 32  # AES-256
_SCRYPT_SALT_BYTES = 16
_GCM_NONCE_BYTES = 12

# scrypt cost parameters for turning a short PIN into a 32-byte wrapping
# key. Deliberately expensive (this only runs once per unlock, not per
# file) - n=2**15 is the same ballpark cryptography libraries recommend as
# a modern default for password-based key derivation, chosen to make
# brute-forcing a 4-6 digit PIN against a stolen vault_key.json slow rather
# than instant, which a cheap/fast KDF would not do on its own.
_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1


class VaultError(Exception):
    """Base for every error this module raises on purpose (wrong PIN/
    password, not set up yet, platform not supported) - callers show
    `str(e)` to the person rather than a raw traceback."""


class WrongCredential(VaultError):
    """The typed PIN or Windows password didn't check out. Deliberately the
    same message/type for both paths - which one is active is itself not
    exposed to anything that doesn't already know (see is_set_up)."""


class NotSetUp(VaultError):
    """No vault_key.json yet - setup_with_pin/setup_with_windows_account
    hasn't run for this install."""


def _appdata_dir() -> Path:
    # Set by Electron's main process (see backend.ts) to its own userData
    # directory - deliberately NOT anywhere under an indexed folder, since
    # the vault key must never sit inside something that could itself get
    # zipped up, synced, or copied elsewhere. Falls back to a dotfolder in
    # the home directory for running the backend directly (tests, dev
    # outside Electron) rather than failing outright.
    raw = os.environ.get("SMARTSEARCH_APPDATA")
    base = Path(raw) if raw else Path.home() / ".smartexplorer"
    d = base / "vault"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key_path() -> Path:
    return _appdata_dir() / "vault_key.json"


def is_set_up() -> bool:
    return _key_path().exists()


def vault_method() -> Optional[str]:
    """'pin' | 'dpapi' | None (not set up yet)."""
    p = _key_path()
    if not p.exists():
        return None
    return json.loads(p.read_text()).get("method")


# --- Windows identity check (ctypes, no PowerShell/helper process needed) --

_IS_WINDOWS = sys.platform == "win32"

# LOGON32_LOGON_INTERACTIVE / LOGON32_PROVIDER_DEFAULT - the standard
# combination for "check whether this username+password is valid right
# now", the same primitive Windows itself uses at the lock screen. Using
# this rather than, say, .NET's PrincipalContext.ValidateCredentials (which
# needs Active Directory services even for local-account checks on some
# configurations) keeps this to one well-understood Win32 API with no
# extra process or assembly load.
_LOGON32_LOGON_INTERACTIVE = 2
_LOGON32_PROVIDER_DEFAULT = 0


def _logon_user(username: str, password: str) -> bool:
    if not _IS_WINDOWS:
        raise VaultError("Windows account verification is only available on Windows.")

    advapi32 = ctypes.windll.advapi32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    token = ctypes.c_void_p()
    ok = advapi32.LogonUserW(
        ctypes.c_wchar_p(username),
        None,  # domain: None = check against the local machine, same as typing just the username at the lock screen
        ctypes.c_wchar_p(password),
        _LOGON32_LOGON_INTERACTIVE,
        _LOGON32_PROVIDER_DEFAULT,
        ctypes.byref(token),
    )
    if ok:
        kernel32.CloseHandle(token)
    return bool(ok)


def current_windows_username() -> str:
    if not _IS_WINDOWS:
        raise VaultError("Windows account verification is only available on Windows.")
    size = ctypes.c_uint(0)
    ctypes.windll.advapi32.GetUserNameW(None, ctypes.byref(size))  # type: ignore[attr-defined]
    buf = ctypes.create_unicode_buffer(size.value)
    ctypes.windll.advapi32.GetUserNameW(buf, ctypes.byref(size))  # type: ignore[attr-defined]
    return buf.value


def windows_account_has_password(username: Optional[str] = None) -> bool:
    """Whether the current Windows account actually has a password set, by
    the simplest means that's also the most directly meaningful one: try
    logging in as that account with an *empty* password. Windows accepts
    that only when the account genuinely has no password - the same check
    the lock screen itself would effectively make. (The alternative,
    reading the UF_PASSWD_NOTREQD flag via NetUserGetInfo, tests the same
    fact a layer more indirectly for no real benefit here.)"""
    username = username or current_windows_username()
    try:
        return not _logon_user(username, "")
    except VaultError:
        raise


def verify_windows_password(username: str, password: str) -> bool:
    return _logon_user(username, password)


# --- DPAPI wrap/unwrap (ctypes over crypt32.dll) ---------------------------

_CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _DATA_BLOB:
    buf = ctypes.create_string_buffer(data, len(data))
    return _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def dpapi_protect(data: bytes) -> bytes:
    """Wraps `data` so only this Windows user profile can ever unwrap it
    again (CRYPTPROTECT_UI_FORBIDDEN: never pops Windows' own dialog - this
    app's own identity check above is what gates access, not a second,
    redundant OS prompt). Default scope is CurrentUser, not LocalMachine -
    deliberately: a LocalMachine-scoped blob would unwrap for *any* account
    on this PC, which defeats the point entirely."""
    if not _IS_WINDOWS:
        raise VaultError("DPAPI is only available on Windows.")
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    in_blob = _blob(data)
    out_blob = _DATA_BLOB()
    ok = crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob)
    )
    if not ok:
        raise VaultError("Windows refused to protect the vault key (CryptProtectData failed).")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


def dpapi_unprotect(blob: bytes) -> bytes:
    if not _IS_WINDOWS:
        raise VaultError("DPAPI is only available on Windows.")
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    in_blob = _blob(blob)
    out_blob = _DATA_BLOB()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob)
    )
    if not ok:
        # Wrong account, or the blob is corrupt/foreign - either way, not
        # something this module can tell apart, and it shouldn't try to:
        # both mean "you don't get the key."
        raise WrongCredential("Could not unlock the vault key for this Windows account.")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


# --- PIN-based wrap/unwrap (pure Python, any platform) ---------------------


def _scrypt_key(pin: str, salt: bytes) -> bytes:
    # maxmem explicit and above what n/r actually need (128*n*r bytes =
    # 32MiB at the defaults below) - hashlib.scrypt's own default cap sits
    # right at that boundary and rejects a request that lands exactly on
    # it, which n=2**15,r=8 does.
    return scrypt(
        pin.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
        dklen=VAULT_KEY_BYTES, maxmem=64 * 1024 * 1024,
    )


def _aesgcm_wrap(key: bytes, plaintext: bytes) -> tuple[bytes, bytes]:
    nonce = os.urandom(_GCM_NONCE_BYTES)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    return nonce, ct


def _aesgcm_unwrap(key: bytes, nonce: bytes, ct: bytes) -> bytes:
    try:
        return AESGCM(key).decrypt(nonce, ct, None)
    except InvalidTag as e:
        raise WrongCredential("That PIN doesn't match.") from e


# --- Setup ------------------------------------------------------------------


def setup_with_pin(pin: str) -> None:
    if is_set_up():
        raise VaultError("The vault is already set up.")
    if len(pin) < 4:
        raise VaultError("Choose a PIN of at least 4 digits.")
    vault_key = os.urandom(VAULT_KEY_BYTES)
    salt = os.urandom(_SCRYPT_SALT_BYTES)
    wrap_key = _scrypt_key(pin, salt)
    nonce, wrapped = _aesgcm_wrap(wrap_key, vault_key)
    _key_path().write_text(
        json.dumps(
            {
                "method": "pin",
                "salt": salt.hex(),
                "nonce": nonce.hex(),
                "wrapped": wrapped.hex(),
            }
        )
    )


def setup_with_windows_account(password: str, username: Optional[str] = None) -> None:
    if is_set_up():
        raise VaultError("The vault is already set up.")
    username = username or current_windows_username()
    if not verify_windows_password(username, password):
        raise WrongCredential("That's not the current Windows account password.")
    vault_key = os.urandom(VAULT_KEY_BYTES)
    wrapped = dpapi_protect(vault_key)
    _key_path().write_text(json.dumps({"method": "dpapi", "username": username, "wrapped": wrapped.hex()}))


# --- Unlocking the vault key -------------------------------------------------


def unlock_vault_key(*, pin: Optional[str] = None, windows_password: Optional[str] = None) -> bytes:
    """The one function everything else in this module needs: given
    whichever credential matches how the vault was set up, returns the raw
    32-byte vault key - or raises WrongCredential / NotSetUp. Both the
    identity check (verify_windows_password) and the cryptographic unwrap
    (dpapi_unprotect) have to succeed for the dpapi method; either one
    failing is reported the same way, on purpose (see dpapi_unprotect)."""
    p = _key_path()
    if not p.exists():
        raise NotSetUp("Your Eyes Only hasn't been set up yet.")
    data = json.loads(p.read_text())
    method = data["method"]

    if method == "pin":
        if pin is None:
            raise VaultError("A PIN is required.")
        salt = bytes.fromhex(data["salt"])
        nonce = bytes.fromhex(data["nonce"])
        wrapped = bytes.fromhex(data["wrapped"])
        wrap_key = _scrypt_key(pin, salt)
        return _aesgcm_unwrap(wrap_key, nonce, wrapped)

    if method == "dpapi":
        if windows_password is None:
            raise VaultError("Your Windows password is required.")
        username = data["username"]
        # Fresh re-check first, even though DPAPI would also fail for the
        # wrong account on its own - this is the specific line of defense
        # against a stranger who's already sitting in an unlocked, already-
        # logged-in session: being logged in proves nothing here, typing
        # the right password does.
        if not verify_windows_password(username, windows_password):
            raise WrongCredential("That's not the current Windows account password.")
        return dpapi_unprotect(bytes.fromhex(data["wrapped"]))

    raise VaultError(f"Unknown vault method: {method!r}")


# --- Per-file locking (the actual "move it into the vault" mechanics) -----

import time


@dataclass
class VaultEntry:
    id: str
    original_path: str
    original_filename: str
    size: int
    locked_at: float
    reasons: List[str] = field(default_factory=list)  # Finding.kind values from sensitive.py
    # True for a whole locked FOLDER (see lock_file below) rather than a
    # single file - changes how the blob is packed/unpacked (zip archive vs
    # raw bytes) but nothing about the manifest/encryption around it.
    # Defaults False so old manifests written before this field existed
    # (every entry in them necessarily a file) still load correctly - a
    # missing key just falls back to this default via VaultEntry(**item).
    is_folder: bool = False


def _legacy_dir_for(root: Path) -> Path:
    # Where vaults used to live: inside the folder the file was locked from.
    # That meant deleting, moving or renaming that folder silently destroyed
    # everything locked from it.
    return root / ".smartsearch" / "vault"


def _store_dir_for(root: Path) -> Path:
    # Where they live now: next to the vault key in the app's own data folder,
    # keyed by the folder they were locked from. Nothing the person does to
    # their own folders can reach it - a locked file leaves only when they
    # restore it.
    key = hashlib.sha1(os.path.normcase(str(root.resolve())).encode("utf-8")).hexdigest()[:20]
    return _appdata_dir() / "store" / key


def _migrate_legacy(root: Path) -> None:
    """Moves a vault found inside a folder (the old layout) into the central
    store. Copy, verify the size, and only then remove the original, so an
    interruption can never lose a file."""
    legacy = _legacy_dir_for(root)
    if not legacy.is_dir():
        return
    dest = _store_dir_for(root)
    dest.mkdir(parents=True, exist_ok=True)
    for f in list(legacy.iterdir()):
        if not f.is_file():
            continue
        target = dest / f.name
        if not target.exists() or target.stat().st_size != f.stat().st_size:
            shutil.copy2(f, target)
        if target.stat().st_size == f.stat().st_size:
            f.unlink()
    try:
        legacy.rmdir()
    except OSError:
        pass


def _vault_dir_for(root: Path) -> Path:
    _migrate_legacy(root)
    d = _store_dir_for(root)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _manifest_path(root: Path) -> Path:
    return _vault_dir_for(root) / "manifest.enc"


def _blob_path(root: Path, entry_id: str) -> Path:
    return _vault_dir_for(root) / f"{entry_id}.enc"


def _read_manifest(vault_key: bytes, root: Path) -> List[VaultEntry]:
    # Look without creating anything: reading a folder that never had a vault
    # must not leave an empty .smartsearch/vault behind in it.
    if _legacy_dir_for(root).is_dir():
        _migrate_legacy(root)
    p = _store_dir_for(root) / "manifest.enc"
    if not p.exists():
        return []
    raw = p.read_bytes()
    nonce, ct = raw[:_GCM_NONCE_BYTES], raw[_GCM_NONCE_BYTES:]
    try:
        plaintext = AESGCM(vault_key).decrypt(nonce, ct, None)
    except InvalidTag as e:
        # Wrong key for this manifest - should only happen if vault_key.json
        # and a root's manifest.enc somehow came from different setups
        # (e.g. the appdata dir was reset but old vault folders were kept).
        # Surfaced distinctly from WrongCredential (that's for a bad PIN/
        # password at the identity-check layer, already passed by the time
        # we get here) rather than silently returning an empty list, which
        # would look like "nothing's locked" when really something is, just
        # unreadable with this key.
        raise VaultError("This folder's vault doesn't match the current vault key.") from e
    return [VaultEntry(**item) for item in json.loads(plaintext)]


def _write_manifest(vault_key: bytes, root: Path, entries: List[VaultEntry]) -> None:
    plaintext = json.dumps([e.__dict__ for e in entries]).encode("utf-8")
    nonce, ct = _aesgcm_wrap(vault_key, plaintext)
    _manifest_path(root).write_bytes(nonce + ct)


# --- every folder that holds a vault -------------------------------------
# A vault lives inside whichever folder the file was locked from
# (<folder>/.smartsearch/vault), so "Your Eyes Only" used to show a different
# list depending on which folder happened to be open. The app-level registry
# below remembers every such folder so the view can show all of them at once.

def _registry_path() -> Path:
    return _appdata_dir() / "vault_roots.json"


def _is_decrypted_temp(root: Path) -> bool:
    # Never treat the folder a locked folder is temporarily decrypted into as
    # a place that holds a vault.
    return "smartexplorer-vault" in {part.lower() for part in root.parts}


def _has_vault(root: Path) -> bool:
    return (_store_dir_for(root) / "manifest.enc").exists() or (
        _legacy_dir_for(root) / "manifest.enc"
    ).exists()


def _load_registry() -> List[str]:
    try:
        data = json.loads(_registry_path().read_text(encoding="utf-8"))
        return [str(x) for x in data] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def register_root(root: Path) -> None:
    root = root.resolve()
    if _is_decrypted_temp(root):
        return
    current = _load_registry()
    norm = {os.path.normcase(r) for r in current}
    if os.path.normcase(str(root)) in norm:
        return
    current.append(str(root))
    try:
        _registry_path().write_text(json.dumps(current), encoding="utf-8")
    except OSError:
        pass  # best effort - the view still falls back to the folders it is told about


def known_roots(extra: Optional[List[Path]] = None) -> List[Path]:
    """Every folder known to hold a vault: the registry, plus any of `extra`
    (folders the app has seen) that turn out to have one - those get added to
    the registry, so vaults created before it existed are found once and then
    remembered."""
    found: List[Path] = []
    seen: set = set()

    def consider(raw, must_exist: bool) -> None:
        try:
            r = Path(raw).expanduser().resolve()
        except OSError:
            return
        key = os.path.normcase(str(r))
        if key in seen or _is_decrypted_temp(r) or not _has_vault(r):
            return
        if must_exist and not r.is_dir():
            return
        seen.add(key)
        found.append(r)

    # A registered folder keeps its locked files even if the folder itself
    # was later deleted, moved or renamed.
    for raw in _load_registry():
        consider(raw, False)
    for raw in extra or []:
        before = len(found)
        consider(raw, True)
        if len(found) > before:
            register_root(found[-1])
    return found


def lock_file(vault_key: bytes, root: Path, file_path: Path, reasons: List[str]) -> VaultEntry:
    """Encrypts file_path's current bytes into the vault and deletes the
    original - the file is genuinely gone from its normal location from
    this point on, not just hidden by a UI filter. Caller (the sensitive
    scan, or a manual \"lock this file\" action) has already decided this
    file should move; this function doesn't re-check anything, the same
    division of responsibility duplicates.py uses between finding a group
    and the explicit delete action.

    file_path can also be a whole FOLDER - the only caller that can ever
    pass one is the manual "send this in" action (the automatic sensitive-
    content scan only ever finds individual flagged files). A folder is
    zipped into one encrypted blob first, preserving its internal structure
    (restore_file reverses this), then the original directory tree is
    removed the same way a single file's original is. Known gap: an empty
    subfolder inside a locked folder isn't preserved on restore - zip
    archives don't record empty directories unless added as their own
    explicit entry, which this doesn't bother doing for a personal file
    vault's sake."""
    is_folder = file_path.is_dir()
    if is_folder:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for child in file_path.rglob("*"):
                if child.is_file():
                    zf.write(child, child.relative_to(file_path))
        data = buf.getvalue()
    else:
        data = file_path.read_bytes()
    nonce, ct = _aesgcm_wrap(vault_key, data)
    entry = VaultEntry(
        id=uuid.uuid4().hex,
        original_path=str(file_path),
        original_filename=file_path.name,
        size=len(data),
        locked_at=time.time(),
        reasons=list(reasons),
        is_folder=is_folder,
    )
    _blob_path(root, entry.id).write_bytes(nonce + ct)

    entries = _read_manifest(vault_key, root)
    entries.append(entry)
    _write_manifest(vault_key, root, entries)
    register_root(root)

    if is_folder:
        shutil.rmtree(file_path)
    else:
        file_path.unlink()
    return entry


def list_vault(vault_key: bytes, root: Path) -> List[VaultEntry]:
    return _read_manifest(vault_key, root)


def _decrypt_entry(vault_key: bytes, root: Path, entry: VaultEntry) -> bytes:
    raw = _blob_path(root, entry.id).read_bytes()
    nonce, ct = raw[:_GCM_NONCE_BYTES], raw[_GCM_NONCE_BYTES:]
    try:
        return AESGCM(vault_key).decrypt(nonce, ct, None)
    except InvalidTag as e:
        raise VaultError(f"Couldn't decrypt {entry.original_filename} - its vault blob may be corrupt.") from e


def _find_entry(entries: List[VaultEntry], entry_id: str) -> VaultEntry:
    for e in entries:
        if e.id == entry_id:
            return e
    raise VaultError("No such vaulted file.")


def unlock_to_temp(vault_key: bytes, root: Path, entry_id: str, tmp_dir: Path) -> Path:
    """Decrypts one entry to a fresh temp file named after the ORIGINAL
    filename (not the opaque entry id), so the OS opens it with the right
    default app and the person sees its real name - and deletes it again.
    Cleanup is the caller's job (see vault.py's module docstring): this
    function hands back a path, it doesn't track or time out the copy
    itself, since knowing when the associated app is done with it is an OS/
    Electron-level concern, not this module's."""
    entries = _read_manifest(vault_key, root)
    entry = _find_entry(entries, entry_id)
    data = _decrypt_entry(vault_key, root, entry)

    tmp_dir.mkdir(parents=True, exist_ok=True)
    # Prefixed with the entry id so two different vaulted files that happen
    # to share a filename can't collide in the same temp dir.
    out_path = tmp_dir / f"{entry.id}_{entry.original_filename}"
    if entry.is_folder:
        # Extracted into a real temp folder rather than written as a
        # single file - Electron's shell.openPath opens a directory in
        # Explorer the same way it opens a file with its default app, so
        # the caller needs no folder-vs-file branch of its own for this.
        out_path.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.extractall(out_path)
    else:
        out_path.write_bytes(data)
    return out_path


def _available_restore_path(original_path: Path) -> Path:
    """Same '-2, -3, ...' convention main.py's _next_available_stem already
    uses elsewhere in this app, reimplemented locally rather than imported -
    main.py imports this module, so the reverse import would be circular."""
    if not original_path.exists():
        return original_path
    stem, suffix, parent = original_path.stem, original_path.suffix, original_path.parent
    n = 2
    while True:
        candidate = parent / f"{stem}-{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def restore_file(vault_key: bytes, root: Path, entry_id: str, dest_dir: Optional[Path] = None) -> Path:
    """Permanently decrypts an entry back to disk and removes it from the
    vault - the deliberate \"I checked, this one didn't need to be locked\"
    action for a false positive, or just \"I'm done hiding this.\" Unlike
    unlock_to_temp, nothing about this is temporary: the vault blob and its
    manifest entry are gone afterward.

    By default restores to (or near) the file's original path. If dest_dir
    is given instead - a folder the person drag-and-dropped the vault entry
    onto (a Sidebar row, a Breadcrumb segment, a FileGrid directory tile) -
    restores there under the entry's original filename instead. Either way
    goes through the same _available_restore_path collision-avoidance, and
    either way this is called, the credential check that produced vault_key
    must have just happened fresh (see the session-key-cache note below) -
    restoring to a new, arbitrary folder is no looser a bar than restoring
    to the original one."""
    entries = _read_manifest(vault_key, root)
    entry = _find_entry(entries, entry_id)
    data = _decrypt_entry(vault_key, root, entry)

    candidate = (dest_dir / entry.original_filename) if dest_dir is not None else Path(entry.original_path)
    restore_path = _available_restore_path(candidate)
    restore_path.parent.mkdir(parents=True, exist_ok=True)
    if entry.is_folder:
        restore_path.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.extractall(restore_path)
    else:
        restore_path.write_bytes(data)

    _blob_path(root, entry.id).unlink(missing_ok=True)
    remaining = [e for e in entries if e.id != entry_id]
    _write_manifest(vault_key, root, remaining)

    return restore_path


# --- Session key cache ------------------------------------------------------
#
# Two different bars, on purpose:
#   - "unlocked for this session" (_session_key) - set once by /vault/unlock,
#     good for the rest of the app's run. Required just to SEE what's in
#     Your Eyes Only (filenames, reasons) - browsing the list shouldn't
#     demand retyping a PIN/password every few seconds, but it still
#     shouldn't be visible to someone who never unlocked it at all this
#     session.
#   - a FRESH check (unlock_vault_key called again, right then, with the
#     credential typed again) - required to actually decrypt one file's
#     real content (unlock_to_temp) or restore_file it back out of the
#     vault. The session cache is never substituted for this, even if it's
#     already populated - that's the specific point of the whole feature:
#     an already-logged-in session proves nothing on its own.
#
# Locking a NEWLY flagged file is a third, looser case: encrypting data
# INTO the vault discloses nothing to anyone, so it only needs a key to
# exist at all, from whichever source is available right now (the session
# cache, or - for the dpapi method specifically - a silent, no-prompt
# DPAPI unwrap, since DPAPI already ties that to the correct Windows
# profile with no password needed). See get_key_for_locking.

_session_key: Optional[bytes] = None
_session_lock = threading.Lock()


def set_session_key(key: bytes) -> None:
    global _session_key
    with _session_lock:
        _session_key = key


def clear_session_key() -> None:
    global _session_key
    with _session_lock:
        _session_key = None


def is_unlocked_for_session() -> bool:
    with _session_lock:
        return _session_key is not None


def get_key_for_locking() -> Optional[bytes]:
    """A key usable for ENCRYPTING a newly-flagged file into the vault right
    now, without necessarily prompting anyone - or None if there's truly
    nothing available (not set up yet, or a PIN vault nobody has unlocked
    this session). See the section comment above for why this is allowed
    to be looser than opening/restoring."""
    with _session_lock:
        if _session_key is not None:
            return _session_key

    if vault_method() == "dpapi":
        try:
            data = json.loads(_key_path().read_text())
            return dpapi_unprotect(bytes.fromhex(data["wrapped"]))
        except VaultError:
            return None
    return None
