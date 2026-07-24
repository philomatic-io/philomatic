/**
 * Track-membership and reading-order MUTATION PLANNING — pure, and the one place the rules
 * live (maintainability plan 1c, 2026-07-22).
 *
 * Why this module exists: the same rules were implemented twice — Journey's
 * moveMember/placeSource/removeMember and Detail's reorderInTrack/addToTrack/removeFromTrack —
 * and every ordering change this week had to be made in both, twice, and was wrong in one of
 * them at least once ("↑ jumps ahead of the last ordered item", "adding auto-orders"). A plan
 * is data: the edges to retract, the edges to assert, and a label. Views execute it and invert
 * it; nobody hand-builds PRECEDES batches any more.
 *
 * The RULES of record, in one place:
 *  - Membership (INCLUDES) and reading order (PRECEDES) are independent. Adding a source
 *    asserts membership ONLY — never an order the learner didn't author.
 *  - A member no PRECEDES edge touches is UNORDERED: it sorts below the ordered chain and
 *    renders without a step number (see lib/order.ts).
 *  - ↑ on an unordered member JOINS the chain as its last step (one new pair); ↓ is a no-op.
 *  - ↑/↓ within the chain swaps neighbours and rewrites the chain (one batch, one validation).
 *  - Removing a member retracts its membership AND every PRECEDES edge touching it.
 *  - Writes are additive/retractive only — the engine's per-context cycle validation is the
 *    guard, so a plan that would contradict an existing order fails cleanly at the seam.
 */
import { orderedSources } from './order';

/** A track, as much of one as planning needs. */
export interface TrackOrder {
  id: string;
  sourceIds: readonly string[];
  sourceLevels?: readonly (readonly string[])[];
  precedes: readonly { srcId: string; dstId: string }[];
}

/** One edge, in the shape both `link`/`unlink` and `importPayload` accept. */
export interface EdgeOp {
  srcType: 'track' | 'source';
  srcId: string;
  type: 'INCLUDES' | 'PRECEDES';
  dstType: 'source';
  dstId: string;
  trackContextId?: string;
}

/** Retract these, then assert these. An empty plan means "the gesture is a no-op". */
export interface Plan {
  unlink: EdgeOp[];
  link: EdgeOp[];
}

const includes = (trackId: string, sourceId: string): EdgeOp => ({
  srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'source', dstId: sourceId,
});
const precedes = (trackId: string, srcId: string, dstId: string): EdgeOp => ({
  srcType: 'source', srcId, type: 'PRECEDES', dstType: 'source', dstId, trackContextId: trackId,
});

export const isEmpty = (p: Plan): boolean => p.unlink.length === 0 && p.link.length === 0;
/** The opposite plan — what Ctrl+Z runs. */
export const invert = (p: Plan): Plan => ({ unlink: p.link, link: p.unlink });

/** Which members the ordering actually touches (the rest are unordered). */
const orderedIds = (t: TrackOrder): Set<string> => new Set(t.precedes.flatMap((p) => [p.srcId, p.dstId]));

/** The members in display order (shared with the views via lib/order). */
const displayOrder = (t: TrackOrder): string[] =>
  orderedSources({ sourceIds: t.sourceIds, sourceLevels: t.sourceLevels ?? [], precedes: t.precedes }).map((o) => o.id);

/** Add a source to a track: MEMBERSHIP ONLY — it lands unordered, at the bottom. */
export function planAdd(track: TrackOrder, sourceId: string): Plan {
  if (track.sourceIds.includes(sourceId)) return { unlink: [], link: [] };
  return { unlink: [], link: [includes(track.id, sourceId)] };
}

/** Remove a member: its membership plus every ordering edge that touches it. */
export function planRemove(track: TrackOrder, sourceId: string): Plan {
  const touching = track.precedes.filter((p) => p.srcId === sourceId || p.dstId === sourceId);
  return {
    unlink: [includes(track.id, sourceId), ...touching.map((p) => precedes(track.id, p.srcId, p.dstId))],
    link: [],
  };
}

/** Retract the whole in-context chain and assert `order` as the new one — the only safe way
 *  to MOVE something already sequenced, since additive writes would contradict its old edges
 *  and the engine's cycle guard would (correctly) reject them. */
function rewriteChain(track: TrackOrder, order: readonly string[]): Plan {
  return {
    unlink: track.precedes.map((p) => precedes(track.id, p.srcId, p.dstId)),
    link: order.slice(0, -1).map((a, k) => precedes(track.id, a, order[k + 1]!)),
  };
}

/** The ordered chain, in display order (unordered members excluded). */
const chainOf = (t: TrackOrder): string[] => {
  const touched = orderedIds(t);
  return displayOrder(t).filter((id) => touched.has(id));
};

/**
 * ↑ / ↓ on a member.
 *  - unordered member + an existing chain: ↑ JOINS the chain as its last step; ↓ no-ops.
 *  - otherwise: swap with the neighbour and rewrite the chain as one batch.
 */
export function planMove(track: TrackOrder, sourceId: string, dir: -1 | 1): Plan {
  const empty: Plan = { unlink: [], link: [] };
  const touched = orderedIds(track);
  const order = displayOrder(track);

  if (track.precedes.length > 0 && !touched.has(sourceId)) {
    if (dir === 1) return empty; // already at the bottom
    const lastOrdered = order.filter((id) => touched.has(id)).pop();
    if (lastOrdered === undefined || lastOrdered === sourceId) return empty;
    return { unlink: [], link: [precedes(track.id, lastOrdered, sourceId)] };
  }

  // Swap WITHIN the ordered chain only. Rebuilding over the display order would sweep the
  // unordered tail into the chain — a reorder must not conscript members the learner never
  // sequenced (found while chasing the 2026-07-22 ordering reports).
  const chainIds = track.precedes.length === 0 ? order : order.filter((id) => touched.has(id));
  const i = chainIds.indexOf(sourceId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= chainIds.length) return empty;
  const next = chainIds.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return rewriteChain(track, next);
}

/**
 * Drag placement: ABOVE an item makes the dragged source its prerequisite, BELOW its
 * post-requisite, ONTO it a co-requisite (sharing the target's predecessors — same step).
 *
 * ADDING IS NOT PLACING (owner ruling 2026-07-23). Dragging in a source that isn't yet a
 * member — the "drag in existing sources" palette — is the same gesture as the add-source
 * button, so it asserts MEMBERSHIP ONLY and the source lands unordered (·) at the bottom,
 * wherever it was dropped. Ordering it is a second, deliberate act (↑, or dragging the row
 * once it IS a member). Otherwise the two add affordances disagreed: the button gave ·, the
 * palette drag silently numbered it.
 *
 * For a source already in the track, order is asserted only against a neighbour that is
 * ITSELF ordered — the tail is where unordered members live, so a drop there stays
 * unordered. Exception: a track with no ordering at all BOOTSTRAPS its first pair, or
 * dragging could never create an order.
 */
export function planPlace(
  track: TrackOrder,
  dragId: string,
  at: { aboveId?: string; belowId?: string; coreqId?: string },
): Plan {
  const empty: Plan = { unlink: [], link: [] };
  if (at.coreqId === dragId) return empty;
  // Not a member yet → this is an ADD, not a placement.
  if (!track.sourceIds.includes(dragId)) return planAdd(track, dragId);

  const touched = orderedIds(track);
  const bootstrapping = track.precedes.length === 0;

  if (at.coreqId !== undefined) {
    // Same step: share the target's predecessors. Pull the dragged item out of the chain
    // first, or its old edges would contradict its new position (cycle).
    if (!touched.has(at.coreqId)) return empty; // an unordered target has no step to share
    const preds = track.precedes.filter((e) => e.dstId === at.coreqId && e.srcId !== dragId);
    if (preds.length === 0) return empty;
    return {
      unlink: track.precedes.filter((e) => e.srcId === dragId || e.dstId === dragId).map((e) => precedes(track.id, e.srcId, e.dstId)),
      link: preds.map((e) => precedes(track.id, e.srcId, dragId)),
    };
  }

  // A track with no ordering at all BOOTSTRAPS its first pair — additively, so the rest of
  // the members stay unordered rather than being swept into a chain nobody authored.
  if (bootstrapping) {
    const link: EdgeOp[] = [];
    if (at.aboveId !== undefined && at.aboveId !== dragId) link.push(precedes(track.id, at.aboveId, dragId));
    if (at.belowId !== undefined && at.belowId !== dragId) link.push(precedes(track.id, dragId, at.belowId));
    return link.length > 0 ? { unlink: [], link } : empty;
  }

  // Linear placement into an existing chain: REWRITE it with the item at its new position.
  // (Additive writes here contradicted the item's old edges and were rejected as a cycle —
  // owner report 2026-07-23: drag-to-reorder failed on any already-ordered track.)
  const chain = chainOf(track);
  const without = chain.filter((id) => id !== dragId);
  const afterIdx = at.aboveId !== undefined && at.aboveId !== dragId ? without.indexOf(at.aboveId) : -1;
  const beforeIdx = at.belowId !== undefined && at.belowId !== dragId ? without.indexOf(at.belowId) : -1;
  const at_ = afterIdx >= 0 ? afterIdx + 1 : beforeIdx >= 0 ? beforeIdx : -1;
  if (at_ < 0) return empty; // dropped against unordered neighbours — stay unordered
  const next = [...without.slice(0, at_), dragId, ...without.slice(at_)];
  if (next.length === chain.length && next.every((id, i) => id === chain[i])) return empty; // no-op
  return rewriteChain(track, next);
}

/** The slice of the engine client a plan needs (kept structural so tests can fake it). */
export interface PlanClient {
  unlink(edge: { srcId: string; type: string; dstId: string; trackContextId?: string }): Promise<unknown>;
  importPayload(payload: unknown): Promise<unknown>;
}

/** Execute a plan: retractions first (so a rewrite can't collide with itself), then one
 *  batched assertion — a chain rewrite is ONE validation, not N intents. */
export async function applyPlan(client: PlanClient, plan: Plan): Promise<void> {
  for (const e of plan.unlink) {
    await client.unlink({ srcId: e.srcId, type: e.type, dstId: e.dstId, ...(e.trackContextId !== undefined ? { trackContextId: e.trackContextId } : {}) });
  }
  if (plan.link.length > 0) await client.importPayload({ version: 2, edges: plan.link });
}
