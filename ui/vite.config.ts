import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Swap node-only modules for browser stand-ins wherever the engine imports them — the
 *  workbench can run the engine in the tab, so the engine is reachable from this entry. */
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

/**
 * Dev: `vite dev` proxies every engine route to the local ingest server (its default port), so
 * the UI iterates hot against a live store. Build: static files the ingest server serves at
 * `GET /` (plan §2.1). `base: '/'` (absolute asset paths): the bundle is served from `/` AND
 * from `/t/<id>` (the publication page), where relative `./assets` would 404 — the old `'./'`
 * served an extension-page case that retired when the extension stopped bundling the viewer.
 */
const ENGINE_ROUTES = [
  '/health',
  '/snapshot',
  '/examples', // fork-first onboarding (capture-first S4)
  '/registry', // community registry proxy + fork (registry discovery RD-S2)
  '/registry-fork',
  '/asks', // 24h recommendation links (asks — SHIPPED § Asks)
  '/tracks',
  '/sources',
  '/snippets',
  '/assemble',
  '/removed',
  '/ingest',
  '/snippet',
  '/ask',
  '/answer',
  '/consume',
  '/unconsume',
  '/track',
  '/stage', // the staged lifecycle (capture-first S3)
  '/unstage',
  '/accept',
  '/reject',
  '/propose',
  '/propose-track',
  '/remove',
  '/restore',
  '/update',
  '/link',
  '/unlink', // was missing — unlink 404'd under ui:dev
  '/timeline',
  '/questions',
  '/relations',
  '/graph',
  '/export',
  '/import',
  '/framework',
  '/publish',
  '/unpublish',
  '/push',
  '/author',
  '/t', // public publication routes (page + .json)
  '/changes', // SSE — http-proxy streams it fine
];

export default defineConfig({
  build: {
    // ONE JS chunk on purpose: the static single-file export and the registry's page renderer
    // (src/cli/export-track.ts) inline exactly one script + one stylesheet into a
    // self-contained HTML file. Code-splitting (manualChunks) would emit chunks the lone file
    // can't fetch — do not "fix" the chunk-size warning that way.
    //
    // `import()` IS used now (B-S1.2: the in-browser engine boots after the backend choice is
    // known, and `App` must evaluate after that engine publishes its client). `inlineDynamicImports`
    // keeps the deferred EXECUTION while emitting one file anyway — the same tool, for the same
    // reason, as vite.public.config.ts.
    chunkSizeWarningLimit: 1800,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  plugins: [browserEngine(), react()],
  base: '/',
  server: {
    proxy: Object.fromEntries(ENGINE_ROUTES.map((r) => [r, 'http://127.0.0.1:4321'])),
  },
});
