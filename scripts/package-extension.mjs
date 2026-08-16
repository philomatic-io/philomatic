#!/usr/bin/env node
/**
 * pnpm package:extension — the release artifact for BOTH browsers: build the capture-client
 * extension, then zip each browser's dist versioned (from the manifest) into dist/. The zips
 * are what a GitHub release ships — zero build for testers, build output stays out of git.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const run = (cmd, cwd = r('..')) => execSync(cmd, { stdio: 'inherit', cwd });

run('node scripts/build-extension.mjs');

const { version } = JSON.parse(readFileSync(r('../src/extension/manifest.json'), 'utf8'));
mkdirSync(r('../dist'), { recursive: true });

const zips = [];
for (const [dir, label] of [
  ['dist-extension', 'chrome'],
  ['dist-extension-firefox', 'firefox'],
]) {
  const zip = `philomatic-extension-${label}-v${version}.zip`;
  run(`zip -qr ../dist/${zip} .`, r(`../${dir}`));
  zips.push(`dist/${zip}`);
}

console.log(`\npackaged → ${zips.join('  ')}`);
console.log(`release:  gh release create v${version} ${zips.join(' ')} --title "Philomatic v${version}"`);
