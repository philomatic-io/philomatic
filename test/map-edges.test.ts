/**
 * The shared map edge-drawing rule — one function, imported by BOTH the
 * workbench Map and the published track's map, because a hand-rolled twin of the pub map
 * would silently miss rule changes. Pinned: track spokes draw only to
 * concept HEADS and UNCLASSIFIED sources; nested concepts arrive via taxonomy ties,
 * classified sources via ABOUT; non-INCLUDES edges pass through untouched.
 */
import { describe, expect, it } from 'vitest';
import { minimalIncludesEdges } from '../ui/src/lib/map-edges';

const KIND: Record<string, string> = {
  syl_t: 'track',
  cpt_head: 'concept',
  cpt_nested: 'concept',
  src_classified: 'source',
  src_loose: 'source',
};
const kindOf = (id: string) => KIND[id];

const EDGES = [
  // membership: the track includes both concepts and both sources
  { srcId: 'syl_t', dstId: 'cpt_head', type: 'INCLUDES' },
  { srcId: 'syl_t', dstId: 'cpt_nested', type: 'INCLUDES' },
  { srcId: 'syl_t', dstId: 'src_classified', type: 'INCLUDES' },
  { srcId: 'syl_t', dstId: 'src_loose', type: 'INCLUDES' },
  // structure: nested sits under head (declared taxonomy); one source is ABOUT head
  { srcId: 'cpt_nested', dstId: 'cpt_head', type: 'LINK', tags: ['#TopicOf'] },
  { srcId: 'src_classified', dstId: 'cpt_head', type: 'ABOUT' },
];

describe('minimalIncludesEdges', () => {
  it('draws track spokes only to concept heads and unclassified sources', () => {
    const drawn = minimalIncludesEdges(EDGES, kindOf);
    const includes = drawn.filter((e) => e.type === 'INCLUDES').map((e) => e.dstId).sort();
    expect(includes).toEqual(['cpt_head', 'src_loose']); // nested + classified arrive via structure
    // the structural edges themselves always pass through
    expect(drawn.filter((e) => e.type !== 'INCLUDES')).toHaveLength(2);
  });

  it('with no structure, every membership spoke draws (nothing else can carry it)', () => {
    const bare = EDGES.filter((e) => e.type === 'INCLUDES');
    expect(minimalIncludesEdges(bare, kindOf)).toHaveLength(4);
  });
});
