/**
 * Which PRECEDES edges order a track — `ordersTrack` in src/engine/read.ts.
 *
 * A PRECEDES may carry a track context. With one it is a claim about reading order inside that
 * track alone. WITHOUT one it is the general claim "A before B", so it holds in any track
 * containing both.
 *
 * Three surfaces ask this question — the snapshot's track layering, the focus view's loose
 * reading list, and the publication projection — and they used to answer it differently: the
 * first two demanded an exact context match while publication accepted context-less edges. The
 * result was a track ordered entirely by context-less edges that was NUMBERED on its published
 * page and UNNUMBERED in the workbench beside it. Nothing in the UI writes a context except
 * drag-ordering inside a track, so most real edges are context-less and hit exactly that hole.
 *
 * These tests pin all three surfaces to the same rule, which is the point: a lone test on one
 * of them would have passed throughout the bug.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { sourceId, trackId } from '../src/schema/ids';

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const SY = trackId('Logic');

/** Two sources in one track, ordered A → B by an edge carrying `context`. */
function seed(engine: PhilomaticEngine, context?: string): void {
  engine.importPayload({
    version: 1,
    tracks: [{ title: 'Logic', includeSources: ['First', 'Second'] }],
    sources: [
      { title: 'First', directUrl: A, modality: 'text' },
      { title: 'Second', directUrl: B, modality: 'text' },
    ],
    edges: [
      {
        srcType: 'source',
        srcId: sourceId({ title: 'First', directUrl: A }),
        type: 'PRECEDES',
        dstType: 'source',
        dstId: sourceId({ title: 'Second', directUrl: B }),
        ...(context !== undefined ? { trackContextId: context } : {}),
      },
    ],
  });
}

/** The track's layering, as titles, so a level split is legible in the failure message. */
function levels(engine: PhilomaticEngine): string[][] {
  const snap = engine.snapshot();
  const by = new Map(snap.sources.map((s) => [s.id, s.title]));
  const track = snap.tracks.find((t) => t.id === SY)!;
  return track.sourceLevels.map((level) => level.map((id) => by.get(id) ?? id));
}

/** The PRECEDES edges that survive into the track's public bundle. */
function precedesInPublication(engine: PhilomaticEngine): unknown[] {
  const edges = engine.publication(SY)!.payload.edges as unknown as { type: string }[];
  return edges.filter((e) => e.type === 'PRECEDES');
}

describe('a context-LESS PRECEDES orders every track containing both ends', () => {
  it('layers the snapshot track', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    expect(levels(engine)).toEqual([['First'], ['Second']]);
    engine.close();
  });

  it('reaches the publication projection too — the surface that always accepted it', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    engine.publish({ ref: SY, license: 'CC-BY-SA-4.0' });
    expect(precedesInPublication(engine)).toHaveLength(1);
    engine.close();
  });
});

describe('a PRECEDES scoped to THIS track orders it', () => {
  it('layers the snapshot track', () => {
    const engine = PhilomaticEngine.open();
    seed(engine, SY);
    expect(levels(engine)).toEqual([['First'], ['Second']]);
    engine.close();
  });
});

describe('a PRECEDES scoped to ANOTHER track does not', () => {
  it('leaves the members in one level, so nothing is numbered', () => {
    const engine = PhilomaticEngine.open();
    seed(engine, trackId('Something Else'));
    expect(levels(engine)).toHaveLength(1);
    engine.close();
  });

  it('is stripped from this track’s publication', () => {
    const engine = PhilomaticEngine.open();
    seed(engine, trackId('Something Else'));
    engine.publish({ ref: SY, license: 'CC-BY-SA-4.0' });
    expect(precedesInPublication(engine)).toHaveLength(0);
    engine.close();
  });
});
