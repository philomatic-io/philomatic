/**
 * Slice 5 — Track (scoped ordering, concept-optional). Covers the Definition of Done:
 *   - a concept-free source reading list assembles into PRECEDES order (the professor case)
 *   - a concept track assembles into a prerequisite-ordered path scoped to its members
 *   - the same source pair ordered oppositely in two tracks coexists (identity scoping)
 *   - an included concept whose prerequisite is outside the track warns (non-fatal)
 *   - tracks + scoped edges round-trip through storage
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { desugar } from '../src/io/sugar';
import { trackId } from '../src/schema/ids';

describe('Slice 5: track', () => {
  it('assembles a concept-free reading list in PRECEDES order (the professor case)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      sources: [
        { title: 'Lecture 1', modality: 'video' },
        { title: 'Lecture 2', modality: 'video' },
        { title: 'Lecture 3', modality: 'video' },
      ],
      tracks: [{ title: 'Course', order: ['Lecture 1', 'Lecture 2', 'Lecture 3'] }],
    });

    const r = engine.assemble(trackId('Course'));
    expect(r.total).toBe(0); // no concepts at all
    expect(r.sourceOrder.flat().map((s) => s.title)).toEqual(['Lecture 1', 'Lecture 2', 'Lecture 3']);
    engine.close();
  });

  it('scopes a concept path to the track and lists members transitively', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [
        { name: 'Addition' },
        { name: 'Multiplication', prerequisites: ['Addition'] },
        { name: 'Calculus', prerequisites: ['Multiplication'] }, // not in the track
      ],
      tracks: [{ title: 'Arithmetic', includes: ['Addition', 'Multiplication'] }],
    });

    const r = engine.assemble(trackId('Arithmetic'));
    expect(r.title).toBe('Arithmetic');
    expect(r.total).toBe(2); // Calculus is excluded
    expect(r.levels.map((l) => l.map((n) => n.name))).toEqual([['Addition'], ['Multiplication']]);
    engine.close();
  });

  it('files an included source under the concept it EXPLAINS, but never a non-member (the invariant)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication', prerequisites: ['Addition'] }],
      sources: [
        { title: 'Khan: Multiplication', modality: 'video', explains: ['Multiplication'] },
        { title: 'Other: Multiplication', modality: 'video', explains: ['Multiplication'] }, // not included
      ],
      tracks: [
        {
          title: 'Arithmetic',
          includes: ['Addition', 'Multiplication'],
          includeSources: ['Khan: Multiplication'],
        },
      ],
    });

    const r = engine.assemble(trackId('Arithmetic'));
    const mult = r.levels.flat().find((n) => n.name === 'Multiplication')!;
    // The explicit member is filed under the concept it explains...
    expect(mult.sources.map((s) => s.title)).toEqual(['Khan: Multiplication']);
    // ...and the non-included source that explains the same concept is nowhere in the assembly.
    const allTitles = [...r.levels.flat().flatMap((n) => n.sources), ...r.sourceOrder.flat()].map((s) => s.title);
    expect(allTitles).not.toContain('Other: Multiplication');
    // The filed source does not also appear in the loose reading list.
    expect(r.sourceOrder.flat()).toHaveLength(0);
    engine.close();
  });

  it('derives a track concept for free from an included source that EXPLAINS it (source-first)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Multiplication' }],
      sources: [{ title: 'Khan: Multiplication', modality: 'video', explains: ['Multiplication'] }],
      // The track includes only the source — no concept members at all.
      tracks: [{ title: 'Just Watch', includeSources: ['Khan: Multiplication'] }],
    });

    const r = engine.assemble(trackId('Just Watch'));
    expect(r.total).toBe(1); // Multiplication came along for free via EXPLAINS
    expect(r.levels.flat().map((n) => n.name)).toEqual(['Multiplication']);
    expect(r.levels.flat()[0]!.sources.map((s) => s.title)).toEqual(['Khan: Multiplication']);
    engine.close();
  });

  it('lets the same source pair be ordered oppositely in two tracks (identity scoping)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      sources: [
        { title: 'Ep I', modality: 'video' },
        { title: 'Ep IV', modality: 'video' },
      ],
      tracks: [
        { title: 'Release Order', order: ['Ep IV', 'Ep I'] },
        { title: 'Chronological', order: ['Ep I', 'Ep IV'] },
      ],
    });

    const release = engine.assemble(trackId('Release Order'));
    const chrono = engine.assemble(trackId('Chronological'));
    expect(release.sourceOrder.flat().map((s) => s.title)).toEqual(['Ep IV', 'Ep I']);
    expect(chrono.sourceOrder.flat().map((s) => s.title)).toEqual(['Ep I', 'Ep IV']);

    // Both orderings coexist as distinct rows (2 PRECEDES edges, opposite directions).
    const precedes = engine.exportAll().edges.filter((e) => e.type === 'PRECEDES');
    expect(precedes).toHaveLength(2);
    engine.close();
  });

  it('warns (non-fatally) when an included concept has a prerequisite outside the track', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication', prerequisites: ['Addition'] }],
      tracks: [{ title: 'Just Multiplication', includes: ['Multiplication'] }], // omits Addition
    });
    expect(report.ok).toBe(true); // it's a warning, not an error
    expect(report.warnings.map((w) => w.code)).toContain('external_prerequisite');
    engine.close();
  });

  it('detects a PRECEDES cycle within a track context', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      sources: [{ title: 'A', modality: 'text' }, { title: 'B', modality: 'text' }],
      tracks: [{ title: 'Loop', order: ['A', 'B', 'A'] }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('precedence_cycle');
    engine.close();
  });

  it('desugars a track into INCLUDES + scoped PRECEDES edges', () => {
    const p = desugar({
      version: 1,
      sources: [{ title: 'A', modality: 'text' }, { title: 'B', modality: 'text' }],
      tracks: [{ title: 'S', order: ['A', 'B'] }],
    });
    const sid = trackId('S');
    expect(p.tracks[0]).toMatchObject({ id: sid, creatorId: 'lnr_default', validationState: 'PENDING' });
    expect(p.edges).toContainEqual(
      expect.objectContaining({ srcType: 'track', srcId: sid, type: 'INCLUDES', dstType: 'source' }),
    );
    expect(p.edges).toContainEqual(
      expect.objectContaining({ type: 'PRECEDES', trackContextId: sid }),
    );
  });

  it('round-trips tracks and scoped edges through storage', () => {
    const engine = PhilomaticEngine.open();
    const imported = engine.importPayload({
      version: 1,
      sources: [{ title: 'A', modality: 'text' }, { title: 'B', modality: 'text' }],
      tracks: [{ title: 'S', goal: 'read in order', order: ['A', 'B'] }],
    });
    const exported = engine.exportAll();
    expect(exported.tracks).toEqual(imported.tracks);
    // Edges are identical up to ordering (export normalizes order for deterministic diffs).
    const byKey = (a: { srcId: string; dstId: string; type: string }, b: typeof a) =>
      `${a.srcId}|${a.dstId}|${a.type}`.localeCompare(`${b.srcId}|${b.dstId}|${b.type}`);
    expect([...exported.edges].sort(byKey)).toEqual([...imported.edges].sort(byKey));
    engine.close();
  });
});
