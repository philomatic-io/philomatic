/**
 * The unified cross-kind item model (workbench redesign) — pure shaping of the read contract's
 * four kinds (track / source / question / snippet) into one browsable list, so the center
 * pane can show everything with a kind glyph, a metadata line, and tags. Framework-free: the
 * root suite pins the metadata + facet behaviour.
 *
 * Concepts joined the browsable kinds on owner feedback (2026-07-17): originally they were
 * "connective tissue" only (facet chips + Map nodes), which made an unconnected concept
 * invisible everywhere but the Map — and left concepts with no path to their detail pane (and
 * its Remove). The rail's concept FACET (filter chips) remains, unchanged.
 */
import type { Modality, QuestionView, SnippetView, SourceView, Snapshot } from '../client/types';

export type ItemKind = 'track' | 'concept' | 'source' | 'question' | 'snippet';

export interface Item {
  id: string;
  kind: ItemKind;
  /** Title / text — the primary line. */
  title: string;
  /** The muted metadata line, kind-specific ("text · 90 min · consumed", "from DL Ch. 6"). */
  meta: string;
  tags: string[];
  /** Concept names this item touches (source EXPLAINS / snippet CLARIFIES+CONTRADICTS /
   *  question ABOUT) — the rail's concept facet. */
  concepts: string[];
  /** For sources: modality, so the list can render the right icon. */
  modality?: Modality;
  /** For questions: answered state (the rail's open/answered sub-facet). */
  answered?: boolean;
  /** Own tags PLUS descendants' (track → sources → snippets; source → snippets) — the facet
   *  and rail chips match recursively (owner request, 2026-07-18); display stays `tags`. */
  facetTags?: string[];
  /** For sorting/search only — the raw view object. */
  raw: SourceView | SnippetView | QuestionView | { id: string; title: string };
  /** Sources only: captured but never CONSUMED — the derived backlog (owner request, 2026-07-18). */
  unread?: boolean;
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
export function buildItems(snapshot: Snapshot, questions: QuestionView[], concepts: { id: string; name: string; tracked: boolean; tags?: string[] }[] = []): Item[] {
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
  const items: Item[] = [
    ...snapshot.tracks.map((s): Item => ({
      id: s.id,
      kind: 'track',
      title: s.title,
      meta: `${s.sourceIds.length} ${s.sourceIds.length === 1 ? 'source' : 'sources'}${s.goal ? ` · ${s.goal}` : ''}`,
      tags: s.tags,
      facetTags: [...new Set([...s.tags, ...s.sourceIds.flatMap((sid) => sourceFacetTags.get(sid) ?? [])])],
      concepts: [],
      raw: s,
    })),
    ...concepts.map((c): Item => ({
      id: c.id,
      kind: 'concept',
      title: c.name,
      meta: c.tracked ? 'following ★' : '',
      tags: c.tags ?? [],
      concepts: [c.name], // the facet matches itself, so concept chips filter concept rows too
      raw: { id: c.id, title: c.name },
    })),
    ...snapshot.sources.map((s): Item => ({
      id: s.id,
      kind: 'source',
      unread: !s.consumed,
      title: s.title,
      meta: sourceMeta(s),
      tags: s.tags,
      facetTags: sourceFacetTags.get(s.id),
      concepts: s.about,
      modality: s.modality,
      raw: s,
    })),
    ...questions.map((q): Item => ({
      id: q.id,
      kind: 'question',
      title: q.text,
      answered: q.answered,
      meta: q.answered ? 'answered' : q.raisedBy.length > 0 ? 'raised while reading' : 'open',
      tags: q.tags,
      concepts: q.about,
      raw: q,
    })),
    ...snapshot.snippets.map((s): Item => ({
      id: s.id,
      kind: 'snippet',
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
  track: number;
  concept: number;
  source: number;
  question: number;
  snippet: number;
}

export function railCounts(items: Item[]): RailCounts {
  const c: RailCounts = { all: items.length, backlog: 0, track: 0, concept: 0, source: 0, question: 0, snippet: 0 };
  for (const i of items) {
    c[i.kind] += 1;
    if (i.unread === true) c.backlog += 1;
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
    /** Standing exclusions (owner workflow, 2026-07-17): items carrying any of these tags are
     *  hidden — the "reference shelf stays out of my library" preference. Persisted by the App. */
    excludedTags?: ReadonlySet<string>;
    /** Read-state filter (owner rework, 2026-07-18): sources narrow to unread/read; other
     *  kinds always pass. Derived — the base stores observations, "unread" is computed. */
    readState?: 'all' | 'unread' | 'read';
    /** Source sub-facet (rail, 2026-07-18): keep only sources of this modality. */
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
