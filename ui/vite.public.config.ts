/**
 * The PUBLIC entry (public-pages plan PP-D2) — the small second bundle the server-rendered
 * public shells load: real workbench components (TrackMap, chips, form styles) rendering from
 * a data island, ~React runtime + what the pages import, nothing else.
 *
 * Separate config on purpose (same reason as the demo build): the MAIN build must stay
 * single-chunk with its script/style referenced from index.html for the export inliner
 * (src/cli/export-track.ts); this build emits FIXED names (assets/public.js, assets/public.css)
 * so the server shells can reference them without a manifest. emptyOutDir stays false — this
 * build lands beside the main one in dist/, never wiping it.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: r('./src/public/main.tsx'),
      output: {
        entryFileNames: 'assets/public.js',
        assetFileNames: (info) => (info.names.some((n) => n.endsWith('.css')) ? 'assets/public.css' : 'assets/[name]-[hash][extname]'),
        // One file like the main build: the shells load exactly public.js + public.css.
        inlineDynamicImports: true,
      },
    },
  },
});
