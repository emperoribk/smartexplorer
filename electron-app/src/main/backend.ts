/**
 * Spawns and supervises the local Python backend (FastAPI/uvicorn) that does
 * all indexing/search/AI work. The renderer talks to it over plain HTTP on
 * 127.0.0.1, so this module's only job is: find a free port, start the
 * process, know when it's ready, and kill it cleanly on app quit.
 */
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { app } from "electron";

let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendPort = 0;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not determine free port"));
      }
    });
  });
}

function backendDir(): string {
  // Dev: python-backend lives next to electron-app in the repo.
  // Packaged: electron-builder copies it into extraResources (see package.json).
  return app.isPackaged
    ? path.join(process.resourcesPath, "python-backend")
    : path.join(__dirname, "..", "..", "..", "python-backend");
}

function pythonExecutable(): string {
  const dir = backendDir();
  const fs = require("node:fs");

  // A fully self-contained Python runtime with every dependency (torch,
  // open_clip, etc.) pre-installed - see python-backend/build-runtime.ps1.
  // This is what a packaged install actually ships and runs; it needs
  // nothing pre-installed on the target machine at all.
  const bundledPython =
    process.platform === "win32"
      ? path.join(dir, "runtime", "python.exe")
      : path.join(dir, "runtime", "bin", "python3");

  // A project-local dev virtualenv (see README) - what we use while
  // developing, never shipped in a packaged install.
  const venvPython =
    process.platform === "win32"
      ? path.join(dir, ".venv", "Scripts", "python.exe")
      : path.join(dir, ".venv", "bin", "python3");

  // Packaged installs only ever have the bundled runtime available. In dev,
  // prefer the venv (what you're actively iterating against), but fall back
  // to a locally-built runtime if that's what's present, then finally to
  // whatever "python"/"python3" resolves to on PATH as a last resort.
  const candidates = app.isPackaged ? [bundledPython] : [venvPython, bundledPython];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
        } else {
          res.resume();
          retry();
        }
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("Backend did not become healthy in time"));
        return;
      }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

export async function startBackend(): Promise<number> {
  const port = await findFreePort();
  const dir = backendDir();
  const python = pythonExecutable();

  backendProcess = spawn(python, ["run.py", String(port)], {
    cwd: dir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // Where the "Your Eyes Only" vault's own key material lives - see
      // vault.py. Deliberately Electron's userData dir, not anything under
      // an indexed folder: the vault key must never sit inside a folder
      // that could itself get zipped up or copied elsewhere, and it's one
      // key for the whole app, not per indexed root.
      SMARTSEARCH_APPDATA: app.getPath("userData"),
    },
  });

  backendProcess.stdout.on("data", (d) => console.log(`[backend] ${d}`));
  backendProcess.stderr.on("data", (d) => console.error(`[backend] ${d}`));
  backendProcess.on("exit", (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });

  await waitForHealth(port);
  backendPort = port;
  return port;
}

export function getBackendPort(): number {
  return backendPort;
}

export function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}
