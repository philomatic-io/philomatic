import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * The service worker, built ALONE and SELF-CONTAINED (cross-browser pass, 2026-08-01).
 *
 * Chrome runs the background as a module service worker; Firefox's MV3 has no service worker
 * background at all — it reads `background.scripts` and runs an event page. A file with zero
 * `import` statements satisfies BOTH: Chrome loads it as a classic worker, Firefox as a classic
 * script. So this build gets its own pass with `inlineDynamicImports`, which rollup only allows
 * for a single input — hence the separate config from the pages build.
 */
export default defineConfig({
  root: r('../src/extension'),
  base: './',
  build: {
    outDir: r('../dist-extension'),
    emptyOutDir: false, // the composition script owns the directory lifecycle
    target: 'es2022',
    rollupOptions: {
      input: r('../src/extension/sw.ts'),
      output: { entryFileNames: 'sw.js', inlineDynamicImports: true, format: 'es' },
    },
  },
});
