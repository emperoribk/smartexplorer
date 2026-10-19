import * as path from "node:path";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, protocol, net, Menu } from "electron";
import { startBackend, stopBackend, getBackendPort } from "./backend";
import { registerFsHandlers, defaultStartDir } from "./fsBridge";
import { registerThumbnailHandlers } from "./thumbnails";
import { registerVaultHandlers, sweepVaultTempDir } from "./vaultBridge";
import { registerZipHandlers } from "./zipBridge";
import { registerRecycleHandlers } from "./recycleBridge";

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged && !process.env.SMARTSEARCH_FORCE_PROD;

/**
 * The renderer needs to preview arbitrary local files (image thumbnails,
 * video hover-previews) by path. Plain `file://` URLs get blocked by
 * Chromium when the page itself isn't loaded from `file://` - which is
 * exactly the case in dev, where the renderer is served from
 * http://localhost:5173 for hot-reload. A custom "privileged" scheme sidesteps
 * that restriction and behaves identically in dev and in the packaged app.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ssfile",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

function registerLocalFileProtocol() {
  protocol.handle("ssfile", (request) => {
    const url = new URL(request.url);
    // We encode the absolute path as the URL's pathname (see fileUrl.ts in
    // the renderer): ssfile://local/C:/Users/... or ssfile://local/home/...
    let filePath = decodeURIComponent(url.pathname);
    if (process.platform === "win32") {
      filePath = filePath.replace(/^\//, ""); // "/C:/Users/x" -> "C:/Users/x"
    }
    // Forward the incoming request's headers - crucially Range - to the
    // underlying file fetch. Without this, every request (whole-file or
    // ranged) came back as a full 200 response with no Range support at
    // all, because a brand new no-headers fetch was issued regardless of
    // what was actually asked for. <img>/<video> tags mostly ask for the
    // whole file so that went unnoticed, but pdf.js's document loader
    // always probes with a Range request first to see whether the server
    // supports ranged/streamed loading, and - getting back a full 200
    // instead of a 206 Partial Content for its own Range probe - treats
    // that as a broken/unexpected response and throws (surfaced in
    // smartexplorer-debug.log as "BaseExceptionClosure" errors, pdf.js's
    // own exception base class, for every single PDF without exception).
    // file:// fetches do support Range (Chromium's FileURLLoader), so
    // simply passing the headers through is enough to fix it.
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers: request.headers,
    });
  });
}

const TITLEBAR_HEIGHT = 40;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "SmartExplorer",
    backgroundColor: "#ffffff",
    // Explorer-style header: the tab strip is the title bar. On Windows the
    // native min/max/close buttons are drawn over the page (titleBarOverlay);
    // the renderer's TitleBar leaves room for them via env(titlebar-area-*).
    ...(process.platform === "win32"
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#f3f3f3", symbolColor: "#1b1b1b", height: TITLEBAR_HEIGHT },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    await mainWindow.loadURL("http://localhost:5183");
    if (process.env.SMARTSEARCH_DEVTOOLS) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerLocalFileProtocol();
  registerFsHandlers(() => mainWindow);
  registerThumbnailHandlers();
  registerVaultHandlers();
  registerZipHandlers();
  registerRecycleHandlers();
  void sweepVaultTempDir(); // best-effort cleanup of any leftover decrypted vault temp files from a previous crashed/force-quit run

  ipcMain.handle("backend:getPort", () => getBackendPort());
  ipcMain.handle("app:defaultStartDir", () => defaultStartDir());
  // No File/Edit/View/Window/Help menu bar - the header is just tabs.
  Menu.setApplicationMenu(null);
  // Keeps the native window buttons readable against the active theme.
  ipcMain.handle("window:setTitleBarTheme", (_e, color: string, symbolColor: string) => {
    if (process.platform !== "win32" || !mainWindow) return;
    try {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
    } catch {
      /* best effort */
    }
  });

  // TEMP DIAGNOSTIC: the renderer has no console access we can read
  // remotely, so this lets it hand back real error text (e.g. why a PDF
  // thumbnail failed to render) to a plain file we can read directly.
  // Safe to remove once the PDF thumbnail issue is confirmed fixed.
  ipcMain.handle("debug:log", async (_event, message: string) => {
    try {
      const logPath = path.join(app.getAppPath(), "smartexplorer-debug.log");
      await fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // Best-effort only - never let logging itself break anything.
    }
  });

  // Start the Python backend in parallel with window creation so the UI
  // shows up immediately; the renderer polls backend:getPort until it's set.
  createWindow();
  try {
    await startBackend();
    mainWindow?.webContents.send("backend:ready", getBackendPort());
  } catch (err) {
    console.error("Failed to start backend:", err);
    mainWindow?.webContents.send("backend:error", String(err));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopBackend();
  void sweepVaultTempDir();
});
