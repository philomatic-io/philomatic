/**
 * lib/reorder — the ordering RULES, unit-tested (maintainability 1c). These are the rules the
 * views used to implement twice and disagree about; pinning them here means the next change
 * is one edit and a red test, not a bug report from two surfaces.
 */
import { describe, expect, it } from 'vitest';
import { applyPlan, invert, isEmpty, planAdd, planMove, planPlace, planRemove, type Plan } from '../ui/src/lib/reorder';

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

describe('planPlace — drag zones', () => {
  it('ABOVE makes the dragged source the target’s prerequisite', () => {
    const p = planPlace(T(), 'a', { aboveId: 'c' });
    expect(p.link).toContainEqual(expect.objectContaining({ srcId: 'c', dstId: 'a', type: 'PRECEDES' }));
  });
  it('BELOW makes it the post-requisite', () => {
    const p = planPlace(T(), 'a', { belowId: 'c' });
    expect(p.link).toContainEqual(expect.objectContaining({ srcId: 'a', dstId: 'c', type: 'PRECEDES' }));
  });
  it('CO-REQ shares the target’s predecessors (same step)', () => {
    const p = planPlace(T(), 'a', { coreqId: 'c' });
    expect(p.link).toContainEqual(expect.objectContaining({ srcId: 'b', dstId: 'a' }));
  });
  it('a NON-MEMBER dragged in is an ADD — membership only, never ordered (owner 2026-07-23)', () => {
    const p = planPlace(T(), 'z', { belowId: 'a' });
    expect(p.link).toEqual([{ srcType: 'track', srcId: 'syl_t', type: 'INCLUDES', dstType: 'source', dstId: 'z' }]);
    expect(p.link.some((e) => e.type === 'PRECEDES')).toBe(false);
  });
  it('the palette drag and the add button agree exactly', () => {
    expect(planPlace(T(), 'z', { aboveId: 'b', belowId: 'c' })).toEqual(planAdd(T(), 'z'));
  });
  it('self-coreq is meaningless', () => expect(isEmpty(planPlace(T(), 'a', { coreqId: 'a' }))).toBe(true));
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

describe('planPlace — the unordered tail stays unordered (owner bug 2026-07-22)', () => {
  // a,b,c are ordered; tail1/tail2 are members no PRECEDES touches
  const withTail = {
    id: 'syl_t',
    sourceIds: ['a', 'b', 'c', 'tail1', 'tail2'],
    sourceLevels: [['a'], ['b'], ['c'], ['tail1'], ['tail2']],
    precedes: [{ srcId: 'a', dstId: 'b' }, { srcId: 'b', dstId: 'c' }],
  };
  it('dropping at the very bottom asserts NO ordering — membership only', () => {
    const p = planPlace(withTail, 'z', { aboveId: 'tail2' });
    expect(p.link).toEqual([{ srcType: 'track', srcId: 'syl_t', type: 'INCLUDES', dstType: 'source', dstId: 'z' }]);
  });
  it('an unordered MEMBER dropped between ordered items JOINS the chain at that position', () => {
    const p = planPlace(withTail, 'tail1', { aboveId: 'a', belowId: 'b' });
    // the chain is rewritten a → tail1 → b → c
    expect(ids(p.link)).toEqual(['tail1', 'b', 'c']);
    expect(p.unlink).toHaveLength(2); // the old chain is retracted first
  });
  it('an existing member dragged to the bottom writes nothing at all', () => {
    expect(isEmpty(planPlace(withTail, 'tail1', { aboveId: 'tail2' }))).toBe(true);
  });

  it('co-req onto an unordered row asserts nothing', () => {
    expect(isEmpty(planPlace(withTail, 'tail1', { coreqId: 'tail2' }))).toBe(true);
  });
  it('on a track with NO ordering, a MEMBER drop still bootstraps the first pair', () => {
    const flat = { id: 'syl_t', sourceIds: ['a', 'b'], sourceLevels: [['a', 'b']], precedes: [] };
    const p = planPlace(flat, 'b', { aboveId: 'a' });
    expect(p.link).toContainEqual(expect.objectContaining({ srcId: 'a', dstId: 'b', type: 'PRECEDES' }));
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

describe('planPlace — drag-to-reorder inside an ordered chain (owner report 2026-07-23)', () => {
  const T3 = () => ({
    id: 'syl_t',
    sourceIds: ['a', 'b', 'c'],
    sourceLevels: [['a'], ['b'], ['c']],
    precedes: [{ srcId: 'a', dstId: 'b' }, { srcId: 'b', dstId: 'c' }],
  });
  it('moving the LAST item to the front rewrites the chain instead of cycling', () => {
    // Additively this asserted c→a on top of a→b→c — a cycle the engine rejected.
    const p = planPlace(T3(), 'c', { belowId: 'a' });
    expect(p.unlink).toHaveLength(2);        // old chain retracted
    expect(ids(p.link)).toEqual(['a', 'b']); // c → a → b
    expect(p.link[0]).toMatchObject({ srcId: 'c', dstId: 'a' });
  });
  it('moving the FIRST item to the end rewrites the chain', () => {
    const p = planPlace(T3(), 'a', { aboveId: 'c' });
    expect(ids(p.link)).toEqual(['c', 'a']); // b → c → a
  });
  it('a plan that changes nothing is a no-op', () => {
    expect(isEmpty(planPlace(T3(), 'b', { aboveId: 'a', belowId: 'c' }))).toBe(true);
  });
  it('the inverse restores the original chain exactly', () => {
    const t = T3();
    const p = planPlace(t, 'c', { belowId: 'a' });
    const back = invert(p);
    expect(ids(back.link)).toEqual(['b', 'c']); // a → b → c, the original
  });
  it('co-req onto an ordered item pulls the dragged item out of the chain first', () => {
    const p = planPlace(T3(), 'c', { coreqId: 'b' });
    // c had b→c; that is retracted, and c takes b's predecessor (a) so both sit at the same step
    expect(p.unlink).toHaveLength(1);
    expect(p.link).toEqual([expect.objectContaining({ srcId: 'a', dstId: 'c' })]);
  });
});
