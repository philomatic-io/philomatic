/**
 * Taxonomy-as-grouping for the maps — the pure parts:
 * group derivation from DECLARED hierarchy (never tag literals), suppression of the ties a
 * hull expresses, and the padded-hull geometry that keeps 1–2 member groups renderable.
 */
import { describe, expect, it } from 'vitest';
import { declaredGroups, paddedHull, snippetGroups, suppressDeclaredGroupEdges, suppressGroupedSnippetEdges, suppressGroupedTaxonomyEdges, taxonomyGroups } from '../ui/src/lib/map-groups';

const KIND: Record<string, string> = { cpt_p: 'concept', cpt_a: 'concept', cpt_b: 'concept', src_s: 'source' };
const isConcept = (id: string) => KIND[id] === 'concept';

const EDGES = [
  { srcId: 'cpt_a', dstId: 'cpt_p', type: 'LINK', tags: ['#TopicOf'] },
  { srcId: 'cpt_b', dstId: 'cpt_p', type: 'LINK', tags: ['#SubfieldOf'] },
  { srcId: 'src_s', dstId: 'cpt_p', type: 'ABOUT' },
  { srcId: 'cpt_a', dstId: 'cpt_b', type: 'LINK', tags: ['#Refines'] }, // non-taxonomy LINK
];

describe('taxonomyGroups', () => {
  it('groups a parent with its #TopicOf and #SubfieldOf children (concepts only)', () => {
    const groups = taxonomyGroups(EDGES, isConcept);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.parentId).toBe('cpt_p');
    expect(groups[0]!.memberIds.sort()).toEqual(['cpt_a', 'cpt_b', 'cpt_p']);
  });
});

describe('suppressGroupedTaxonomyEdges', () => {
  it('drops only the ties the hull expresses; ABOUT and other LINKs pass', () => {
    const groups = taxonomyGroups(EDGES, isConcept);
    const kept = suppressGroupedTaxonomyEdges(EDGES, groups);
    expect(kept.map((e) => `${e.srcId}->${e.dstId}:${e.type}`).sort()).toEqual([
      'cpt_a->cpt_b:LINK', // #Refines is not hierarchy — stays
      'src_s->cpt_p:ABOUT',
    ]);
  });
});

describe('snippetGroups (owner request, 2026-08-10 — a source and its passages share a field)', () => {
  const KINDS: Record<string, string> = { src_a: 'source', src_b: 'source', snp_1: 'snippet', snp_2: 'snippet', snp_3: 'snippet', cpt_c: 'concept' };
  const kindOf = (id: string) => KINDS[id];
  const SNIP_EDGES = [
    { srcId: 'snp_1', dstId: 'src_a', type: 'SNIPPET_OF' },
    { srcId: 'snp_2', dstId: 'src_a', type: 'SNIPPET_OF' },
    { srcId: 'snp_3', dstId: 'src_b', type: 'SNIPPET_OF' },
    { srcId: 'src_a', dstId: 'cpt_c', type: 'ABOUT' },
    { srcId: 'snp_1', dstId: 'cpt_c', type: 'CLARIFIES' },
  ];

  it('groups each source with ITS passages, one hull per source', () => {
    const groups = snippetGroups(SNIP_EDGES, kindOf);
    expect(groups).toHaveLength(2);
    const byParent = new Map(groups.map((g) => [g.parentId, g.memberIds.sort()]));
    expect(byParent.get('src_a')).toEqual(['snp_1', 'snp_2', 'src_a']);
    expect(byParent.get('src_b')).toEqual(['snp_3', 'src_b']);
  });

  it('suppresses exactly the grouped SNIPPET_OF ties; anchors and ABOUT still draw', () => {
    const groups = snippetGroups(SNIP_EDGES, kindOf);
    const kept = suppressGroupedSnippetEdges(SNIP_EDGES, groups);
    expect(kept.map((e) => `${e.srcId}->${e.dstId}:${e.type}`).sort()).toEqual([
      'snp_1->cpt_c:CLARIFIES', // a passage's concept anchor is not containment — stays a line
      'src_a->cpt_c:ABOUT',
    ]);
  });

  it('an edge whose endpoints are not snippet→source never groups (no guessing)', () => {
    const groups = snippetGroups([{ srcId: 'cpt_c', dstId: 'src_a', type: 'SNIPPET_OF' }], kindOf);
    expect(groups).toEqual([]);
  });
});

describe('declaredGroups (FE-S1 — a render:"group" tag hulls like the taxonomy)', () => {
  const GTAGS = new Set(['PartOf']);
  const EDGES = [
    { srcId: 'a', dstId: 'head', type: 'LINK', tags: ['#PartOf'] },
    { srcId: 'b', dstId: 'head', type: 'LINK', tags: ['#PartOf:x'] }, // subtype matches the bare name
    { srcId: 'c', dstId: 'head', type: 'LINK', tags: ['#Other'] }, // not a group tag — stays a line
    { srcId: 'a', dstId: 'b', type: 'LINK', tags: ['#PartOf'] }, // a second, smaller group
  ];

  it('the DST end heads the group (taxonomy direction); one hull per head', () => {
    const groups = declaredGroups(EDGES, GTAGS);
    const byParent = new Map(groups.map((g) => [g.parentId, g.memberIds.sort()]));
    expect(byParent.get('head')).toEqual(['a', 'b', 'head']);
    expect(byParent.get('b')).toEqual(['a', 'b']);
  });

  it('suppresses exactly the grouped ties; ungrouped tags keep their lines', () => {
    const groups = declaredGroups(EDGES, GTAGS);
    const kept = suppressDeclaredGroupEdges(EDGES, groups, GTAGS);
    expect(kept.map((e) => `${e.srcId}->${e.dstId}`)).toEqual(['c->head']);
  });

  it('an empty tag set is a no-op', () => {
    expect(declaredGroups(EDGES, new Set())).toEqual([]);
    expect(suppressDeclaredGroupEdges(EDGES, [], new Set())).toHaveLength(EDGES.length);
  });
});

describe('paddedHull', () => {
  it('a single point becomes a ring (renderable, not degenerate)', () => {
    const hull = paddedHull([{ x: 0, y: 0 }], 20);
    expect(hull.length).toBeGreaterThanOrEqual(6);
    for (const p of hull) expect(Math.hypot(p.x, p.y)).toBeCloseTo(20, 5);
  });

  it('the hull contains every member with padding to spare', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }];
    const hull = paddedHull(pts, 10);
    const xs = hull.map((p) => p.x);
    const ys = hull.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThanOrEqual(-9);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(109);
    expect(Math.min(...ys)).toBeLessThanOrEqual(-9);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(89);
  });
});
