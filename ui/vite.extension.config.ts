import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * The capture-client extension PAGES (self-serve plan T1/T2) — popup, crop, and options, all
 * thin HTTP clients of the ingest server. The embedded engine retired in T2, so no
 * storage-driver aliasing is needed; the viewer is served by the server itself.
 *
 * The service worker builds separately (vite.extension-sw.config.ts) so it can be a single
 * self-contained file — the shape both Chrome's worker and Firefox's event page accept.
 */
export default defineConfig({
  root: r('../src/extension'),
  base: './',
  build: {
    outDir: r('../dist-extension'),
    emptyOutDir: false, // the composition script owns the directory lifecycle
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: r('../src/extension/popup.html'),
        crop: r('../src/extension/crop.html'),
        options: r('../src/extension/options.html'),
      },
      // Stable names: the manifest points at popup.html / options.html directly.
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});
