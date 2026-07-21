/**
 * Concept ranks (owner request, 2026-07-18): frameworks declare WHICH tags form a hierarchy
 * (`hierarchy`/`hierarchyRole` — semantic tokens, never presentation); clients derive ranks.
 * Pinned here: the declarations exist on core's taxonomy tags, and the derivation classifies
 * field / subfield / topic / plain correctly, including the mixed cases.
 */
import { describe, expect, it } from 'vitest';
import { PHILOMATIC_CORE } from '../src/engine';
import { conceptRanks } from '../ui/src/lib/ranks';

describe('the taxonomy hierarchy declarations (F0)', () => {
  it('core declares #SubfieldOf as parent-link and #TopicOf as attachment', () => {
    const sub = PHILOMATIC_CORE.edgeTags.find((t) => t.name === 'SubfieldOf')!;
    const top = PHILOMATIC_CORE.edgeTags.find((t) => t.name === 'TopicOf')!;
    expect([sub.hierarchy, sub.hierarchyRole]).toEqual(['taxonomy', 'parent']);
    expect([top.hierarchy, top.hierarchyRole]).toEqual(['taxonomy', 'attachment']);
  });
});

describe('conceptRanks derivation', () => {
  const n = (id: string, kind = 'concept') => ({ id, kind });
  const e = (srcId: string, dstId: string, tag: string) => ({ srcId, dstId, tags: [tag] });

  it('classifies field / subfield / topic / plain, mixed cases included', () => {
    const ranks = conceptRanks(
      [n('stats'), n('applied'), n('descriptive'), n('normality'), n('loose'), n('src_x', 'source')],
      [
        e('applied', 'stats', '#SubfieldOf'),
        e('descriptive', 'stats', '#SubfieldOf'),
        e('normality', 'descriptive', '#TopicOf'),
        e('applied', 'loose', '#AnalogousTo'), // non-hierarchy tags never rank
      ],
    );
    expect(ranks.get('stats')).toBe('field'); // things under it, nothing above
    expect(ranks.get('applied')).toBe('subfield');
    expect(ranks.get('descriptive')).toBe('subfield'); // a subfield even though it also covers a topic
    expect(ranks.get('normality')).toBe('topic');
    expect(ranks.get('loose')).toBe('plain');
    expect(ranks.has('src_x')).toBe(false); // only concepts rank
  });

  it('a field with only topics (no subfields) still ranks as field', () => {
    const ranks = conceptRanks([n('geo'), n('maps')], [e('maps', 'geo', '#TopicOf')]);
    expect(ranks.get('geo')).toBe('field');
    expect(ranks.get('maps')).toBe('topic');
  });
});
