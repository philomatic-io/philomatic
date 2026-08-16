/**
 * nextMoves — the next-reading moves, driven by explicit source
 * PRECEDES edges over the guarded-DFS topic structure. Strong connections only; moves may leave
 * the track by ONE hop.
 *
 *   deeper — same-topic successor (down the branch) OR a different-topic/out-of-track
 *            PREDECESSOR (descend into a foundation)
 *   wider  — a successor that leaves the topic or the track
 *   back   — a same-topic predecessor (review in-topic)
 */
import { describe, expect, it } from 'vitest';
import { nextMoves } from '../ui/src/lib/topics';

const concept = (id: string, name: string) => ({ id, name, tags: [], answered: false, sources: [], snippets: [], questions: [], following: false });
// Two topics: Topic One and Topic Two, each its own owner-main (no prereq between them → distinct topics).
const asm = {
  version: 2,
  levels: [[concept('c1', 'Topic One'), concept('c2', 'Topic Two')]],
  sourceOrder: [], total: 2, answeredCount: 0, openQuestions: [], corpusGaps: [], trackId: 'syl', title: 'T',
} as any;
const src = (id: string, about: string[], consumed = false) =>
  ({ id, title: id.toUpperCase(), modality: 'text', tags: [], about, consumed, staged: false }) as any;

// A,B,X under Topic One; F,G under Topic Two; OUT is about nothing / not a member.
const SOURCES = [
  src('a', ['Topic One']),
  src('b', ['Topic One']),
  src('x', ['Topic One']),
  src('f', ['Topic Two']),
  src('g', ['Topic Two']),
  src('out', []),
];
const graph = {
  version: 2,
  nodes: [
    { id: 'c1', kind: 'concept', label: 'Topic One', tags: [] },
    { id: 'c2', kind: 'concept', label: 'Topic Two', tags: [] },
    ...['a', 'b', 'x', 'f', 'g', 'out'].map((id) => ({ id, kind: 'source', label: id.toUpperCase(), tags: [] })),
  ],
  edges: [
    { srcId: 'syl', dstId: 'c1', type: 'INCLUDES', tags: [] },
    { srcId: 'syl', dstId: 'c2', type: 'INCLUDES', tags: [] },
    // reading order around B:
    { srcId: 'a', dstId: 'b', type: 'PRECEDES', tags: [] }, // A precedes B (same topic) → back
    { srcId: 'b', dstId: 'x', type: 'PRECEDES', tags: [] }, // B precedes X (same topic) → deeper
    { srcId: 'f', dstId: 'b', type: 'PRECEDES', tags: [] }, // F precedes B (diff topic) → deeper
    { srcId: 'b', dstId: 'g', type: 'PRECEDES', tags: [] }, // B precedes G (diff topic) → wider
    { srcId: 'b', dstId: 'out', type: 'PRECEDES', tags: [] }, // B precedes OUT (not a member) → wider
  ],
} as any;

const track = { id: 'syl', sourceIds: ['a', 'b', 'x', 'f', 'g'] }; // OUT is deliberately not a member
const moves = () => nextMoves(asm, graph, 'syl', SOURCES, 'b')!;

describe('nextMoves — deeper / wider / back over the guarded-DFS structure', () => {
  it('a same-topic PREDECESSOR is Go back', () => {
    expect(moves().back.map((m) => m.source.id)).toEqual(['a']);
  });

  it('a same-topic SUCCESSOR is Go deeper', () => {
    expect(moves().deeper.map((m) => m.source.id)).toContain('x');
  });

  it('a DIFFERENT-topic predecessor is Go deeper (descend into that foundation) — the TPL case', () => {
    expect(moves().deeper.map((m) => m.source.id)).toContain('f');
  });

  it('a successor that leaves the topic is Go wider', () => {
    expect(moves().wider.map((m) => m.source.id)).toContain('g');
  });

  it('an OUT-OF-TRACK successor still shows — one hop, as a wider move', () => {
    expect(moves().wider.map((m) => m.source.id)).toContain('out');
  });

  it('every move is a real PRECEDES edge — nothing inferred through concepts', () => {
    const all = [...moves().back, ...moves().deeper, ...moves().wider].map((m) => m.source.id).sort();
    expect(all).toEqual(['a', 'f', 'g', 'out', 'x']); // exactly B's direct neighbours
  });

  it('a consumed forward target is skipped (deeper/wider are what to read NEXT)', () => {
    const withConsumedX = SOURCES.map((s) => (s.id === 'x' ? { ...s, consumed: true } : s));
    const m = nextMoves(asm, graph, 'syl', withConsumedX, 'b')!;
    expect(m.deeper.map((s) => s.source.id)).not.toContain('x');
    expect(m.deeper.map((s) => s.source.id)).toContain('f'); // the foundation still shows
  });
});
