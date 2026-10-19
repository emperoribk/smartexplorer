/**
 * The only bridge between the sandboxed renderer and Node/Electron APIs.
 * Everything exposed here is deliberately narrow (no raw fs/child_process
 * access reaches the renderer) so a compromised/buggy web page can't do
 * more than browse folders and talk to the local search backend.
 */
import { contextBridge, ipcRenderer } from "electron";

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

export interface SpecialFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  videos: string;
}

/** One item in the Windows Recycle Bin. `id` is opaque - the renderer hands
 *  ids back to restore/delete, never file paths. (Kept in sync with
 *  main/recycleBin.ts; declared here because the renderer can't import main.) */
export interface RecycleBinEntry {
  id: string;
  name: string;
  originalPath: string;
  originalDir: string;
  size: number;
  deletedMs: number;
  isDirectory: boolean;
}

export interface RecycleBinListing {
  supported: boolean;
  entries: RecycleBinEntry[];
  totalSize: number;
  error?: string;
}

export interface RecycleBinFailedItem {
  id: string;
  name: string;
  error: string;
}

export interface RecycleBinActionResult {
  done: number;
  failed: RecycleBinFailedItem[];
}

export interface DiskUsage {
  total: number;
  free: number;
  /** Ready-to-display label, e.g. "Local Disk (C:)" on Windows or the raw
   *  mount point elsewhere - computed on the main-process side since only
   *  it knows the platform-appropriate way to name a drive. */
  label: string;
  root: string;
}

const api = {
  listDir: (dirPath: string, showAllFiles?: boolean): Promise<DirEntry[]> =>
    ipcRenderer.invoke("fs:listDir", dirPath, showAllFiles),
  homeDir: (): Promise<string> => ipcRenderer.invoke("fs:homeDir"),
  specialFolders: (): Promise<SpecialFolders> => ipcRenderer.invoke("fs:specialFolders"),
  statPaths: (paths: string[]): Promise<DirEntry[]> => ipcRenderer.invoke("fs:statPaths", paths),
  diskUsage: (forPath?: string): Promise<DiskUsage> => ipcRenderer.invoke("fs:diskUsage", forPath),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("fs:pickFolder"),
  openPath: (targetPath: string): Promise<void> => ipcRenderer.invoke("fs:openPath", targetPath),
  showInFolder: (targetPath: string): Promise<void> =>
    ipcRenderer.invoke("fs:showInFolder", targetPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("fs:openExternal", url),
  rename: (targetPath: string, newName: string): Promise<string> =>
    ipcRenderer.invoke("fs:rename", targetPath, newName),
  deleteItems: (paths: string[]): Promise<void> => ipcRenderer.invoke("fs:delete", paths),
  newFolder: (dirPath: string): Promise<string> => ipcRenderer.invoke("fs:newFolder", dirPath),
  copyItems: (paths: string[], destDir: string): Promise<string[]> =>
    ipcRenderer.invoke("fs:copyItems", paths, destDir),
  moveItems: (paths: string[], destDir: string): Promise<string[]> =>
    ipcRenderer.invoke("fs:moveItems", paths, destDir),
  // "Compress to ZIP" / "Extract" (see App.tsx's contextMenuItems and
  // main/zipBridge.ts). zipItems returns the new .zip's path; extractZip
  // returns the new folder it extracted into - both for the toast/refresh
  // the caller does afterward, same as rename/newFolder already return
  // their result path for that reason.
  zipItems: (paths: string[], destDir: string, zipBaseName: string): Promise<string> =>
    ipcRenderer.invoke("fs:zipItems", paths, destDir, zipBaseName),
  extractZip: (zipPath: string): Promise<string> => ipcRenderer.invoke("fs:extractZip", zipPath),
  getVideoThumbnail: (videoPath: string): Promise<string | null> =>
    ipcRenderer.invoke("thumb:video", videoPath),
  getImageThumbnail: (imagePath: string): Promise<string | null> =>
    ipcRenderer.invoke("thumb:image", imagePath),
  getFileIcon: (targetPath: string): Promise<string | null> =>
    ipcRenderer.invoke("thumb:fileIcon", targetPath),
  getPdfThumbnailCached: (pdfPath: string): Promise<string | null> =>
    ipcRenderer.invoke("thumb:pdfCached", pdfPath),
  cachePdfThumbnail: (pdfPath: string, dataUrl: string): Promise<string | null> =>
    ipcRenderer.invoke("thumb:pdfCacheWrite", pdfPath, dataUrl),
  // TEMP DIAGNOSTIC - see main.ts's "debug:log" handler doc comment. Safe to
  // remove once the PDF thumbnail rendering issue is confirmed fixed.
  debugLog: (message: string): Promise<void> => ipcRenderer.invoke("debug:log", message),
  // Recycle Bin screen (see main/recycleBridge.ts). Ids only - never paths.
  recycleList: (): Promise<RecycleBinListing> => ipcRenderer.invoke("recycle:list"),
  recycleRestore: (ids: string[]): Promise<RecycleBinActionResult> =>
    ipcRenderer.invoke("recycle:restore", ids),
  recycleDelete: (ids: string[]): Promise<RecycleBinActionResult> =>
    ipcRenderer.invoke("recycle:delete", ids),
  recycleEmpty: (): Promise<RecycleBinActionResult> => ipcRenderer.invoke("recycle:empty"),
  defaultStartDir: (): Promise<string> => ipcRenderer.invoke("app:defaultStartDir"),
  setTitleBarTheme: (color: string, symbolColor: string): Promise<void> =>
    ipcRenderer.invoke("window:setTitleBarTheme", color, symbolColor),
  getBackendPort: (): Promise<number> => ipcRenderer.invoke("backend:getPort"),
  // Opens a decrypted "Your Eyes Only" temp file (see vault.py /
  // main.ts's vault:openTemp) with its normal default app, then schedules
  // its own best-effort cleanup - see vaultBridge.ts for why this can't
  // be a hard guarantee.
  openVaultTemp: (tempPath: string): Promise<void> => ipcRenderer.invoke("vault:openTemp", tempPath),
  // Deletes a decrypted vault FOLDER that was browsed inside the app, as
  // soon as its last tab is closed/left (see vaultBridge.ts).
  releaseVaultTemp: (tempPath: string): Promise<void> => ipcRenderer.invoke("vault:releaseTemp", tempPath),
  onBackendReady: (cb: (port: number) => void) => {
    ipcRenderer.on("backend:ready", (_event, port: number) => cb(port));
  },
  onBackendError: (cb: (message: string) => void) => {
    ipcRenderer.on("backend:error", (_event, message: string) => cb(message));
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("smartsearch", api);

export type SmartSearchApi = typeof api;
