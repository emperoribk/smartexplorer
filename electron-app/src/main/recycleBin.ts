/**
 * Windows Recycle Bin access: list what's in it, restore items, delete some
 * of them for good, or empty it.
 *
 * How it works: every deleted file or folder is stored in
 * `<drive>:\$Recycle.Bin\<your SID>\` as a pair - `$R<id><ext>` is the item
 * itself (renamed) and `$I<id><ext>` is a small metadata record holding its
 * original path, size and deletion time. This module reads those records
 * directly, so what the app lists is exactly what Explorer's Recycle Bin
 * holds (for the current user's own bin folders only - other users' bins are
 * never readable by a normal account anyway).
 *
 * Safety design:
 *  - The renderer never sends a file path. It sends opaque entry ids
 *    ("C:AB12CD.pdf" = drive + the `$I`/`$R` suffix) that this module resolves
 *    against the user's own bin folders and validates, so a compromised page
 *    can't turn "delete from the Recycle Bin" into "delete any file".
 *  - Deleting removes the `$R` item first and the `$I` record only after
 *    that succeeded, so a failure leaves the entry intact and still listed.
 *  - Nothing here follows symlinks/junctions: removing a link removes the
 *    link, never what it points at.
 *
 * Only Windows is supported (the layout above is Windows-specific). On other
 * platforms `listRecycleBin()` reports `supported: false`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";

export interface RecycleBinEntry {
  /** Opaque, stable handle: "<drive letter>:<suffix of the $I/$R file name>". */
  id: string;
  name: string;
  /** Full original path, as Windows recorded it. */
  originalPath: string;
  /** Folder it was deleted from. */
  originalDir: string;
  size: number;
  deletedMs: number;
  isDirectory: boolean;
}

export interface RecycleBinListing {
  supported: boolean;
  entries: RecycleBinEntry[];
  totalSize: number;
  /** Set when the bin couldn't be read at all (shown to the person). */
  error?: string;
}

export interface FailedItem {
  id: string;
  name: string;
  error: string;
}

export interface RecycleBinActionResult {
  /** How many items the action completed for. */
  done: number;
  failed: FailedItem[];
}

/** One drive's bin folder for the current user. `drive` is kept separately
 *  (rather than sliced out of `dir`) so ids stay stable and tests can use
 *  ordinary temp folders. */
export interface BinDir {
  drive: string;
  dir: string;
}

export interface ParsedInfo {
  size: number;
  deletedMs: number;
  originalPath: string;
}

const FILETIME_EPOCH_OFFSET_MS = 11644473600000n; // 1601-01-01 -> 1970-01-01

/** Decodes a `$I` metadata record. Handles both on-disk versions: v1
 *  (Vista..Win10 1607: fixed 520-byte path) and v2 (Win10 1703+: a length
 *  field, then a variable-length path). Returns null for anything that isn't
 *  a recognizable record rather than guessing. */
export function parseInfoRecord(buf: Buffer): ParsedInfo | null {
  if (buf.length < 28) return null;
  const version = buf.readBigInt64LE(0);
  let pathBytes: Buffer;
  if (version === 2n) {
    const chars = buf.readUInt32LE(24);
    if (chars === 0 || chars > 32768) return null;
    pathBytes = buf.subarray(28, 28 + chars * 2);
  } else if (version === 1n) {
    pathBytes = buf.subarray(24, 24 + 520);
  } else {
    return null;
  }
  const size = Number(buf.readBigInt64LE(8));
  const filetime = buf.readBigUInt64LE(16);
  const deletedMs = Number(filetime / 10000n - FILETIME_EPOCH_OFFSET_MS);
  const text = pathBytes.toString("utf16le");
  const nul = text.indexOf("\0");
  const originalPath = nul >= 0 ? text.slice(0, nul) : text;
  if (!originalPath) return null;
  return { size: size < 0 ? 0 : size, deletedMs, originalPath };
}

/** Last path segment of a Windows path, whichever slash style it uses. */
function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
}
function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : "";
}

let cachedSid: string | null = null;

function currentUserSid(): Promise<string> {
  if (cachedSid) return Promise.resolve(cachedSid);
  return new Promise((resolve, reject) => {
    execFile("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const sid = !err ? /S-1-[\d-]+/.exec(stdout)?.[0] : undefined;
      if (!sid) return reject(new Error("Couldn't work out which Recycle Bin belongs to your account."));
      cachedSid = sid;
      resolve(sid);
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      }
    );
  });
}

/** The user's own bin folder on every drive that has one, e.g.
 *  `C:\$Recycle.Bin\S-1-5-21-...`. A disconnected network drive can make a
 *  stat hang for seconds, so each probe is time-boxed. */
export async function findBinDirs(): Promise<BinDir[]> {
  const sid = await currentUserSid();
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const probes = letters.map(async (l) => {
    const dir = `${l}:\\$Recycle.Bin\\${sid}`;
    const ok = await withTimeout(
      fs.stat(dir).then((s) => s.isDirectory()),
      1500,
      false
    );
    return ok ? { drive: l, dir } : null;
  });
  return (await Promise.all(probes)).filter((d): d is BinDir => !!d);
}

interface RawPair {
  dir: string;
  drive: string;
  suffix: string;
  infoPath: string;
  itemPath: string;
}

async function scanDir({ drive, dir }: BinDir): Promise<{ pairs: RawPair[]; orphanInfos: string[]; orphanItems: string[] }> {
  const names = await fs.readdir(dir);
  const infoSuffixes = new Set<string>();
  const itemSuffixes = new Set<string>();
  for (const n of names) {
    if (n.length > 2 && n.slice(0, 2).toUpperCase() === "$I") infoSuffixes.add(n.slice(2));
    else if (n.length > 2 && n.slice(0, 2).toUpperCase() === "$R") itemSuffixes.add(n.slice(2));
  }
  const pairs: RawPair[] = [];
  const orphanInfos: string[] = [];
  const orphanItems: string[] = [];
  for (const s of infoSuffixes) {
    if (itemSuffixes.has(s)) {
      pairs.push({ dir, drive, suffix: s, infoPath: path.join(dir, "$I" + s), itemPath: path.join(dir, "$R" + s) });
    } else {
      orphanInfos.push(path.join(dir, "$I" + s));
    }
  }
  for (const s of itemSuffixes) if (!infoSuffixes.has(s)) orphanItems.push(path.join(dir, "$R" + s));
  return { pairs, orphanInfos, orphanItems };
}

async function readEntries(dirs: BinDir[]): Promise<{ entries: RecycleBinEntry[]; orphans: string[] }> {
  const entries: RecycleBinEntry[] = [];
  const orphans: string[] = [];
  for (const bin of dirs) {
    let scan;
    try {
      scan = await scanDir(bin);
    } catch {
      continue; // an unreadable bin folder just contributes nothing
    }
    orphans.push(...scan.orphanInfos, ...scan.orphanItems);
    for (const p of scan.pairs) {
      let info: ParsedInfo | null = null;
      try {
        info = parseInfoRecord(await fs.readFile(p.infoPath));
      } catch {
        info = null;
      }
      if (!info) {
        // Unreadable record: can't be listed or restored, only cleared by "Empty"
        // (the item goes with it - leaving it behind would hold disk space forever).
        orphans.push(p.infoPath, p.itemPath);
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = (await fs.lstat(p.itemPath)).isDirectory();
      } catch {
        orphans.push(p.infoPath);
        continue;
      }
      entries.push({
        id: `${p.drive}:${p.suffix}`,
        name: baseName(info.originalPath),
        originalPath: info.originalPath,
        originalDir: dirName(info.originalPath),
        size: info.size,
        deletedMs: info.deletedMs,
        isDirectory,
      });
    }
  }
  entries.sort((a, b) => b.deletedMs - a.deletedMs || a.name.localeCompare(b.name));
  return { entries, orphans };
}

/** What the Recycle Bin screen shows. `dirs` is injectable for tests. */
export async function listRecycleBin(dirs?: BinDir[]): Promise<RecycleBinListing> {
  if (!dirs && process.platform !== "win32") return { supported: false, entries: [], totalSize: 0 };
  try {
    const { entries } = await readEntries(dirs ?? (await findBinDirs()));
    return { supported: true, entries, totalSize: entries.reduce((n, e) => n + e.size, 0) };
  } catch (err) {
    return { supported: true, entries: [], totalSize: 0, error: (err as Error).message };
  }
}

interface Resolved {
  id: string;
  infoPath: string;
  itemPath: string;
  entry: RecycleBinEntry;
}

/** Turns renderer-supplied ids into real bin paths, rejecting anything that
 *  isn't a plain "<drive>:<file-name-suffix>" naming a pair that exists in
 *  one of the user's bin folders. */
function resolveIds(ids: unknown, dirs: BinDir[], known: Map<string, RecycleBinEntry>): { ok: Resolved[]; bad: FailedItem[] } {
  const ok: Resolved[] = [];
  const bad: FailedItem[] = [];
  if (!Array.isArray(ids)) return { ok, bad: [{ id: String(ids), name: "", error: "Invalid request." }] };
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw : "";
    if (seen.has(id)) continue;
    seen.add(id);
    const m = /^([A-Za-z]):(.+)$/.exec(id);
    const suffix = m?.[2] ?? "";
    const invalid =
      !m || suffix === "." || suffix === ".." || suffix.length > 240 || /[\\/:*?"<>|\0]/.test(suffix);
    const bin = m ? dirs.find((d) => d.drive.toUpperCase() === m[1].toUpperCase()) : undefined;
    if (invalid || !bin) {
      bad.push({ id, name: "", error: "That item isn't in your Recycle Bin." });
      continue;
    }
    const dir = bin.dir;
    const infoPath = path.join(dir, "$I" + suffix);
    const itemPath = path.join(dir, "$R" + suffix);
    // Belt and braces: after joining, both must still sit directly in the bin folder.
    if (path.dirname(infoPath) !== dir || path.dirname(itemPath) !== dir) {
      bad.push({ id, name: "", error: "That item isn't in your Recycle Bin." });
      continue;
    }
    // Must be an entry that really is in the bin right now - a well-formed
    // id for something that isn't there is an error, not a silent "success".
    const entry = known.get(`${m[1].toUpperCase()}:${suffix}`);
    if (!entry) {
      bad.push({ id, name: "", error: "That item isn't in your Recycle Bin (it may already have been removed)." });
      continue;
    }
    ok.push({ id, infoPath, itemPath, entry });
  }
  return { ok, bad };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function removeEverything(p: string): Promise<void> {
  // rm doesn't follow symlinks/junctions (it removes the link itself), and on
  // Windows it clears the read-only attribute and retries.
  await fs.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Permanently deletes the given entries. Irreversible. */
export async function deleteFromRecycleBin(ids: unknown, dirs?: BinDir[]): Promise<RecycleBinActionResult> {
  const useDirs = dirs ?? (await requireWindowsDirs());
  const { entries } = await readEntries(useDirs);
  const known = new Map(entries.map((e) => [e.id.replace(/^./, (c) => c.toUpperCase()), e]));
  const { ok, bad } = resolveIds(ids, useDirs, known);
  const failed: FailedItem[] = [...bad];
  let done = 0;
  for (const r of ok) {
    try {
      await removeEverything(r.itemPath);
      if (await exists(r.itemPath)) throw new Error("Windows wouldn't let go of it (is it open in another program?).");
      await removeEverything(r.infoPath); // only after the item itself is really gone
      done++;
    } catch (err) {
      failed.push({ id: r.id, name: r.entry.name, error: friendlyError(err) });
    }
  }
  return { done, failed };
}

/** Permanently deletes everything in the bin, including unreadable or
 *  half-deleted leftovers that the list can't show. Irreversible. */
export async function emptyRecycleBin(dirs?: BinDir[]): Promise<RecycleBinActionResult> {
  const useDirs = dirs ?? (await requireWindowsDirs());
  const { entries, orphans } = await readEntries(useDirs);
  const result = await deleteFromRecycleBin(
    entries.map((e) => e.id),
    useDirs
  );
  for (const o of orphans) {
    try {
      await removeEverything(o);
    } catch (err) {
      result.failed.push({ id: path.basename(o), name: path.basename(o), error: friendlyError(err) });
    }
  }
  return result;
}

/** Puts entries back where they were deleted from. Never overwrites: if
 *  something already sits at the original path, that item is skipped and
 *  reported so nothing gets silently replaced. */
export async function restoreFromRecycleBin(ids: unknown, dirs?: BinDir[]): Promise<RecycleBinActionResult> {
  const useDirs = dirs ?? (await requireWindowsDirs());
  const { entries } = await readEntries(useDirs);
  const known = new Map(entries.map((e) => [e.id.replace(/^./, (c) => c.toUpperCase()), e]));
  const { ok, bad } = resolveIds(ids, useDirs, known);
  const failed: FailedItem[] = [...bad];
  let done = 0;
  for (const r of ok) {
    const name = r.entry.name;
    try {
      const target = r.entry.originalPath;
      const looksAbsolute = /^[A-Za-z]:[\\/]/.test(target) || (process.platform !== "win32" && path.isAbsolute(target));
      if (!looksAbsolute) throw new Error("Its original location looks invalid.");
      if (target.split(/[\\/]/).includes("..")) throw new Error("Its original location looks invalid.");
      if (await exists(target)) {
        throw new Error(`Something named "${name}" already exists in ${r.entry.originalDir}. Rename or move it first.`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(r.itemPath, target);
      await removeEverything(r.infoPath);
      done++;
    } catch (err) {
      failed.push({ id: r.id, name, error: friendlyError(err) });
    }
  }
  return { done, failed };
}

async function requireWindowsDirs(): Promise<BinDir[]> {
  if (process.platform !== "win32") throw new Error("The Recycle Bin screen is only available on Windows.");
  return findBinDirs();
}

function friendlyError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EBUSY" || e?.code === "EPERM" || e?.code === "EACCES") {
    return "Windows wouldn't allow it (the item may be open in another program).";
  }
  return e?.message ?? String(err);
}
