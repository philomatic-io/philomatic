/**
 * The track view's DRAG RULES, as one pure function (owner feature, 2026-07-23).
 *
 * Every gesture is (what was dragged) × (what it was dropped on) → edges. The failure mode for
 * a feature this size is that the matrix ends up smeared across drag handlers in JSX, where it
 * can only be tested by hand in a browser — which is exactly how the last four ordering bugs
 * survived. So the DOM's only job is to produce a `DragItem` and a `DropTarget`; the rules live
 * here and are unit-tested exhaustively, and everything comes back as a lib/reorder `Plan`,
 * whose inverse is the whole gesture rather than one edge of it.
 *
 * The rulings behind the table (owner, 2026-07-23):
 *  - Ordering is asserted only against a neighbour that is ITSELF ordered; a drop next to an
 *    unordered row asserts nothing and both stay unordered. (planPlace already held this line —
 *    the tail is where unordered members live.)
 *  - Three drop zones per row survive: top third BEFORE, middle CO-REQUISITE, bottom AFTER.
 *  - A source dragged out of a concept group onto the path JOINS the track and KEEPS its
 *    concepts — the drag is purely additive. Stripping concepts is the ×, and only the ×.
 *  - ABOUT is a GLOBAL fact about the source, not a track-scoped one. Dropping a source on a
 *    concept here makes it about that concept everywhere. There is no track-scoped ABOUT in
 *    the model, so the gesture cannot be made local; callers should say so in the toast.
 */
import { merge, planAbout, planAdd, planPlace, type Plan, type TrackOrder } from './reorder';

export type DragItem =
  /** `from` matters: with a member also listed under its concepts, the same source id can be
   *  in the DOM twice, and the two copies do not mean the same thing. */
  | { kind: 'source'; id: string; from: 'spine' | 'group' }
  | { kind: 'concept'; id: string };

export type DropTarget =
  /** A row on the reading spine, plus which third of it was under the cursor. */
  | { kind: 'spine-row'; id: string; zone: 'before' | 'coreq' | 'after' }
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

  if (target.kind === 'source-row') return empty; // sources are placed by zone, not by row

  // ── a source onto the spine ────────────────────────────────────────────────────────────
  if (target.id === item.id) return empty;
  const at =
    target.zone === 'before' ? { belowId: target.id } : target.zone === 'after' ? { aboveId: target.id } : { coreqId: target.id };

  if (ctx.track.sourceIds.includes(item.id)) return planPlace(ctx.track, item.id, at);

  // Coming from a concept group: join the track AND take the place it was dropped at. The
  // ordering is computed against the track it is about to be part of, so the two halves of
  // the gesture agree; if the neighbour is unordered, planPlace declines and only the
  // membership lands (which is the rule, not an accident).
  const asMember: TrackOrder = { ...ctx.track, sourceIds: [...ctx.track.sourceIds, item.id] };
  return merge(planAdd(ctx.track, item.id), planPlace(asMember, item.id, at));
}

/** Which third of a row the cursor is in — the geometry, kept next to the rules it feeds. */
export function zoneOf(offsetY: number, height: number): 'before' | 'coreq' | 'after' {
  if (height <= 0) return 'coreq';
  const f = offsetY / height;
  return f < 1 / 3 ? 'before' : f > 2 / 3 ? 'after' : 'coreq';
}
