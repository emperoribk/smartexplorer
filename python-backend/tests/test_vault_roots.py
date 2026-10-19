"""Your Eyes Only lists every folder's vault together, not just the open one."""
import os
from pathlib import Path

import pytest

pytest.importorskip("cryptography")

from app import vault  # noqa: E402


@pytest.fixture()
def appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("SMARTSEARCH_APPDATA", str(tmp_path / "appdata"))
    return tmp_path


def test_known_roots_spans_folders_and_survives_without_registry(appdata):
    key = os.urandom(32)
    a, b = appdata / "Documents", appdata / "Documents" / "Work"
    b.mkdir(parents=True)
    fa, fb = a / "ssn.txt", b / "card.txt"
    fa.write_text("111-22-3333")
    fb.write_text("4111 1111 1111 1111")

    vault.lock_file(key, a, fa, ["ssn"])
    vault.lock_file(key, b, fb, ["card"])

    roots = {str(r) for r in vault.known_roots()}
    assert roots == {str(a.resolve()), str(b.resolve())}

    # Vaults made before the registry existed are found via the folders the
    # app has seen, then remembered.
    vault._registry_path().unlink()
    assert vault.known_roots() == []
    assert {str(r) for r in vault.known_roots([a, b, appdata / "nope"])} == roots
    assert {str(r) for r in vault.known_roots()} == roots


def test_listing_a_folder_without_a_vault_creates_nothing(appdata):
    key = os.urandom(32)
    plain = appdata / "plain"
    plain.mkdir()
    assert vault.list_vault(key, plain) == []
    assert not (plain / ".smartsearch").exists()
    assert not vault._store_dir_for(plain).exists()


def test_decrypted_temp_folders_are_never_registered(appdata):
    tmp = appdata / "smartexplorer-vault" / "abc_Folder"
    tmp.mkdir(parents=True)
    vault.register_root(tmp)
    assert vault._load_registry() == []


def test_locked_files_survive_the_folder_being_deleted_and_restore_later(appdata):
    import shutil

    key = os.urandom(32)
    folder = appdata / "Taxes"
    folder.mkdir()
    f = folder / "return.txt"
    f.write_text("secret")
    entry = vault.lock_file(key, folder, f, ["ssn"])

    shutil.rmtree(folder)  # the person deletes or moves the whole folder

    roots = vault.known_roots()
    assert len(roots) == 1
    assert [e.id for e in vault.list_vault(key, roots[0])] == [entry.id]
    restored = vault.restore_file(key, roots[0], entry.id)
    assert restored.read_text() == "secret"
    assert vault.list_vault(key, roots[0]) == []


def test_old_in_folder_vaults_are_moved_into_the_store_without_loss(appdata):
    key = os.urandom(32)
    folder = appdata / "Old"
    folder.mkdir()
    f = folder / "a.txt"
    f.write_text("hello")
    entry = vault.lock_file(key, folder, f, ["card"])

    # Recreate the old layout: put the store's files back inside the folder.
    legacy = folder / ".smartsearch" / "vault"
    legacy.mkdir(parents=True)
    store = vault._store_dir_for(folder)
    for item in store.iterdir():
        item.rename(legacy / item.name)

    entries = vault.list_vault(key, folder)  # triggers the migration
    assert [e.id for e in entries] == [entry.id]
    assert not legacy.exists() or not any(legacy.iterdir())
    assert vault.restore_file(key, folder, entry.id).read_text() == "hello"
