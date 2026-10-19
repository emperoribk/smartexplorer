/** Renders a PDF's first page to a small JPEG data URL, for the grid's PDF
 *  tiles. Runs entirely in the renderer (not the main process) because it
 *  needs a real <canvas> to rasterize into - pdfjs-dist is pure JS/WASM, so
 *  this needs no native module. Loaded lazily (dynamic import) so the
 *  ~1MB+ pdfjs bundle only ever loads for someone who actually has PDFs in
 *  view, not on every app start. The result is cached to disk by the caller
 *  (see FileGrid's PdfTile + thumb:pdfCacheWrite) - this module never
 *  touches the filesystem itself. */
import { toFileUrl } from "./fileUrl";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfLoadingTask = ReturnType<PdfjsModule["getDocument"]>;

/** pdfjs-dist 6.x's bundles call a whole handful of VERY recently added
 *  JS builtins that this app's pinned Electron version (32.3.3) doesn't
 *  have yet, and pdfjs-dist does no feature-detection for any of them
 *  (it does for one unrelated thing - Iterator helpers' `.join()` - which
 *  is how I know this is a deliberate style choice elsewhere in the
 *  bundle, just not applied consistently). Each one was found the same
 *  way: a PDF would fail, the debug log would show a new, different
 *  "X is not a function", and grepping the two pdfjs-dist bundle files
 *  for that method name turned up more call sites than just the one that
 *  happened to crash first. Rather than keep fixing these one at a time
 *  through another round-trip of "try it, check the log, find the next
 *  one," this function polyfills everything that scan turned up, so a
 *  method that isn't native yet doesn't matter either way:
 *
 *  - Uint8Array.prototype.toHex()/.toBase64(), Uint8Array.fromBase64() -
 *    used when computing a PDF's internal "fingerprint" on open (the
 *    very first crash seen, and what PdfTile's "pdfjs's worker never
 *    initialized correctly" regression actually was too - see
 *    FileGrid.tsx).
 *  - Map/WeakMap.prototype.getOrInsert()/.getOrInsertComputed() (the
 *    "Upsert" proposal) - used throughout pdfjs-dist's caching code
 *    (worker-RPC result caches, bitmap caches, named-destination
 *    lookups); this is what the *second* crash turned out to be,
 *    surfacing from `renderPage` instead of `getDocument` once the
 *    fingerprint bug above was actually fixed. Polyfilled onto WeakMap
 *    too (same proposal) even though every call site found so far is on
 *    a plain Map - cheap insurance against a WeakMap-typed cache
 *    somewhere that just hasn't been exercised yet.
 *  - Set.prototype.intersection() (the Set-methods proposal) - one call
 *    site (named-destination bookkeeping); almost certainly already
 *    native here (it shipped in V8 well before the other two), included
 *    for completeness since the guard makes it a no-op if so.
 *  - Promise.try() - pdfjs-dist's worker message-dispatch calls this
 *    unguarded; not yet confirmed as an actual failure in this app, but
 *    unlike the Iterator helpers case above, pdfjs-dist does nothing to
 *    protect itself here either.
 *
 *  This covers main-thread pdfjs code (pd.mjs calls several of these
 *  directly - PDFPageProxy.render's canvas/bitmap caching is where the
 *  Map one actually crashed, since rendering has to happen on the main
 *  thread where the real <canvas> lives). The worker thread needs the
 *  exact same list, installed separately inside its own realm - see
 *  pdfWorkerEntry.ts, which this main-thread copy intentionally
 *  duplicates in plain JS rather than sharing code with (see that file's
 *  own doc comment for why). */
function installPdfjsBuiltinPolyfills(): void {
  const u8proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  if (typeof u8proto.toHex !== "function") {
    u8proto.toHex = function toHex(this: Uint8Array): string {
      let hex = "";
      for (let i = 0; i < this.length; i++) {
        hex += this[i].toString(16).padStart(2, "0");
      }
      return hex;
    };
  }
  if (typeof u8proto.toBase64 !== "function") {
    u8proto.toBase64 = function toBase64(this: Uint8Array): string {
      let binary = "";
      for (let i = 0; i < this.length; i++) binary += String.fromCharCode(this[i]);
      return btoa(binary);
    };
  }
  const u8ctor = Uint8Array as unknown as Record<string, unknown>;
  if (typeof u8ctor.fromBase64 !== "function") {
    u8ctor.fromBase64 = function fromBase64(base64: string): Uint8Array {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
  }

  for (const ctor of [Map, WeakMap] as const) {
    const proto = ctor.prototype as unknown as Record<string, unknown>;
    if (typeof proto.getOrInsert !== "function") {
      proto.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      };
    }
    if (typeof proto.getOrInsertComputed !== "function") {
      proto.getOrInsertComputed = function (
        this: Map<unknown, unknown>,
        key: unknown,
        callbackfn: (key: unknown) => unknown
      ) {
        if (this.has(key)) return this.get(key);
        const inserted = callbackfn(key);
        this.set(key, inserted);
        return inserted;
      };
    }
  }

  const setProto = Set.prototype as unknown as Record<string, unknown>;
  if (typeof setProto.intersection !== "function") {
    setProto.intersection = function (this: Set<unknown>, other: Set<unknown>): Set<unknown> {
      const result = new Set<unknown>();
      for (const v of this) if (other.has(v)) result.add(v);
      return result;
    };
  }

  const promiseCtor = Promise as unknown as Record<string, unknown>;
  if (typeof promiseCtor.try !== "function") {
    promiseCtor.try = function (fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
      return new Promise((resolve) => resolve(fn(...args)));
    };
  }
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    installPdfjsBuiltinPolyfills();
    pdfjsPromise = (async () => {
      // `?worker&url` is Vite's own suffix for "bundle this file as a
      // worker chunk (resolving whatever it imports) and give me back its
      // URL as a string, without constructing a Worker yet" - exactly
      // what's needed to hand pdfjs a workerSrc that's actually
      // pdfWorkerEntry.ts (polyfill + the real pdf.worker.mjs), properly
      // bundled for both dev and a packaged build.
      const [pdfjsLib, workerUrlModule] = await Promise.all([
        import("pdfjs-dist"),
        import("./pdfWorkerEntry.ts?worker&url"),
      ]);
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrlModule.default;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

export interface PdfPreviewHandle {
  numPages: number;
  /** Renders one page to a JPEG data URL, scaled to fit within
   *  `maxWidth`x`maxHeight` (never upscaled past the page's own natural
   *  resolution, so a small PDF doesn't come out blurry) - returns null on
   *  a page that fails to render rather than throwing, same convention as
   *  renderPdfFirstPage below. */
  renderPage(pageNum: number, maxWidth: number, maxHeight: number): Promise<string | null>;
  /** Frees the parsed document's worker-side state - callers must call
   *  this when done (Quick Look's cleanup effect), same reason
   *  renderPdfFirstPage's own `finally` does. */
  destroy(): void;
}

/** Opens a PDF for Quick Look's multi-page preview (see
 *  QuickLookOverlay.tsx) - unlike renderPdfFirstPage below, this keeps the
 *  parsed document around so paging through it doesn't re-parse the whole
 *  file on every page turn. Returns null if the PDF can't be opened at all
 *  (corrupt, encrypted with no password); callers fall back to "no
 *  preview available". */
async function logPdfFailure(stage: string, pdfPath: string, err: unknown): Promise<void> {
  try {
    // pdfjs's own exception classes (BaseException and its subclasses -
    // InvalidPDFException, PasswordException, UnexpectedResponseException,
    // etc.) are constructed through a shared minified closure
    // ("BaseExceptionClosure" in the bundled output), and that closure's
    // own call site is all `.stack` ends up showing - the actual
    // `.message`/`.name` pdfjs set are separate properties that `.stack`
    // alone doesn't surface. Logging those directly (plus every other own
    // property, in case pdfjs attached something like a `.details` or
    // `.code`) is what actually says WHY it failed, where `.stack` alone
    // just says "somewhere inside pdfjs".
    let detail: string;
    if (err instanceof Error) {
      const extra: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(err)) {
        if (key !== "stack" && key !== "message") extra[key] = (err as unknown as Record<string, unknown>)[key];
      }
      detail = `name=${err.name} message=${JSON.stringify(err.message)} extra=${JSON.stringify(extra)} stack=${err.stack}`;
    } else {
      detail = `non-Error value thrown (typeof ${typeof err}): ${JSON.stringify(err)}`;
    }
    await window.smartsearch.debugLog(`openPdfPreview[${stage}] failed for ${pdfPath}: ${detail}`);
  } catch {
    // Logging itself is best-effort - never let it mask the real failure.
  }
}

export async function openPdfPreview(pdfPath: string): Promise<PdfPreviewHandle | null> {
  let loadingTask: PdfLoadingTask | null = null;
  let pdfjsLib: PdfjsModule;
  try {
    // Split out from the getDocument() call below (unlike
    // renderPdfFirstPage's single try/catch) specifically so a failure
    // here - loading the pdfjs module/worker itself - logs distinguishably
    // from a failure opening THIS particular file, given PdfTile's own
    // history of pdfjs's worker not initializing correctly in this
    // Electron + Vite setup (see that component's doc comment) - knowing
    // which stage actually breaks is the difference between "every PDF
    // everywhere is broken" and "this one file is corrupt".
    pdfjsLib = await loadPdfjs();
  } catch (err) {
    await logPdfFailure("loadPdfjs", pdfPath, err);
    return null;
  }

  // Handed the whole file's bytes directly (`data`) rather than a `url` -
  // a `url` makes pdfjs run its own HTTP range-probing against the file
  // through ssfile://, and that's the exact code path that broke PDF
  // thumbnails before: even after the protocol handler was fixed to
  // forward Range headers (see main.ts's comment on that), pdfjs kept
  // throwing the same BaseException on that probe, which is why PdfTile
  // gave up on pdfjs entirely for the grid. A plain whole-file fetch - the
  // same kind of request <img>/<video> tags already make successfully
  // through this exact protocol, no Range involved - sidesteps that
  // whole code path rather than re-fighting it a third time.
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(toFileUrl(pdfPath));
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    await logPdfFailure("fetchBytes", pdfPath, err);
    return null;
  }

  try {
    loadingTask = pdfjsLib.getDocument({ data: bytes });
    const doc = await loadingTask.promise;
    return {
      numPages: doc.numPages,
      async renderPage(pageNum, maxWidth, maxHeight) {
        try {
          const page = await doc.getPage(pageNum);
          const unscaled = page.getViewport({ scale: 1 });
          if (!unscaled.width || !unscaled.height) return null;
          const scale = Math.min(maxWidth / unscaled.width, maxHeight / unscaled.height, 2);
          const viewport = page.getViewport({ scale: scale > 0 ? scale : 1 });

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));

          await page.render({ canvas, viewport }).promise;
          return canvas.toDataURL("image/jpeg", 0.9);
        } catch (err) {
          await logPdfFailure(`renderPage(${pageNum})`, pdfPath, err);
          return null;
        }
      },
      destroy() {
        void loadingTask?.destroy();
      },
    };
  } catch (err) {
    await logPdfFailure("getDocument", pdfPath, err);
    void loadingTask?.destroy();
    return null;
  }
}

const TARGET_WIDTH = 320;

/** Returns a `data:image/jpeg;...` URL of the PDF's first page, or null if
 *  the file couldn't be parsed/rendered (corrupt file, encrypted with no
 *  password, zero pages, etc.) - callers should fall back to the plain PDF
 *  glyph, not treat this as fatal. */
export async function renderPdfFirstPage(pdfPath: string): Promise<string | null> {
  let loadingTask: PdfLoadingTask | null = null;
  try {
    const pdfjsLib = await loadPdfjs();
    loadingTask = pdfjsLib.getDocument({ url: toFileUrl(pdfPath) });
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    if (!unscaled.width || !unscaled.height) return null;
    const scale = TARGET_WIDTH / unscaled.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch (err) {
    // TEMP DIAGNOSTIC: this renderer process has no console we can read
    // remotely, so hand the real failure back to a plain log file via the
    // main process (see main.ts's "debug:log" handler) instead of just
    // swallowing it - safe to remove once the underlying rendering issue is
    // confirmed fixed. Also now covers loadPdfjs() itself failing (loading
    // the pdfjs module/worker), which the old try block didn't wrap.
    try {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await window.smartsearch.debugLog(`renderPdfFirstPage failed for ${pdfPath}: ${detail}`);
    } catch {
      // Logging itself is best-effort - never let it mask the real failure.
    }
    return null;
  } finally {
    // Frees the parsed document's memory once we're done with it - without
    // this, rendering a folder full of PDFs one after another would leak
    // each document's worker-side state for the lifetime of the window.
    void loadingTask?.destroy();
  }
}
