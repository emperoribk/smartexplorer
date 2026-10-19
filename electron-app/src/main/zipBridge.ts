/**
 * Plain compress/extract actions for the file browser - "Compress to ZIP"
 * and "Extract" in the context menu (see App.tsx's contextMenuItems).
 * Deliberately simple: no pre-flight sensitive-content scan here (that was
 * floated as a separate, bigger feature and explicitly deferred - this is
 * just zip in, zip out, the same thing File Explorer's own "Compress to
 * ZIP file" / "Extract All" does).
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ipcMain } from "electron";
import archiver from "archiver";
import extractZip from "extract-zip";
import { uniqueDestPath } from "./fsBridge";

export function registerZipHandlers() {
  // Zips sourcePaths (files and/or folders, already-resolved absolute
  // paths) into one new .zip sitting in destDir, named zipBaseName (e.g.
  // "report.zip" for a single file, "Archive.zip" for a multi-select) -
  // collision-avoided the same " (2)" way every other new-file action in
  // this app already uses. A folder is added as a real subtree (archiver's
  // own .directory(), which walks it) so the zip opens with the same
  // folder structure you selected, not a flattened dump of its contents.
  ipcMain.handle(
    "fs:zipItems",
    async (_event, sourcePaths: string[], destDir: string, zipBaseName: string): Promise<string> => {
      if (sourcePaths.length === 0) {
        throw new Error("Nothing selected to compress.");
      }
      const destPath = await uniqueDestPath(destDir, zipBaseName);
      // Logged on both ends - this terminal shows nothing at all for a
      // successful zip/extract otherwise (it's pure Electron IPC, no
      // Python-backend HTTP call to show up in the usual request log
      // above), which made an earlier real failure here indistinguishable
      // from the app silently doing nothing at all.
      console.log(`[zip] compressing ${sourcePaths.length} item(s) -> ${destPath}`);
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(destPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          // A partial/corrupt zip left behind after a failed write is
          // worse than no zip at all - best-effort clean it up, but don't
          // let a cleanup error mask the real one.
          output.destroy();
          void fsp.rm(destPath, { force: true }).finally(() => reject(err));
        };
        output.on("close", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        output.on("error", (err) => {
          console.error("[zip] output stream error:", err);
          fail(err);
        });
        archive.on("error", (err) => {
          console.error("[zip] archiver error:", err);
          fail(err);
        });
        archive.pipe(output);
        for (const src of sourcePaths) {
          const stat = fs.statSync(src);
          if (stat.isDirectory()) {
            archive.directory(src, path.basename(src));
          } else {
            archive.file(src, { name: path.basename(src) });
          }
        }
        void archive.finalize();
      });
      console.log(`[zip] done -> ${destPath}`);
      return destPath;
    }
  );

  // Extracts zipPath into a new folder named after the zip (minus its
  // .zip extension) sitting right next to it, collision-avoided the same
  // way - never extracts loose into the zip's own containing folder,
  // since a zip full of top-level files would otherwise scatter them
  // straight into whatever folder you were already browsing.
  ipcMain.handle("fs:extractZip", async (_event, zipPath: string): Promise<string> => {
    const parent = path.dirname(zipPath);
    const baseName = path.basename(zipPath, path.extname(zipPath)) || "Archive";
    const destDir = await uniqueDestPath(parent, baseName);
    console.log(`[zip] extracting ${zipPath} -> ${destDir}`);
    await fsp.mkdir(destDir, { recursive: true });
    try {
      await extractZip(zipPath, { dir: destDir });
    } catch (err) {
      console.error("[zip] extract error:", err);
      // Don't leave a half-extracted folder sitting around looking like a
      // real result if extraction failed partway through.
      await fsp.rm(destDir, { recursive: true, force: true });
      throw err;
    }
    console.log(`[zip] extracted -> ${destDir}`);
    return destDir;
  });
}
