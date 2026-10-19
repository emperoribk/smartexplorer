/**
 * File-system access for the renderer, exposed only through IPC (the
 * renderer itself has no Node/fs access - see preload.ts). This is what
 * powers plain folder browsing (as opposed to indexed search, which goes
 * through the Python backend).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { app, dialog, ipcMain, shell, BrowserWindow } from "electron";

const exec = promisify(execCallback);

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isVideo: boolean;
  isImage: boolean;
  isPdf: boolean;
  isDocument: boolean;
  isInstaller: boolean;
  isArchive: boolean;
  size: number;
  mtimeMs: number;
}

const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".wmv", ".flv", ".mpg", ".mpeg",
]);
const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg", ".heic", ".heif", ".ico",
]);
const PDF_EXTS = new Set([".pdf"]);
// Everything else "document"-shaped, kept separate from PDFs so the UI can
// give PDFs their own distinct look.
const DOCUMENT_EXTS = new Set([
  ".doc", ".docx", ".rtf", ".odt",
  ".xls", ".xlsx", ".ods", ".csv",
  ".ppt", ".pptx", ".odp",
  ".txt", ".md",
]);
// Real installers - the kind of file someone browsing their Downloads
// folder actually wants to see - as opposed to shortcuts, config files,
// and other OS clutter that "show all files" is for.
const INSTALLER_EXTS = new Set([".exe", ".msi", ".msix", ".dmg", ".pkg", ".appimage"]);
// .zip specifically (not .rar/.7z/etc, which this app can't act on anyway)
// used to fall under "archives, etc." below and stay hidden by default -
// fine for a stray archive someone's Downloads folder already had sitting
// in it, but this app's own "Compress to ZIP" context-menu action creates
// one of these directly, and silently hiding the file you just asked the
// app to create looks exactly like the action did nothing. The file this
// app's own "Extract" action needs you to be able to right-click has the
// same problem in reverse. So .zip gets promoted out of "clutter" and
// always shown, the same reasoning as installers above.
const ARCHIVE_EXTS = new Set([".zip"]);

// The grid's default view is meant to surface content worth searching or
// previewing - photos, videos, PDFs, documents, installers, and zips - not
// every stray file a folder happens to contain. Anything else (Windows
// shortcut .lnk files, config/system files, other archive formats, etc.) is
// left out of the default view, but can be revealed with the "show all
// files" toggle.
const ALLOWED_EXTS = new Set<string>([
  ...VIDEO_EXTS,
  ...IMAGE_EXTS,
  ...PDF_EXTS,
  ...DOCUMENT_EXTS,
  ...INSTALLER_EXTS,
  ...ARCHIVE_EXTS,
]);

async function listDir(dirPath: string, showAllFiles: boolean): Promise<DirEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: DirEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // hide dotfiles/.smartsearch index dir
    const isDirectory = entry.isDirectory();
    const ext = path.extname(entry.name).toLowerCase();
    // Folders are always shown so browsing still works normally; files are
    // filtered down to the "important" kinds unless the toggle is on.
    if (!isDirectory && !showAllFiles && !ALLOWED_EXTS.has(ext)) continue;

    const full = path.join(dirPath, entry.name);
    try {
      const stat = await fs.stat(full);
      results.push({
        name: entry.name,
        path: full,
        isDirectory,
        isVideo: VIDEO_EXTS.has(ext),
        isImage: IMAGE_EXTS.has(ext),
        isPdf: PDF_EXTS.has(ext),
        isDocument: DOCUMENT_EXTS.has(ext),
        isInstaller: INSTALLER_EXTS.has(ext),
        isArchive: ARCHIVE_EXTS.has(ext),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // File vanished or is inaccessible mid-listing (permissions, etc.) - skip it.
    }
  }

  results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return results;
}

/** Same kind-sniffing/stat logic listDir uses, but for one arbitrary path
 *  rather than a whole directory - used to build GridItems for paths that
 *  don't come from a directory listing (e.g. "recent files", which can span
 *  many different folders). Returns null rather than throwing when the
 *  path no longer exists (moved, renamed, deleted since it was last opened)
 *  so callers can just drop it instead of surfacing an error for something
 *  that isn't really a failure. */
async function statOne(fullPath: string): Promise<DirEntry | null> {
  try {
    const stat = await fs.stat(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    return {
      name: path.basename(fullPath),
      path: fullPath,
      isDirectory: stat.isDirectory(),
      isVideo: VIDEO_EXTS.has(ext),
      isImage: IMAGE_EXTS.has(ext),
      isPdf: PDF_EXTS.has(ext),
      isDocument: DOCUMENT_EXTS.has(ext),
      isInstaller: INSTALLER_EXTS.has(ext),
      isArchive: ARCHIVE_EXTS.has(ext),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export interface SpecialFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  videos: string;
}

function getSpecialFolders(): SpecialFolders {
  // app.getPath falls back gracefully (e.g. to home) for a folder that
  // doesn't exist on a given OS/config, so this is safe cross-platform.
  const pick = (name: Parameters<typeof app.getPath>[0]) => {
    try {
      return app.getPath(name);
    } catch {
      return app.getPath("home");
    }
  };
  return {
    home: pick("home"),
    desktop: pick("desktop"),
    documents: pick("documents"),
    downloads: pick("downloads"),
    pictures: pick("pictures"),
    videos: pick("videos"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Finds a free name in destDir for baseName, appending " (2)", " (3)", etc.
 *  before the extension if something's already there - the same convention
 *  every desktop file manager uses for copy/paste collisions. Exported so
 *  zipBridge.ts can reuse it for a new zip's name / an extract folder's
 *  name, rather than reimplementing the same collision convention again. */
export async function uniqueDestPath(destDir: string, baseName: string): Promise<string> {
  let candidate = path.join(destDir, baseName);
  if (!(await pathExists(candidate))) return candidate;

  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  for (let n = 2; ; n++) {
    candidate = path.join(destDir, `${stem} (${n})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

export function registerFsHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("fs:listDir", async (_event, dirPath: string, showAllFiles?: boolean) => {
    return listDir(dirPath, !!showAllFiles);
  });

  ipcMain.handle("fs:homeDir", async () => {
    return os.homedir();
  });

  ipcMain.handle("fs:specialFolders", async () => {
    return getSpecialFolders();
  });

  // Stats an arbitrary list of paths (as opposed to listDir's whole-folder
  // listing) - used to turn a "recent files" list of bare paths (which can
  // span many different folders, some possibly no longer there) into the
  // same DirEntry shape the file grid already knows how to render.
  // Silently drops any path that no longer resolves rather than failing
  // the whole batch - the caller (App.tsx's loadHomeRecent) uses which
  // paths came back to prune its own recent-files list too.
  ipcMain.handle("fs:statPaths", async (_event, paths: string[]) => {
    const results: DirEntry[] = [];
    for (const p of paths) {
      const entry = await statOne(p);
      if (entry) results.push(entry);
    }
    return results;
  });

  // Free/total space for the drive a given path lives on (defaults to the
  // home folder's drive) - powers the "Local Disk (C:)" bar in the
  // sidebar, the same thing File Explorer's "This PC" page shows.
  // fs.statfs (Node 18.15+) is used instead of a Windows-only command so
  // this works the same way on macOS/Linux too.
  ipcMain.handle("fs:diskUsage", async (_event, forPath?: string) => {
    const target = forPath || getSpecialFolders().home;
    const root = path.parse(target).root || target;
    const stat = await fs.statfs(root);
    const total = stat.blocks * stat.bsize;
    // bavail (space available to the current, non-root user), not bfree -
    // it's the number that actually matches what the OS itself reports as
    // "free space" in these situations.
    const free = stat.bavail * stat.bsize;
    const label =
      process.platform === "win32" ? `Local Disk (${root.replace(/[\\/]+$/, "")})` : root;
    return { total, free, label, root };
  });

  ipcMain.handle("fs:pickFolder", async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("fs:openPath", async (_event, targetPath: string) => {
    const { shell } = await import("electron");
    await shell.openPath(targetPath);
  });

  ipcMain.handle("fs:showInFolder", async (_event, targetPath: string) => {
    const { shell } = await import("electron");
    shell.showItemInFolder(targetPath);
  });

  // Opens a URL in the person's real, default browser (never inside the
  // app window) - used for the one-off "go install Tesseract" link when OCR
  // isn't available, so it behaves like a normal link rather than
  // navigating this Electron window away from the app.
  ipcMain.handle("fs:openExternal", async (_event, url: string) => {
    const { shell } = await import("electron");
    await shell.openExternal(url);
  });

  // --- file management: rename, delete (to the OS trash/recycle bin),
  // new folder, and copy/cut+paste ---

  // Windows briefly holds an exclusive lock on a file that was just read -
  // the backend extracting a PDF/OCR's text for the search index
  // (query_parse.py/extract.py), an antivirus scan, a thumbnail generator -
  // and a rename that lands in that narrow window fails with EBUSY
  // ("resource busy or locked") even though nothing is actually wrong. A
  // short retry with a growing wait gives that lock a moment to clear
  // (capped so one stubborn file can't hang the UI indefinitely) instead of
  // surfacing a scary error for what's usually gone within a couple of
  // seconds. If it's STILL locked after ~10s of retrying, that's no longer
  // "briefly busy" - something is holding the file open the whole time
  // (most often the file itself open in a PDF/photo viewer, a browser tab,
  // or Explorer's own preview pane), so the error is rethrown with a
  // plainer explanation instead of Node's raw EBUSY message.
  async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await fs.rename(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EBUSY" && code !== "EPERM") throw err;
        if (i === attempts - 1) {
          const lockingApp = await guessLockingApp(from);
          const openedWhere = lockingApp
            ? `open in ${lockingApp}`
            : "open somewhere else (a viewer, a browser tab, or a preview pane)";
          throw new Error(`"${path.basename(from)}" is ${openedWhere} and can't be renamed until it's closed.`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** i, 2000)));
      }
    }
  }

  // Node has no built-in "which process has this file open" - that needs
  // either a native module (risks the exact compiler problem this app just
  // worked around for the chat feature, see chat.py) or shelling out to
  // Windows' Restart Manager API. Cheaper and dependency-free: ask Windows
  // what program that FILE TYPE opens with by default (assoc/ftype, both
  // built into cmd.exe on every Windows install). Not a live look at what
  // actually holds the lock right now - a file opened once via "Open with
  // -> something else" would still report its usual default here - but the
  // file's own default handler catches the overwhelming majority of real
  // cases (the person opened it the normal way, from this app or Explorer),
  // and a good guess beats a raw EBUSY dump.
  async function guessLockingApp(filePath: string): Promise<string | null> {
    if (process.platform !== "win32") return null;
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return null;
    try {
      const { stdout: assocOut } = await exec(`cmd.exe /c assoc ${ext}`);
      const progId = assocOut.split("=")[1]?.trim();
      if (!progId) return null;
      const { stdout: ftypeOut } = await exec(`cmd.exe /c ftype ${progId}`);
      const match = /"([^"]+\.exe)"/i.exec(ftypeOut);
      if (!match) return null;
      return friendlyAppName(match[1]);
    } catch {
      return null;
    }
  }

  const KNOWN_APP_NAMES: Record<string, string> = {
    acrord32: "Adobe Acrobat Reader",
    acrobat: "Adobe Acrobat",
    wpspdf: "WPS Office",
    wpsoffice: "WPS Office",
    wps: "WPS Office",
    et: "WPS Office", // WPS's spreadsheet module ships as et.exe
    wpp: "WPS Office", // WPS's presentation module ships as wpp.exe
    msedge: "Microsoft Edge",
    chrome: "Google Chrome",
    firefox: "Mozilla Firefox",
    winword: "Microsoft Word",
    excel: "Microsoft Excel",
    powerpnt: "Microsoft PowerPoint",
    photos: "the Photos app",
    sumatrapdf: "SumatraPDF",
    foxitreader: "Foxit Reader",
    foxitphantompdf: "Foxit PDF Editor",
  };

  function friendlyAppName(exePath: string): string {
    const base = path.basename(exePath, ".exe").toLowerCase();
    for (const key of Object.keys(KNOWN_APP_NAMES)) {
      if (base === key || base.includes(key)) return KNOWN_APP_NAMES[key];
    }
    // Not a program we recognize by name - still more useful than nothing,
    // so show its own executable name rather than falling back to "somewhere else".
    return base.replace(/[-_]+/g, " ");
  }

  ipcMain.handle("fs:rename", async (_event, targetPath: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error("That's not a valid name.");
    }
    // Only the characters the filesystem itself can't store in a name at
    // all - path separators, plus Windows' handful of reserved punctuation
    // (":*?\"<>|", plus control characters) since this app also has to run
    // there even when developed/tested elsewhere. Ordinary Unicode text -
    // accented letters, other scripts, emoji - is completely unrestricted;
    // a modern filesystem (NTFS, APFS, ext4) stores those as fine as ASCII.
    // eslint-disable-next-line no-control-regex
    const invalidChars = /[/\\:*?"<>|\x00-\x1f]/;
    const match = trimmed.match(invalidChars);
    if (match) {
      throw new Error(`A file name can't contain ${match[0]}`);
    }
    const destPath = path.join(path.dirname(targetPath), trimmed);
    if (destPath === targetPath) return destPath;
    if (await pathExists(destPath)) {
      throw new Error(`"${trimmed}" already exists here.`);
    }
    await renameWithRetry(targetPath, destPath);
    return destPath;
  });

  ipcMain.handle("fs:delete", async (_event, targetPaths: string[]) => {
    // Moves to the OS trash/recycle bin rather than deleting outright - one
    // wrong click shouldn't be unrecoverable.
    for (const p of targetPaths) {
      await shell.trashItem(p);
    }
  });

  ipcMain.handle("fs:newFolder", async (_event, dirPath: string) => {
    const dest = await uniqueDestPath(dirPath, "New folder");
    await fs.mkdir(dest);
    return dest;
  });

  ipcMain.handle("fs:copyItems", async (_event, sourcePaths: string[], destDir: string) => {
    const results: string[] = [];
    for (const src of sourcePaths) {
      const dest = await uniqueDestPath(destDir, path.basename(src));
      await copyRecursive(src, dest);
      results.push(dest);
    }
    return results;
  });

  ipcMain.handle("fs:moveItems", async (_event, sourcePaths: string[], destDir: string) => {
    const results: string[] = [];
    for (const src of sourcePaths) {
      if (path.dirname(src) === destDir) {
        results.push(src); // already here - nothing to do
        continue;
      }
      const dest = await uniqueDestPath(destDir, path.basename(src));
      try {
        await fs.rename(src, dest);
      } catch (err: unknown) {
        // Moving across drives fails with EXDEV - fall back to copy+delete.
        if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
          await copyRecursive(src, dest);
          await fs.rm(src, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      results.push(dest);
    }
    return results;
  });
}

// Re-exported so main.ts can pick a sensible default starting folder.
export function defaultStartDir(): string {
  try {
    return app.getPath("desktop");
  } catch {
    return app.getPath("home");
  }
}
