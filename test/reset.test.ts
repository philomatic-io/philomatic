/**
 * The reset escape hatch (owner request, 2026-07-18): wipe the store and reinstantiate from an
 * exported payload — the pre-Phase-2 recovery move when something gets messed up. File
 * discipline mirrors migrate-v2: the old store is RENAMED to a timestamped backup, never
 * deleted, so "losing the history" means it moves to a file you can still open.
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

describe('PhilomaticEngine.resetDb', () => {
  it('backs the old store aside; a fresh import reinstantiates clean (no history)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-reset-'));
    const path = join(dir, 'store.sqlite');

    // A messy world: content + a removal (history) + an edit trail.
    const a = PhilomaticEngine.open(path);
    a.importPayload({
      version: 2,
      concepts: [{ name: 'Keep' }, { name: 'Mess' }],
      sources: [{ title: 'S', directUrl: 'https://example.com/s', modality: 'text' }],
    });
    a.remove({ ref: 'Mess' });
    const exported = a.exportLive(); // what the owner would reset FROM (their Share file)
    a.close();

    const { backupPath } = PhilomaticEngine.resetDb(path);
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath!)).toBe(true);
    expect(existsSync(path)).toBe(false); // the path is free for the fresh store

    const fresh = PhilomaticEngine.open(path);
    fresh.importPayload(exported);
    expect(fresh.snapshot().sources.map((s) => s.title)).toEqual(['S']);
    expect(fresh.removed()).toHaveLength(0); // history not carried — a clean slate
    expect(fresh.exportAll().events).toHaveLength(0);
    fresh.close();

    // The backup still opens and still holds the full history.
    const old = PhilomaticEngine.open(backupPath!);
    expect(old.removed().some((r) => r.kind === 'concept')).toBe(true);
    old.close();

    // Nothing was deleted: exactly the fresh store + the backup family live in the dir.
    expect(readdirSync(dir).some((f) => f.includes('.pre-reset-'))).toBe(true);
  });

  it('is a no-op for :memory: and missing files', () => {
    expect(PhilomaticEngine.resetDb(':memory:')).toEqual({});
    expect(PhilomaticEngine.resetDb('/tmp/definitely-not-a-real-store.sqlite')).toEqual({});
  });
});
