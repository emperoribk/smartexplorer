import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
  optimizeDeps: {
    // pdfjs-dist ships its own worker file (pdf.worker.mjs) that has to be
    // the exact same build as the main-thread copy it talks to - the two
    // exchange messages across the worker boundary and expect to recognize
    // each other's internal classes. Vite's dependency pre-bundling
    // rewrites/hashes the main-thread copy into .vite/deps/ but leaves the
    // worker's own dynamic ?url import resolving to the untouched
    // node_modules file, so the two end up as mismatched copies - the
    // worker throws, and pdfjs's cross-thread error handling can only
    // reconstruct it as a bare, message-less Error on the main thread
    // (exactly the symptom seen: every PDF failing identically and
    // instantly). Excluding pdfjs-dist from pre-bundling keeps both sides
    // as the same untouched files, which is the fix Vite+pdfjs-dist
    // integrations generally need.
    exclude: ["pdfjs-dist"],
  },
});
