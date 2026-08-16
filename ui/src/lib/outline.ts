/**
 * trackOutline — THE answer to "how is this track organised?", computed once (beta plan, after
 * an engine-parity audit).
 *
 * The bug class this exists to end: that question used to be re-derived per surface, each from
 * whatever data that surface happened to hold — the workbench from its snapshot, the published
 * page from a bundle via a SYNTHESISED assemble projection, and TrackGraph from bare ABOUT
 * edges when nobody told it anything. Four derivations, four different inputs, and every one of
 * them drifted: edge tags dropped so the taxonomy went invisible, grouping gated on
 * "concept-anchored", an empty grouping silently disabling a fallback, and finally a component
 * INVENTING groups the workbench would never show.
 *
 * So: one normalised input, one function, one outline. A host's only job is to project its data
 * into `OutlineInput` — nothing may compute grouping on its own, and a component handed no
 * outline renders flat rather than guessing. `test/outline.test.ts` pins the invariant that the
 * workbench's input and a publication bundle's input yield the SAME outline for the same track.
 */
import type { AssembleResult, GraphEnvelope, SourceView } from '../client/types';
import { buildTopics, type TopicGroup } from './topics';
import { byReading, numberRows, placedSources, suggestedReading, prereqLevels } from './order';

/** What every host must produce. Tags are DISPLAY labels ('#TopicOf') — the taxonomy is read
 *  from them, so a host that drops them silently loses all nesting. */
export interface OutlineInput {
  trackId: string;
  concepts: { id: string; name: string; tags: string[] }[];
  sources: { id: string; title: string; modality?: string; author?: string; url?: string; about: string[] }[];
  edges: { srcId: string; dstId: string; type: string; tags: string[] }[];
  /**
   * The track's members. Order is a TIE-BREAK only: `trackOutline` derives the reading order
   * itself from the PRECEDES edges, because the two hosts disagree about what they hand over —
   * the workbench's `snapshot().sourceIds` is INCLUDES order (its `sourceLevels` carries the
   * layering separately), while the published page pre-layers. Deriving it here is what keeps
   * "which is source 1?" one answer instead of two.
   */
  memberOrder: string[];
}

/** One stretch of the page: a category and its members, or a run of uncategorized ones. */
export interface TrackBlock {
  /** The category heading this block. Absent → these members belong to no category the track
   *  holds, and the page says so rather than filing them somewhere they are not. */
  conceptId?: string;
  sourceIds: string[];
}

export interface TrackOutline {
  /** Concept groups, in order. Empty when the track includes no concepts — that is a real
   *  answer ("this track is a flat reading list"), not a missing one. */
  groups: (TopicGroup & { sourceIds: string[] })[];
  /** Members under no group, in reading order. Kept for callers that only need the set; the
   *  PAGE should walk `blocks`, which puts each of them where its number says it goes. */
  ungrouped: string[];
  /** The page, in order: categories in prerequisite order with uncategorized runs between them. */
  blocks: TrackBlock[];
  /** DISPLAY order: the spine, then the grouped sources in group order. The sequence a surface
   *  renders, top to bottom. */
  order: string[];
  /** sourceId → its 1-based place in `order`, i.e. its place ON THE PAGE. Empty for a track
   *  nothing orders. See `numberRows` for why numbering is the display walk and not a second
   *  derivation of it. */
  numberOf: Record<string, number>;
  /** sourceId → conceptId, for hosts that hand a component its grouping. */
  groupOf: Record<string, string>;
}

/** Kahn levels over a track's own PRECEDES — co-requisites share a level. */
function readingLevels(memberIds: readonly string[], precedes: { srcId: string; dstId: string }[]): string[][] {
  const members = new Set(memberIds);
  const indeg = new Map(memberIds.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of precedes) {
    if (!members.has(e.srcId) || !members.has(e.dstId)) continue;
    indeg.set(e.dstId, (indeg.get(e.dstId) ?? 0) + 1);
    out.set(e.srcId, [...(out.get(e.srcId) ?? []), e.dstId]);
  }
  const levels: string[][] = [];
  const seen = new Set<string>();
  let frontier = memberIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const id of frontier) seen.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dst of out.get(id) ?? []) {
        indeg.set(dst, (indeg.get(dst) ?? 1) - 1);
        if ((indeg.get(dst) ?? 0) === 0 && !seen.has(dst) && !next.includes(dst)) next.push(dst);
      }
    }
    frontier = next;
  }
  // A cycle leaves members unplaced; they keep their listed order in a final level.
  const rest = memberIds.filter((id) => !seen.has(id));
  if (rest.length > 0) levels.push(rest);
  return levels;
}

export function trackOutline(input: OutlineInput): TrackOutline {
  // Kahn layering over PREREQUISITE_OF gives the concept base order — computable from edges
  // alone, so both hosts reach it identically (an assemble projection is NOT required, and
  // requiring one is what made the published path synthesise a fake).
  const ids = input.concepts.map((c) => c.id);
  const levels = prereqLevels(ids, input.edges);

  const byId = new Map(input.concepts.map((c) => [c.id, c]));
  const asm = {
    levels: levels.map((lvl) => lvl.map((id) => ({ id, name: byId.get(id)!.name, tags: byId.get(id)!.tags }))),
  } as unknown as AssembleResult;
  const graph = {
    nodes: input.concepts.map((c) => ({ id: c.id, kind: 'concept', label: c.name, tags: c.tags })),
    edges: input.edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, type: e.type, tags: e.tags })),
  } as unknown as GraphEnvelope;
  const sources = input.sources.map((s) => ({
    id: s.id,
    title: s.title,
    modality: s.modality ?? 'text',
    url: s.url,
    tags: [],
    about: s.about,
    author: s.author,
    consumed: false,
    staged: false,
  })) as unknown as SourceView[];

  // Membership and grouping come from the workbench's OWN rule (buildTopics → project): a group
  // per INCLUDED top-level concept, sources filed under the one they're tied to, child concepts
  // rolled up and shown as chips.
  const raw = buildTopics(asm, graph, input.trackId, sources);
  const memberSet = new Set(input.memberOrder);
  const groups = raw.map((g) => ({ ...g, sourceIds: g.sources.map((e) => e.source.id).filter((id) => memberSet.has(id)) }));

  const precedes = input.edges
    .filter((e) => e.type === 'PRECEDES' && memberSet.has(e.srcId) && memberSet.has(e.dstId))
    .map((e) => ({ srcId: e.srcId, dstId: e.dstId }));
  const syl = { sourceIds: input.memberOrder, sourceLevels: readingLevels(input.memberOrder, precedes), precedes };
  // ONE list answers both questions: where a row sits inside its category,
  // and what number it wears. They were two derivations, and a number that disagreed with the row
  // order beside it is exactly the drift that keeps recurring here.
  const groupIndex = new Map<string, number>();
  groups.forEach((g, i) => g.sourceIds.forEach((id) => groupIndex.set(id, i)));
  // A member with no concept has no place in the lattice, and therefore no DEPTH to be deferred
  // for — the tie-break exists to stop the walk diving deep before shallow, and there is nothing
  // deep about an uncategorized row. Ranking it after every category pushed a prerequisite of the
  // track's opening source down to 5th; ranking it before them costs nothing, because anything
  // that genuinely reads late is held there by its own PRECEDES edges, which the walk never
  // breaks. (`Fairness (machine learning) — Wikipedia` stays last for exactly that reason.)
  const reading = suggestedReading(syl, (id) => groupIndex.get(id) ?? -1);
  const numberOf = numberRows(reading, placedSources(precedes));
  const place = numberOf;
  const grouped = new Set(groups.flatMap((g) => g.sourceIds));
  const ungrouped = reading.filter((id) => !grouped.has(id));

  // ── the arrangement ─────────────────────────────
  //
  // Categories run in PREREQUISITE order — the order `buildTopics` already hands them over in,
  // from conceptFamily's guarded-DFS rank — and the sources inside a category run in READING
  // order. Two orders because they answer different questions: what you must understand first,
  // and what to read first. Ranking the categories themselves by their earliest reading (shipped
  // wrong) scrambled a prerequisite lattice the author had modelled by hand, and a
  // category is never split to chase the reading either — see the numbers below, which carry
  // that job instead.
  const inReading = groups.map((g) => ({ ...g, sourceIds: byReading(g.sourceIds, place) }));

  // THE NUMBER IS THE PLACE IN THE READING, not the row's place on the page.
  // A grouped page and the author's chain are different sequences, so numbering the page walk
  // asserted an order nobody wrote: in a 25-source track the 4th thing to read was labelled 2.
  // Now the count runs down the READING and the page shows where each one landed, which is why a
  // category's numbers have gaps — the gaps are what the interleaving looks like.
  //
  // `placedSources` still decides WHO gets a number at all: only a member some PRECEDES edge
  // actually touches. A concept's own prerequisites confer nothing on its sources, and a source
  // in no chain stays unnumbered however ordered the track around it is.

  // Uncategorized members are NOT one block at an end. One of them can belong
  // before everything and another after it, and a single block cannot be in two places. Each one
  // sits in the gap its number puts it in: after every category whose reading starts before it.
  // Categories keep their order and are never split, so a member landing mid-category trails it
  // rather than cutting it in half — its number still says where it goes.
  // Placement is by the NEAREST edge of a category, not its start. Comparing
  // against the start alone sank a member that reads FIRST to the bottom of the page: `AI Risk
  // Management Framework` is a prerequisite of the track's opening source, and it landed below
  // every Fairness row because Fairness happened to start at 1. A category's midpoint is the one
  // comparison that reads correctly in all three cases — before its span, after it, or inside —
  // and inside, it puts the member on the side it is actually nearer to. A tie goes LATER, so
  // a member with a category row already read before it never jumps ahead of that row.
  const midpointOf = (ids: readonly string[]): number => {
    const ns = ids.map((id) => numberOf[id]).filter((n): n is number => n !== undefined);
    return ns.length === 0 ? Number.POSITIVE_INFINITY : (Math.min(...ns) + Math.max(...ns)) / 2;
  };
  const categoryMid = inReading.map((g) => midpointOf(g.sourceIds));
  const gapOf = (id: string): number => {
    const n = numberOf[id];
    if (n === undefined) return inReading.length; // no number, no claim — it trails
    return categoryMid.filter((mid) => mid <= n).length;
  };
  const blocks: TrackBlock[] = [];
  for (let i = 0; i <= inReading.length; i++) {
    const loose = byReading(ungrouped.filter((id) => gapOf(id) === i), place);
    if (loose.length > 0) blocks.push({ sourceIds: loose });
    const g = inReading[i];
    if (g !== undefined) blocks.push({ conceptId: g.conceptId, sourceIds: g.sourceIds });
  }
  const order = blocks.flatMap((b) => b.sourceIds);

  const groupOf: Record<string, string> = {};
  for (const g of inReading) for (const id of g.sourceIds) groupOf[id] = g.conceptId;
  return { groups: inReading, ungrouped, blocks, order, numberOf, groupOf };
}

/** A publication bundle → the one input shape. */
export function outlineFromBundle(p: {
  tracks: { id: string }[];
  concepts: { id: string; name: string; tags: { name: string; subtype?: string; degree?: number }[] }[];
  sources: { id: string; title: string; author?: string; directUrl?: string; modality: string }[];
  edges: { srcId: string; dstId: string; dstType: string; type: string; tags?: { name: string; subtype?: string; degree?: number }[] }[];
  memberOrder: string[];
}): OutlineInput {
  const label = (t: { name: string; subtype?: string; degree?: number }): string =>
    `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}${t.degree !== undefined ? `:${t.degree}` : ''}`;
  const nameById = new Map(p.concepts.map((c) => [c.id, c.name]));
  const about = new Map<string, string[]>();
  for (const e of p.edges) {
    if (e.type === 'ABOUT' && e.dstType === 'concept') {
      const n = nameById.get(e.dstId);
      if (n !== undefined) about.set(e.srcId, [...(about.get(e.srcId) ?? []), n]);
    }
  }
  return {
    trackId: p.tracks[0]?.id ?? '',
    concepts: p.concepts.map((c) => ({ id: c.id, name: c.name, tags: c.tags.map(label) })),
    sources: p.sources.map((s) => ({
      id: s.id,
      title: s.title,
      modality: s.modality,
      ...(s.author !== undefined ? { author: s.author } : {}),
      ...(s.directUrl !== undefined ? { url: s.directUrl } : {}),
      about: about.get(s.id) ?? [],
    })),
    edges: p.edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, type: e.type, tags: (e.tags ?? []).map(label) })),
    memberOrder: p.memberOrder,
  };
}
