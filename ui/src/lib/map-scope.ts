/**
 * Map scope — "show me this one thing, in context, with its contents".
 *
 * Double-click a node on the Map, or jump there with "view in map" from the Library, and the
 * canvas narrows to one entity's world. ONE definition lives here, so the double-click and the
 * Library's jump cannot come to mean different things — the same drift lib/outline.ts exists
 * to end.
 *
 * The rule has two halves and NO conditional between them:
 *
 *   CONTEXT   — everything the entity directly touches, one hop, any relation, either
 *               direction. This is where a concept's PREREQUISITE_OF neighbours come from, and
 *               a source's reading-order neighbours, its track, and what it is about.
 *   CONTENTS  — everything under it, followed recursively, through containment and taxonomy
 *               only: track → members → their declared topics → what is ABOUT those → their
 *               passages and questions. This is what makes double-clicking a TRACK give you
 *               its whole world rather than just its direct members.
 *
 * Context is one hop ON PURPOSE. Prerequisites chain: Model Theory unlocks Formal Arithmetic
 * unlocks the next thing, and following that recursively hands back most of the track you were
 * trying to narrow away from. Descent starts at the seed only, for the same reason — a
 * neighbour appears, but its subtree does not come with it.
 *
 * Superseded: an earlier cut descended only, and fell back to the
 * neighbourhood when nothing was under the seed. That made the gesture answer two different
 * questions depending on whether an entity happened to have children — two sources in one
 * track, one after the other, drew completely unalike. A rule that switches on the data is not
 * a rule the reader can hold in their head.
 */
import { hierarchyLinks } from './ranks';

export interface ScopeEdge {
  srcId: string;
  dstId: string;
  type: string;
  tags?: readonly string[];
}

export function scopeOf(seedId: string, edges: readonly ScopeEdge[]): Set<string> {
  const ids = new Set<string>([seedId]);

  // CONTEXT — one hop, any relation, either direction.
  for (const e of edges) {
    if (e.srcId === seedId) ids.add(e.dstId);
    if (e.dstId === seedId) ids.add(e.srcId);
  }

  // CONTENTS — what "under" means, as an adjacency to walk.
  const down = new Map<string, Set<string>>();
  const add = (parent: string, child: string): void => {
    if (parent === child) return;
    if (!down.has(parent)) down.set(parent, new Set());
    down.get(parent)!.add(child);
  };
  for (const e of edges) {
    if (e.type === 'INCLUDES') add(e.srcId, e.dstId);
    else if (e.type === 'SNIPPET_OF') add(e.dstId, e.srcId);
    else if (e.type === 'RAISES') add(e.srcId, e.dstId);
    else if (e.type === 'ABOUT') add(e.dstId, e.srcId);
  }
  // Taxonomy from the framework DECLARATIONS, never tag-name literals, and
  // BOTH roles — the same rule the hulls group by (lib/map-groups.ts). #TopicOf is declared an
  // 'attachment', so filtering to 'parent' would quietly drop every topic from its field.
  for (const [childId, links] of hierarchyLinks(edges)) {
    for (const l of links) add(l.dstId, childId);
  }

  const walked = new Set<string>([seedId]);
  const queue = [seedId];
  while (queue.length > 0) {
    for (const child of down.get(queue.shift()!) ?? []) {
      ids.add(child);
      if (walked.has(child)) continue;
      walked.add(child);
      queue.push(child);
    }
  }
  return ids;
}
