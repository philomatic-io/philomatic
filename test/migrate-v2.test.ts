/**
 * Model v2 migration (implementation_plan_model_v2.md §3) — the ONE v1→v2 shim:
 *   - retired edge types collapse to LINK/ABOUT/INCLUDES + injected framework tags, with
 *     REFERENCE_FOR inverting endpoints and same-identity duplicates merging by tag union
 *   - SEMINAL folds onto the INCLUDES edge — the "seminal but not a member" orphan state
 *     becomes membership with a role tag
 *   - authored URL sources re-key (author left the id hash) and the cascade follows:
 *     snippet ids, edge endpoints, event targets. Never-authored ids survive unchanged;
 *     explicit human ids are never touched
 *   - the whole thing lands through importPayload({version:1,…}) with no caller involvement,
 *     and re-import (v2 export → import) is an idempotent no-op
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { migrateV1 } from '../src/io/migrate';
import { openDb } from '../src/storage/db';
import { legacySourceIdV1, snippetId, sourceId } from '../src/schema/ids';

const URL_AUTHORED = 'https://example.com/dl-ch6';
const AUTHOR = 'Goodfellow, Bengio, Courville';
const OLD_ID = legacySourceIdV1(URL_AUTHORED, AUTHOR);
const NEW_ID = sourceId({ title: 'DL Ch6', directUrl: URL_AUTHORED });

function v1Payload(): Record<string, unknown> {
  const oldSnp = snippetId({ sourceId: OLD_ID, text: 'The chain rule.' });
  return {
    version: 1,
    learners: [{ id: 'lnr_default', displayName: 'default' }],
    concepts: [{ id: 'cpt_backprop', name: 'Backprop', aliases: [], tags: [] }],
    sources: [
      { id: OLD_ID, title: 'DL Ch6', author: AUTHOR, directUrl: URL_AUTHORED, modality: 'text', status: 'active', tags: [] },
      { id: 'src_handbook', title: 'Handbook', modality: 'text', status: 'active', tags: [] }, // explicit id — untouched
    ],
    snippets: [{ id: oldSnp, sourceId: OLD_ID, text: 'The chain rule.', tags: [] }],
    questions: [],
    events: [{ learnerId: 'lnr_default', verb: 'STAGED', targetType: 'source', targetId: OLD_ID, occurredAt: 1720000000000 }],
    edges: [
      // Both collapse onto ONE ABOUT edge with the union of tags.
      { srcType: 'source', srcId: OLD_ID, type: 'EXPLAINS', dstType: 'concept', dstId: 'cpt_backprop', tags: [] },
      { srcType: 'source', srcId: OLD_ID, type: 'EXERCISES', dstType: 'concept', dstId: 'cpt_backprop', tags: [] },
      // Direction inversion: v1 "handbook is a reference FOR ch6" → v2 "ch6 RefersTo handbook".
      { srcType: 'source', srcId: 'src_handbook', type: 'REFERENCE_FOR', dstType: 'source', dstId: OLD_ID, tags: [] },
    ],
  };
}

describe('migrateV1 (pure)', () => {
  it('re-keys authored sources, cascades snippets/edges/events, collapses + merges edges', () => {
    const out = migrateV1(v1Payload()) as {
      version: number;
      sources: { id: string }[];
      snippets: { id: string; sourceId: string }[];
      events: { targetId: string }[];
      edges: { srcId: string; dstId: string; type: string; tags: { name: string }[] }[];
    };
    expect(out.version).toBe(2);
    expect(out.sources.map((s) => s.id)).toEqual([NEW_ID, 'src_handbook']);
    expect(out.snippets[0]).toMatchObject({ sourceId: NEW_ID, id: snippetId({ sourceId: NEW_ID, text: 'The chain rule.' }) });
    expect(out.events[0]!.targetId).toBe(NEW_ID);

    const about = out.edges.filter((e) => e.type === 'ABOUT');
    expect(about).toHaveLength(1); // EXPLAINS + EXERCISES merged
    expect(about[0]!.srcId).toBe(NEW_ID);
    expect(about[0]!.tags.map((t) => t.name).sort()).toEqual(['Exercises', 'Explains']);

    const link = out.edges.find((e) => e.type === 'LINK')!;
    // Inverted: the authored source now points at the handbook it refers to.
    expect(link).toMatchObject({ srcId: NEW_ID, dstId: 'src_handbook' });
    expect(link.tags).toContainEqual({ name: 'RefersTo' });
  });

  it('folds SEMINAL onto INCLUDES (membership + role, never an orphan role)', () => {
    const out = migrateV1({
      version: 1,
      tracks: [{ id: 'syl_t', creatorId: 'lnr_default', title: 'T', locked: false, validationState: 'PENDING', tags: [] }],
      sources: [{ id: 'src_a', title: 'A', modality: 'text', status: 'active', tags: [] }],
      edges: [
        { srcType: 'track', srcId: 'syl_t', type: 'INCLUDES', dstType: 'source', dstId: 'src_a', tags: [] },
        { srcType: 'track', srcId: 'syl_t', type: 'SEMINAL', dstType: 'source', dstId: 'src_a', tags: [] },
      ],
    }) as { edges: { type: string; tags: { name: string }[] }[] };
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ type: 'INCLUDES' });
    expect(out.edges[0]!.tags).toContainEqual({ name: 'Seminal' });
  });

  it('passes v2 payloads through untouched', () => {
    const v2 = { version: 2, edges: [] };
    expect(migrateV1(v2)).toBe(v2);
  });
});

describe('the shim inside importPayload (end to end)', () => {
  it('imports a v1 payload, reads back v2, and re-import of the export is a no-op', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(v1Payload());

    const out = engine.exportAll();
    expect(out.version).toBe(2);
    expect(out.sources.map((s) => s.id).sort()).toEqual([NEW_ID, 'src_handbook'].sort());
    // author survives as a plain attribute (only the id stopped depending on it)
    expect(out.sources.find((s) => s.id === NEW_ID)!.author).toBe(AUTHOR);
    expect(out.edges.some((e) => e.type === 'ABOUT' && e.srcId === NEW_ID)).toBe(true);

    engine.importPayload(out); // v2 round trip
    expect(engine.exportAll()).toEqual(out);
    engine.close();
  });

  it('a migrated #Seminal INCLUDES survives the sugar-emitted plain INCLUDES in the SAME payload', () => {
    // Regression pin: within-payload duplicates share one INSERT; without payload-level dedup
    // the sugar-emitted untagged INCLUDES clobbered the shim's #Seminal tags.
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      sources: [{ id: 'src_a', title: 'A', modality: 'text' }],
      tracks: [{ title: 'T', includeSources: ['A'] }], // sugar → plain INCLUDES
      edges: [{ srcType: 'track', srcId: 'syl_t', type: 'SEMINAL', dstType: 'source', dstId: 'src_a', tags: [] }],
    });
    const inc = engine.exportAll().edges.filter((e) => e.type === 'INCLUDES');
    expect(inc).toHaveLength(1);
    expect(inc[0]!.tags).toContainEqual({ name: 'Seminal' });
    engine.close();
  });

  it('edge-tag re-asserts merge by union (D5), not clobber', () => {
    const engine = PhilomaticEngine.open();
    const base = {
      concepts: [{ name: 'Backprop' }],
      sources: [{ id: 'src_a', title: 'A', modality: 'text' }],
    };
    engine.importPayload({ version: 2, ...base, edges: [{ srcType: 'source', srcId: 'src_a', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_backprop', tags: [{ name: 'Explains' }] }] });
    engine.importPayload({ version: 2, ...base, edges: [{ srcType: 'source', srcId: 'src_a', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_backprop', tags: [{ name: 'Exercises' }] }] });
    const edge = engine.exportAll().edges.find((e) => e.type === 'ABOUT')!;
    expect(edge.tags.map((t) => t.name).sort()).toEqual(['Exercises', 'Explains']);
    engine.close();
  });
});

describe('migrateDbV2 — the live store file (the alpha server DB case)', () => {
  it('rebuilds a pre-v2 DB at the same path, keeps a .v1-backup, and reads come back v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'philomatic-migrate-'));
    const path = join(dir, 'store.sqlite');

    // Write a genuinely legacy store: raw v1 rows straight into the tables (the schema layer
    // would rightly refuse to produce these today). The narrow SqliteConn type only exposes
    // close(); reach the underlying better-sqlite3 handle for raw INSERTs.
    const { sqlite } = openDb(path);
    const raw = sqlite as unknown as { prepare(q: string): { run(...args: unknown[]): unknown } };
    const now = 1720000000000;
    raw.prepare("INSERT INTO concepts (id, name, aliases, tags, created_at, updated_at) VALUES ('cpt_backprop','Backprop','[]','[]',?,?)").run(now, now);
    raw.prepare("INSERT INTO sources (id, title, modality, status, tags, created_at, updated_at) VALUES ('src_a','A','text','active','[]',?,?)").run(now, now);
    raw.prepare("INSERT INTO edges (src_type, src_id, edge_type, dst_type, dst_id, syllabus_context_id, tags) VALUES ('source','src_a','EXPLAINS','concept','cpt_backprop','','[]')").run();
    sqlite.close();

    const result = PhilomaticEngine.migrateDbV2(path);
    expect(result.migrated).toBe(true);
    expect(existsSync(result.backupPath!)).toBe(true);

    const engine = PhilomaticEngine.open(path);
    const edge = engine.exportAll().edges.find((e) => e.type === 'ABOUT')!; // reads validate again
    expect(edge.tags).toContainEqual({ name: 'Explains' });
    engine.close();

    // Idempotent: a second run is a no-op.
    expect(PhilomaticEngine.migrateDbV2(path)).toEqual({ migrated: false });
  });
});
