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
import { orderedSources } from './order';
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
  /** Per source: the family concept it ANCHORS at (its earliest-ranked in-family tie). */
  anchorOf: Map<string, string>;
  /** concept → its direct prerequisites (for ancestry walks). */
  upstream: Map<string, string[]>;
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
  const anchorOf = new Map<string, string>();
  for (const s of allSources) {
    const tieIds = s.about
      .map((n) => idByName.get(n))
      .filter((id): id is string => id !== undefined && fam.familyIds.has(id));
    if (tieIds.length === 0) continue;
    const topTie = tieIds.slice().sort((a, b) => order.get(a)!.level - order.get(b)!.level || order.get(a)!.seq - order.get(b)!.seq)[0]!;
    const owner = fam.ownerOf.get(topTie);
    if (owner === undefined) continue;
    // ONE assignment for every consumer: the source ANCHORS at its top tie (earliest-ranked
    // in-family tie); grouping views roll that up to the tie's owner main. A finer-grained
    // view (the graph tier) hangs the source at the anchor itself — same rule, two zooms,
    // so the views can never disagree about where a source lives.
    anchorOf.set(s.id, topTie);
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
    anchorOf,
    upstream: fam.upstream,
  };
}

/** The ONE definition of a concept-anchored track: membership is concepts, not sources.
 *  Every view must use this — ad-hoc variants (filtered-source emptiness etc.) drifted. */
export function isConceptAnchored(track: { sourceIds: readonly string[] }): boolean {
  return track.sourceIds.length === 0;
}

/** A concept-anchored track's reading list, FLAT: buildTopics' groups flattened in guarded-DFS
 *  order, each source labeled with the concept group it sits under. The single source of truth
 *  for "what does the reader actually read" on such a track (Journey path, Detail by-sources,
 *  % consumed all consume this). */
export function derivedReading(
  asm: AssembleResult,
  graph: GraphEnvelope,
  trackId: string,
  allSources: SourceView[],
): { source: SourceView; concept: string }[] {
  return buildTopics(asm, graph, trackId, allSources).flatMap((g) =>
    g.sources.map((e) => ({ source: e.source, concept: g.conceptName })),
  );
}

/** By-concept groups for EITHER anchor mode — the one entry point for "show this track by
 *  concept" (Detail rail; owner gap 2026-07-21: the rail was empty for source-anchored tracks
 *  while Journey's lens had a fallback — same-surface views must share one derivation).
 *  Concept-anchored → buildTopics (owner-main groups). Source-anchored → the MEMBER sources
 *  grouped under the concepts they're ABOUT, in the same guarded order as Journey's lens
 *  fallback (orderedConceptsForSources), PRECEDES-ordered within each group; a source tied to
 *  several listed concepts appears under each (ties semantics, matching the lens sublists). */
export function topicsForTrack(
  asm: AssembleResult,
  graph: GraphEnvelope,
  track: { id: string; sourceIds: readonly string[]; sourceLevels?: readonly (readonly string[])[]; precedes?: readonly { srcId: string; dstId: string }[] },
  allSources: SourceView[],
): TopicGroup[] {
  if (isConceptAnchored(track)) return buildTopics(asm, graph, track.id, allSources);
  const memberIds = new Set(track.sourceIds);
  const members = allSources.filter((s) => memberIds.has(s.id));
  const ordered = orderedConceptsForSources(asm, graph, orderedSources({ sourceIds: track.sourceIds, sourceLevels: track.sourceLevels ?? [], precedes: track.precedes }).map((o) => o.id));
  const listed = new Set(ordered.map((c) => c.name));
  const idByName = new Map(ordered.map((c) => [c.name, c.id]));
  const precedes = graph.edges.filter((e) => e.type === 'PRECEDES');
  return ordered
    .map((c) => {
      const tied = members.filter((s) => s.about.includes(c.name));
      return {
        conceptId: c.id,
        conceptName: c.name,
        tags: c.tags,
        sources: orderByPrecedes(tied, precedes).map((source) => ({
          source,
          ties: source.about.filter((n) => listed.has(n)).map((n) => ({ id: idByName.get(n)!, name: n })),
        })),
      };
    })
    .filter((g) => g.sources.length > 0);
}

/**
 * A SOURCE-anchored track "by concept": its reading IN ORDER, each source carrying the
 * concepts it is ABOUT (owner bug 2026-07-23).
 *
 * Concept-first grouping is only honest when the track IS anchored on concepts. Applied to a
 * source-anchored track it invented a hierarchy from whatever ties happened to exist and
 * DROPPED every member without one — Interview Prep showed a single "Programming Problems"
 * topic, hiding five of its six sources. Here the reading is the spine and concepts annotate
 * it: nothing is hidden, and a source with no tie simply shows none.
 */
export function readingWithConcepts(
  asm: AssembleResult,
  graph: GraphEnvelope,
  track: { id: string; sourceIds: readonly string[]; sourceLevels?: readonly (readonly string[])[]; precedes?: readonly { srcId: string; dstId: string }[] },
  allSources: SourceView[],
): { source: SourceView; ties: { id: string; name: string }[] }[] {
  const idByName = new Map(asm.levels.flat().map((c) => [c.name, c.id]));
  const byId = new Map(allSources.map((s) => [s.id, s]));
  return orderedSources({ sourceIds: track.sourceIds, sourceLevels: track.sourceLevels ?? [], precedes: track.precedes })
    .map((o) => byId.get(o.id))
    .filter((s): s is SourceView => s !== undefined)
    .map((source) => ({
      source,
      ties: source.about
        .map((name) => ({ id: idByName.get(name), name }))
        .filter((t): t is { id: string; name: string } => t.id !== undefined),
    }));
}

/**
 * THE TRACK VIEW (owner design, 2026-07-23) — one shape for every track, replacing the
 * by-sources / by-concept toggle in the Library rail:
 *
 *   spine    — the track's MEMBER sources that are NOT filed under any concept below. The spine
 *              is "in the track, but not yet classified": sources you know you want but haven't
 *              decided how to file. A member with a concept tie lives under that concept alone.
 *   concepts — the concepts the track INCLUDES, in prerequisite order with their family
 *              hierarchy, each showing the MEMBERS tied to it (candidates are a separate pool).
 *
 * No duplicates: a member is in exactly ONE place, and which place carries meaning — on the
 * spine means unclassified, under a concept means filed there. Membership is always explicit
 * (the invariant): a concept contributes framing, never content.
 */
export interface TrackViewModel {
  /** Members NOT filed under any concept below — "in the track, not yet classified". Each
   *  still shows the concepts it is ABOUT as chips: on a source-anchored track those concepts
   *  aren't INCLUDED (so the source isn't filed under one), but seeing the aboutness is how you
   *  decide whether to include that concept and file the reading (owner, 2026-07-23). */
  spine: { source: SourceView; unordered: boolean; topics: { id: string; name: string }[] }[];
  /** TOP-LEVEL groups only — an included concept, then the cluster of member sources that sit
   *  under it, each carrying its own ties as chips. No indentation and no intermediate rows:
   *  the structure is implied by the chips, not drawn (owner, 2026-07-23). */
  concepts: (TopicGroup & {
    /** Concepts in this group's hierarchy that NO source is tied to (owner, 2026-07-23).
     *  They ride as chips beside the heading, which is the only place an empty concept is
     *  visible at all — and the only way one can be a drop target. */
    emptyConcepts: { id: string; name: string }[];
    /** Sources ABOUT this group but NOT members of the track — the candidate pool (owner,
     *  2026-07-23). Including a concept contributes framing, never content: a source appears
     *  only when someone deliberately added it (the membership invariant). These are shown as
     *  a collapsed count you can promote, so a concept 500 sources explain stays one line. */
    candidates: SourceView[];
  })[];
}

export function trackViewModel(
  asm: AssembleResult,
  graph: GraphEnvelope,
  track: { id: string; sourceIds: readonly string[]; sourceLevels?: readonly (readonly string[])[]; precedes?: readonly { srcId: string; dstId: string }[] },
  allSources: SourceView[],
): TrackViewModel {
  const p = project(asm, graph, track.id, allSources);
  const byId = new Map(allSources.map((s) => [s.id, s]));
  // ALL concepts by name (not just the family), so an unclassified spine source can still show
  // what it is ABOUT — the family map (p.byId) would miss a concept the track hasn't included.
  const conceptByName = new Map<string, { id: string; name: string }>();
  for (const n of graph.nodes) if (n.kind === 'concept') conceptByName.set(n.label, { id: n.id, name: n.label });

  // ── the spine: members NOT represented under any concept below (owner ruling, 2026-07-23) ──
  //
  //    A member shows at the top ONLY if it is not tied to a concept the track shows. The spine
  //    is precisely "in the track, but not yet classified" — sources you know you want but
  //    haven't decided how to file. The moment a source is tied to a concept it lives under
  //    that concept, and there alone. This is the no-duplicates rule: a member is in exactly
  //    one place, and which place says something (classified vs not).
  //
  //    `anchorOf` holds an entry iff the source has at least one tie to a FAMILY concept, so it
  //    is exactly the "is this classified within this track?" test. An unclassified member has
  //    no family tie, hence no path — the top rows never carry concept chips.
  const spine = orderedSources({ sourceIds: track.sourceIds, sourceLevels: track.sourceLevels ?? [], precedes: track.precedes })
    .map((o) => ({ source: byId.get(o.id), unordered: o.unordered === true }))
    .filter((e): e is { source: SourceView; unordered: boolean } => e.source !== undefined)
    .filter((e) => !p.anchorOf.has(e.source.id))
    .map(({ source, unordered }) => ({
      source,
      unordered,
      topics: source.about.map((name) => conceptByName.get(name)).filter((t): t is { id: string; name: string } => t !== undefined),
    }));

  // ── the concept section: the INCLUDED concepts as top-level groups (project().groups —
  //    owner mains, ties as chips).
  //
  //    A concept group shows only the track's own MEMBERS (owner ruling, 2026-07-23). Including
  //    a concept contributes framing and ordering, never content — a source is on the track
  //    only if someone deliberately added it (the membership invariant of record). The rest of
  //    the sources ABOUT the concept are CANDIDATES, surfaced as a collapsed count to promote.
  //    This is what makes a track publishable: its contents don't depend on the size or shape
  //    of the author's private library. See scripts/promote-derived-sources.mjs — it made the
  //    previously auto-pulled reading explicit so this change is view-identical, not gutting.
  //
  //    Every member that sits under a concept therefore appears in BOTH halves, always — the
  //    concept section is "your reading, by concept". (This supersedes the earlier "duplication
  //    as a signal you're mixing paradigms" reading: with derivation gone, there is no second
  //    paradigm left to signal.)
  const memberIds = new Set(track.sourceIds);

  // A concept no source is tied to has no chip anywhere and no row of its own, so without this
  // it would be invisible — and unreachable as a drop target. Each main collects the concepts
  // it owns that nothing under IT is tied to; the main itself is excluded, since it is the
  // heading those chips hang off.
  //
  // "Under it", not "anywhere" (owner, 2026-07-23). A concept owned by T1 can be tied to a
  // source that DISPLAYS under T2 — a source anchors at its earliest-ranked tie, so its other
  // ties can reach across topics. Asking globally, T1 would go on hiding a concept that
  // nothing in T1 points at any more. The question each heading answers is about its own
  // group: T1 still owns the concept, it just no longer has a source on it.
  //    Emptiness now asks about MEMBER sources only: a concept is a chip when no source the
  //    track actually includes is tied to it under this topic. A candidate ABOUT it does not
  //    fill it — the whole point is that candidates aren't on the track.
  const tiedIn = new Map<string, Set<string>>();
  for (const g of p.groups) {
    const memberTies = g.sources.filter((e) => memberIds.has(e.source.id)).flatMap((e) => e.ties.map((t) => t.id));
    tiedIn.set(g.conceptId, new Set(memberTies));
  }
  const emptyByMain = new Map<string, { id: string; name: string }[]>();
  for (const id of [...p.familyIds].sort((a, b) => (p.order.get(a)?.seq ?? 0) - (p.order.get(b)?.seq ?? 0))) {
    const owner = p.owner.get(id);
    if (owner === undefined || owner === id) continue;
    if (tiedIn.get(owner)?.has(id) === true) continue;
    if (!emptyByMain.has(owner)) emptyByMain.set(owner, []);
    emptyByMain.get(owner)!.push({ id, name: p.byId.get(id)!.name });
  }

  // Every INCLUDED concept is listed, even with nothing under it yet: you put it on the track,
  // so it gets a heading (and something to drop onto). Members are the group's content; the
  // rest are candidates to promote.
  const concepts = p.groups.map((g) => ({
    ...g,
    sources: g.sources.filter((e) => memberIds.has(e.source.id)),
    candidates: g.sources.filter((e) => !memberIds.has(e.source.id)).map((e) => e.source),
    emptyConcepts: emptyByMain.get(g.conceptId) ?? [],
  }));

  return { spine, concepts };
}

/** The graph tier's data: the track's ordered concept family plus, per family concept, the
 *  sources ANCHORED there (project()'s anchorOf — the same assignment buildTopics rolls up to
 *  owner groups, so the tier and the grouped views always agree), PRECEDES-ordered. */
export function conceptTier(
  asm: AssembleResult,
  graph: GraphEnvelope,
  trackId: string,
  allSources: SourceView[],
): {
  concepts: { id: string; name: string; tags: string[]; level: number; main: boolean }[];
  sourcesOf: Map<string, SourceView[]>;
} {
  const p = project(asm, graph, trackId, allSources);
  const mainSet = new Set(p.mains);
  const concepts = [...p.familyIds]
    .filter((id) => p.order.has(id))
    .sort((a, b) => p.order.get(a)!.level - p.order.get(b)!.level || p.order.get(a)!.seq - p.order.get(b)!.seq)
    .map((id) => ({ id, name: p.byId.get(id)!.name, tags: p.byId.get(id)!.tags, level: p.depth.get(id) ?? 0, main: mainSet.has(id) }));
  const byAnchor = new Map<string, SourceView[]>();
  for (const s of allSources) {
    const anchor = p.anchorOf.get(s.id);
    if (anchor === undefined) continue;
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor)!.push(s);
  }
  const sourcesOf = new Map<string, SourceView[]>();
  for (const [cid, list] of byAnchor) sourcesOf.set(cid, orderByPrecedes(list, p.precedes));
  return { concepts, sourcesOf };
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
  /** The track's member sources IN READING ORDER (orderedSources) — the authored pedagogy. */
  orderedSourceIds: readonly string[],
): { id: string; name: string; tags: string[]; main: boolean }[] {
  const base = new Map<string, number>();
  let seq = 0;
  for (const c of asm.levels.flat()) base.set(c.id, seq++);
  const byId = new Map(asm.levels.flat().map((c) => [c.id, c]));
  const sourceIds = new Set(orderedSourceIds);
  const readPos = new Map(orderedSourceIds.map((id, i) => [id, i]));
  // Rank each tied concept by its FIRST appearance in the reading order (owner ruling,
  // 2026-07-21): a source-anchored track's pedagogy lives in its PRECEDES/INCLUDES order, so
  // the derived concept order follows the reading, not the corpus's assemble accident. Real
  // PREREQUISITE_OF edges still dominate via the guard; this is the base rank beneath it.
  const firstPos = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== 'ABOUT' || !sourceIds.has(e.srcId) || !base.has(e.dstId)) continue;
    const p = readPos.get(e.srcId)!;
    const cur = firstPos.get(e.dstId);
    if (cur === undefined || p < cur) firstPos.set(e.dstId, p);
  }
  const ids = [...firstPos.keys()];
  const fam = conceptFamily({
    conceptIds: ids,
    prereqs: graph.edges.filter((e) => e.type === 'PREREQUISITE_OF'),
    mains: ids, // exactly the tied set, guarded-DFS ordered among themselves
    baseRank: (a, b) => firstPos.get(a)! - firstPos.get(b)! || (base.get(a) ?? 0) - (base.get(b) ?? 0),
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
  /** The concept that justifies the recommendation — the target's topic anchor, or (for an
   *  out-of-track target) its first ABOUT concept. Absent when the target has no concept. */
  viaId?: string;
  viaName?: string;
}
export interface NextMoves {
  /** Down the SAME topic branch — unconsumed direct successors sharing the topic. */
  deeper: NextMove[];
  /** Onward into a NEW topic — direct successors that leave the branch. */
  wider: NextMove[];
  /** Back to a prerequisite WITHIN the same topic — direct predecessors, for review. */
  back: NextMove[];
  /** True when the source is in this track's family but nothing unconsumed remains forward. */
  frontier: boolean;
}

/**
 * The next reading moves from a source, driven by the track's own EXPLICIT source reading-order
 * (PRECEDES) edges over the guarded-DFS topic structure (owner design, 2026-07-24). Strong
 * connections only — no concept-chain inference:
 *
 *   deeper — an unconsumed same-topic SUCCESSOR (keep going down the branch), OR a PREDECESSOR
 *            in a DIFFERENT topic / outside the track (descend into a foundation). Multiple.
 *   wider  — a SUCCESSOR that leaves the topic or the track: onward into a new area.
 *   back   — a same-topic direct PREDECESSOR (reads-after): a foundation to review, in-topic.
 *
 * Moves may leave the track by ONE hop (owner, 2026-07-24): a directly-connected out-of-track
 * source is a valid move; the graph is not chained past it. Labelled by the target's topic
 * anchor, or (out of track) its first ABOUT concept.
 */
export function nextMoves(
  asm: AssembleResult,
  graph: GraphEnvelope,
  trackId: string,
  allSources: SourceView[],
  sourceId: string,
): NextMoves | undefined {
  const { groups, order, precedes, anchorOf, owner, byId } = project(asm, graph, trackId, allSources);
  const gi = groups.findIndex((g) => g.sources.some((e) => e.source.id === sourceId));
  if (gi < 0) return undefined; // the source has no topic in this track — no moves to make

  const byIdSrc = new Map(allSources.map((s) => [s.id, s]));
  const conceptName = new Map(graph.nodes.filter((n) => n.kind === 'concept').map((n) => [n.id, n.label]));
  const conceptIdByName = new Map(graph.nodes.filter((n) => n.kind === 'concept').map((n) => [n.label, n.id]));
  /** A source's topic: the owner-main of its guarded-DFS anchor (undefined = outside the family). */
  const topicOf = (sid: string): string | undefined => {
    const a = anchorOf.get(sid);
    return a === undefined ? undefined : owner.get(a);
  };
  const myTopic = topicOf(sourceId);
  const rank = (id: string | undefined) => (id !== undefined ? (order.get(id) ?? { level: 99, seq: 99 }) : { level: 99, seq: 99 });
  const earlier = (a: string | undefined, b: string | undefined) => rank(a).level - rank(b).level || rank(a).seq - rank(b).seq;

  const toMove = (sid: string): NextMove | undefined => {
    const src = byIdSrc.get(sid);
    if (src === undefined) return undefined;
    // The via concept: the family anchor if in-family, else the source's first ABOUT concept.
    const via = anchorOf.get(sid) ?? (src.about[0] !== undefined ? conceptIdByName.get(src.about[0]) : undefined);
    return { source: src, ...(via !== undefined ? { viaId: via, viaName: conceptName.get(via) ?? via } : {}) };
  };
  const bySrcRank = (a: NextMove, b: NextMove) => earlier(a.viaId, b.viaId) || rank(a.source.id).seq - rank(b.source.id).seq;
  /** In-family AND sharing this source's topic. Out-of-track sources are never "same topic". */
  const sameTopic = (sid: string) => myTopic !== undefined && topicOf(sid) === myTopic;

  const deeper: NextMove[] = [];
  const wider: NextMove[] = [];
  const back: NextMove[] = [];
  for (const e of precedes) {
    if (e.srcId === sourceId) {
      // SUCCESSOR (this reads before it) — forward, so only unconsumed. Same topic → deeper
      // (down the branch); otherwise (different topic OR out of track) → wider (onward).
      const other = byIdSrc.get(e.dstId);
      if (other === undefined || other.consumed) continue;
      const m = toMove(e.dstId);
      if (m !== undefined) (sameTopic(e.dstId) ? deeper : wider).push(m);
    } else if (e.dstId === sourceId) {
      // PREDECESSOR (this reads after it) — a foundation. Same topic → back (review in-topic);
      // otherwise (different topic OR out of track) → deeper (descend into that foundation).
      const m = toMove(e.srcId);
      if (m !== undefined) (sameTopic(e.srcId) ? back : deeper).push(m);
    }
  }
  deeper.sort(bySrcRank);
  wider.sort(bySrcRank);
  back.sort(bySrcRank);
  return { deeper, wider, back, frontier: deeper.length === 0 && wider.length === 0 };
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
