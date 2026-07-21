/**
 * Directed-graph cycle detection (MVP.md §3). Shared by the parser's
 * Tier-2 check today and the read-side topological assembler later — one implementation,
 * two callers.
 */

export interface DirectedEdge {
  src: string;
  dst: string;
}

/**
 * Return the first cycle found as a node path (`[a, b, a]`), or null if the graph is
 * acyclic. Iterative-friendly DFS with white/gray/black colouring; a gray neighbour is a
 * back-edge, i.e. a cycle.
 */
export function findCycle(edges: DirectedEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const { src, dst } of edges) {
    nodes.add(src);
    nodes.add(dst);
    const list = adj.get(src);
    if (list) list.push(dst);
    else adj.set(src, [dst]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];

  const visit = (u: string): string[] | null => {
    color.set(u, GRAY);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const start = path.indexOf(v);
        return [...path.slice(start), v];
      }
      if (c === WHITE) {
        const found = visit(v);
        if (found) return found;
      }
    }
    color.set(u, BLACK);
    path.pop();
    return null;
  };

  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}
