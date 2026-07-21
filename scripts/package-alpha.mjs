#!/usr/bin/env node
/**
 * pnpm package:alpha — the M8 release artifact: build the self-contained extension, drop the
 * tester guide inside, and zip it versioned (from the manifest) into dist/. The zip is what a
 * GitHub release ships — zero build for testers, build output stays out of git.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const run = (cmd, cwd = r('..')) => execSync(cmd, { stdio: 'inherit', cwd });

run('node scripts/build-extension.mjs');
copyFileSync(r('../ALPHA.md'), r('../dist-extension/ALPHA.md'));

const { version } = JSON.parse(readFileSync(r('../src/extension/manifest.json'), 'utf8'));
const zip = `philomatic-extension-v${version}.zip`;
mkdirSync(r('../dist'), { recursive: true });
run(`zip -qr ../dist/${zip} .`, r('../dist-extension'));

console.log(`\npackaged → dist/${zip}`);
console.log(`release:  gh release create v${version} dist/${zip} --title "Philomatic alpha v${version}" --notes-file ALPHA.md`);
