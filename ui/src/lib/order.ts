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
}

export function orderedSources(syl: { sourceIds: readonly string[]; sourceLevels: readonly (readonly string[])[] }): OrderedSource[] {
  const includesIdx = new Map(syl.sourceIds.map((id, i) => [id, i]));
  const byIncludes = (a: string, b: string) => (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0);
  const levels = syl.sourceLevels.length > 0 ? syl.sourceLevels : [syl.sourceIds];
  if (levels.length <= 1) {
    // No ordering edges yet: INCLUDES order, one step each.
    return [...(levels[0] ?? [])].sort(byIncludes).map((id, i) => ({ id, level: i }));
  }
  return levels.flatMap((lvl, li) => [...lvl].sort(byIncludes).map((id) => ({ id, level: li })));
}
