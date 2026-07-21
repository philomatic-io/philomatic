/**
 * The concept family of a track (debt/read-contract, 2026-07-19) — ONE implementation of the
 * closure + ordering that the concepts-anchored model rests on, shared by the engine's
 * publication closure (src/engine/read.ts) and the workbench's projection (ui/src/lib/topics.ts).
 * Dependency-free and pure on purpose, like pub-verify: both sides import it, so the two can't
 * drift (they briefly did — this module is the fix).
 *
 * Definitions:
 *  - FAMILY: the track's INCLUDED concepts (mains) plus every concept connected to them by
 *    walking PREREQUISITE_OF in BOTH directions — the ancestors a track assumes and the
 *    descendants that specialize it.
 *  - OWNER: a concept's most specific nearest included main. The upstream walk STOPS at the
 *    first main it hits (mains chain to each other; walking past them would collapse
 *    everything into the root topic); of several nearest mains, the latest-ranked wins.
 *  - GUARDED RANK (owner ruling, 2026-07-19): the shared total order. A depth-first walk that
 *    commits to a branch and goes as deep as possible but never enters a concept before ALL
 *    its in-family prerequisites; deferred children resume when their last prerequisite lands.
 *    Deterministic via `baseRank` (roots, child order, tie-breaks). It is a topological order,
 *    so anything monotone on it (next-reading moves) cannot cycle.
 */

export interface FamilyInput {
  /** Every concept id in scope (family membership is derived from these). */
  conceptIds: Iterable<string>;
  /** PREREQUISITE_OF pairs among concepts — src is a prerequisite of dst. */
  prereqs: { srcId: string; dstId: string }[];
  /** The track's INCLUDED concept ids (unordered; this module orders them). */
  mains: Iterable<string>;
  /** Deterministic comparator for roots / sibling order / tie-breaks (e.g. assemble rank). */
  baseRank: (a: string, b: string) => number;
}

export interface Family {
  /** Concepts in the family (mains included). */
  familyIds: Set<string>;
  /** The included concepts, guarded-rank ordered. */
  mains: string[];
  /** Owning main per family concept (a main owns itself). */
  ownerOf: Map<string, string | undefined>;
  /** Guarded-DFS rank per family concept — the shared total order. */
  rank: Map<string, number>;
  /** Guarded-DFS depth per family concept (indentation for flat lenses). */
  depth: Map<string, number>;
  /** PREREQUISITE_OF adjacency restricted to known concepts: prerequisite → dependents. */
  downstream: Map<string, string[]>;
  /** The reverse adjacency: concept → its direct prerequisites. */
  upstream: Map<string, string[]>;
}

export function conceptFamily(input: FamilyInput): Family {
  const conceptIds = new Set(input.conceptIds);
  const mainSet = new Set([...input.mains].filter((id) => conceptIds.has(id)));

  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const e of input.prereqs) {
    if (!conceptIds.has(e.srcId) || !conceptIds.has(e.dstId)) continue;
    if (!upstream.has(e.dstId)) upstream.set(e.dstId, []);
    upstream.get(e.dstId)!.push(e.srcId);
    if (!downstream.has(e.srcId)) downstream.set(e.srcId, []);
    downstream.get(e.srcId)!.push(e.dstId);
  }

  // Nearest included ancestors — memoized upstream walk that stops at mains.
  const nearest = new Map<string, Set<string>>();
  const resolve = (id: string, seen: Set<string>): Set<string> => {
    const cached = nearest.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    if (mainSet.has(id)) out.add(id);
    else if (!seen.has(id)) {
      seen.add(id);
      for (const up of upstream.get(id) ?? []) for (const m of resolve(up, seen)) out.add(m);
    }
    nearest.set(id, out);
    return out;
  };
  for (const id of conceptIds) resolve(id, new Set());
  const familyIds = new Set([...conceptIds].filter((id) => (nearest.get(id)?.size ?? 0) > 0));

  // Guarded depth-first rank over the family.
  const famPrereqs = new Map<string, string[]>();
  const kids = new Map<string, string[]>();
  for (const id of familyIds) famPrereqs.set(id, (upstream.get(id) ?? []).filter((p) => familyIds.has(p)));
  for (const [id, ups] of famPrereqs)
    for (const up of ups) {
      if (!kids.has(up)) kids.set(up, []);
      kids.get(up)!.push(id);
    }
  for (const list of kids.values()) list.sort(input.baseRank);
  const rank = new Map<string, number>();
  const depth = new Map<string, number>();
  const visit = (id: string, d: number): void => {
    if (rank.has(id) || !famPrereqs.get(id)!.every((pr) => rank.has(pr))) return;
    rank.set(id, rank.size);
    depth.set(id, d);
    const cs = kids.get(id) ?? [];
    for (const c of cs) visit(c, d + 1);
    for (const c of cs) visit(c, d + 1); // a child deferred above may be ready now
  };
  const roots = [...familyIds].filter((id) => famPrereqs.get(id)!.length === 0).sort(input.baseRank);
  for (let grew = true; grew; ) {
    const before = rank.size;
    for (const r of roots) visit(r, 0);
    grew = rank.size !== before;
  }

  const guarded = (a: string, b: string): number => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return input.baseRank(a, b);
  };
  const mains = [...mainSet].sort(guarded);
  const latest = (a: string, b: string): number => -guarded(a, b);
  const ownerOf = new Map<string, string | undefined>();
  for (const id of familyIds) ownerOf.set(id, [...nearest.get(id)!].sort(latest)[0]);

  return { familyIds, mains, ownerOf, rank, depth, downstream, upstream };
}
