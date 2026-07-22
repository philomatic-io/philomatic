#!/usr/bin/env node
/**
 * release-public — sync the public-safe subset of dev `main` to the public repo as a NORMAL,
 * STACKED commit (owner ruling 2026-07-21: public history accumulates; the earlier orphan cut
 * was a one-off remediation, not the process).
 *
 * What it does, without ever touching your working tree or switching branches:
 *   1. reads the tree of a source ref (default `main`) into a throwaway index;
 *   2. drops every top-level entry that isn't on the ALLOWLIST (private docs, plans, .claude…);
 *   3. GATES — aborts if anything outside the allowlist (or on the explicit DENY list) survives;
 *   4. writes that filtered tree and commits it with the CURRENT public HEAD as its parent, so
 *      the push is a fast-forward — no rewrite, no force, clones `git pull` cleanly;
 *   5. pushes the new commit to <remote>/main.
 *
 * Files are EXCLUDED BY DEFAULT: a new top-level entry is published only once you add it to
 * ALLOWLIST here. Private data never leaks by omission — only public files leak by omission,
 * which is the safe direction.
 *
 * Usage:
 *   node scripts/release-public.mjs -m "v0.x — <what changed>"     # cut + push
 *   node scripts/release-public.mjs --dry-run                       # build + gate + show, no push
 * Env: PUBLIC_REMOTE (default "public"), PUBLIC_BRANCH (default "main"), PUBLIC_SOURCE_REF (default "main").
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Top-level entries that make up the public repo. Add a new PUBLIC entry here to ship it. */
const ALLOWLIST = new Set([
  '.dockerignore',
  '.gitignore',
  'CONTRIBUTING.md',
  'DATA_MODEL.md',
  'Dockerfile',
  'LICENSE',
  'LICENSE-MIT',
  'PHILOSOPHY.md',
  'README.md',
  'docker-compose.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'browser',
  'docs',
  'examples',
  'obsidian',
  'scripts',
  'src',
  'test',
  'ui',
]);

/** Belt-and-suspenders: these must NEVER reach public even if the allowlist logic is edited. */
const DENY = new Set([
  '.claude',
  'ALPHA.md',
  'ARCHITECTURE.md',
  'DATA_GOVERNANCE.md',
  'GOVERNANCE.md',
  'MVP.md',
  'ROADMAP.md',
  'SPEC.md',
  'STRATEGY.md',
  'UX.md',
]);

const REMOTE = process.env.PUBLIC_REMOTE ?? 'public';
const BRANCH = process.env.PUBLIC_BRANCH ?? 'main';
const SOURCE_REF = process.env.PUBLIC_SOURCE_REF ?? 'main';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const message = flag('-m') ?? flag('--message');

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const topOf = (p) => p.split('/')[0];

// 0. Sanity + a friendly heads-up if uncommitted allowlisted edits won't be included.
git(['rev-parse', '--verify', `${SOURCE_REF}^{commit}`]);
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean);
const dirtyPublic = dirty.map((l) => l.slice(3)).filter((p) => ALLOWLIST.has(topOf(p)) && !DENY.has(topOf(p)));
if (dirtyPublic.length > 0) {
  console.warn(`⚠  Uncommitted changes to public files won't be included (release cuts from committed ${SOURCE_REF}):`);
  for (const p of dirtyPublic.slice(0, 10)) console.warn(`     ${p}`);
}

// 1. Get the current public HEAD — the parent for the new stacked commit.
git(['fetch', REMOTE, BRANCH]);
const parent = git(['rev-parse', `${REMOTE}/${BRANCH}`]);

// 2. Build the filtered tree in a THROWAWAY index (working tree untouched).
const dir = mkdtempSync(join(tmpdir(), 'pm-release-'));
const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
try {
  git(['read-tree', SOURCE_REF], { env });
  const top = git(['ls-tree', '--name-only', SOURCE_REF]).split('\n').filter(Boolean);
  const excluded = top.filter((e) => !ALLOWLIST.has(e) || DENY.has(e));
  if (excluded.length > 0) git(['rm', '-r', '--cached', '--quiet', '--', ...excluded], { env });

  // 3. GATE — nothing outside the allowlist, nothing on the deny list, may remain.
  const staged = git(['ls-files'], { env }).split('\n').filter(Boolean);
  const leaks = staged.filter((f) => !ALLOWLIST.has(topOf(f)) || DENY.has(topOf(f)));
  if (leaks.length > 0) fail(`allowlist gate: ${leaks.length} non-public path(s) would ship, e.g.\n     ${leaks.slice(0, 8).join('\n     ')}`);

  // 4. Write the tree; skip if public already matches (nothing to release).
  const tree = git(['write-tree'], { env });
  if (tree === git(['rev-parse', `${parent}^{tree}`])) {
    console.log(`\n✓ No public-facing changes since ${parent.slice(0, 9)} — nothing to release.\n`);
    process.exit(0);
  }

  const stat = git(['diff', '--stat', parent, tree]);
  const msg = message ?? `Public sync from ${SOURCE_REF} @ ${git(['rev-parse', '--short', SOURCE_REF])}`;
  console.log(`\nRelease → ${REMOTE}/${BRANCH}`);
  console.log(`  parent : ${parent.slice(0, 9)}  (stacks on top — fast-forward, no rewrite)`);
  console.log(`  files  : ${staged.length} (allowlisted only)`);
  console.log(`  message: ${msg}`);
  console.log(`\n${stat}\n`);

  if (DRY) {
    console.log('— dry run: no commit, no push —\n');
    process.exit(0);
  }

  // 5. Commit the filtered tree parented on public HEAD, and push as a fast-forward.
  const commit = git(['commit-tree', tree, '-p', parent, '-m', msg], { env });
  git(['push', REMOTE, `${commit}:refs/heads/${BRANCH}`]);
  console.log(`✓ Released ${commit.slice(0, 9)} → ${REMOTE}/${BRANCH}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
