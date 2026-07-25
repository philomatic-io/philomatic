/**
 * The track rename (owner ruling, 2026-07-18: "track everywhere; syllabus retires" — a
 * published track needs no second noun). Pinned here, forever:
 *   - legacy payloads (`syllabi:`, edge `syllabusContextId`, sugared source `syllabus:`)
 *     import unchanged — the vocabulary every pre-rename export speaks;
 *   - ids keep their `syl_` prefix (opaque historical artifact — no data migration, ever);
 *   - exports emit ONLY the `tracks` vocabulary.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { normalizeLegacyKeys } from '../src/io/migrate';

const LEGACY = {
  version: 2,
  syllabi: [{ title: 'Fairness 101', goal: 'learn fairness', includeSources: ['Paper A', 'Paper B'] }],
  sources: [
    { title: 'Paper A', directUrl: 'https://ex.com/a', modality: 'text' },
    { title: 'Paper B', directUrl: 'https://ex.com/b', modality: 'text' },
  ],
  edges: [
    {
      srcType: 'source', srcId: 'src_will_be_ignored', type: 'PRECEDES', dstType: 'source', dstId: 'src_also_ignored',
      syllabusContextId: 'syl_fairness-101',
    },
  ],
};

describe('track rename compatibility', () => {
  it('a pre-rename export (syllabi / syllabusContextId / source.syllabus) imports whole', () => {
    const engine = PhilomaticEngine.open();
    // Drop the synthetic edge (its endpoints are fake) — the KEY translation is what matters.
    engine.importPayload({ ...LEGACY, edges: [] });
    const snap = engine.snapshot();
    expect(snap.tracks.map((t) => t.title)).toEqual(['Fairness 101']);
    expect(snap.tracks[0]!.id).toBe('syl_fairness-101'); // the historical prefix survives
    expect(snap.tracks[0]!.sourceIds.length).toBe(2); // includeSources filed both in
    engine.close();
  });

  it('normalizeLegacyKeys translates every legacy key and leaves modern payloads IDENTICAL', () => {
    const norm = normalizeLegacyKeys(LEGACY) as Record<string, unknown>;
    expect(norm.tracks).toEqual(LEGACY.syllabi);
    expect(norm.syllabi).toBeUndefined();
    expect((norm.edges as Record<string, unknown>[])[0]!.trackContextId).toBe('syl_fairness-101');
    expect((norm.edges as Record<string, unknown>[])[0]!.syllabusContextId).toBeUndefined();

    const modern = { version: 2, tracks: [{ title: 'T' }] };
    expect(normalizeLegacyKeys(modern)).toBe(modern); // same reference — a true no-op
  });

  it('exports emit only the tracks vocabulary — legacy keys never round-trip out', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ ...LEGACY, edges: [] });
    const out = engine.exportAll() as unknown as Record<string, unknown>;
    expect(out.tracks).toBeDefined();
    expect(out.syllabi).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('syllabusContextId');
    engine.close();
  });
});
