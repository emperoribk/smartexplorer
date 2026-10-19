/** The actual Worker-thread entry point we hand to pdfjs-dist (see
 *  loadPdfjs in pdfThumbnail.ts) instead of pointing it directly at
 *  pdfjs-dist's own pdf.worker.mjs.
 *
 *  Why this file needs to exist at all: pdfjs-dist 6.x's bundles call a
 *  whole handful of VERY recently added JS builtins that this app's
 *  pinned Electron version (32.3.3) doesn't have yet, with no
 *  feature-detection of its own. Each one was found the same way: a PDF
 *  would fail, the debug log (see logPdfFailure in pdfThumbnail.ts) would
 *  show a new, different "X is not a function", and grepping both
 *  pdfjs-dist bundle files for that method name turned up more call sites
 *  than just the one that happened to crash first - so rather than fix
 *  these one at a time through another round of "try it, check the log,
 *  find the next one," this file polyfills everything that scan turned
 *  up in one pass:
 *
 *  - Uint8Array.prototype.toHex()/.toBase64(), Uint8Array.fromBase64() -
 *    used when computing a PDF's internal "fingerprint" on open (the
 *    first crash found, and what PdfTile's "pdfjs's worker never
 *    initialized correctly" regression actually was too - see
 *    FileGrid.tsx - never a worker-loading or Range-header problem).
 *  - Map/WeakMap.prototype.getOrInsert()/.getOrInsertComputed() (the
 *    "Upsert" proposal) - used throughout pdfjs-dist's caching code; the
 *    second crash found, once the fingerprint bug above was actually
 *    fixed. Polyfilled onto WeakMap too even though every call site found
 *    so far is on a plain Map - cheap insurance.
 *  - Set.prototype.intersection() - one call site; almost certainly
 *    already native here, included for completeness.
 *  - Promise.try() - called unguarded by pdfjs-dist's worker message
 *    dispatch; not yet confirmed as an actual failure, included because
 *    nothing here protects against it either.
 *
 *  The worker runs in its own JS realm (a separate `Worker` global), so a
 *  polyfill installed in the renderer's main thread (see
 *  installPdfjsBuiltinPolyfills in pdfThumbnail.ts - same list, kept as a
 *  separate plain-JS copy here rather than shared code, since the
 *  duplication is small and static and stringifying a real function would
 *  quietly break the moment one copy was edited without the other anyway)
 *  never reaches code running here - it has to run inside this file,
 *  before pdf.worker.mjs's own module code does.
 *
 *  First attempt at getting a polyfill into this realm: fetch
 *  pdf.worker.mjs's source as text and re-serve it with the polyfill
 *  spliced in front, via a blob: URL. That broke in a different way -
 *  Vite's dev server injects a root-relative HMR import into the .mjs
 *  response when it's fetched as plain text, and a blob: URL has no
 *  hierarchical base a root-relative import can resolve against, so the
 *  worker failed to set up at all.
 *
 *  This file is the real fix: a worker entry point we own, imported with
 *  Vite's own `?worker&url` suffix (see loadPdfjs), which asks Vite to
 *  bundle this file - resolving its own import of pdf.worker.mjs - into a
 *  proper worker chunk and hand back a loadable URL, in both dev and a
 *  packaged build, rather than us trying to reconstruct that ourselves.
 *  Static imports always fully evaluate before any of this file's own
 *  top-level statements run (true regardless of where the import line
 *  sits textually), so by the time pdf.worker.mjs's message handler can
 *  receive a real request and reach any of the methods above, this
 *  polyfill has already run. */
import "pdfjs-dist/build/pdf.worker.mjs";

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
