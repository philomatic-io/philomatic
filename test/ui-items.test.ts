/**
 * The unified item model (workbench redesign) — pure list shaping, pinned by the root suite:
 * cross-kind merge, kind-specific metadata lines, tag aggregation, and the kind/tag/query filter.
 */
import { describe, expect, it } from 'vitest';
import { allConcepts, allTags, buildItems, filterItems, railCounts } from '../ui/src/lib/items';
import { readingWithConcepts } from '../ui/src/lib/topics';
import type { QuestionView, Snapshot } from '../ui/src/client/types';

const snapshot: Snapshot = {
  version: 1,
  tracks: [{ id: 'syl_1', title: 'Intro to DL', tags: ['#level:intro'], sourceIds: ['src_a'], sourceLevels: [['src_a']], precedes: [] }],
  sources: [
    { id: 'src_a', title: 'DL Book', modality: 'text', tags: ['#difficulty:4'], about: ['Gradient Descent'], estimatedDurationMins: 90, consumed: false, staged: true },
    { id: 'src_b', title: '3B1B', modality: 'video', tags: ['#visual'], about: ['Backprop'], consumed: true, staged: false },
  ],
  snippets: [{ id: 'snp_1', text: 'chain rule', sourceId: 'src_a', source: 'DL Book', clarifies: ['Backprop'], contradicts: [], tags: ['#key'], raises: [] }],
};
const questions: QuestionView[] = [
  { id: 'qst_1', text: 'Why converge?', asked: true, answered: false, gap: true, tags: ['#foundational'], about: ['Gradient Descent'], raisedBy: [{ kind: 'snippet', id: 'snp_1', label: 'chain rule', sourceTitle: 'DL Book' }], answeredBy: [] },
];

describe('unified item model', () => {
  const items = buildItems(snapshot, questions);

  it('merges four kinds with kind-specific metadata lines', () => {
    const meta = Object.fromEntries(items.map((i) => [i.id, i.meta]));
    expect(meta.src_a).toBe('text · 90 min');
    expect(meta.src_b).toBe('video'); // read state lives in the pill + Backlog facet now
    expect(meta.syl_1).toBe('1 source · Intro to DL'.replace(' · Intro to DL', '')); // no goal → just count
    expect(meta.snp_1).toBe('from DL Book');
    expect(meta.qst_1).toBe('raised by DL Book'); // the snippet's owning source, not 'raised while reading'
  });

  const F = (opts: Partial<Parameters<typeof filterItems>[1]>) =>
    filterItems(items, { kind: 'all', tags: new Set(), concepts: new Set(), query: '', ...opts });

  it('counts per kind and aggregates tags + concepts across kinds', () => {
    expect(railCounts(items)).toEqual({ all: 5, backlog: 1, track: 1, concept: 0, source: 2, question: 1, snippet: 1 });
    expect(allTags(items)).toEqual(['#difficulty:4', '#foundational', '#key', '#level:intro', '#visual']);
    expect(allConcepts(items)).toEqual(['Backprop', 'Gradient Descent']);
  });

  it('filters by kind, ordered by title', () => {
    expect(F({ kind: 'source' }).map((i) => i.id)).toEqual(['src_b', 'src_a']);
  });

  it('the read-state filter narrows sources; other kinds always pass (derived, never stored)', () => {
    const unreadSources = F({ readState: 'unread' }).filter((i) => i.kind === 'source');
    expect(unreadSources.length).toBe(1);
    expect(unreadSources.every((i) => i.unread === true)).toBe(true);
    expect(F({ readState: 'unread' }).some((i) => i.kind !== 'source')).toBe(true); // non-sources untouched
    const readSources = F({ readState: 'read' }).filter((i) => i.kind === 'source');
    expect(readSources.every((i) => i.unread !== true)).toBe(true);
    expect(F({ readState: 'all' }).length).toBe(F({}).length);
  });

  it('excludedTags hide items regardless of the include facet (the reference-shelf preference)', () => {
    const visible = F({ excludedTags: new Set(['#visual']) });
    expect(visible.some((i) => i.id === 'src_b')).toBe(false);
    expect(visible.some((i) => i.id === 'src_a')).toBe(true);
    // Exclusion beats inclusion: selecting the tag while it is excluded still shows nothing.
    expect(F({ tags: new Set(['#visual']), excludedTags: new Set(['#visual']) })).toHaveLength(0);
  });

  it('filters by tag (OR within the facet)', () => {
    expect(F({ tags: new Set(['#visual']) }).map((i) => i.id)).toEqual(['src_b']);
  });

  it('filters by concept across kinds (OR within): Backprop touches src_b + snp_1', () => {
    expect(F({ concepts: new Set(['Backprop']) }).map((i) => i.id)).toEqual(['src_b', 'snp_1']);
    // A TRACK is now about the concepts its members are (owner, 2026-07-23: topic chips on the
    // card), so it joins the concept facet too — syl_1's member src_a is about Gradient Descent.
    expect(F({ concepts: new Set(['Gradient Descent']) }).map((i) => i.id)).toEqual(['syl_1', 'src_a', 'qst_1']);
  });

  it('AND across facets: concept Backprop AND kind source → only src_b', () => {
    expect(F({ kind: 'source', concepts: new Set(['Backprop']) }).map((i) => i.id)).toEqual(['src_b']);
  });

  it('free-text query matches title or tag', () => {
    expect(F({ query: 'converge' }).map((i) => i.id)).toEqual(['qst_1']);
    expect(F({ query: 'key' }).map((i) => i.id)).toEqual(['snp_1']);
  });

  it('orders by kind (rail order) then title', () => {
    expect(F({}).map((i) => i.kind)).toEqual(['track', 'source', 'source', 'question', 'snippet']);
  });
});

describe('track meta — a track counts its MEMBERS, not its candidate pool (invariant, 2026-07-23)', () => {
  // A track with NO member sources, whose reading comes from the concepts it includes.
  const asm = {
    version: 2,
    levels: [[{ id: 'cpt_a', name: 'Alpha', tags: [], answered: false, sources: [], snippets: [], questions: [], following: false }]],
    sourceOrder: [],
    total: 1,
    answeredCount: 0,
    openQuestions: [],
    corpusGaps: [],
    trackId: 'syl_c',
    title: 'Concept Track',
  } as any;
  const graph = {
    version: 2,
    nodes: [{ id: 'cpt_a', kind: 'concept', label: 'Alpha', tags: [] }],
    edges: [{ srcId: 'syl_c', dstId: 'cpt_a', type: 'INCLUDES', tags: [] }],
  } as any;
  const snapshot = {
    tracks: [{ id: 'syl_c', title: 'Concept Track', goal: 'a roadmap', sourceIds: [], sourceLevels: [], precedes: [], tags: [] }],
    sources: [
      { id: 'src_1', title: 'One', modality: 'text', tags: [], about: ['Alpha'], consumed: false, staged: false },
      { id: 'src_2', title: 'Two', modality: 'text', tags: [], about: ['Alpha'], consumed: false, staged: false },
    ],
    snippets: [],
  } as any;

  it('names its concepts but counts only MEMBERS — the two sources ABOUT Alpha are candidates', () => {
    // A concept contributes framing, not content. The track has NO members, so it reports its
    // concept count and "0 sources" honestly, rather than counting the pool as if it were the
    // reading (the pre-invariant behaviour, which auto-pulled everything about Alpha).
    const [track] = buildItems(snapshot, [], [], { asm, graph });
    expect(track!.meta).toBe('1 concept · 0 sources · a roadmap');
  });

  it('without a projection it falls back to the member count', () => {
    const [track] = buildItems(snapshot, [], []);
    expect(track!.meta).toBe('0 sources · a roadmap');
  });

  it('the meta shows concepts AND sources uniformly — no anchor-mode branch (2026-07-23)', () => {
    const s = { ...snapshot, tracks: [{ ...snapshot.tracks[0], sourceIds: ['src_1', 'src_2'] }] };
    // A track that includes a concept AND has members now reports both, the same shape a
    // concepts-only track uses — the "source-anchored vs concept-anchored" split is gone.
    expect(buildItems(s, [], [], { asm, graph })[0]!.meta).toBe('1 concept · 2 sources · a roadmap');
  });
});

describe('readingWithConcepts — a source-anchored track by concept (owner bug 2026-07-23)', () => {
  const asm = {
    version: 2,
    levels: [[{ id: 'cpt_p', name: 'Programming Problems', tags: [], answered: false, sources: [], snippets: [], questions: [], following: false }]],
    sourceOrder: [], total: 1, answeredCount: 0, openQuestions: [], corpusGaps: [], trackId: 't', title: 'T',
  } as any;
  const graph = { version: 2, nodes: [{ id: 'cpt_p', kind: 'concept', label: 'Programming Problems', tags: [] }], edges: [] } as any;
  const track = { id: 'syl_p', sourceIds: ['s1', 's2', 's3'], sourceLevels: [['s1'], ['s2'], ['s3']], precedes: [{ srcId: 's1', dstId: 's2' }, { srcId: 's2', dstId: 's3' }] };
  const sources = [
    { id: 's1', title: 'One', modality: 'text', tags: [], about: [], consumed: false, staged: false },
    { id: 's2', title: 'Two', modality: 'text', tags: [], about: ['Programming Problems'], consumed: false, staged: false },
    { id: 's3', title: 'Three', modality: 'text', tags: [], about: [], consumed: false, staged: false },
  ] as any;

  it('lists EVERY member in reading order — untied sources are not dropped', () => {
    const rows = readingWithConcepts(asm, graph, track, sources);
    expect(rows.map((r) => r.source.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('attaches the concept only to the source that carries it', () => {
    const rows = readingWithConcepts(asm, graph, track, sources);
    expect(rows.map((r) => r.ties.map((t) => t.name))).toEqual([[], ['Programming Problems'], []]);
  });
});
