/**
 * The demo build (owner request, 2026-07-19): the workbench + the ENGINE compiled for the
 * browser (sql.js/WASM), as static files the registry serves at /demo. Separate config on
 * purpose — the main build must stay single-chunk for the export inliner, and this one must
 * alias the node storage driver out of existence.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Swap node-only modules for browser stand-ins wherever the engine imports them. */
function browserEngine(): Plugin {
  return {
    name: 'browser-engine-aliases',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'node:fs') return r('./src/shims/node-fs.ts');
      if (source === 'node:path') return r('./src/shims/node-path.ts');
      if ((source.endsWith('/storage/db') || source === './db') && importer?.includes('/src/')) {
        return r('../src/storage/db-node-stub.browser.ts');
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [browserEngine(), react()],
  base: '/demo/',
  build: {
    outDir: 'dist-demo',
    chunkSizeWarningLimit: 1500, // engine + sql.js + workbench in one page; served locally by the registry
    rollupOptions: { input: r('./demo.html') },
  },
});
