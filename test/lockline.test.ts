/**
 * The engine's lock line, mechanically enforced (ARCHITECTURE.md §7; ROADMAP §2.6).
 *
 * The frozen-core / command-layer / shell tiers are directories, so the lock line is an
 * import-graph property — this test makes violating it a CI failure instead of a review catch:
 *
 *   1. Shells (`src/cli`, `src/server`, `src/extension`) touch `src/` ONLY via the engine facade
 *      (`src/engine`). Id derivation, validation, and clobber-safety must stay single-source
 *      behind it. The chrome.runtime engine host (alpha UI plan §2.7) is a shell like the other
 *      two — import-checked by CI, not invisible to it.
 *   2. All writes funnel through `importPayload`: only the facade imports `storage/upsert`.
 *   3. The DB driver (better-sqlite3 / sql.js / drizzle-orm) stays under `src/storage` —
 *      principle #3's dialect seam has exactly one home, now with two residents (node + browser
 *      openers), which is precisely why the rule matters.
 *
 * Static string analysis over import/re-export specifiers; the codebase uses no dynamic imports.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ENGINE = join(SRC, 'engine');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Every `import … from '…'` / `export … from '…'` specifier in a file (multi-line safe). */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1]!,
  );
}

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/** Resolve a relative specifier against its importing file (extension-less, like the specifiers). */
const target = (file: string, spec: string): string => resolve(dirname(file), spec);

describe('the engine lock line (ARCHITECTURE.md §7)', () => {
  const all = tsFiles(SRC);

  it('shells (src/cli, src/server, src/extension) import src/ only via the engine facade', () => {
    const shells = all.filter(
      (f) => under(f, join(SRC, 'cli')) || under(f, join(SRC, 'server')) || under(f, join(SRC, 'extension')),
    );
    expect(shells.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of shells) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith('.')) continue; // packages/builtins are not the lock line's concern
        const t = target(file, spec);
        const inEngine = under(t, ENGINE);
        const inOwnDir = dirname(t) === dirname(file); // e.g. server/ingest ↔ server/adapters
        if (under(t, SRC) && !inEngine && !inOwnDir) violations.push(`${file} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('all writes funnel through importPayload: only the engine facade imports storage/upsert', () => {
    const upsert = join(SRC, 'storage', 'upsert');
    const allowed = join(ENGINE, 'index.ts');
    const violations: string[] = [];
    for (const file of all) {
      if (under(file, join(SRC, 'storage')) || file === allowed) continue;
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith('.') && target(file, spec) === upsert) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('within src/engine, only the facade touches storage (commands/read/capture are storage-free)', () => {
    const violations: string[] = [];
    for (const file of all) {
      if (!under(file, ENGINE) || file === join(ENGINE, 'index.ts')) continue;
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith('.') && under(target(file, spec), join(SRC, 'storage'))) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the DB driver stays under src/storage (the dialect seam has one home)', () => {
    const violations: string[] = [];
    for (const file of all) {
      if (under(file, join(SRC, 'storage'))) continue;
      for (const spec of importSpecifiers(file)) {
        if (spec === 'better-sqlite3' || spec === 'sql.js' || spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/')) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('the lock line applied externally (obsidian plan OB1)', () => {
  it('the obsidian workspace never imports repo src/ — a capability gap is a missing route', () => {
    const dir = resolve(SRC, '..', 'obsidian', 'src');
    if (!existsSync(dir)) return; // extracted to its own repo (OB-S6) — nothing to check
    const violations: string[] = [];
    for (const file of tsFiles(dir)) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith('.')) continue;
        if (under(target(file, spec), SRC)) violations.push(`${file} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
