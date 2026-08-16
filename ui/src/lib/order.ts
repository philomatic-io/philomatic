/**
 * Track source ordering — the display order shared by Journey and Graph.
 *
 * The engine layers a track's members by its in-context PRECEDES edges
 * (`TrackView.sourceLevels`); sources sharing a level are co-requisites. When no PRECEDES
 * edges exist (one big level), INCLUDES order stands in as the sequence — each source gets its
 * own step number, preserving the pre-ordering UX. Once any PRECEDES exists, the topological
 * level is the step number, so co-requisites share it ("same line").
 */

export interface OrderedSource {
  id: string;
  /** 0-based step; co-requisites share it (display as step + 1). */
  level: number;
  /** True for members NO ordering edge touches while an ordering exists — they trail the
   *  chain and should display WITHOUT a number (a number implies a position they
   *  don't have). */
  unordered?: boolean;
}

export function orderedSources(syl: {
  sourceIds: readonly string[];
  sourceLevels: readonly (readonly string[])[];
  precedes?: readonly { srcId: string; dstId: string }[];
}): OrderedSource[] {
  const includesIdx = new Map(syl.sourceIds.map((id, i) => [id, i]));
  const byIncludes = (a: string, b: string) => (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0);
  const levels = syl.sourceLevels.length > 0 ? syl.sourceLevels : [syl.sourceIds];
  if (levels.length <= 1) {
    // NO ordering edges anywhere: every member is unordered. This used to
    // number them 1..N in INCLUDES order, which reads as a reading sequence the learner never
    // authored — "a user would assume a prerequisite relationship when it's just based on when
    // they were added". A number now means exactly one thing on every surface: a place some
    // PRECEDES edge actually asserts. Inclusion order still decides where the rows sit.
    return [...(levels[0] ?? [])].sort(byIncludes).map((id, i) => ({ id, level: i, unordered: true }));
  }
  // Members that NO ordering edge touches are UNORDERED — they belong at the BOTTOM (a
  // fresh capture into an ordered track once landed at step 1 beside the real
  // first source, because a node with no predecessors topo-levels to 0). They follow the
  // ordered chain in inclusion order, one step each; without the precedes list we can't
  // tell ordered from untouched and keep the raw levels.
  const touched = syl.precedes === undefined ? undefined : new Set(syl.precedes.flatMap((p) => [p.srcId, p.dstId]));
  if (touched === undefined) return levels.flatMap((lvl, li) => [...lvl].sort(byIncludes).map((id) => ({ id, level: li })));
  const orderedLevels = levels.map((lvl) => [...lvl].filter((id) => touched.has(id)).sort(byIncludes)).filter((lvl) => lvl.length > 0);
  const out = orderedLevels.flatMap((lvl, li) => lvl.map((id) => ({ id, level: li })));
  const tail = syl.sourceIds.filter((id) => !touched.has(id)).sort(byIncludes);
  return [...out, ...tail.map((id, i) => ({ id, level: orderedLevels.length + i, unordered: true }))];
}

/**
 * sourceId → the AUTHOR'S 1-based reading position. Members no ordering edge touches are absent.
 *
 * This is not what gets displayed — `numberRows` still counts the page. This is the input to
 * the ARRANGEMENT: where a row and its block belong, so that the page walk and the author's
 * chain agree as far as grouping allows.
 */
export function readingPlaces(syl: {
  sourceIds: readonly string[];
  sourceLevels: readonly (readonly string[])[];
  precedes?: readonly { srcId: string; dstId: string }[];
}): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const r of orderedSources(syl)) if (r.unordered !== true) out[r.id] = ++n;
  return out;
}

/**
 * Ids in the author's reading order. Members the author never placed keep their given order and
 * follow the ones he did — they have no position to sort by, and inventing one is what a number
 * on an unordered row would be.
 */
export function byReading(ids: readonly string[], place: Record<string, number>): string[] {
  const placed = ids.filter((id) => place[id] !== undefined).sort((a, b) => place[a]! - place[b]!);
  return [...placed, ...ids.filter((id) => place[id] === undefined)];
}

/**
 * Where a BLOCK sits: at its earliest authored member.
 *
 * A track is a handful of blocks — the unclassified spine, and one per included concept — and
 * this is what orders them against each other. A block the author ordered none of has no claim
 * on a position and sinks to the end, keeping whatever order it already had.
 *
 * This is the half of the rule that stops grouping from rewriting the reading order (03): including a concept moves a block, never the sequence inside it. Grouping is
 * still contiguous, so a lone unclassified source sitting BETWEEN grouped ones is the one thing
 * that cannot keep its place — holding it would mean splitting its neighbours' block in two.
 */
export function blockRank(ids: readonly string[], place: Record<string, number>): number {
  const places = ids.map((id) => place[id]).filter((n): n is number => n !== undefined);
  return places.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...places);
}

/**
 * sourceId → the row's 1-based number, counted DOWN THE PAGE.
 *
 * THE numbering rule, and deliberately trivial: walk the ids in the order the surface renders
 * them and count. Pass the sequence you emit, and numbering cannot disagree with ordering —
 * they are the same walk.
 *
 * Every earlier version counted a SECOND traversal, the authored PRECEDES order, while the page
 * laid its rows out by concept group. Those agree only where arrangement and chain coincide, so
 * numbering was reported wrong twice in one day: an eight-source track
 * numbered 5,6,7,8 then 1,2,3,4, and a 25-source track whose first concept group read 6, 16, 21,
 * 24, 25. Each report was answered by making the numbering traversal cleverer, and each time it
 * still wasn't the traversal that drew the rows. There is now only one traversal to be right
 * about.
 *
 * `placed` is the members the ordering actually touches; the rest are skipped, because a number
 * implies a position they don't have (a fresh capture into an ordered track
 * must not land labelled "step 4"). An EMPTY `placed` therefore numbers nobody, which is the
 * same rule doing the same job at track scale: a track nothing orders is a set, not a sequence.
 * Skipping shifts no number — the counter only advances on a placed row — so the page still
 * reads 1, 2, 3 straight down, with the unplaced rows sitting between them unnumbered.
 */
export function numberRows(idsInRenderOrder: readonly string[], placed: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const id of idsInRenderOrder) if (placed.has(id) && out[id] === undefined) out[id] = ++n;
  return out;
}

/** The members some ordering edge touches — `numberRows`' `placed`. */
export function placedSources(precedes: readonly { srcId: string; dstId: string }[]): Set<string> {
  return new Set(precedes.flatMap((p) => [p.srcId, p.dstId]));
}

/**
 * The SUGGESTED reading — one deterministic walk of a track.
 *
 * `orderedSources` answers "what depth is this?" from the source chain alone, and that is not the
 * same question as "what should I read first?". A source with no source-level prerequisite is a
 * root of that chain however deep its CONCEPT sits: on a real track it opened the reading with a
 * paper on the Axiom of Choice, a concept whose prerequisite is Set Theory, whose prerequisites
 * run back through Formal Arithmetic and Model Theory to Algebra for Logic. Nothing was going to
 * stop it — the walk never looked at the lattice.
 *
 * So the lattice breaks the tie. `PRECEDES` stays a HARD constraint: nothing is ever suggested
 * before something the author said comes first. Where several members are ready at once — which
 * is most steps, since a track is a DAG and not a line — the one whose concept comes earliest is
 * taken. `rank` is that lattice position, and inclusion order settles what it cannot.
 *
 * Members no ordering edge touches trail the walk. They have no position to be walked to, and
 * `numberRows` skips them anyway; they are here so the arrangement can still place their rows.
 */
export function suggestedReading(
  syl: {
    sourceIds: readonly string[];
    precedes?: readonly { srcId: string; dstId: string }[];
  },
  rank: (id: string) => number = () => 0,
): string[] {
  const includesIdx = new Map(syl.sourceIds.map((id, i) => [id, i]));
  const prefer = (a: string, b: string): number =>
    rank(a) - rank(b) || (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0);
  const precedes = syl.precedes ?? [];
  const touched = placedSources(precedes);
  const members = syl.sourceIds.filter((id) => touched.has(id));

  const blocking = new Map<string, number>(members.map((id) => [id, 0]));
  const unlocks = new Map<string, string[]>();
  for (const p of precedes) {
    if (!blocking.has(p.srcId) || !blocking.has(p.dstId)) continue;
    blocking.set(p.dstId, (blocking.get(p.dstId) ?? 0) + 1);
    unlocks.set(p.srcId, [...(unlocks.get(p.srcId) ?? []), p.dstId]);
  }
  const out: string[] = [];
  const done = new Set<string>();
  let ready = members.filter((id) => (blocking.get(id) ?? 0) === 0);
  while (ready.length > 0) {
    ready.sort(prefer);
    const next = ready.shift()!;
    out.push(next);
    done.add(next);
    for (const dst of unlocks.get(next) ?? []) {
      blocking.set(dst, (blocking.get(dst) ?? 1) - 1);
      if ((blocking.get(dst) ?? 0) === 0 && !done.has(dst)) ready.push(dst);
    }
  }
  // A cycle leaves members unreached; they keep inclusion order rather than vanishing.
  const stranded = members.filter((id) => !done.has(id)).sort((a, b) => (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0));
  const untouched = syl.sourceIds.filter((id) => !touched.has(id)).sort((a, b) => (includesIdx.get(a) ?? 0) - (includesIdx.get(b) ?? 0));
  return [...out, ...stranded, ...untouched];
}

/**
 * Kahn layering of concepts over PREREQUISITE_OF — computable from edges alone, so every
 * consumer (the workbench outline AND a publication bundle's synthesized view) reaches the
 * same base order without an assemble projection. Cycles degrade gracefully: a stuck round
 * places its first remaining id and continues.
 */
export function prereqLevels(ids: readonly string[], edges: readonly { srcId: string; dstId: string; type: string }[]): string[][] {
  const idSet = new Set(ids);
  const before = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const e of edges) {
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
  return levels;
}
