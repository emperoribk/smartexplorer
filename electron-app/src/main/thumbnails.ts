/**
 * Generates and caches a static poster-frame thumbnail for video files, so
 * the grid can show an actual frame from the video at rest instead of a
 * plain play-icon placeholder. Uses the ffmpeg binary bundled via
 * ffmpeg-static (no separate ffmpeg install required on the target machine).
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app, ipcMain, nativeImage } from "electron";
import { isInsideVaultTempDir } from "./vaultBridge";

// electron-builder can't run a binary straight out of the asar archive, so
// ffmpeg-static's binary is unpacked alongside it (see package.json's
// "asarUnpack") - when running packaged, redirect the path there.
function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bundled = require("ffmpeg-static") as string;
  return app.isPackaged ? bundled.replace("app.asar", "app.asar.unpacked") : bundled;
}

function cacheDir(): string {
  return path.join(app.getPath("userData"), "thumbnails");
}

// A folder full of videos/images would otherwise spawn dozens of ffmpeg
// processes (video) or synchronous decode+resize calls (images) at once the
// moment it's opened - cap how many run concurrently. Shared by both: for
// video this genuinely lets several ffmpeg child processes run at once; for
// images (see getImageThumbnail) nativeImage's work is synchronous, so this
// mainly just keeps a big batch from racing each other for no benefit -
// either way, harmless to share one gate.
const MAX_CONCURRENT = 3;
// Grid tiles show a thumbnail at 108x82 CSS px (see styles.css's .thumb) -
// 320px wide covers that comfortably even at 3x pixel density, matching the
// width the video poster frames below are already generated at.
const IMAGE_THUMB_MAX_WIDTH = 320;
let running = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (running < MAX_CONCURRENT) {
      running++;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
}

function releaseSlot(): void {
  running--;
  const next = waiters.shift();
  if (next) {
    running++;
    next();
  }
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath(), args);
    } catch {
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Windows caps a plain path at ~260 characters; anything longer (a deeply
// nested Documents folder is a common way to hit this with .docx/.pdf files
// specifically) fails a plain fs.stat with ENOENT even though the file is
// really there. The "\\?\" prefix opts a Windows path into the extended-length
// form, bypassing that cap - only meaningful on win32, and only for local
// (non-UNC) absolute paths, which is all we ever get here (file dialog/drag
// results, not raw user-typed UNC paths).
function longPathSafe(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\")) return p;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return "\\\\?\\" + p.replace(/\//g, "\\");
  return p;
}

async function statSafe(p: string): Promise<{ mtimeMs: number }> {
  try {
    return await fs.stat(p);
  } catch (err) {
    const safe = longPathSafe(p);
    if (safe === p) throw err;
    return fs.stat(safe);
  }
}

/** A cache path keyed by (kind, target path, mtime) - shared by every
 *  thumbnail generator below so a file's icon/preview auto-invalidates the
 *  moment the file itself changes, without needing any explicit cleanup. */
async function cachePathFor(kind: string, targetPath: string, ext: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await statSafe(targetPath)).mtimeMs;
  } catch {
    return null;
  }
  const hash = crypto.createHash("sha1").update(`${kind}:${targetPath}:${mtimeMs}`).digest("hex");
  return path.join(cacheDir(), `${hash}${ext}`);
}

// ffprobe isn't bundled here (only ffmpeg-static is) - rather than add a
// second native binary dependency just to read one number, this runs
// plain `ffmpeg -i <file>` with no output at all: ffmpeg still probes and
// logs the input's container info (including a "Duration: H:MM:SS.ss"
// line) to stderr before it gets to complaining that no output was given,
// which is the well-known trick for getting a file's duration out of a
// bare ffmpeg install. Returns null if the line can't be found/parsed
// (unusual container, corrupt file) - callers fall back to the old fixed
// 1-second seek rather than guessing at a duration.
function probeDurationSeconds(videoPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath(), ["-i", videoPath]);
    } catch {
      resolve(null);
      return;
    }
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (!m) {
        resolve(null);
        return;
      }
      const hours = Number(m[1]);
      const minutes = Number(m[2]);
      const seconds = Number(m[3]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        resolve(null);
        return;
      }
      resolve(hours * 3600 + minutes * 60 + seconds);
    });
  });
}

function formatSeek(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

// How far into the clip the frame is pulled from, as a fraction of total
// duration - usually well clear of an intro/title card/black fade-in,
// scaling with the video's own length instead of a fixed offset that's
// still the intro on a 2-hour video and past the end on a 2-second one.
//
// An earlier version of this pulled TWO candidate frames (at 25% and
// 10%) and picked whichever one decoded as less of a flat/solid-color
// image, to dodge the occasional cut-to-black or title card landing
// exactly on the one frame grabbed. In practice that meant three ffmpeg
// spawns per video (a duration probe plus two frame extractions) and a
// round of temp-file juggling to compare them, for a benefit that's hard
// to even notice next to the simple version - not worth the extra time
// and process overhead on a folder with a lot of videos in it. Back to
// one frame: still duration-scaled (the actual improvement over the
// original fixed 1-second seek), just not auditioning a second one.
const SEEK_FRACTION = 0.25;
// Never seek earlier than this (a flat 25% of a 2-second clip is
// basically frame zero anyway) or within half a second of the very end
// (seeking right at EOF often just fails to produce a frame at all).
const MIN_SEEK_SECONDS = 1;

async function generate(videoPath: string, cachePath: string): Promise<boolean> {
  const frameArgs = (seek: string) => [
    "-y",
    "-ss",
    seek,
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-2",
    "-q:v",
    "4",
    cachePath,
  ];

  const duration = await probeDurationSeconds(videoPath);
  if (duration === null || duration <= 0) {
    // Duration unknown (probe failed, or a zero-length/corrupt file) -
    // fall back to the old fixed-offset behavior rather than guessing
    // blind at a seek point with nothing to clamp it against.
    if (await runFfmpeg(frameArgs("00:00:01"))) return true;
    return runFfmpeg(frameArgs("00:00:00"));
  }

  const upperBound = Math.max(MIN_SEEK_SECONDS, duration - 0.5);
  const seekSeconds = Math.min(Math.max(duration * SEEK_FRACTION, MIN_SEEK_SECONDS), upperBound);
  if (await runFfmpeg(frameArgs(formatSeek(seekSeconds)))) return true;
  // The duration-scaled seek itself failed outright (unusual codec,
  // truncated stream) - last resort, try frame zero before giving up.
  return runFfmpeg(frameArgs("00:00:00"));
}

/** Returns a local file path to a cached JPEG poster frame for videoPath,
 *  generating and caching one first if this is the first time it's been
 *  asked for. Returns null if ffmpeg isn't available or extraction fails -
 *  callers should fall back to a placeholder, not treat this as fatal. */
// Bump this whenever generate()'s actual frame-picking logic changes -
// it's folded into the cache key below so an existing cached thumbnail
// (keyed only by path+mtime otherwise) doesn't just sit there looking
// identical forever after a change like this one. Without it, every video
// the user had already browsed before this change would keep showing its
// old thumbnail indefinitely, since its file's mtime hasn't changed - the
// new frame-picking logic would be correct in code but invisible in
// practice. History: 1 (implicit) was the original fixed-1-second seek;
// 2 was a since-reverted two-candidate/variance-scored version; 3 is the
// current duration-scaled single-frame seek.
const VIDEO_THUMB_ALGO_VERSION = 3;

export async function getVideoThumbnail(videoPath: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await statSafe(videoPath)).mtimeMs;
  } catch {
    return null;
  }

  const hash = crypto
    .createHash("sha1")
    .update(`${videoPath}:${mtimeMs}:v${VIDEO_THUMB_ALGO_VERSION}`)
    .digest("hex");
  const cachePath = path.join(cacheDir(), `${hash}.jpg`);

  if (await pathExists(cachePath)) return cachePath;

  await fs.mkdir(cacheDir(), { recursive: true });

  await acquireSlot();
  try {
    const ok = await generate(videoPath, cachePath);
    if (!ok) return null;
  } finally {
    releaseSlot();
  }

  return (await pathExists(cachePath)) ? cachePath : null;
}

/** Returns a local path to a small cached JPEG thumbnail of an image file,
 *  generating and caching one first if this is the first time it's been
 *  asked for - mirrors getVideoThumbnail's pattern exactly, including the
 *  mtime-keyed cache path (see cachePathFor) and the shared concurrency
 *  gate.
 *
 *  Why this exists: ImageTile used to point an <img> straight at the
 *  original file (toFileUrl(item.path)) with no resizing at all. That's
 *  fine for a handful of photos, but a grid tile is only 108x82 CSS px
 *  (styles.css's .thumb) - for a folder with hundreds of full-resolution
 *  camera photos (a Downloads folder is the common case), the renderer was
 *  decoding every single one of those at full original size just to show
 *  it that small, and - since nothing cached the result - paying that same
 *  decode cost again basically every time an image scrolled back into view,
 *  not just the first time. That's exactly what made scrolling through a
 *  photo-heavy folder feel heavy in both directions, worse the more of the
 *  folder had scrolled past. Generating a small version once and reusing it
 *  (like the video poster frames and file icons already do) means the
 *  renderer only ever has to load a small pre-shrunk JPEG from then on.
 *
 *  nativeImage's decode/resize/encode is synchronous - there's no async
 *  variant - so this does block the main process for the (brief) duration
 *  of each call; the shared concurrency gate at least keeps a big batch
 *  of never-thumbnailed images from all trying to go at once. Returns null
 *  (never throws) on anything nativeImage can't read - callers should fall
 *  back to the original file, not treat this as fatal. */
export async function getImageThumbnail(imagePath: string): Promise<string | null> {
  const cachePath = await cachePathFor("img", imagePath, ".jpg");
  if (!cachePath) return null;
  if (await pathExists(cachePath)) return cachePath;

  await acquireSlot();
  try {
    let image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) {
      const safe = longPathSafe(imagePath);
      if (safe !== imagePath) image = nativeImage.createFromPath(safe);
    }
    if (image.isEmpty()) return null;

    const { width } = image.getSize();
    const resized = width > IMAGE_THUMB_MAX_WIDTH ? image.resize({ width: IMAGE_THUMB_MAX_WIDTH }) : image;
    const jpeg = resized.toJPEG(82);
    if (!jpeg || jpeg.length === 0) return null;

    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cachePath, jpeg);
  } catch {
    return null;
  } finally {
    releaseSlot();
  }

  return (await pathExists(cachePath)) ? cachePath : null;
}

/** Returns a local path to that file's real OS shell icon (the same icon
 *  Explorer would show for it) - used for every kind that doesn't get its
 *  own content preview (installers, documents, anything unrecognized), so
 *  the grid never falls back to a plain generic glyph. Cached like the
 *  video poster frame, keyed by path + mtime. `size: "large"` asks Windows
 *  for its biggest available icon (still small - Explorer/Shell icons cap
 *  out well under 256px - but the largest this API offers). */
export async function getFileIcon(targetPath: string): Promise<string | null> {
  const cachePath = await cachePathFor("icon", targetPath, ".png");
  if (!cachePath) return null;
  if (await pathExists(cachePath)) return cachePath;

  // "large" is what we want (crisper at the tile size we show it), but on
  // some Windows setups the shell only has a smaller icon cached for a given
  // extension and getFileIcon comes back empty at "large" specifically
  // (observed with .docx and a few other Office-associated types) - falling
  // through to "normal" then "small" before giving up means a file only
  // fails to get *any* icon if the OS genuinely has none for it, which is
  // rare (even "unknown file type" has a generic shell icon).
  let image;
  for (const p of [targetPath, longPathSafe(targetPath)]) {
    for (const size of ["large", "normal", "small"] as const) {
      try {
        image = await app.getFileIcon(p, { size });
      } catch {
        continue;
      }
      if (image && !image.isEmpty()) break;
      image = undefined;
    }
    if (image) break;
    if (p === targetPath && longPathSafe(targetPath) === targetPath) break; // no "\\?\" form to try
  }
  if (!image) return null;

  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cachePath, image.toPNG());
  return cachePath;
}

/** PDF first-page thumbnails are rendered on the renderer side (via
 *  pdfjs-dist, which needs a real <canvas> - not available in the main
 *  process) - these two just manage the on-disk cache for that, mirroring
 *  the video poster-frame pattern: check first, render only on a miss, then
 *  persist so it's instant next time. */
export async function getPdfThumbnailCached(pdfPath: string): Promise<string | null> {
  const cachePath = await cachePathFor("pdf", pdfPath, ".jpg");
  if (!cachePath) return null;
  return (await pathExists(cachePath)) ? cachePath : null;
}

export async function cachePdfThumbnail(pdfPath: string, dataUrl: string): Promise<string | null> {
  const cachePath = await cachePathFor("pdf", pdfPath, ".jpg");
  if (!cachePath) return null;
  const match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl);
  if (!match) return null;

  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cachePath, Buffer.from(match[1], "base64"));
  return cachePath;
}

export function registerThumbnailHandlers(): void {
  ipcMain.handle("thumb:video", async (_event, videoPath: string) => {
    // Never cache anything derived from a decrypted vault folder.
    if (isInsideVaultTempDir(videoPath)) return null;
    try {
      return await getVideoThumbnail(videoPath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("thumb:image", async (_event, imagePath: string) => {
    // Never cache anything derived from a decrypted vault folder.
    if (isInsideVaultTempDir(imagePath)) return null;
    try {
      return await getImageThumbnail(imagePath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("thumb:fileIcon", async (_event, targetPath: string) => {
    // Never cache anything derived from a decrypted vault folder.
    if (isInsideVaultTempDir(targetPath)) return null;
    try {
      return await getFileIcon(targetPath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("thumb:pdfCached", async (_event, pdfPath: string) => {
    // Never cache anything derived from a decrypted vault folder.
    if (isInsideVaultTempDir(pdfPath)) return null;
    try {
      return await getPdfThumbnailCached(pdfPath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("thumb:pdfCacheWrite", async (_event, pdfPath: string, dataUrl: string) => {
    // Never cache anything derived from a decrypted vault folder.
    if (isInsideVaultTempDir(pdfPath)) return null;
    try {
      return await cachePdfThumbnail(pdfPath, dataUrl);
    } catch {
      return null;
    }
  });
}
