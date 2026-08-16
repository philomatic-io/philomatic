#!/usr/bin/env node
/**
 * pnpm build:extension — build the capture-client extension.
 *
 * The extension is a thin HTTP client of the self-hosted ingest server: no embedded
 * engine, no sql.js WASM, no bundled viewer (the server serves `ui/dist` itself — build that
 * with `pnpm ui:build`). This composes the service worker, popup, and options page into
 * `dist-extension/`, loadable unpacked or zipped as a release asset.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = r('../dist-extension');
const OUT_FF = r('../dist-extension-firefox');
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: r('..') });

rmSync(OUT, { recursive: true, force: true });
rmSync(OUT_FF, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. The extension pages' own typecheck (they need the DOM lib the engine tsconfig lacks).
run('pnpm exec tsc --noEmit -p src/extension/tsconfig.json');

// 2. The service worker, alone and self-contained (see vite.extension-sw.config.ts), then the
//    pages. Two passes because rollup allows inlineDynamicImports only for a single input.
run('pnpm --filter philomatic-ui exec vite build --config vite.extension-sw.config.ts');
run('pnpm --filter philomatic-ui exec vite build --config vite.extension.config.ts');

// 3. The manifests. ONE source of truth, two dialects: Chrome MV3
//    runs the background as a service worker and REJECTS `background.scripts`; Firefox MV3 has
//    no service-worker background and ignores `service_worker`, reading `scripts` instead. A
//    single manifest carrying both keys warns in both browsers, so each build gets its own.
// Icons ride along: without them Firefox shows a generic puzzle piece behind the unified
// extensions menu and the add-on looks like it never loaded.
cpSync(r('../src/extension/icons'), `${OUT}/icons`, { recursive: true });

const manifest = JSON.parse(readFileSync(r('../src/extension/manifest.json'), 'utf8'));
writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

const firefox = {
  ...manifest,
  // An event page, not a worker. `type: module` is deliberately absent: the sw build emits a
  // file with no import statements, so it loads as a classic script on either engine.
  background: { scripts: ['sw.js'] },
  // Gecko requires a stable id to install (temporarily or signed) and a floor version:
  // 115 is the first ESR with workable MV3 support.
  browser_specific_settings: { gecko: { id: 'philomatic@philomatic.io', strict_min_version: '115.0' } },
};
cpSync(OUT, OUT_FF, { recursive: true });
writeFileSync(`${OUT_FF}/manifest.json`, `${JSON.stringify(firefox, null, 2)}\n`);

console.log('\ncomposed → dist-extension/          (chrome://extensions → Load unpacked)');
console.log('composed → dist-extension-firefox/ (about:debugging → Load Temporary Add-on → manifest.json)');
