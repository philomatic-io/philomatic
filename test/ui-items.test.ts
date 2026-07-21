/**
 * The unified item model (workbench redesign) — pure list shaping, pinned by the root suite:
 * cross-kind merge, kind-specific metadata lines, tag aggregation, and the kind/tag/query filter.
 */
import { describe, expect, it } from 'vitest';
import { allConcepts, allTags, buildItems, filterItems, railCounts } from '../ui/src/lib/items';
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
  { id: 'qst_1', text: 'Why converge?', asked: true, answered: false, gap: true, tags: ['#foundational'], about: ['Gradient Descent'], raisedBy: [{ kind: 'snippet', id: 'snp_1', label: 'chain rule' }], answeredBy: [] },
];

describe('unified item model', () => {
  const items = buildItems(snapshot, questions);

  it('merges four kinds with kind-specific metadata lines', () => {
    const meta = Object.fromEntries(items.map((i) => [i.id, i.meta]));
    expect(meta.src_a).toBe('text · 90 min');
    expect(meta.src_b).toBe('video'); // read state lives in the pill + Backlog facet now
    expect(meta.syl_1).toBe('1 source · Intro to DL'.replace(' · Intro to DL', '')); // no goal → just count
    expect(meta.snp_1).toBe('from DL Book');
    expect(meta.qst_1).toBe('raised while reading');
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
    expect(F({ concepts: new Set(['Gradient Descent']) }).map((i) => i.id)).toEqual(['src_a', 'qst_1']);
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
