/**
 * The unified cross-kind item model (workbench redesign) — pure shaping of the read contract's
 * four kinds (track / source / question / snippet) into one browsable list, so the center
 * pane can show everything with a kind glyph, a metadata line, and tags. Framework-free: the
 * root suite pins the metadata + facet behaviour.
 *
 * Concepts joined the browsable kinds late: originally they were
 * "connective tissue" only (facet chips + Map nodes), which made an unconnected concept
 * invisible everywhere but the Map — and left concepts with no path to their detail pane (and
 * its Remove). The rail's concept FACET (filter chips) remains, unchanged.
 */
import type { AssembleResult, GraphEnvelope, Modality, QuestionView, SnippetView, SourceView, Snapshot } from '../client/types';

export type ItemKind = 'track' | 'concept' | 'source' | 'question' | 'snippet';

export interface Item {
  id: string;
  kind: ItemKind;
  /** Title / text — the primary line. */
  title: string;
  /** The muted metadata line, kind-specific ("text · 90 min · consumed", "from DL Ch. 6"). */
  meta: string;
  /** `meta` WITHOUT the description tacked on — for a surface that shows the description
   *  separately. A track's card has only this one line and needs the goal in it; the detail
   *  rail renders the goal on its own line directly underneath, so it read the same sentence
   *  twice, once shouted in caps. Absent = `meta` already says it
   *  once. */
  counts?: string;
  tags: string[];
  /** Concept names this item touches (source EXPLAINS / snippet CLARIFIES+CONTRADICTS /
   *  question ABOUT) — the rail's concept facet. */
  concepts: string[];
  /** For sources: modality, so the list can render the right icon. */
  modality?: Modality;
  /** For questions: answered state (the rail's open/answered sub-facet). */
  answered?: boolean;
  /** Sources and tracks: what hangs off them. The same two counts the
   *  detail rail's rows already carry — a track sums its members', so "how much is under this"
   *  reads the same in the list as in the rail. Absent/0 renders nothing. */
  openQuestions?: number;
  snippets?: number;
  /** Own tags PLUS descendants' (track → sources → snippets; source → snippets) — the facet
   *  and rail chips match recursively; display stays `tags`. */
  facetTags?: string[];
  /** For sorting/search only — the raw view object. */
  raw: SourceView | SnippetView | QuestionView | { id: string; title: string };
  /** Sources only: captured but never CONSUMED — the derived backlog. */
  unread?: boolean;
  /** Pending validation: the entity carries a STAGED marker — a proposal
   *  or a hand-parked item awaiting the learner's verdict — including a whole proposed
   *  track from the survey pass. */
  staged?: boolean;
}

const MODALITY_LABEL: Record<string, string> = {
  text: 'text',
  video: 'video',
  audio: 'audio',
  interactive: 'interactive',
  other: 'other',
};

/** MLCommons-scale papers carry 100+ names — the DATA keeps them all, display lines don't. */
export function shortAuthors(author: string): string {
  const names = author.split(', ');
  return names.length > 4 ? `${names.slice(0, 3).join(', ')} et al.` : author;
}

function sourceMeta(s: SourceView): string {
  const parts: string[] = [MODALITY_LABEL[s.modality] ?? s.modality];
  if (s.author !== undefined) parts.push(shortAuthors(s.author));
  if (s.estimatedDurationMins !== undefined) parts.push(`${s.estimatedDurationMins} min`);
  return parts.join(' · ');
}

/** Merge the read contract into one list. `questions` comes from the separate questions view;
 *  `concepts` from the assemble projection (snapshot carries no concept collection). */
export function buildItems(
  snapshot: Snapshot,
  questions: QuestionView[],
  concepts: { id: string; name: string; tracked: boolean; tags?: string[]; staged?: boolean }[] = [],
  /** Supplies a track's included concepts — for the list card's concept chips and the meta's
   *  concept count. Without it, cards show a track's members' aboutness only, and the meta is
   *  the member count alone. */
  projection?: { asm: AssembleResult; graph: GraphEnvelope },
): Item[] {
  const sourceTitle = new Map(snapshot.sources.map((s) => [s.id, s.title]));
  // Recursive tag rollup: a snippet's #tag surfaces on its source, and a source's (own +
  // snippet) tags surface on every track that includes it.
  const snippetTagsBySource = new Map<string, string[]>();
  for (const sn of snapshot.snippets) {
    snippetTagsBySource.set(sn.sourceId, [...(snippetTagsBySource.get(sn.sourceId) ?? []), ...sn.tags]);
  }
  const sourceFacetTags = new Map(
    snapshot.sources.map((s) => [s.id, [...new Set([...s.tags, ...(snippetTagsBySource.get(s.id) ?? [])])]]),
  );
  // The concepts a track is ABOUT — for the list card's chips. The union of
  // its INCLUDED concepts and the concepts its member sources are about: "what this track
  // covers", whether it was built concept-first or source-first.
  const aboutBySource = new Map(snapshot.sources.map((s) => [s.id, s.about]));
  const includedConcepts = new Map<string, string[]>();
  if (projection !== undefined) {
    const nameOf = new Map(projection.graph.nodes.filter((n) => n.kind === 'concept').map((n) => [n.id, n.label]));
    for (const e of projection.graph.edges) {
      if (e.type !== 'INCLUDES' || !nameOf.has(e.dstId)) continue;
      includedConcepts.set(e.srcId, [...(includedConcepts.get(e.srcId) ?? []), nameOf.get(e.dstId)!]);
    }
  }
  // What hangs off a source: its passages, and the questions raised by it OR by one of its
  // passages that nothing has answered yet. Same shape the detail rail computes per row.
  const snippetsBySource = new Map<string, number>();
  for (const sn of snapshot.snippets) snippetsBySource.set(sn.sourceId, (snippetsBySource.get(sn.sourceId) ?? 0) + 1);
  const snippetOwner = new Map(snapshot.snippets.map((sn) => [sn.id, sn.sourceId]));
  const openBySource = new Map<string, number>();
  for (const q of questions) {
    if (q.answered) continue;
    // A question can be raised more than once; count the SOURCE once per question.
    const owners = new Set(
      q.raisedBy.map((r) => (r.kind === 'source' ? r.id : snippetOwner.get(r.id))).filter((id): id is string => id !== undefined),
    );
    for (const sid of owners) openBySource.set(sid, (openBySource.get(sid) ?? 0) + 1);
  }
  const sumOver = (ids: readonly string[], m: Map<string, number>): number =>
    ids.reduce((n, id) => n + (m.get(id) ?? 0), 0);

  const trackConcepts = (t: Snapshot['tracks'][number]): string[] => [
    ...new Set([...(includedConcepts.get(t.id) ?? []), ...t.sourceIds.flatMap((sid) => aboutBySource.get(sid) ?? [])]),
  ];

  /** A track's one-line meta — the SAME shape for every track, no anchor-mode branch (23). Its member sources always count; when it also includes concepts, they lead.
   *  A track's SIZE is its explicit members (the membership invariant — a concept is framing,
   *  not content), so a concepts-with-no-members track honestly reads "N concepts · 0 sources".*/
  const trackCounts = (t: Snapshot['tracks'][number]): string => {
    const n = t.sourceIds.length;
    const c = includedConcepts.get(t.id)?.length ?? 0;
    const parts = [...(c > 0 ? [`${c} concept${c === 1 ? '' : 's'}`] : []), `${n} source${n === 1 ? '' : 's'}`];
    return parts.join(' · ');
  };
  const trackMeta = (t: Snapshot['tracks'][number]): string => {
    const goal = t.goal !== undefined && t.goal !== '' ? ` · ${t.goal}` : '';
    return `${trackCounts(t)}${goal}`;
  };
  const items: Item[] = [
    ...snapshot.tracks.map((s): Item => ({
      id: s.id,
      kind: 'track',
      staged: s.staged,
      title: s.title,
      meta: trackMeta(s),
      counts: trackCounts(s),
      tags: s.tags,
      facetTags: [...new Set([...s.tags, ...s.sourceIds.flatMap((sid) => sourceFacetTags.get(sid) ?? [])])],
      concepts: trackConcepts(s),
      ...(sumOver(s.sourceIds, openBySource) ? { openQuestions: sumOver(s.sourceIds, openBySource) } : {}),
      ...(sumOver(s.sourceIds, snippetsBySource) ? { snippets: sumOver(s.sourceIds, snippetsBySource) } : {}),
      raw: s,
    })),
    ...concepts.map((c): Item => ({
      id: c.id,
      kind: 'concept',
      title: c.name,
      meta: c.tracked ? 'following ★' : '',
      tags: c.tags ?? [],
      concepts: [c.name], // the facet matches itself, so concept chips filter concept rows too
      staged: c.staged === true,
      raw: { id: c.id, title: c.name },
    })),
    ...snapshot.sources.map((s): Item => ({
      id: s.id,
      kind: 'source',
      unread: !s.consumed,
      staged: s.staged,
      title: s.title,
      meta: sourceMeta(s),
      tags: s.tags,
      facetTags: sourceFacetTags.get(s.id),
      concepts: s.about,
      modality: s.modality,
      ...(openBySource.get(s.id) ? { openQuestions: openBySource.get(s.id)! } : {}),
      ...(snippetsBySource.get(s.id) ? { snippets: snippetsBySource.get(s.id)! } : {}),
      raw: s,
    })),
    ...questions.map((q): Item => {
      // "raised by <source>" — the source that raised it: a source
      // provenance names itself, a snippet names its owning source.
      const rb = q.raisedBy[0];
      const raiser = rb === undefined ? undefined : rb.kind === 'source' ? rb.label : (rb.sourceTitle ?? rb.label);
      return {
        id: q.id,
        kind: 'question',
        title: q.text,
        answered: q.answered,
        staged: q.staged,
        meta: q.answered ? 'answered' : raiser !== undefined ? `raised by ${raiser}` : 'open',
        tags: q.tags,
        concepts: q.about,
        raw: q,
      };
    }),
    ...snapshot.snippets.map((s): Item => ({
      id: s.id,
      kind: 'snippet',
      staged: s.staged,
      title: s.text,
      meta: `from ${sourceTitle.get(s.sourceId) ?? s.source}`,
      tags: s.tags,
      concepts: [...s.clarifies, ...s.contradicts],
      raw: s,
    })),
  ];
  return items;
}

export interface RailCounts {
  all: number;
  /** Sources captured but never consumed — the Backlog rail row. */
  backlog: number;
  /** Entities pending validation — the Inbox count. */
  staged: number;
  track: number;
  concept: number;
  source: number;
  question: number;
  snippet: number;
}

export function railCounts(items: Item[]): RailCounts {
  const c: RailCounts = { all: items.length, backlog: 0, staged: 0, track: 0, concept: 0, source: 0, question: 0, snippet: 0 };
  for (const i of items) {
    c[i.kind] += 1;
    if (i.unread === true) c.backlog += 1;
    if (i.staged === true) c.staged += 1;
  }
  return c;
}

/** Every distinct tag across all kinds, sorted — the rail's cross-kind tag facet. */
export function allTags(items: Item[]): string[] {
  return [...new Set(items.flatMap((i) => i.facetTags ?? i.tags))].sort((a, b) => a.localeCompare(b));
}

/** Every distinct concept touched by any item, sorted — the rail's concept facet. */
export function allConcepts(items: Item[]): string[] {
  return [...new Set(items.flatMap((i) => i.concepts))].sort((a, b) => a.localeCompare(b));
}

/**
 * Filter by kind (or 'all'), tags, concepts, and a free-text query. Standard faceted logic:
 * OR *within* a facet (any selected tag / any selected concept), AND *across* facets (kind AND
 * tags AND concepts AND query). Order: kind (rail order), then title.
 */
const KIND_ORDER: ItemKind[] = ['track', 'concept', 'source', 'question', 'snippet'];

export function filterItems(
  items: Item[],
  opts: {
    kind: ItemKind | 'all';
    tags: ReadonlySet<string>;
    concepts: ReadonlySet<string>;
    query: string;
    /** Standing exclusions: items carrying any of these tags are
     *  hidden — the "reference shelf stays out of my library" preference. Persisted by the App. */
    excludedTags?: ReadonlySet<string>;
    /** Read-state filter: sources narrow to unread/read; other
     *  kinds always pass. Derived — the base stores observations, "unread" is computed. */
    readState?: 'all' | 'unread' | 'read';
    /** Source sub-facet (rail): keep only sources of this modality. */
    modality?: string;
    /** Question sub-facet: keep only open or answered questions. */
    question?: '' | 'open' | 'answered';
  },
): Item[] {
  const q = opts.query.trim().toLowerCase();
  const excluded = opts.excludedTags ?? new Set<string>();
  return items
    .filter(
      (i) =>
        !opts.readState || opts.readState === 'all' || i.kind !== 'source' ||
        (opts.readState === 'unread' ? i.unread === true : i.unread !== true),
    )
    .filter((i) => opts.kind === 'all' || i.kind === opts.kind)
    .filter((i) => !opts.modality || (i.kind === 'source' && i.modality === opts.modality))
    .filter((i) => !opts.question || (i.kind === 'question' && i.answered === (opts.question === 'answered')))
    .filter((i) => !i.tags.some((t) => excluded.has(t)))
    .filter((i) => opts.tags.size === 0 || (i.facetTags ?? i.tags).some((t) => opts.tags.has(t)))
    .filter((i) => opts.concepts.size === 0 || i.concepts.some((c) => opts.concepts.has(c)))
    .filter((i) => q === '' || i.title.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title));
}
