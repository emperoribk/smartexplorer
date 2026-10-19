import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ipcMain, shell } from "electron";

/**
 * Opening a decrypted "Your Eyes Only" file (see vault.py's /vault/open)
 * leaves a real plaintext copy sitting in the OS temp folder for as long
 * as whatever app opened it needs - that's unavoidable, since there's no
 * way to hand a PDF/Word viewer a file it can read without it existing as
 * a real file somewhere. What this module does is keep that window as
 * short as it reasonably can:
 *   - every temp copy gets a scheduled best-effort delete a few minutes
 *     after being opened, not just "whenever the app happens to clean up"
 *   - every temp copy still sitting around also gets swept on app launch
 *     (covering a crash/force-quit that skipped its own scheduled delete)
 *     and again on quit
 * This is deliberately NOT a guarantee - if someone's PDF viewer is still
 * open and holding the file when the timer fires, the delete can fail (and
 * is allowed to fail silently) depending on the OS; the real protection is
 * that the file never existed unencrypted until the person re-entered
 * their PIN/password a moment ago, not this cleanup. Same honesty-over-
 * false-security spirit as vault.py's module docstring.
 */

// Must match main.py's post_vault_open: Path(tempfile.gettempdir()) /
// "smartexplorer-vault". Re-derived here (not passed over IPC) so a
// renderer talking to a compromised/different backend can't point this
// handler at deleting something outside that one folder.
const VAULT_TEMP_DIR = path.join(os.tmpdir(), "smartexplorer-vault");

const DELETE_AFTER_MS = 10 * 60 * 1000; // 10 minutes
const pendingDeletes = new Map<string, NodeJS.Timeout>();

export function isInsideVaultTempDir(target: string): boolean {
  if (typeof target !== "string" || !target) return false;
  let resolved = path.resolve(target);
  let dir = path.resolve(VAULT_TEMP_DIR) + path.sep;
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
    dir = dir.toLowerCase();
  }
  return resolved.startsWith(dir);
}

async function bestEffortDelete(target: string): Promise<void> {
  try {
    // recursive+force so this works the same whether target is a single
    // decrypted temp file or a whole temp folder (a locked FOLDER's
    // "Open"/unlock_to_temp extracts into a directory here instead of
    // writing one file - see vault.py's unlock_to_temp) - plain unlink()
    // would throw EISDIR on a directory and leak it on every cleanup pass.
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Already gone, or still open elsewhere, or permissions - this is a
    // best-effort cleanup pass, not a step anything else depends on.
  }
}

function scheduleDelete(target: string) {
  const existing = pendingDeletes.get(target);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingDeletes.delete(target);
    void bestEffortDelete(target);
  }, DELETE_AFTER_MS);
  pendingDeletes.set(target, timer);
}

/** Best-effort sweep of every leftover decrypted temp file - called once
 *  on app startup (covers a previous run that crashed/was force-quit
 *  before its own scheduled deletes fired) and again on quit. Deletes the
 *  whole smartexplorer-vault temp directory's contents; harmless if it
 *  doesn't exist or is already empty. */
export async function sweepVaultTempDir(): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(VAULT_TEMP_DIR);
  } catch {
    return; // Doesn't exist yet - nothing to sweep.
  }
  await Promise.all(names.map((name) => bestEffortDelete(path.join(VAULT_TEMP_DIR, name))));
}

export function registerVaultHandlers() {
  // Opens a decrypted vault temp file with its normal default app (same
  // mechanism as the existing fs:openPath) and schedules its cleanup. The
  // renderer only ever has a temp_path to pass here because it got it
  // back from the backend's own /vault/open response a moment earlier.
  ipcMain.handle("vault:openTemp", async (_event, tempPath: string) => {
    if (!isInsideVaultTempDir(tempPath)) {
      throw new Error("Refusing to open a path outside the vault's own temp folder.");
    }
    await shell.openPath(tempPath);
    scheduleDelete(tempPath);
  });

  // A locked FOLDER is browsed inside SmartExplorer itself (so it works even
  // with no Windows Explorer), which means its decrypted copy has to stay put
  // for as long as the person has a tab open on it - the 10-minute timer used
  // for single files would pull the folder out from under them. The renderer
  // calls this the moment no tab is inside that folder any more; any pending
  // timer for it is cancelled and the whole folder is deleted right away.
  // (Quit/startup sweeps remain the backstop if the app dies first.)
  ipcMain.handle("vault:releaseTemp", async (_event, tempPath: string) => {
    if (!isInsideVaultTempDir(tempPath)) {
      throw new Error("Refusing to delete a path outside the vault's own temp folder.");
    }
    const timer = pendingDeletes.get(tempPath);
    if (timer) {
      clearTimeout(timer);
      pendingDeletes.delete(tempPath);
    }
    await bestEffortDelete(tempPath);
  });
}
