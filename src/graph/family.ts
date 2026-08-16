/**
 * The concept family of a track — ONE implementation of the membership/arrangement/ordering
 * split that the track views rest on, shared by the engine's publication closure
 * (src/engine/read.ts) and the workbench's projection (ui/src/lib/topics.ts). Dependency-free
 * and pure on purpose, like pub-verify: both sides import it, so the two can't drift.
 *
 * MODEL (the concept side of the membership invariant):
 *  - MEMBERSHIP — `INCLUDES` says WHAT is in the track. The family IS the track's included
 *    concepts, period. Nothing is derived into membership: walking PREREQUISITE_OF used to pull
 *    every downstream specialization into the family, which broke exactly like auto-pulled
 *    sources did ("add a concept next month and it silently joins every track upstream of it").
 *  - ARRANGEMENT — the declared taxonomy (#SubfieldOf/#TopicOf framework LINKs) says HOW to
 *    show it. HEADS are included concepts with no included taxonomy parent; every other
 *    included concept rolls up to its OWNER, the nearest head reachable by walking taxonomy
 *    parents within the included set (of several, the latest-ranked wins). No taxonomy ties ⇒
 *    every member is a head (flat sections) — the honest fallback.
 *  - ORDERING — PREREQUISITE_OF orders; it never expands or groups. GUARDED RANK
 *    is the shared total order: a depth-first walk that commits to a
 *    branch and goes as deep as possible but never enters a concept before ALL its in-family
 *    prerequisites; deferred children resume when their last prerequisite lands. Deterministic
 *    via `baseRank` (roots, child order, tie-breaks). It is a topological order, so anything
 *    monotone on it (next-reading moves) cannot cycle.
 */

export interface FamilyInput {
  /** The track's INCLUDED concept ids — membership, period. */
  members: Iterable<string>;
  /** PREREQUISITE_OF pairs among concepts — ORDERING only. src is a prerequisite of dst. */
  prereqs: { srcId: string; dstId: string }[];
  /** Declared-taxonomy ties, child → parent (#SubfieldOf/#TopicOf LINKs) — GROUPING only. */
  taxonomy?: { childId: string; parentId: string }[];
  /** Deterministic comparator for roots / sibling order / tie-breaks (e.g. assemble rank). */
  baseRank: (a: string, b: string) => number;
}

export interface Family {
  /** Concepts in the family — exactly the included members. */
  familyIds: Set<string>;
  /** The section heads (members with no included taxonomy parent), guarded-rank ordered. */
  mains: string[];
  /** Owning head per member (a head owns itself). */
  ownerOf: Map<string, string | undefined>;
  /** Guarded-DFS rank per member — the shared total order. */
  rank: Map<string, number>;
  /** Guarded-DFS depth per member (indentation for flat lenses). */
  depth: Map<string, number>;
  /** PREREQUISITE_OF adjacency restricted to members: prerequisite → dependents. */
  downstream: Map<string, string[]>;
  /** The reverse adjacency: member → its direct in-family prerequisites. */
  upstream: Map<string, string[]>;
}

export function conceptFamily(input: FamilyInput): Family {
  const familyIds = new Set(input.members);

  // Prerequisite adjacency, restricted to members — ordering only.
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const e of input.prereqs) {
    if (!familyIds.has(e.srcId) || !familyIds.has(e.dstId)) continue;
    if (!upstream.has(e.dstId)) upstream.set(e.dstId, []);
    upstream.get(e.dstId)!.push(e.srcId);
    if (!downstream.has(e.srcId)) downstream.set(e.srcId, []);
    downstream.get(e.srcId)!.push(e.dstId);
  }

  // Guarded depth-first rank over the members.
  const famPrereqs = new Map<string, string[]>();
  const kids = new Map<string, string[]>();
  for (const id of familyIds) famPrereqs.set(id, upstream.get(id) ?? []);
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

  // Taxonomy parents, restricted to members — grouping only.
  const parentsOf = new Map<string, string[]>();
  for (const t of input.taxonomy ?? []) {
    if (!familyIds.has(t.childId) || !familyIds.has(t.parentId) || t.childId === t.parentId) continue;
    if (!parentsOf.has(t.childId)) parentsOf.set(t.childId, []);
    parentsOf.get(t.childId)!.push(t.parentId);
  }
  const headSet = new Set([...familyIds].filter((id) => (parentsOf.get(id)?.length ?? 0) === 0));
  // Nearest heads — memoized upward taxonomy walk. A taxonomy CYCLE among members resolves to
  // no head; those members become their own heads below (honesty rule: never lose content).
  const nearest = new Map<string, Set<string>>();
  const resolve = (id: string, seen: Set<string>): Set<string> => {
    const cached = nearest.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    if (headSet.has(id)) out.add(id);
    else if (!seen.has(id)) {
      seen.add(id);
      for (const up of parentsOf.get(id) ?? []) for (const h of resolve(up, seen)) out.add(h);
    }
    nearest.set(id, out);
    return out;
  };
  for (const id of familyIds) resolve(id, new Set());
  for (const id of familyIds) if ((nearest.get(id)?.size ?? 0) === 0) headSet.add(id); // cycle fallback

  const mains = [...headSet].sort(guarded);
  const latest = (a: string, b: string): number => -guarded(a, b);
  const ownerOf = new Map<string, string | undefined>();
  for (const id of familyIds) {
    const heads = [...(nearest.get(id) ?? [])];
    ownerOf.set(id, headSet.has(id) ? id : heads.sort(latest)[0]);
  }

  return { familyIds, mains, ownerOf, rank, depth, downstream, upstream };
}
