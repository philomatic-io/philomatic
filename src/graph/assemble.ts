/**
 * Topological assembly (MVP.md §3). Orders concepts into prerequisite
 * "levels" via Kahn's algorithm: level 0 has no unmet prerequisites, each later level
 * depends only on earlier ones. Assumes the graph is acyclic — the parser (Tier 2)
 * guarantees this before anything is persisted.
 */
import type { DirectedEdge } from './cycles';

/**
 * @param nodeIds  the concept ids to order
 * @param prereq   PREREQUISITE_OF edges (src = prerequisite, dst = dependent)
 * @returns        levels, each a sorted array of concept ids; prerequisites precede dependents
 */
export function topoLevels(nodeIds: string[], prereq: DirectedEdge[]): string[][] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const { src, dst } of prereq) {
    if (!indegree.has(src) || !indegree.has(dst)) continue; // ignore edges to excluded nodes
    adj.get(src)!.push(dst);
    indegree.set(dst, (indegree.get(dst) ?? 0) + 1);
  }

  const levels: string[][] = [];
  let frontier = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  while (frontier.length > 0) {
    levels.push(frontier);
    const next: string[] = [];
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        const d = (indegree.get(v) ?? 0) - 1;
        indegree.set(v, d);
        if (d === 0) next.push(v);
      }
    }
    frontier = next.sort();
  }
  return levels;
}
