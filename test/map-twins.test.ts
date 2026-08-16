/**
 * Twin collapse for the map — the pure rule: nodes fold only on
 * IDENTICAL kind + inputs + outputs, the representative is stable, edges re-point and dedupe,
 * and an expanded group stays open.
 */
import { describe, expect, it } from 'vitest';
import { collapseTwins } from '../ui/src/lib/map-twins';

const node = (id: string, kind: string) => ({ id, kind });
const edge = (srcId: string, type: string, dstId: string, tags: string[] = []) => ({ srcId, dstId, type, tags });

// One source with three interchangeable passages, one passage that ALSO clarifies a concept,
// and two loose questions raised by the source.
const NODES = [
  node('src_a', 'source'),
  node('snp_1', 'snippet'), node('snp_2', 'snippet'), node('snp_3', 'snippet'),
  node('snp_x', 'snippet'), // same SNIPPET_OF, but also CLARIFIES — NOT a twin
  node('cpt_c', 'concept'),
  node('q_1', 'question'), node('q_2', 'question'),
];
const EDGES = [
  edge('snp_1', 'SNIPPET_OF', 'src_a'),
  edge('snp_2', 'SNIPPET_OF', 'src_a'),
  edge('snp_3', 'SNIPPET_OF', 'src_a'),
  edge('snp_x', 'SNIPPET_OF', 'src_a'),
  edge('snp_x', 'CLARIFIES', 'cpt_c'),
  edge('src_a', 'RAISES', 'q_1'),
  edge('src_a', 'RAISES', 'q_2'),
];

describe('collapseTwins', () => {
  it('folds identical-signature nodes per kind; different signatures stay', () => {
    const { nodes, twins } = collapseTwins(NODES, EDGES);
    const ids = nodes.map((n) => n.id);
    expect(twins.get('snp_1'), 'the three plain passages fold to the first').toEqual(['snp_1', 'snp_2', 'snp_3']);
    expect(ids).toContain('snp_x'); // the clarifying passage is no twin
    expect(twins.get('q_1'), 'the two open questions fold').toEqual(['q_1', 'q_2']);
    expect(ids).not.toContain('snp_2');
    expect(ids).not.toContain('q_2');
  });

  it('re-points and DEDUPES edges at the representative', () => {
    const { edges } = collapseTwins(NODES, EDGES);
    expect(edges.filter((e) => e.type === 'SNIPPET_OF')).toHaveLength(2); // rep + snp_x
    expect(edges.filter((e) => e.type === 'RAISES')).toHaveLength(1); // both questions → one line
  });

  it('an expanded group stays open; the others stay folded', () => {
    const { nodes, twins } = collapseTwins(NODES, EDGES, new Set(['snp_1']));
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('snp_2');
    expect(ids).toContain('snp_3');
    expect(twins.has('snp_1')).toBe(false);
    expect(twins.get('q_1')).toEqual(['q_1', 'q_2']);
  });

  it('edgeless nodes fold per kind (a hundred loose captures read as one counted node)', () => {
    const loose = [node('src_l1', 'source'), node('src_l2', 'source'), node('q_l', 'question')];
    const { nodes, twins } = collapseTwins(loose, []);
    expect(twins.get('src_l1')).toEqual(['src_l1', 'src_l2']);
    expect(nodes.map((n) => n.id)).toContain('q_l'); // alone in its kind — no fold
  });

  it('same signature but different KIND never folds together', () => {
    const mixed = [node('q_a', 'question'), node('q_b', 'question'), node('cpt_z', 'concept')];
    const es = [edge('src_o', 'RAISES', 'q_a'), edge('src_o', 'RAISES', 'q_b')];
    const { twins } = collapseTwins([node('src_o', 'source'), ...mixed], es);
    expect(twins.get('q_a')).toEqual(['q_a', 'q_b']);
    expect([...twins.keys()]).not.toContain('cpt_z');
  });
});
