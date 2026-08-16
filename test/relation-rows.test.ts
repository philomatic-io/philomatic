/**
 * One display row per MEANING: edge tags union-merge, so one edge can
 * carry several relation words and the row's × used to delete them all at once. Pinned: the
 * split (a multi-tag relation becomes one row per tag, each knowing the edge's full tag set)
 * and that single-tag/bare relations pass through untouched.
 */
import { describe, expect, it } from 'vitest';
import { splitRelationRows } from '../ui/src/lib/relations';

describe('splitRelationRows', () => {
  it('splits a multi-tagged relation into one row per tag, carrying allTags', () => {
    const rows = splitRelationRows([
      { tags: ['#DrawsOn', '#TopicOf'], otherId: 'cpt_x' },
      { tags: ['#Refines'], otherId: 'cpt_y' },
      { tags: [], otherId: 'cpt_z' },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ tags: ['#DrawsOn'], allTags: ['#DrawsOn', '#TopicOf'], otherId: 'cpt_x' });
    expect(rows[1]).toMatchObject({ tags: ['#TopicOf'], allTags: ['#DrawsOn', '#TopicOf'], otherId: 'cpt_x' });
    expect(rows[2]).toMatchObject({ tags: ['#Refines'], allTags: ['#Refines'] });
    expect(rows[3]).toMatchObject({ tags: [], allTags: [] });
  });
});
