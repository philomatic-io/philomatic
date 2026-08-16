/**
 * The track view's DRAG RULES, as one pure function.
 *
 * Every gesture is (what was dragged) × (what it was dropped on) → edges. The DOM's only job
 * is to produce a `DragItem` and a `DropTarget`; the rules live here and are unit-tested
 * exhaustively, and everything comes back as a lib/reorder `Plan`, whose inverse is the whole
 * gesture rather than one edge of it.
 *
 * The model: reading order is a PARTIAL ORDER, not a chain. In a
 * partial order a source doesn't OWN a location — its position is derived from its relations.
 * So a drop ASSERTS relations (additively, one labeled strip = one meaning), badges RETRACT
 * them (planCutPrecedes), and nothing ever rewrites the whole ordering. A drop that would
 * contradict existing order is not resolved here — the engine's per-context cycle guard
 * refuses it at the seam, and the caller's toast names the conflict.
 *
 * Standing rulings that carry over:
 *  - A source dragged out of a concept group KEEPS its concepts — drags are additive;
 *    stripping concepts is the chip ×, and only the chip ×.
 *  - ABOUT is a GLOBAL fact about the source. Dropping a source on a concept makes it about
 *    that concept everywhere; callers say so in the toast.
 * Retired with the chain (deliberately): "order only against an ordered neighbour". A
 * pairwise edge PLACES both its ends — dropping "after A" when A was unordered simply makes
 * A part of the order too, which is what the labeled strip says it does.
 */
import { merge, planAbout, planAdd, planPair, type Plan, type TrackOrder } from './reorder';

export type DragItem =
  /** `from` matters: with a member also listed under its concepts, the same source id can be
   *  in the DOM twice, and the two copies do not mean the same thing. */
  | { kind: 'source'; id: string; from: 'spine' | 'group' }
  | { kind: 'concept'; id: string };

export type DropTarget =
  /** A GAP STRIP. `aboveId` set = "reads after that source"; `belowId` set = "reads
   *  before that source"; both set = the BETWEEN strip. The ends of the list are the
   *  one-sided cases. */
  | { kind: 'gap'; aboveId?: string; belowId?: string }
  /** A concept — its group heading, or one of the tie chips that names an INTERMEDIATE
   *  concept on some row. Both mean the same write, which is why they are one target. */
  | { kind: 'concept'; id: string }
  /** A whole source row, as the destination for a concept chip dragged down onto it. */
  | { kind: 'source-row'; id: string };

export interface DropContext {
  track: TrackOrder;
  /** The role tag a dragged ABOUT gets — the same default the anchor form opens on, since a
   *  drag has nowhere to choose one. */
  aboutFlavour: string;
  /** Per source, the concepts it is already ABOUT (ids) — so a repeat drag is a no-op. */
  aboutOf: (sourceId: string) => readonly string[];
}

/** Would asserting srcId→dstId close a loop — i.e. does dstId already reach srcId through
 *  the in-context PRECEDES edges? A UI courtesy for going INERT before the drop (strips that can't do what they say go light); the ENGINE's per-context cycle
 *  guard remains the authority at the seam. */
export function wouldCycle(
  precedes: readonly { srcId: string; dstId: string }[],
  srcId: string,
  dstId: string,
): boolean {
  if (srcId === dstId) return true;
  const out = new Map<string, string[]>();
  for (const p of precedes) out.set(p.srcId, [...(out.get(p.srcId) ?? []), p.dstId]);
  const seen = new Set<string>([dstId]);
  const queue = [dstId];
  while (queue.length > 0) {
    for (const next of out.get(queue.pop()!) ?? []) {
      if (next === srcId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Resolve one drop into the edges it should write. An empty plan means "nothing to do" — an
 *  illegal combination, a self-drop, or a repeat of something already asserted. */
export function resolveDrop(item: DragItem, target: DropTarget, ctx: DropContext): Plan {
  const empty: Plan = { unlink: [], link: [] };

  if (item.kind === 'concept') {
    // A concept dragged onto a source says the source is about it. Dropping a concept on
    // another concept would mean a prerequisite edit, which this view does not author.
    if (target.kind !== 'source-row') return empty;
    return planAbout(target.id, item.id, ctx.aboutFlavour, ctx.aboutOf(target.id));
  }

  if (target.kind === 'concept') {
    return planAbout(item.id, target.id, ctx.aboutFlavour, ctx.aboutOf(item.id));
  }

  if (target.kind === 'source-row') return empty; // sources order via gap strips, not rows

  // ── a source onto a gap strip: ASSERT the strip's pair(s), additively ─────────────────
  const pairs: { srcId: string; dstId: string }[] = [];
  if (target.aboveId !== undefined && target.aboveId !== item.id) pairs.push({ srcId: target.aboveId, dstId: item.id });
  if (target.belowId !== undefined && target.belowId !== item.id) pairs.push({ srcId: item.id, dstId: target.belowId });
  if (pairs.length === 0) return empty;
  const ordering = planPair(ctx.track, pairs);

  // A non-member dropped on a LABELED strip joins the track AND takes the strip's meaning —
  // one deliberate gesture, one undo. (The "adding is not placing" ruling was
  // about ambiguous palette drags under chain conscription; an explicit "reads after ‘A’"
  // strip is the placement intent, stated.)
  if (!ctx.track.sourceIds.includes(item.id)) return merge(planAdd(ctx.track, item.id), ordering);
  return ordering;
}
