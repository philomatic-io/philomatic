/**
 * Track source ordering — the display order shared by Journey and Graph.
 *
 * The engine layers a track's members by its in-context PRECEDES edges
 * (`TrackView.sourceLevels`); sources sharing a level are co-requisites. When no PRECEDES
 * edges exist (one big level), INCLUDES order stands in as the sequence — each source gets its
 * own step number, preserving the pre-ordering UX. Once any PRECEDES exists, the topological
 * level is the step number, so co-requisites share it ("same line").
 */

export interface OrderedSource {
  id: string;
  /** 0-based step; co-requisites share it (display as step + 1). */
  level: number;
  /** True for members NO ordering edge touches while an ordering exists — they trail the
   *  chain and should display WITHOUT a number (owner: a number implies a position they
   *  don't have; 2026-07-22). */
  unordered?: boolean;
}

export function orderedSources(syl: {
  sourceIds: readonly string[];
  sourceLevels: readonly (readonly string[])[];
  precedes?: readonly { srcId: string; dstId: string }[];
}): OrderedSource[] {
  const includesIdx = new Map(syl.sourceIds.map((id, i) => [id, i]));
  const byIncludes = (a: string, b: string) => (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0);
  const levels = syl.sourceLevels.length > 0 ? syl.sourceLevels : [syl.sourceIds];
  if (levels.length <= 1) {
    // No ordering edges yet: INCLUDES order, one step each.
    return [...(levels[0] ?? [])].sort(byIncludes).map((id, i) => ({ id, level: i }));
  }
  // Members that NO ordering edge touches are UNORDERED — they belong at the BOTTOM (owner
  // bug 2026-07-22: a fresh capture into an ordered track landed at step 1 beside the real
  // first source, because a node with no predecessors topo-levels to 0). They follow the
  // ordered chain in inclusion order, one step each; without the precedes list we can't
  // tell ordered from untouched and keep the raw levels.
  const touched = syl.precedes === undefined ? undefined : new Set(syl.precedes.flatMap((p) => [p.srcId, p.dstId]));
  if (touched === undefined) return levels.flatMap((lvl, li) => [...lvl].sort(byIncludes).map((id) => ({ id, level: li })));
  const orderedLevels = levels.map((lvl) => [...lvl].filter((id) => touched.has(id)).sort(byIncludes)).filter((lvl) => lvl.length > 0);
  const out = orderedLevels.flatMap((lvl, li) => lvl.map((id) => ({ id, level: li })));
  const tail = syl.sourceIds.filter((id) => !touched.has(id)).sort(byIncludes);
  return [...out, ...tail.map((id, i) => ({ id, level: orderedLevels.length + i, unordered: true }))];
}
