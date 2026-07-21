#!/usr/bin/env node
/**
 * pnpm build:extension — build the capture-client extension (self-serve plan T1/T2).
 *
 * Since T2 the extension is a thin HTTP client of the self-hosted ingest server: no embedded
 * engine, no sql.js WASM, no bundled viewer (the server serves `ui/dist` itself — build that
 * with `pnpm ui:build`). This composes the service worker, popup, and options page into
 * `dist-extension/`, loadable unpacked or zipped as a release asset.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = r('../dist-extension');
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: r('..') });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. The extension pages' own typecheck (they need the DOM lib the engine tsconfig lacks).
run('pnpm exec tsc --noEmit -p src/extension/tsconfig.json');

// 2. Service worker + popup + options page.
run('pnpm --filter philomatic-ui exec vite build --config vite.extension.config.ts');

// 3. The manifest.
cpSync(r('../src/extension/manifest.json'), `${OUT}/manifest.json`);

console.log('\ncomposed → dist-extension/  (chrome://extensions → Load unpacked, or zip for a release)');
