/**
 * resolveDrop — the track view's whole drag matrix, as a truth table.
 *
 * Owner, 2026-07-23: "please plan how we might want to implement this as it is prone to any
 * bugs." This file IS that plan's answer. Every gesture is a pure (item, target) → Plan, so the
 * rules can be wrong here loudly instead of in a browser quietly. The browser tests that follow
 * only have to prove the wiring produces the right (item, target).
 */
import { describe, expect, it } from 'vitest';
import { resolveDrop, zoneOf, type DragItem, type DropTarget } from '../ui/src/lib/drag';
import { invert, isEmpty, type Plan } from '../ui/src/lib/reorder';

/** a → b → c ordered; `loose` is a member no edge touches; `outside` is not a member. */
const TRACK = {
  id: 'syl',
  sourceIds: ['a', 'b', 'c', 'loose'],
  sourceLevels: [['a'], ['b'], ['c']],
  precedes: [
    { srcId: 'a', dstId: 'b' },
    { srcId: 'b', dstId: 'c' },
  ],
};

const ctx = (aboutOf: (id: string) => string[] = () => []) => ({ track: TRACK, aboutFlavour: 'EXPLAINS', aboutOf });
const drop = (item: DragItem, target: DropTarget, c = ctx()): Plan => resolveDrop(item, target, c);

const src = (id: string, from: 'spine' | 'group' = 'spine'): DragItem => ({ kind: 'source', id, from });
const row = (id: string, zone: 'before' | 'coreq' | 'after'): DropTarget => ({ kind: 'spine-row', id, zone });

/** The PRECEDES pairs a plan ends up asserting, as "x>y". */
const asserted = (p: Plan) => p.link.filter((e) => e.type === 'PRECEDES').map((e) => `${e.srcId}>${e.dstId}`);

describe('resolveDrop — a source onto the reading spine', () => {
  it('ABOVE an ordered row makes the dragged source its prerequisite', () => {
    expect(asserted(drop(src('c'), row('a', 'before')))).toEqual(['c>a', 'a>b']);
  });

  it('BELOW an ordered row makes it a post-requisite', () => {
    expect(asserted(drop(src('a'), row('c', 'after')))).toEqual(['b>c', 'c>a']);
  });

  it('ONTO the middle of a row makes them co-requisites — the third zone stays', () => {
    // c shares b's predecessors, so both sit at the same step.
    expect(asserted(drop(src('c'), row('b', 'coreq')))).toEqual(['a>c']);
  });

  it('a drop against an UNORDERED neighbour asserts NOTHING', () => {
    // Owner ruling: order is asserted only against a neighbour that is itself ordered.
    expect(isEmpty(drop(src('a'), row('loose', 'before')))).toBe(true);
    expect(isEmpty(drop(src('a'), row('loose', 'after')))).toBe(true);
    expect(isEmpty(drop(src('a'), row('loose', 'coreq')))).toBe(true);
  });

  it('dragging the unordered member against an ORDERED row does place it', () => {
    expect(asserted(drop(src('loose'), row('b', 'before')))).toEqual(['a>loose', 'loose>b', 'b>c']);
  });

  it('a drop on itself is a no-op, in every zone', () => {
    for (const z of ['before', 'coreq', 'after'] as const) expect(isEmpty(drop(src('a'), row('a', z)))).toBe(true);
  });

  it('a reorder never conscripts the unordered tail', () => {
    const plan = drop(src('c'), row('a', 'before'));
    expect(plan.link.flatMap((e) => [e.srcId, e.dstId])).not.toContain('loose');
  });

  it('rewrites the chain rather than adding to it — the 2026-07-23 cycle bug', () => {
    // Moving something already sequenced must retract its old edges in the same plan.
    const plan = drop(src('c'), row('a', 'before'));
    expect(plan.unlink.filter((e) => e.type === 'PRECEDES')).toHaveLength(TRACK.precedes.length);
  });
});

describe('resolveDrop — a source dragged OUT of a concept group', () => {
  const outside = src('outside', 'group');

  it('joins the track and takes the place it was dropped at', () => {
    const plan = drop(outside, row('b', 'before'));
    expect(plan.link.filter((e) => e.type === 'INCLUDES').map((e) => e.dstId)).toEqual(['outside']);
    expect(asserted(plan)).toEqual(['a>outside', 'outside>b', 'b>c']);
  });

  it('KEEPS its concepts — the drag is purely additive, stripping them is the ×', () => {
    const plan = drop(outside, row('b', 'before'));
    expect(plan.unlink.filter((e) => e.type === 'ABOUT')).toHaveLength(0);
  });

  it('lands as membership ONLY when the neighbour is unordered', () => {
    const plan = drop(outside, row('loose', 'after'));
    expect(plan.link.map((e) => e.type)).toEqual(['INCLUDES']);
  });
});

describe('resolveDrop — concepts', () => {
  it('a source dropped on a concept becomes ABOUT it', () => {
    const plan = drop(src('a'), { kind: 'concept', id: 'cpt_x' });
    expect(plan.link).toEqual([
      { srcType: 'source', srcId: 'a', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_x', tags: [{ name: 'EXPLAINS' }] },
    ]);
  });

  it('a chip is the same target as a group heading — that is how INTERMEDIATE concepts are reachable', () => {
    // The owner's "kicker": dropping on a tie chip anchors to that intermediate concept, not
    // to the top-level group it hangs under.
    expect(drop(src('a'), { kind: 'concept', id: 'cpt_intermediate' }).link[0]!.dstId).toBe('cpt_intermediate');
  });

  it('a CONCEPT dragged down onto a source row does the same write, from the other end', () => {
    const plan = drop({ kind: 'concept', id: 'cpt_x' }, { kind: 'source-row', id: 'a' });
    expect(plan.link).toEqual([
      { srcType: 'source', srcId: 'a', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_x', tags: [{ name: 'EXPLAINS' }] },
    ]);
  });

  it('repeating a tie the source already has is a no-op — no toast, no undo entry', () => {
    expect(isEmpty(drop(src('a'), { kind: 'concept', id: 'cpt_x' }, ctx(() => ['cpt_x'])))).toBe(true);
  });

  it('a concept dropped on another concept does nothing — this view does not author prerequisites', () => {
    expect(isEmpty(drop({ kind: 'concept', id: 'cpt_x' }, { kind: 'concept', id: 'cpt_y' }))).toBe(true);
  });

  it('a source dropped on a source ROW (not a zone) does nothing — sources are placed by zone', () => {
    expect(isEmpty(drop(src('a'), { kind: 'source-row', id: 'b' }))).toBe(true);
  });
});

describe('every gesture is undoable as ONE thing', () => {
  const gestures: [string, Plan][] = [
    ['reorder', drop(src('c'), row('a', 'before'))],
    ['co-requisite', drop(src('c'), row('b', 'coreq'))],
    ['join from a group', drop(src('outside', 'group'), row('b', 'before'))],
    ['anchor to a concept', drop(src('a'), { kind: 'concept', id: 'cpt_x' })],
  ];
  for (const [name, plan] of gestures) {
    it(`${name}: the inverse retracts everything it asserted, and vice versa`, () => {
      // The bug shape this whole module exists to prevent: a multi-edge gesture with a
      // single-edge undo (concept ×, adding, placement — three times in one week).
      expect(invert(plan).unlink).toEqual(plan.link);
      expect(invert(plan).link).toEqual(plan.unlink);
      expect(invert(invert(plan))).toEqual(plan);
    });
  }
});

describe('zoneOf — the geometry the rules are fed', () => {
  it('splits a row into three', () => {
    expect(zoneOf(2, 60)).toBe('before');
    expect(zoneOf(30, 60)).toBe('coreq');
    expect(zoneOf(58, 60)).toBe('after');
  });
  it('degenerate rows do not throw', () => {
    expect(zoneOf(0, 0)).toBe('coreq');
  });
});
