/**
 * The sql.js (browser) driver must behave like the node driver for the engine's write-both
 * verbs — regression for the silent unconsume (2026-07-19): sql.js reports no rows-affected,
 * so deleteEdge's `changes` check skipped the UNCONSUMED event and the old CONSUMED event
 * resurrected the edge on export→import replay (the demo's persistence cycle).
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

describe('browser driver (sql.js)', () => {
  it('unconsume reports changed, records the counter-event, and survives export→import replay', async () => {
    const e = await PhilomaticEngine.openBrowser({});
    e.captureSource({ url: 'https://ex.com/a', title: 'Paper A' });
    const id = e.snapshot().sources[0]!.id;
    e.consume(id);
    expect(e.snapshot().sources[0]!.consumed).toBe(true);

    const r = e.unconsume(id);
    expect(r.changed).toBe(true); // sql.js used to report false — the event was skipped
    expect(e.snapshot().sources[0]!.consumed).toBe(false);

    // The demo's persistence cycle: exportAll → fresh engine → importPayload.
    const payload = e.exportAll();
    const f = await PhilomaticEngine.openBrowser({});
    f.importPayload(payload);
    expect(f.snapshot().sources[0]!.consumed).toBe(false); // no resurrection
  });
});

describe('engine.link (the tie-writing seam)', () => {
  it('asserts with validation, idempotence, tags, and context; unlink is its inverse', async () => {
    const e = await PhilomaticEngine.openBrowser({});
    e.importPayload({ version: 2, concepts: [{ name: 'Alpha' }], sources: [{ title: 'Paper', modality: 'text' }] });
    const src = e.snapshot().sources[0]!;
    const cpt = e.assemble().levels.flat()[0]!;

    const r1 = e.link({ srcType: 'source', srcId: src.id, type: 'ABOUT', dstType: 'concept', dstId: cpt.id, tags: [{ name: 'explains' }] });
    expect(r1.created).toBe(true);
    const r2 = e.link({ srcType: 'source', srcId: src.id, type: 'ABOUT', dstType: 'concept', dstId: cpt.id, tags: [{ name: 'explains' }] });
    expect(r2.created).toBe(false); // idempotent
    expect(e.snapshot().sources[0]!.about).toContain('Alpha');

    // dangling target → the import pipeline's validation rejects it
    expect(() => e.link({ srcType: 'source', srcId: src.id, type: 'ABOUT', dstType: 'concept', dstId: 'cpt_nope', tags: [] })).toThrow();
    // behavioral types are not linkable
    expect(() => e.link({ srcType: 'learner', srcId: 'lnr_default', type: 'CONSUMED', dstType: 'source', dstId: src.id })).toThrow();

    expect(e.unlink({ srcId: src.id, type: 'ABOUT', dstId: cpt.id }).changed).toBe(true);
    expect(e.snapshot().sources[0]!.about).toHaveLength(0);
  });
});
