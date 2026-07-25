/**
 * orderedSources — what a step NUMBER is allowed to mean.
 *
 * Owner, 2026-07-23: "it's a little confusing to have sources numbered when there is no
 * prerequisite relation… a user would assume a prerequisite relationship when it's just based
 * on when they were added to the track."
 *
 * So a number means exactly one thing, on every surface: a place some PRECEDES edge actually
 * asserts. Everything else reads `·`. Inclusion order still decides where rows SIT — it just
 * no longer claims to be a reading order.
 */
import { describe, expect, it } from 'vitest';
import { orderedSources } from '../ui/src/lib/order';

const marks = (rows: { id: string; unordered?: boolean }[]) => rows.map((r) => (r.unordered ? '·' : 'n'));

describe('orderedSources', () => {
  it('a track with NO ordering edges numbers nothing', () => {
    const rows = orderedSources({ sourceIds: ['a', 'b', 'c'], sourceLevels: [], precedes: [] });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']); // inclusion order still places them
    expect(marks(rows)).toEqual(['·', '·', '·']); // …but claims no sequence
  });

  it('once a chain exists, its members are numbered and the rest trail as `·`', () => {
    const rows = orderedSources({
      sourceIds: ['a', 'b', 'loose'],
      sourceLevels: [['a'], ['b']],
      precedes: [{ srcId: 'a', dstId: 'b' }],
    });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'loose']);
    expect(marks(rows)).toEqual(['n', 'n', '·']);
  });

  it('co-requisites share a step', () => {
    const rows = orderedSources({
      sourceIds: ['a', 'b', 'c'],
      sourceLevels: [['a'], ['b', 'c']],
      precedes: [
        { srcId: 'a', dstId: 'b' },
        { srcId: 'a', dstId: 'c' },
      ],
    });
    expect(rows.map((r) => r.level)).toEqual([0, 1, 1]);
    expect(marks(rows)).toEqual(['n', 'n', 'n']);
  });

  it('without the precedes list it cannot tell ordered from untouched, and keeps the levels', () => {
    // The Graph passes a track view that carries levels but no edge list; guessing `·` there
    // would be worse than deferring to the engine's layering.
    const rows = orderedSources({ sourceIds: ['a', 'b'], sourceLevels: [['a'], ['b']] });
    expect(marks(rows)).toEqual(['n', 'n']);
  });
});
