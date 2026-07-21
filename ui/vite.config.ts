import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    // self-contained HTML file. Code-splitting (manualChunks, dynamic import()) would emit
    // chunks the lone file can't fetch — do not "fix" the chunk-size warning that way.
    chunkSizeWarningLimit: 900,
  },
  plugins: [react()],
  base: '/',
  server: {
    proxy: Object.fromEntries(ENGINE_ROUTES.map((r) => [r, 'http://127.0.0.1:4321'])),
  },
});
