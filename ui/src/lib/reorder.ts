/**
 * Track-membership and reading-order MUTATION PLANNING — pure, and the one place the rules
 * live (maintainability plan 1c).
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
  /** Each pair's STORED shape — `trackContextId` absent = a context-free edge that orders
   *  every track (see engine read `ordersTrack`). Retractions must reproduce the stored
   *  shape exactly or the delete misses. */
  precedes: readonly { srcId: string; dstId: string; trackContextId?: string }[];
}

/** One edge, in the shape both `link`/`unlink` and `importPayload` accept. */
export interface EdgeOp {
  srcType: 'track' | 'source';
  srcId: string;
  type: 'INCLUDES' | 'PRECEDES' | 'ABOUT';
  dstType: 'source' | 'concept';
  dstId: string;
  trackContextId?: string;
  /** ABOUT carries a framework-declared role flavour; it must ride along so that inverting a
   *  retraction restores the edge as it was, not as a bare ABOUT. */
  tags?: { name: string }[];
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
/** The retraction for a pair AS STORED — context-free edges unlink context-free. */
const cutOp = (row: { srcId: string; dstId: string; trackContextId?: string }): EdgeOp => ({
  srcType: 'source', srcId: row.srcId, type: 'PRECEDES', dstType: 'source', dstId: row.dstId,
  ...(row.trackContextId !== undefined ? { trackContextId: row.trackContextId } : {}),
});
const about = (sourceId: string, conceptId: string, flavour: string): EdgeOp => ({
  srcType: 'source', srcId: sourceId, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: flavour }],
});

/** Two plans, one gesture — retractions and assertions concatenated, so the inverse is still
 *  the whole thing. */
export const merge = (...ps: Plan[]): Plan => ({ unlink: ps.flatMap((p) => p.unlink), link: ps.flatMap((p) => p.link) });

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
    unlink: [includes(track.id, sourceId), ...touching.map(cutOp)],
    link: [],
  };
}

/** Retract the whole in-context chain and assert `order` as the new one — the only safe way
 *  to MOVE something already sequenced, since additive writes would contradict its old edges
 *  and the engine's cycle guard would (correctly) reject them. */
function rewriteChain(track: TrackOrder, order: readonly string[]): Plan {
  return {
    unlink: track.precedes.map(cutOp),
    link: order.slice(0, -1).map((a, k) => precedes(track.id, a, order[k + 1]!)),
  };
}

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
  // sequenced (found while chasing ordering reports).
  const chainIds = track.precedes.length === 0 ? order : order.filter((id) => touched.has(id));
  const i = chainIds.indexOf(sourceId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= chainIds.length) return empty;
  const next = chainIds.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return rewriteChain(track, next);
}

/**
 * PAIRWISE ordering: assert exactly these
 * PRECEDES pairs, in this track's context, skipping self-pairs and ones already asserted.
 * Never retracts anything — in a partial order, position is derived from relations, so a
 * drop adds meaning and only a badge × removes it. A pair that would contradict existing
 * order is the ENGINE's refusal (per-context cycle guard), not this function's.
 */
export function planPair(track: TrackOrder, pairs: readonly { srcId: string; dstId: string }[]): Plan {
  const have = new Set(track.precedes.map((p) => `${p.srcId}>${p.dstId}`));
  const link = pairs
    .filter((p) => p.srcId !== p.dstId && !have.has(`${p.srcId}>${p.dstId}`))
    .map((p) => precedes(track.id, p.srcId, p.dstId));
  return { unlink: [], link };
}

/** A relation badge's ×: retract exactly ONE in-context PRECEDES edge. A no-op when
 *  the edge isn't there — a stale badge repeats harmlessly. */
export function planCutPrecedes(track: TrackOrder, srcId: string, dstId: string): Plan {
  // Cut EVERY stored shape of the pair (a legacy library can hold it twice — context-free
  // AND in-context); the inverse restores exactly the shapes that were cut.
  const rows = track.precedes.filter((p) => p.srcId === srcId && p.dstId === dstId);
  const shapes = new Map(rows.map((r) => [r.trackContextId ?? '', r] as const));
  return { unlink: [...shapes.values()].map(cutOp), link: [] };
}

/** Say this source is ABOUT this concept. A no-op when it already is — the drag repeats
 *  harmlessly, and a no-op plan means no toast and no undo entry. */
export function planAbout(sourceId: string, conceptId: string, flavour: string, alreadyAbout: readonly string[] = []): Plan {
  if (alreadyAbout.includes(conceptId)) return { unlink: [], link: [] };
  return { unlink: [], link: [about(sourceId, conceptId, flavour)] };
}

/**
 * The × inside a TIE CHIP: this source is no longer about that concept (
 * "the x for concepts actually should be in the concept chip").
 *
 * It cuts exactly one ABOUT edge, and only ever a DIRECT tie — which is what a chip is. A
 * source shows under a top-level group because of the tie it holds, so you can untie it from
 * "Stability Theory" but not from "Model Theory", which it was never about.
 *
 * `flavour` is the edge's current role tag, read at click time, so Ctrl+Z restores the edge as
 * it was rather than as a bare ABOUT. When the cut takes the source's LAST tie in this track's
 * family it would otherwise vanish from the view entirely, so it joins the track's path
 * instead — the owner's "show it at the top as included in the track".
 *
 * The trigger is SOURCE-side, and deliberately so (asked and
 * confirmed): it fires on this source running out of ties, NOT on the concept running out of
 * sources. How many other sources the concept holds is not an input here, and must not become
 * one — the concept-side reading drops a source out of the track with no trace whenever its
 * only tie happens to be a well-populated concept. The × means "this isn't about that"; the
 * spine's × is what removes things.
 */
export function planUntieConcept(
  track: TrackOrder,
  sourceId: string,
  concept: { id: string; flavour: string },
  otherFamilyTies: readonly string[],
): Plan {
  const cut: Plan = { unlink: [about(sourceId, concept.id, concept.flavour)], link: [] };
  const stillShown = otherFamilyTies.some((id) => id !== concept.id);
  return stillShown ? cut : merge(cut, planAdd(track, sourceId));
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
