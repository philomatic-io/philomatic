/**
 * The ONE set of map edge-drawing rules — the workbench Map and the
 * published track's map must draw the same picture, so the rule lives here and both import
 * it. It was previously inline in MapView, and the publication map (an early twin)
 * silently missed a later ruling — the look-alike-drift failure mode again.
 *
 * The rule: INCLUDES draws as its MINIMAL NON-REDUNDANT subset —
 * a track's direct spoke shows only when the member isn't already reachable through the
 * track's own structure. Concepts: only the HEADS (no taxonomy parent among this track's
 * member concepts) — nested members arrive via their #TopicOf/#SubfieldOf tie. Sources: only
 * UNCLASSIFIED members (ABOUT none of this track's member concepts) — classified ones hang
 * off their concept. Every drawn line is a real edge; membership itself is unchanged
 * (all INCLUDES edges still drive scoping and filters — this shapes DRAWING only).
 */
import { hierarchyLinks } from './ranks';

export interface DrawableEdge {
  srcId: string;
  dstId: string;
  type: string;
  tags?: readonly string[];
}

export function minimalIncludesEdges<E extends DrawableEdge>(
  edges: readonly E[],
  kindOf: (id: string) => string | undefined,
): E[] {
  const memberConcepts = new Map<string, Set<string>>(); // track → its member concept ids
  for (const e of edges) {
    if (e.type !== 'INCLUDES' || kindOf(e.dstId) !== 'concept') continue;
    if (!memberConcepts.has(e.srcId)) memberConcepts.set(e.srcId, new Set());
    memberConcepts.get(e.srcId)!.add(e.dstId);
  }
  const taxonomyParents = hierarchyLinks(edges); // child → its declared parents
  const aboutOf = new Map<string, Set<string>>(); // source → concepts it is ABOUT
  for (const e of edges) {
    if (e.type !== 'ABOUT' || kindOf(e.dstId) !== 'concept') continue;
    if (!aboutOf.has(e.srcId)) aboutOf.set(e.srcId, new Set());
    aboutOf.get(e.srcId)!.add(e.dstId);
  }
  return edges.filter((e) => {
    if (e.type !== 'INCLUDES') return true;
    const members = memberConcepts.get(e.srcId) ?? new Set<string>();
    const dk = kindOf(e.dstId);
    if (dk === 'concept') return !(taxonomyParents.get(e.dstId) ?? []).some((l) => members.has(l.dstId));
    if (dk === 'source') return ![...(aboutOf.get(e.dstId) ?? [])].some((c) => members.has(c));
    return true;
  });
}
