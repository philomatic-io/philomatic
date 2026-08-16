/**
 * lib/reorder — the ordering RULES, unit-tested (maintainability 1c). These are the rules the
 * views used to implement twice and disagree about; pinning them here means the next change
 * is one edit and a red test, not a bug report from two surfaces.
 */
import { describe, expect, it } from 'vitest';
import { applyPlan, invert, isEmpty, planAdd, planMove, planRemove, planUntieConcept, type Plan } from '../ui/src/lib/reorder';

const T = (over: Partial<{ sourceIds: string[]; precedes: { srcId: string; dstId: string }[]; sourceLevels: string[][] }> = {}) => ({
  id: 'syl_t',
  sourceIds: over.sourceIds ?? ['a', 'b', 'c'],
  sourceLevels: over.sourceLevels ?? [['a'], ['b'], ['c']],
  precedes: over.precedes ?? [{ srcId: 'a', dstId: 'b' }, { srcId: 'b', dstId: 'c' }],
});
const ids = (p: { dstId: string }[]) => p.map((e) => e.dstId);

describe('planAdd — membership only', () => {
  it('asserts INCLUDES and NO ordering', () => {
    const p = planAdd(T(), 'd');
    expect(p.link).toEqual([{ srcType: 'track', srcId: 'syl_t', type: 'INCLUDES', dstType: 'source', dstId: 'd' }]);
    expect(p.unlink).toEqual([]);
  });
  it('is a no-op for an existing member', () => expect(isEmpty(planAdd(T(), 'a'))).toBe(true));
});

describe('planRemove', () => {
  it('retracts membership AND every touching PRECEDES', () => {
    const p = planRemove(T(), 'b');
    expect(p.link).toEqual([]);
    expect(p.unlink).toHaveLength(3); // INCLUDES + a→b + b→c
    expect(p.unlink.filter((e) => e.type === 'PRECEDES')).toHaveLength(2);
  });
});

describe('planMove — the ↑ rule that was wrong twice', () => {
  const withTail = T({ sourceIds: ['a', 'b', 'c', 'tail'], sourceLevels: [['a'], ['b'], ['c'], ['tail']] });
  it('↑ on an UNORDERED member joins the chain as its LAST step (one pair, no rewrite)', () => {
    const p = planMove(withTail, 'tail', -1);
    expect(p.unlink).toEqual([]);
    expect(p.link).toHaveLength(1);
    expect(p.link[0]).toMatchObject({ srcId: 'c', dstId: 'tail', type: 'PRECEDES' });
  });
  it('↓ on an unordered member is a no-op — it is already at the bottom', () =>
    expect(isEmpty(planMove(withTail, 'tail', 1))).toBe(true));
  it('↑ within the chain swaps neighbours and rewrites it', () => {
    const p = planMove(T(), 'c', -1);
    expect(p.unlink).toHaveLength(2);
    expect(ids(p.link)).toEqual(['c', 'b']); // a→c, c→b
  });
  it('refuses to move past the ends', () => {
    expect(isEmpty(planMove(T(), 'a', -1))).toBe(true);
    expect(isEmpty(planMove(T(), 'c', 1))).toBe(true);
  });
});


describe('invert + applyPlan', () => {
  it('invert swaps assertions and retractions', () => {
    const p = planAdd(T(), 'd');
    expect(invert(p)).toEqual({ unlink: p.link, link: p.unlink });
  });
  it('applyPlan retracts first, then asserts ONE batch', async () => {
    const calls: string[] = [];
    const plan: Plan = planMove(T(), 'c', -1);
    await applyPlan(
      {
        unlink: async () => void calls.push('unlink'),
        importPayload: async () => void calls.push('import'),
      },
      plan,
    );
    expect(calls).toEqual(['unlink', 'unlink', 'import']);
  });
});


describe('planMove — a reorder must not conscript the unordered tail', () => {
  const withTail = {
    id: 'syl_t',
    sourceIds: ['a', 'b', 'c', 'tail'],
    sourceLevels: [['a'], ['b'], ['c'], ['tail']],
    precedes: [{ srcId: 'a', dstId: 'b' }, { srcId: 'b', dstId: 'c' }],
  };
  it('swapping two ORDERED members leaves the tail unordered', () => {
    const p = planMove(withTail, 'c', -1);           // a,b,c → a,c,b
    const ends = new Set(p.link.flatMap((e) => [e.srcId, e.dstId]));
    expect(ends.has('tail')).toBe(false);            // tail must NOT be chained in
    expect(p.link).toHaveLength(2);                  // a→c, c→b — the chain stays 3 long
  });
  it('↓ on the last ordered member does not swap it with an unordered one', () => {
    expect(isEmpty(planMove(withTail, 'c', 1))).toBe(true);
  });
});


describe('planUntieConcept — the × inside a tie chip (owner design 2026-07-23)', () => {
  const track = { id: 'syl', sourceIds: ['member'], sourceLevels: [['member']], precedes: [] };
  const stability = { id: 'cpt_stability', flavour: 'EXPLAINS' };

  it('cuts exactly the one tie you clicked', () => {
    const p = planUntieConcept(track, 'course', stability, ['cpt_stability', 'cpt_ultra']);
    expect(p.unlink).toHaveLength(1);
    expect(p.unlink[0]!.dstId).toBe('cpt_stability');
    expect(p.unlink[0]!.type).toBe('ABOUT');
  });

  it('leaves the source where it is while it still has another tie in the family', () => {
    const p = planUntieConcept(track, 'course', stability, ['cpt_stability', 'cpt_ultra']);
    expect(p.link).toHaveLength(0); // still shown under its other concept — no membership write
  });

  it('puts it on the track PATH when that was its last tie — or it would vanish', () => {
    // The owner's worked example: A Course in Model Theory is under "Model Theory" only by way
    // of Stability Theory. Cut that and it has nowhere left to appear.
    const p = planUntieConcept(track, 'course', stability, ['cpt_stability']);
    expect(p.link).toEqual([{ srcType: 'track', srcId: 'syl', type: 'INCLUDES', dstType: 'source', dstId: 'course' }]);
  });

  it('does not re-assert membership for a source already on the path', () => {
    const p = planUntieConcept(track, 'member', stability, ['cpt_stability']);
    expect(p.link).toHaveLength(0);
  });

  // THE RULE, decided explicitly: the trigger is SOURCE-side.
  // The alternative — trigger on the CONCEPT having no other sources — differs exactly here,
  // and makes the source vanish from the track with no trace. Real case from the owner's data:
  // "A Shorter Model Theory" is tied ONLY to "Model Theory", while "Model Theory" also holds
  // Chang & Keisler and Marker. Cutting that chip must still land Hodges on the path.
  it('moves the source even when the CONCEPT still has other sources', () => {
    const p = planUntieConcept(track, 'hodges', { id: 'cpt_model_theory', flavour: 'EXPLAINS' }, ['cpt_model_theory']);
    expect(p.link).toEqual([{ srcType: 'track', srcId: 'syl', type: 'INCLUDES', dstType: 'source', dstId: 'hodges' }]);
    // The concept's other sources are not even an input — that is the ruling, structurally.
  });

  it('carries the FLAVOUR, so Ctrl+Z restores the edge as it was', () => {
    const p = planUntieConcept(track, 'course', { id: 'cpt_x', flavour: 'CRITIQUES' }, ['cpt_x', 'cpt_y']);
    expect(invert(p).link).toEqual([
      { srcType: 'source', srcId: 'course', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_x', tags: [{ name: 'CRITIQUES' }] },
    ]);
  });
});
