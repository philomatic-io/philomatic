/**
 * The scholarly-metadata adapter — OpenAlex (free, keyless, all
 * disciplines) answers what a bare reading title can't: the CANONICAL title, the authors, a
 * DOI hyperlink, and the citation count. Two jobs:
 *
 *   1. `scholarLookup(title)` — the survey/propose passes enrich their proposed readings:
 *      canonical metadata fills what's missing (fill-empty only, the adapter doctrine), the
 *      DOI becomes the reading's link, and `cited_by_count` rides as a `#citations:N` tag —
 *      an additive, learner-deletable observation the inbox can rank by (the assumption:
 *      higher citations ≈ more valuable; the tag makes that visible, never decisive).
 *   2. `scholarAdapter` — capture-time `resolve` for doi.org URLs: title + authors fill
 *      still-empty fields on capture, same ladder as arXiv (user text always wins).
 *
 * Mis-resolution guardrail (the same asymmetry as concept resolution): the top hit counts
 * ONLY when its normalized title matches the query (equal or one contains the other) —
 * a wrong scholarly identity attached silently is worse than no enrichment at all.
 */
import type { AdapterCtx, ResolvePatch, SourceAdapter } from './adapters';
import type { Fetcher } from './llm';

// Local (not imported from ./propose): adapters are LEAVES — importing the chain would close
// an import cycle adapters→scholar→propose→acquire→adapters.
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export interface ScholarWork {
  title: string;
  authors: string[];
  /** The DOI in URL form (https://doi.org/…) — the durable hyperlink. */
  doi?: string;
  citations: number;
  year?: number;
}

const API = 'https://api.openalex.org/works';

interface OpenAlexWork {
  display_name?: string;
  doi?: string | null;
  cited_by_count?: number;
  publication_year?: number;
  authorships?: { author?: { display_name?: string } }[];
}

function toWork(r: OpenAlexWork): ScholarWork {
  return {
    title: r.display_name ?? '',
    authors: (r.authorships ?? []).map((a) => a.author?.display_name ?? '').filter((a) => a !== ''),
    ...(typeof r.doi === 'string' && r.doi !== '' ? { doi: r.doi } : {}),
    citations: r.cited_by_count ?? 0,
    ...(r.publication_year !== undefined ? { year: r.publication_year } : {}),
  };
}

/** Title-matched lookup: undefined when OpenAlex's best hit is not clearly the same work. */
export async function scholarLookup(title: string, fetcher: Fetcher = fetch): Promise<ScholarWork | undefined> {
  const res = await fetcher(`${API}?search=${encodeURIComponent(title)}&per-page=1`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { results?: OpenAlexWork[] };
  const hit = body.results?.[0];
  if (hit === undefined) return undefined;
  const got = norm(hit.display_name ?? '');
  const want = norm(title);
  if (got === '' || (got !== want && !got.includes(want) && !want.includes(got))) return undefined;
  return toWork(hit);
}

const DOI_URL = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i;
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf|html)\/([^?#]+?)(?:v\d+)?(?:[?#]|$)/i;
const SELECT = 'select=display_name,doi,cited_by_count,publication_year,authorships';

/** The survey's OWN reference list from the citation graph (hybrid ground truth,
 *  resolve the survey (arXiv id → its DataCite DOI, doi.org → the DOI,
 *  else guarded title search), then batch-fetch its `referenced_works`. Returns undefined
 *  whenever the survey is not indexed (blogs, docs) — the caller falls back to per-title
 *  search. `total` is the full reference count even when the fetch is capped. */
export async function surveyReferences(
  source: { title: string; url?: string },
  fetcher: Fetcher = fetch,
): Promise<{ cites: ScholarWork[]; total: number } | undefined> {
  type Rec = OpenAlexWork & { referenced_works?: string[] };
  const getRec = async (path: string): Promise<Rec | undefined> => {
    try {
      const res = await fetcher(`${API}/${path}?${SELECT},referenced_works`, { signal: AbortSignal.timeout(8000) });
      return res.ok ? ((await res.json()) as Rec) : undefined;
    } catch {
      return undefined;
    }
  };
  let rec: Rec | undefined;
  const arxiv = source.url !== undefined ? ARXIV_URL.exec(source.url) : null;
  const doi = source.url !== undefined ? DOI_URL.exec(source.url) : null;
  if (arxiv) rec = await getRec(`doi:10.48550/arXiv.${arxiv[1]!}`);
  if (rec === undefined && doi) rec = await getRec(`doi:${doi[1]!}`);
  if (rec === undefined) {
    // last resort: title search, same match guard as scholarLookup
    try {
      const res = await fetcher(`${API}?search=${encodeURIComponent(source.title)}&per-page=1&${SELECT},referenced_works`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const hit = ((await res.json()) as { results?: Rec[] }).results?.[0];
        if (hit !== undefined) {
          const got = norm(hit.display_name ?? '');
          const want = norm(source.title);
          if (got !== '' && (got === want || got.includes(want) || want.includes(got))) rec = hit;
        }
      }
    } catch {
      /* not indexed — caller falls back */
    }
  }
  const refIds = rec?.referenced_works ?? [];
  if (refIds.length === 0) return undefined;
  const ids = refIds.slice(0, 300).map((u) => u.split('/').pop()!);
  const cites: ScholarWork[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const res = await fetcher(`${API}?filter=openalex_id:${ids.slice(i, i + 50).join('|')}&per-page=50&${SELECT}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { results?: OpenAlexWork[] };
      cites.push(...(body.results ?? []).map(toWork).filter((w) => w.title !== ''));
    } catch {
      /* a failed batch shrinks coverage, never breaks the draft */
    }
  }
  return cites.length > 0 ? { cites, total: refIds.length } : undefined;
}

/** Capture-time resolve for doi.org URLs — title/authors fill still-empty fields. */
export function scholarAdapter(fetcher: Fetcher = fetch): SourceAdapter {
  return {
    name: 'scholar',
    cost: 'cheap',
    applies: (url) => DOI_URL.test(url),
    async resolve(url: string, ctx: AdapterCtx): Promise<ResolvePatch> {
      const doi = DOI_URL.exec(url)![1]!;
      const res = await fetcher(`${API}/https://doi.org/${encodeURIComponent(doi)}`, {
        signal: ctx.signal ?? AbortSignal.timeout(4000),
      });
      if (!res.ok) return {};
      const work = toWork((await res.json()) as OpenAlexWork);
      if (work.title === '') return {};
      return {
        title: work.title,
        ...(work.authors.length > 0 ? { author: work.authors.join(', ') } : {}),
      };
    },
  };
}
