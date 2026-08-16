/**
 * TWIN COLLAPSE for the map: nodes with IDENTICAL inputs and
 * outputs — same kind, same edge set (type + direction + tags + the other endpoint) — fold
 * into one representative carrying a count. A graph with hundreds of interchangeable passages,
 * questions or sources reads as a handful of counted nodes instead of a starburst; clicking a
 * collapsed node expands ITS group and nothing else.
 *
 * Pure derivation, deliberately structural: twinship is decided ONLY by the graph (never by
 * label similarity — that would be a fuzzy merge, and the invariant forbids guessing).
 * Nodes with no edges at all have identical (empty) signatures too and fold per kind — a
 * hundred loose captures read as one counted node, which is exactly the relief this exists
 * to give.
 */

interface TwinNode {
  id: string;
  kind: string;
}
interface TwinEdge {
  srcId: string;
  dstId: string;
  type: string;
  tags?: readonly unknown[];
}

export interface TwinCollapse<N extends TwinNode, E extends TwinEdge> {
  nodes: N[];
  edges: E[];
  /** representative id → EVERY member id of its collapsed group (rep included). */
  twins: Map<string, string[]>;
}

/**
 * Fold twin groups (size ≥ 2) down to their representative — the lexically first member, so
 * the choice is stable across renders. Groups whose rep is in `expanded` stay open. Edges are
 * re-pointed at representatives, deduped, and twin-internal self-loops dropped.
 */
export function collapseTwins<N extends TwinNode, E extends TwinEdge>(
  nodes: readonly N[],
  edges: readonly E[],
  expanded: ReadonlySet<string> = new Set(),
): TwinCollapse<N, E> {
  // Each node's connection signature: every touching edge as direction|type|tags|other.
  const sig = new Map<string, string[]>();
  for (const n of nodes) sig.set(n.id, []);
  for (const e of edges) {
    const tagKey = JSON.stringify(e.tags ?? []);
    sig.get(e.srcId)?.push(`out|${e.type}|${tagKey}|${e.dstId}`);
    sig.get(e.dstId)?.push(`in|${e.type}|${tagKey}|${e.srcId}`);
  }

  const byTwinKey = new Map<string, N[]>();
  for (const n of nodes) {
    const key = `${n.kind}§${sig.get(n.id)!.sort().join('‖')}`;
    const bucket = byTwinKey.get(key);
    if (bucket) bucket.push(n);
    else byTwinKey.set(key, [n]);
  }

  const twins = new Map<string, string[]>();
  const repOf = new Map<string, string>(); // collapsed member → its representative
  for (const group of byTwinKey.values()) {
    if (group.length < 2) continue;
    const ids = group.map((n) => n.id).sort();
    const rep = ids[0]!;
    if (expanded.has(rep)) continue; // the reader opened this group — leave it open
    twins.set(rep, ids);
    for (const id of ids) if (id !== rep) repOf.set(id, rep);
  }

  const keptNodes = nodes.filter((n) => !repOf.has(n.id));
  const seen = new Set<string>();
  const keptEdges: E[] = [];
  for (const e of edges) {
    const srcId = repOf.get(e.srcId) ?? e.srcId;
    const dstId = repOf.get(e.dstId) ?? e.dstId;
    if (srcId === dstId) continue; // a tie between two twins of one group folds away
    const key = `${srcId}|${dstId}|${e.type}|${JSON.stringify(e.tags ?? [])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keptEdges.push(srcId === e.srcId && dstId === e.dstId ? e : { ...e, srcId, dstId });
  }
  return { nodes: keptNodes, edges: keptEdges, twins };
}
