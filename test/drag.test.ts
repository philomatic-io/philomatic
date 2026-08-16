/**
 * resolveDrop — the track view's whole drag matrix, as a truth table.
 *
 * Drag rules are bug-prone, so every gesture is a pure (item, target) → Plan and the rules
 * can be wrong here loudly instead of in a browser quietly. The browser tests that follow
 * only have to prove the wiring produces the right (item, target).
 *
 * The model is PAIRWISE and purely additive: gap strips assert individual PRECEDES edges,
 * nothing rewrites the ordering, and contradictions are the engine's cycle guard's to
 * refuse — not these rules'.
 */
import { describe, expect, it } from 'vitest';
import { resolveDrop, wouldCycle, type DragItem, type DropTarget } from '../ui/src/lib/drag';
import { invert, isEmpty, planCutPrecedes, planPair, type Plan } from '../ui/src/lib/reorder';

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
const gap = (aboveId?: string, belowId?: string): DropTarget => ({ kind: 'gap', ...(aboveId !== undefined ? { aboveId } : {}), ...(belowId !== undefined ? { belowId } : {}) });

/** The PRECEDES pairs a plan ends up asserting, as "x>y". */
const asserted = (p: Plan) => p.link.filter((e) => e.type === 'PRECEDES').map((e) => `${e.srcId}>${e.dstId}`);

describe('resolveDrop — gap strips (pairwise, ADDITIVE — R1, 2026-08-14)', () => {
  it('the AFTER strip (below a source) asserts exactly one pair: neighbour precedes dragged', () => {
    expect(asserted(drop(src('loose'), gap('a')))).toEqual(['a>loose']);
  });

  it('the BEFORE strip (above a source) asserts exactly one pair: dragged precedes neighbour', () => {
    expect(asserted(drop(src('loose'), gap(undefined, 'a')))).toEqual(['loose>a']);
  });

  it('the BETWEEN strip asserts both pairs', () => {
    expect(asserted(drop(src('loose'), gap('a', 'b')))).toEqual(['a>loose', 'loose>b']);
  });

  it('NOTHING is ever retracted — a drop adds meaning; removal is the badge ×', () => {
    for (const t of [gap('a'), gap(undefined, 'c'), gap('a', 'b')]) {
      expect(drop(src('loose'), t).unlink).toHaveLength(0);
    }
  });

  it('a pair already asserted repeats as a no-op (and BETWEEN keeps only the missing half)', () => {
    expect(isEmpty(drop(src('b'), gap('a')))).toBe(true); // a>b already exists
    expect(asserted(drop(src('b'), gap('a', 'loose')))).toEqual(['b>loose']);
  });

  it('an UNORDERED neighbour is a legal partner now — the pairwise edge places both ends', () => {
    // The chain-era "order only against an ordered neighbour" rule retired with the chain:
    // an explicit "reads after ‘loose’" strip says exactly what it does.
    expect(asserted(drop(src('a'), gap('loose')))).toEqual(['loose>a']);
  });

  it('self-drops no-op: a one-sided self gap entirely, a BETWEEN keeps the other half', () => {
    expect(isEmpty(drop(src('a'), gap('a')))).toBe(true);
    expect(isEmpty(drop(src('a'), gap(undefined, 'a')))).toBe(true);
    expect(asserted(drop(src('a'), gap('a', 'loose')))).toEqual(['a>loose']);
  });

  it('the dragged source keeps its other relations — multi-relation orders build up drop by drop', () => {
    // c already reads after b; dropping it "after a" ADDS a>c and touches nothing else.
    const plan = drop(src('c'), gap('a'));
    expect(asserted(plan)).toEqual(['a>c']);
    expect(plan.unlink).toHaveLength(0);
  });
});

describe('resolveDrop — a source dragged OUT of a concept group onto a strip', () => {
  const outside = src('outside', 'group');

  it('joins the track AND takes the strip meaning — one gesture, one undo', () => {
    // "Adding is not placing" guards ambiguous palette drags under chain conscription;
    // an explicit labeled strip IS the placement intent, stated.
    const plan = drop(outside, gap('a', 'b'));
    expect(plan.link.filter((e) => e.type === 'INCLUDES').map((e) => e.dstId)).toEqual(['outside']);
    expect(asserted(plan)).toEqual(['a>outside', 'outside>b']);
  });

  it('KEEPS its concepts — the drag is purely additive, stripping them is the ×', () => {
    const plan = drop(outside, gap('a', 'b'));
    expect(plan.unlink).toHaveLength(0);
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

  it('a source dropped on a source ROW does nothing — sources order via gap strips', () => {
    expect(isEmpty(drop(src('a'), { kind: 'source-row', id: 'b' }))).toBe(true);
  });
});

describe('the badge rules (DR-S3 feeds on these)', () => {
  it('planPair skips self-pairs and duplicates, asserts the rest', () => {
    const p = planPair(TRACK, [
      { srcId: 'a', dstId: 'a' },
      { srcId: 'a', dstId: 'b' }, // exists
      { srcId: 'a', dstId: 'loose' },
    ]);
    expect(asserted(p)).toEqual(['a>loose']);
    expect(p.unlink).toHaveLength(0);
  });

  it('planCutPrecedes retracts the pair AS STORED, and no-ops when absent', () => {
    // TRACK's pairs carry no trackContextId — they are context-free edges (most are:
    // real libraries order tracks with global PRECEDES; see engine read ordersTrack).
    // A cut pinned to this track's context would miss them, retracting nothing while
    // reporting success — the retraction must match the pair AS STORED.
    const cut = planCutPrecedes(TRACK, 'a', 'b');
    expect(cut.unlink).toEqual([
      { srcType: 'source', srcId: 'a', type: 'PRECEDES', dstType: 'source', dstId: 'b' },
    ]);
    expect(cut.link).toHaveLength(0);
    expect(isEmpty(planCutPrecedes(TRACK, 'b', 'a'))).toBe(true);
  });

  it('a pair stored BOTH context-free and in-context cuts as two shaped retractions', () => {
    const twin = { ...TRACK, precedes: [...TRACK.precedes, { srcId: 'a', dstId: 'b', trackContextId: 'syl' }] };
    const cut = planCutPrecedes(twin, 'a', 'b');
    expect(cut.unlink).toEqual([
      { srcType: 'source', srcId: 'a', type: 'PRECEDES', dstType: 'source', dstId: 'b' },
      { srcType: 'source', srcId: 'a', type: 'PRECEDES', dstType: 'source', dstId: 'b', trackContextId: 'syl' },
    ]);
  });
});

describe('wouldCycle — the inert-strip courtesy (engine stays the authority)', () => {
  const PRE = TRACK.precedes; // a>b, b>c
  it('detects the direct and the transitive loop', () => {
    expect(wouldCycle(PRE, 'b', 'a')).toBe(true); // a already reaches b
    expect(wouldCycle(PRE, 'c', 'a')).toBe(true); // transitively
  });
  it('a self-pair is a loop by definition', () => {
    expect(wouldCycle(PRE, 'a', 'a')).toBe(true);
  });
  it('forward and unrelated pairs are clean', () => {
    expect(wouldCycle(PRE, 'a', 'c')).toBe(false); // shortcut edge, legal in a DAG
    expect(wouldCycle(PRE, 'loose', 'a')).toBe(false);
    expect(wouldCycle(PRE, 'c', 'loose')).toBe(false);
  });
});

describe('every gesture is undoable as ONE thing', () => {
  const gestures: [string, Plan][] = [
    ['after strip', drop(src('loose'), gap('a'))],
    ['between strip', drop(src('loose'), gap('a', 'b'))],
    ['join from a group', drop(src('outside', 'group'), gap('a', 'b'))],
    ['anchor to a concept', drop(src('a'), { kind: 'concept', id: 'cpt_x' })],
    ['badge cut', planCutPrecedes(TRACK, 'a', 'b')],
  ];
  for (const [name, plan] of gestures) {
    it(`${name}: the inverse retracts everything it asserted, and vice versa`, () => {
      expect(invert(plan).unlink).toEqual(plan.link);
      expect(invert(plan).link).toEqual(plan.unlink);
      expect(invert(invert(plan))).toEqual(plan);
    });
  }
});
