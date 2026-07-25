/**
 * Un-assertion (owner ruling, 2026-07-18): a wrong structural edge must be as cheap to remove
 * as the concept editors made it to create. Interim shape — physical row deletion by full
 * coordinates (no ids, no event log; the inverse is re-assertion) — upgrading to true
 * retraction when the assertion layer mints edge ids (ROADMAP §2.3).
 */
import { describe, expect, it } from 'vitest';
import { CaptureError, PhilomaticEngine } from '../src/engine';

const tie = (srcId: string, dstId: string, tag?: string) => ({
  srcType: 'concept', srcId, type: 'LINK', dstType: 'concept', dstId,
  tags: tag !== undefined ? [{ name: tag }] : [],
});

describe('engine.unlink', () => {
  it('removes exactly the addressed edge; re-assertion is the undo', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 2,
      concepts: [{ name: 'Applied Statistics' }, { name: 'Statistics' }, { name: 'Normality' }],
      edges: [
        tie('cpt_applied-statistics', 'cpt_statistics', 'SubfieldOf'),
        tie('cpt_normality', 'cpt_descriptive-statistics', 'TopicOf'), // dangling dst? no — create it:
      ].slice(0, 1),
    });
    const has = () =>
      engine.relations('cpt_applied-statistics').some((r) => r.tags.includes('#SubfieldOf'));
    expect(has()).toBe(true);

    const res = engine.unlink({ srcId: 'cpt_applied-statistics', type: 'LINK', dstId: 'cpt_statistics' });
    expect(res.changed).toBe(true);
    expect(has()).toBe(false);
    // Gone again = no-op, honestly reported.
    expect(engine.unlink({ srcId: 'cpt_applied-statistics', type: 'LINK', dstId: 'cpt_statistics' }).changed).toBe(false);

    // The undo: re-import the identical edge.
    engine.importPayload({ version: 2, edges: [tie('cpt_applied-statistics', 'cpt_statistics', 'SubfieldOf')] });
    expect(has()).toBe(true);
    engine.close();
  });

  it('respects the track context coordinate (a scoped PRECEDES is its own row)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 2,
      sources: [
        { id: 'src_a', title: 'A', modality: 'text' },
        { id: 'src_b', title: 'B', modality: 'text' },
      ],
      tracks: [{ title: 'T', includeSources: ['A', 'B'], order: ['A', 'B'] }],
    });
    // Wrong coordinates (no context) touch nothing; the right ones remove the ordering edge.
    expect(engine.unlink({ srcId: 'src_a', type: 'PRECEDES', dstId: 'src_b' }).changed).toBe(false);
    expect(engine.unlink({ srcId: 'src_a', type: 'PRECEDES', dstId: 'src_b', trackContextId: 'syl_t' }).changed).toBe(true);
    engine.close();
  });

  it('refuses non-structural targets: overlay verbs and synthesized containment', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, sources: [{ id: 'src_a', title: 'A', modality: 'text' }] });
    engine.consume('src_a');
    expect(() => engine.unlink({ srcId: 'lnr_default', type: 'CONSUMED', dstId: 'src_a' })).toThrow(CaptureError);
    expect(() => engine.unlink({ srcId: 'snp_x', type: 'SNIPPET_OF', dstId: 'src_a' })).toThrow(/containment is a field/);
    engine.close();
  });
});
