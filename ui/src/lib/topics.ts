/**
 * Topic grouping (experiment) — the concept-anchored projection of a track, shared by the
 * Outline tab and the Library detail rail's concept view.
 *
 * Only the track's INCLUDED concepts become topics (numbered by the global assemble's
 * prerequisite order). Sources are gathered from the whole prerequisite family and each
 * rolls UP to one topic: its top tie (earliest in-family concept) decides, via that
 * concept's NEAREST included ancestor — the upstream walk stops at the first main it hits
 * (mains chain to each other; walking past them would collapse everything into the root
 * topic), and a multi-ancestor concept belongs to its most specific main. The source's
 * actual in-family ties ride along for the chips row. Derived, read-only — the ABOUT pool
 * is candidates; topic grouping is NOT membership and never publishes.
 */
import { conceptFamily } from '../../../src/graph/family';
import type { AssembleResult, GraphEnvelope, SourceView } from '../client/types';

export interface TopicGroup {
  conceptId: string;
  conceptName: string;
  tags: string[];
  /** Source + the in-family concepts it's tied to (the card-foot chips). */
  sources: { source: SourceView; ties: { id: string; name: string }[] }[];
}

/** Stable topological order by PRECEDES within one group; falls back to given order on cycles. */
function orderByPrecedes(sources: SourceView[], edges: { srcId: string; dstId: string }[]): SourceView[] {
  const ids = new Set(sources.map((s) => s.id));
  const before = new Map<string, Set<string>>(); // id → ids that must come before it
  for (const s of sources) before.set(s.id, new Set());
  for (const e of edges) if (ids.has(e.srcId) && ids.has(e.dstId)) before.get(e.dstId)!.add(e.srcId);
  const placed = new Set<string>();
  const out: SourceView[] = [];
  let remaining = sources.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => [...before.get(s.id)!].every((b) => placed.has(b)));
    const batch = ready.length > 0 ? ready : [remaining[0]!]; // cycle guard: emit in given order
    for (const s of batch) {
      out.push(s);
      placed.add(s.id);
    }
    remaining = remaining.filter((s) => !placed.has(s.id));
  }
  return out;
}

interface Projection {
  groups: TopicGroup[];
  order: Map<string, { level: number; seq: number }>;
  byId: Map<string, { id: string; name: string; tags: string[] }>;
  /** PREREQUISITE_OF adjacency, prerequisite → dependents (concepts only). */
  downstream: Map<string, string[]>;
  /** Source→source PRECEDES edges (reading order — readsAfter sugar / Reading order UI). */
  precedes: { srcId: string; dstId: string }[];
  /** Concepts in the track's prerequisite family (an included main upstream of them, or a main). */
  familyIds: Set<string>;
  /** The track's INCLUDED concepts, prerequisite-ordered. */
  mains: string[];
  /** Guarded-DFS depth per family concept (indentation for flat lenses). */
  depth: Map<string, number>;
  /** Owning main per family concept (a main owns itself). */
  owner: Map<string, string | undefined>;
}

function project(asm: AssembleResult, graph: GraphEnvelope, trackId: string, allSources: SourceView[]): Projection {
  // Assemble order over ALL concepts (level, then seq) — the deterministic base rank the
  // shared family module uses for roots/siblings/tie-breaks.
  const base = new Map<string, { level: number; seq: number }>();
  let seq = 0;
  asm.levels.forEach((level, li) => {
    for (const c of level) base.set(c.id, { level: li, seq: seq++ });
  });
  const byId = new Map(asm.levels.flat().map((c) => [c.id, c]));
  const idByName = new Map(asm.levels.flat().map((c) => [c.name, c.id]));
  const baseRank = (a: string, b: string) => base.get(a)!.level - base.get(b)!.level || base.get(a)!.seq - base.get(b)!.seq;

  const conceptIds = graph.nodes.filter((n) => n.kind === 'concept').map((n) => n.id).filter((id) => base.has(id));
  const fam = conceptFamily({
    conceptIds,
    prereqs: graph.edges.filter((e) => e.type === 'PREREQUISITE_OF'),
    mains: graph.edges.filter((e) => e.type === 'INCLUDES' && e.srcId === trackId).map((e) => e.dstId),
    baseRank,
  });
  // The projection's total order: guarded rank for family concepts, base rank elsewhere
  // (only in-family comparisons matter downstream — see nextMoves).
  const order = new Map(base);
  for (const [id, r] of fam.rank) order.set(id, { level: 0, seq: r });

  const byMain = new Map<string, { source: SourceView; ties: { id: string; name: string }[] }[]>();
  for (const s of allSources) {
    const tieIds = s.about
      .map((n) => idByName.get(n))
      .filter((id): id is string => id !== undefined && fam.familyIds.has(id));
    if (tieIds.length === 0) continue;
    const topTie = tieIds.slice().sort((a, b) => order.get(a)!.level - order.get(b)!.level || order.get(a)!.seq - order.get(b)!.seq)[0]!;
    const owner = fam.ownerOf.get(topTie);
    if (owner === undefined) continue;
    if (!byMain.has(owner)) byMain.set(owner, []);
    byMain.get(owner)!.push({ source: s, ties: tieIds.map((id) => ({ id, name: byId.get(id)!.name })) });
  }

  const precedes = graph.edges.filter((e) => e.type === 'PRECEDES');
  const groups = fam.mains.map((id) => {
    const entries = byMain.get(id) ?? [];
    const ordered = orderByPrecedes(entries.map((e) => e.source), precedes);
    const byIdEntry = new Map(entries.map((e) => [e.source.id, e]));
    return {
      conceptId: id,
      conceptName: byId.get(id)!.name,
      tags: byId.get(id)!.tags,
      sources: ordered.map((s) => byIdEntry.get(s.id)!),
    };
  });
  return {
    groups,
    order,
    byId: new Map([...byId].map(([id, c]) => [id, { id: c.id, name: c.name, tags: c.tags }])),
    downstream: fam.downstream,
    precedes,
    familyIds: fam.familyIds,
    mains: fam.mains,
    depth: fam.depth,
    owner: fam.ownerOf,
  };
}

export function buildTopics(asm: AssembleResult, graph: GraphEnvelope, trackId: string, allSources: SourceView[]): TopicGroup[] {
  return project(asm, graph, trackId, allSources).groups;
}

/** The track's whole concept family, FLAT, in prerequisite order (assemble's level, then
 *  seq) — Journey's concept lens: "just list all concepts in order" (owner, 2026-07-19). */
export function orderedConcepts(
  asm: AssembleResult,
  graph: GraphEnvelope,
  trackId: string,
): { id: string; name: string; tags: string[]; level: number; main: boolean; owner?: string }[] {
  const { order, byId, familyIds, mains, depth, owner } = project(asm, graph, trackId, []);
  const mainSet = new Set(mains);
  return [...familyIds]
    .filter((id) => order.has(id))
    .sort((a, b) => order.get(a)!.level - order.get(b)!.level || order.get(a)!.seq - order.get(b)!.seq)
    .map((id) => ({ id, name: byId.get(id)!.name, tags: byId.get(id)!.tags, level: depth.get(id) ?? 0, main: mainSet.has(id), owner: owner.get(id) }));
}

/** Every concept, guarded-DFS ordered as if each were its own topic — the Journey concept
 *  column's fallback when a track includes no concepts yet (nothing is a 'main'). */
export function orderedConceptsAll(
  asm: AssembleResult,
  graph: GraphEnvelope,
): { id: string; name: string; tags: string[]; main: boolean }[] {
  const base = new Map<string, number>();
  let seq = 0;
  for (const c of asm.levels.flat()) base.set(c.id, seq++);
  const byId = new Map(asm.levels.flat().map((c) => [c.id, c]));
  const allIds = graph.nodes.filter((n) => n.kind === 'concept').map((n) => n.id).filter((id) => base.has(id));
  const fam = conceptFamily({
    conceptIds: allIds,
    prereqs: graph.edges.filter((e) => e.type === 'PREREQUISITE_OF'),
    mains: allIds, // every concept is its own main → guarded DFS over the whole graph
    baseRank: (a, b) => (base.get(a) ?? 0) - (base.get(b) ?? 0),
  });
  return [...fam.familyIds]
    .sort((a, b) => (fam.rank.get(a) ?? 0) - (fam.rank.get(b) ?? 0))
    .map((id) => ({ id, name: byId.get(id)!.name, tags: byId.get(id)!.tags, main: false }));
}

/** Concepts the given member sources are ABOUT, guarded-DFS ordered among themselves — the
 *  Journey concept column for a track with member sources but no INCLUDED concepts: "the
 *  conceptual territory this track's reading actually covers" (owner request, 2026-07-20).
 *  Only the tied concepts (not their descendants) appear. */
export function orderedConceptsForSources(
  asm: AssembleResult,
  graph: GraphEnvelope,
  sourceIds: Set<string>,
): { id: string; name: string; tags: string[]; main: boolean }[] {
  const base = new Map<string, number>();
  let seq = 0;
  for (const c of asm.levels.flat()) base.set(c.id, seq++);
  const byId = new Map(asm.levels.flat().map((c) => [c.id, c]));
  const tied = new Set(
    graph.edges.filter((e) => e.type === 'ABOUT' && sourceIds.has(e.srcId)).map((e) => e.dstId).filter((id) => base.has(id)),
  );
  const ids = [...tied];
  const fam = conceptFamily({
    conceptIds: ids,
    prereqs: graph.edges.filter((e) => e.type === 'PREREQUISITE_OF'),
    mains: ids, // exactly the tied set, guarded-DFS ordered among themselves
    baseRank: (a, b) => (base.get(a) ?? 0) - (base.get(b) ?? 0),
  });
  return [...fam.familyIds]
    .sort((a, b) => (fam.rank.get(a) ?? 0) - (fam.rank.get(b) ?? 0))
    .map((id) => ({ id, name: byId.get(id)!.name, tags: byId.get(id)!.tags, main: false }));
}

// ── Next-reading recommendations (owner design, 2026-07-19; monotone rework same day) ─────
// Two live moves from a source, derived, explainable, and skipping consumed sources. Both
// axes are STRICTLY MONOTONE on the prerequisite order, so recommendations can never cycle
// (owner report: fresh sources pointed at each other under the shared-concept rule):
//   deeper — the EXPLICIT reading order first (readsAfter / PRECEDES successors — the
//            author's hand-laid next, owner rule 2026-07-19); only when no unconsumed
//            successor exists, fall back to BFS strictly DOWN PREREQUISITE_OF from the
//            deepest tie (nearest descendant concept with an unconsumed source);
//   wider  — the first unconsumed source whose top tie is strictly LATER in prerequisite
//            order and shares no tie with the current source (labeled Topic N when it lands
//            in a later topic). Both wider and deeper's FALLBACK respect the reading order:
//            a source is only recommended when READY — all its PRECEDES predecessors are
//            consumed (the source you're on counts as satisfied). Explicit successors are
//            exempt: standing on a predecessor is what makes the successor next.
// Pure view: observations in, recommendation out; nothing is stored.

export interface NextMove {
  source: SourceView;
  /** The concept that justifies the recommendation — always shown to the user. */
  viaId: string;
  viaName: string;
  /** For moves landing in a later topic: the 1-based topic number. */
  topicIndex?: number;
}
export interface NextMoves {
  deeper?: NextMove;
  wider?: NextMove;
  /** True when the source is in this track's family but nothing unconsumed remains on either axis. */
  frontier: boolean;
}

export function nextMoves(
  asm: AssembleResult,
  graph: GraphEnvelope,
  trackId: string,
  allSources: SourceView[],
  sourceId: string,
): NextMoves | undefined {
  const { groups, order, byId, downstream, precedes } = project(asm, graph, trackId, allSources);
  const gi = groups.findIndex((g) => g.sources.some((e) => e.source.id === sourceId));
  if (gi < 0) return undefined; // not in this track's concept family
  const entry = groups[gi]!.sources.find((e) => e.source.id === sourceId)!;
  const tieIds = new Set(entry.ties.map((t) => t.id));
  const rank = (id: string) => order.get(id)!;
  const earlier = (a: string, b: string) => rank(a).level - rank(b).level || rank(a).seq - rank(b).seq;
  const later = (a: string, b: string) => -earlier(a, b);

  // All family entries with their topic index and stable position, for candidate scans.
  const all = groups.flatMap((g, ti) => g.sources.map((e, pos) => ({ e, ti, pos })));

  // Reading-order readiness: every PRECEDES predecessor consumed (current source counts).
  const consumedIds = new Set(allSources.filter((s) => s.consumed).map((s) => s.id));
  const predsOf = new Map<string, string[]>();
  for (const e of precedes) {
    if (!predsOf.has(e.dstId)) predsOf.set(e.dstId, []);
    predsOf.get(e.dstId)!.push(e.srcId);
  }
  const ready = (sid: string): boolean => (predsOf.get(sid) ?? []).every((pr) => consumedIds.has(pr) || pr === sourceId);

  // deeper 0: the explicit reading order — a PRECEDES successor beats any inference.
  let deeper: NextMove | undefined;
  const succEntries = precedes
    .filter((e) => e.srcId === sourceId)
    .flatMap((e) => {
      const hit = all.find(({ e: x }) => x.source.id === e.dstId && !x.source.consumed);
      return hit ? [hit] : []; // successors outside this track's family (no entry) are skipped
    })
    .map((c) => ({ ...c, top: c.e.ties.map((t) => t.id).sort(earlier)[0]! }))
    .sort((a, b) => earlier(a.top, b.top) || a.ti - b.ti || a.pos - b.pos);
  if (succEntries.length > 0) {
    const pick = succEntries[0]!;
    deeper = {
      source: pick.e.source,
      viaId: pick.top,
      viaName: byId.get(pick.top)!.name,
      ...(pick.ti !== gi ? { topicIndex: pick.ti + 1 } : {}),
    };
  }

  // deeper fallback: BFS strictly down the prerequisite chain from the deepest tie.
  const start = deeper === undefined ? [...tieIds].sort(later)[0] : undefined;
  if (start !== undefined) {
    const seen = new Set([start]);
    let frontierIds = [start];
    while (frontierIds.length > 0 && deeper === undefined) {
      const next: string[] = [];
      for (const cid of frontierIds) for (const d of downstream.get(cid) ?? []) if (!seen.has(d)) { seen.add(d); next.push(d); }
      // At equal depth, stay in the CURRENT topic when possible (Heyting before Forcing
      // when both are direct dependents of Boolean Algebras), then concept order.
      const depthCands = next
        .flatMap((cid) => {
          const cand = all.find(({ e }) => e.source.id !== sourceId && !e.source.consumed && ready(e.source.id) && e.ties.some((t) => t.id === cid));
          return cand ? [{ cid, cand }] : [];
        })
        .sort((a, b) => (a.cand.ti === gi ? 0 : 1) - (b.cand.ti === gi ? 0 : 1) || earlier(a.cid, b.cid) || a.cand.pos - b.cand.pos);
      if (depthCands.length > 0) {
        const { cid, cand } = depthCands[0]!;
        deeper = { source: cand.e.source, viaId: cid, viaName: byId.get(cid)!.name, ...(cand.ti !== gi ? { topicIndex: cand.ti + 1 } : {}) };
      }
      frontierIds = next;
    }
  }

  // wider: always FORWARD in topic order — a later concept within this topic, else any
  // later topic (never a jump back; prerequisite order alone can point at earlier topics).
  let wider: NextMove | undefined;
  const myTop = [...tieIds].sort(earlier)[0]!;
  const widerCands = all
    .filter(({ e }) => e.source.id !== sourceId && e.source.id !== deeper?.source.id && !e.source.consumed && ready(e.source.id) && !e.ties.some((t) => tieIds.has(t.id)))
    .map((c) => ({ ...c, top: c.e.ties.map((t) => t.id).sort(earlier)[0]! }))
    .filter((c) => c.ti > gi || (c.ti === gi && earlier(myTop, c.top) < 0))
    .sort((a, b) => a.ti - b.ti || earlier(a.top, b.top) || a.pos - b.pos);
  if (widerCands.length > 0) {
    const pick = widerCands[0]!;
    wider = {
      source: pick.e.source,
      viaId: pick.top,
      viaName: byId.get(pick.top)!.name,
      ...(pick.ti !== gi ? { topicIndex: pick.ti + 1 } : {}),
    };
  }

  return { deeper, wider, frontier: deeper === undefined && wider === undefined };
}

// ── Bundle-native entry (publication pages) ────────────────────────────────────────────────
// A published page has a BUNDLE, not an engine: fabricate the projection inputs here (Kahn
// layering over the bundle's own PREREQUISITE_OF as the base rank) so the viewer shares the
// exact grouping/ordering logic instead of hand-rolling inputs (the fake-asm hack retired).

interface BundleTag {
  name: string;
  subtype?: string;
  degree?: number;
}
export interface TopicsBundlePayload {
  tracks: { id: string }[];
  concepts: { id: string; name: string; tags: BundleTag[] }[];
  sources: { id: string; title: string; author?: string; directUrl?: string; modality: string; tags: BundleTag[] }[];
  edges: { srcType: string; srcId: string; type: string; dstType: string; dstId: string }[];
}

const bundleTagLabel = (t: BundleTag): string =>
  `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}${t.degree !== undefined ? `:${t.degree}` : ''}`;

export function buildTopicsFromBundle(p: TopicsBundlePayload): TopicGroup[] {
  const trackId = p.tracks[0]?.id ?? '';
  // Kahn layering over the bundle's PREREQUISITE_OF — the deterministic base rank.
  const ids = p.concepts.map((c) => c.id);
  const idSet = new Set(ids);
  const before = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const e of p.edges) {
    if (e.type === 'PREREQUISITE_OF' && idSet.has(e.srcId) && idSet.has(e.dstId)) before.get(e.dstId)!.add(e.srcId);
  }
  const levels: string[][] = [];
  const placed = new Set<string>();
  let remaining = ids.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter((id) => [...before.get(id)!].every((b) => placed.has(b)));
    const level = ready.length > 0 ? ready : [remaining[0]!];
    levels.push(level);
    for (const id of level) placed.add(id);
    remaining = remaining.filter((id) => !placed.has(id));
  }
  const conceptById = new Map(p.concepts.map((c) => [c.id, c]));
  const nameById = new Map(p.concepts.map((c) => [c.id, c.name]));
  const aboutBySource = new Map<string, string[]>();
  for (const e of p.edges) {
    if (e.type === 'ABOUT' && e.dstType === 'concept') {
      const name = nameById.get(e.dstId);
      if (name !== undefined) aboutBySource.set(e.srcId, [...(aboutBySource.get(e.srcId) ?? []), name]);
    }
  }
  const asm = {
    levels: levels.map((lvl) => lvl.map((id) => ({ id, name: conceptById.get(id)!.name, tags: conceptById.get(id)!.tags.map(bundleTagLabel) }))),
  } as unknown as AssembleResult;
  const graph = {
    nodes: p.concepts.map((c) => ({ id: c.id, kind: 'concept', label: c.name, tags: [] })),
    edges: p.edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, type: e.type, tags: [] })),
  } as unknown as GraphEnvelope;
  const sources = p.sources.map((src) => ({
    id: src.id,
    title: src.title,
    modality: src.modality,
    url: src.directUrl,
    tags: src.tags.map(bundleTagLabel),
    about: aboutBySource.get(src.id) ?? [],
    author: src.author,
    consumed: false,
    staged: false,
  })) as unknown as SourceView[];
  return buildTopics(asm, graph, trackId, sources);
}
