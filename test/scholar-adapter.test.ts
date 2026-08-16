/**
 * The scholarly-metadata adapter: OpenAlex lookups behind the
 * same doctrines as every adapter — fill-empty only, title-match-guarded (a wrong scholarly
 * identity attached silently is worse than no enrichment), failure-isolated.
 */
import { describe, expect, it } from 'vitest';
import { scholarAdapter, scholarLookup, surveyReferences } from '../src/server/scholar-adapter';
import type { Fetcher } from '../src/server/llm';

const work = (over: Record<string, unknown> = {}) => ({
  display_name: 'Equality of Opportunity in Supervised Learning',
  doi: 'https://doi.org/10.48550/arxiv.1610.02413',
  cited_by_count: 1927,
  publication_year: 2016,
  authorships: [
    { author: { display_name: 'Moritz Hardt' } },
    { author: { display_name: 'Eric Price' } },
    { author: { display_name: 'Nathan Srebro' } },
  ],
  ...over,
});

const respondJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('scholarLookup', () => {
  it('returns the canonical record when the top hit matches the queried title', async () => {
    const fetcher: Fetcher = async () => respondJson({ results: [work()] });
    const w = await scholarLookup('equality of opportunity in supervised learning', fetcher);
    expect(w).toMatchObject({
      title: 'Equality of Opportunity in Supervised Learning',
      doi: 'https://doi.org/10.48550/arxiv.1610.02413',
      citations: 1927,
      authors: ['Moritz Hardt', 'Eric Price', 'Nathan Srebro'],
    });
  });

  it('refuses a mismatched top hit — no silent wrong identity', async () => {
    const fetcher: Fetcher = async () => respondJson({ results: [work({ display_name: 'A Totally Different Paper' })] });
    expect(await scholarLookup('Widget Calculus', fetcher)).toBeUndefined();
  });

  it('is quiet on API failure and empty results', async () => {
    expect(await scholarLookup('x', async () => new Response('down', { status: 503 }))).toBeUndefined();
    expect(await scholarLookup('x', async () => respondJson({ results: [] }))).toBeUndefined();
  });
});

describe('surveyReferences — the citation-graph ground truth', () => {
  it('resolves an arXiv survey via its DataCite DOI and batch-fetches the references', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/works/doi:10.48550/arXiv.2304.07683')) {
        return respondJson({
          display_name: 'Fairness And Bias in AI',
          referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
        });
      }
      if (u.includes('filter=openalex_id:W1|W2')) {
        return respondJson({ results: [work(), work({ display_name: 'Widget Calculus', cited_by_count: 12 })] });
      }
      return respondJson({ results: [] });
    };
    const refs = await surveyReferences({ title: 'whatever', url: 'https://arxiv.org/pdf/2304.07683' }, fetcher);
    expect(refs?.total).toBe(2);
    expect(refs?.cites.map((w) => w.title)).toEqual(['Equality of Opportunity in Supervised Learning', 'Widget Calculus']);
    expect(calls.some((u) => u.includes('search='))).toBe(false); // the DOI path never searches
  });

  it('returns undefined for unindexed surveys (blogs) — the caller falls back', async () => {
    const fetcher: Fetcher = async (url) =>
      String(url).includes('search=') ? respondJson({ results: [] }) : new Response('no', { status: 404 });
    expect(await surveyReferences({ title: 'RLHF 101', url: 'https://blog.example/rlhf' }, fetcher)).toBeUndefined();
  });
});

describe('scholarAdapter — capture-time resolve for doi.org URLs', () => {
  it('applies to doi.org only and fills title + authors', async () => {
    const a = scholarAdapter(async () => respondJson(work()));
    expect(a.applies('https://doi.org/10.48550/arxiv.1610.02413')).toBe(true);
    expect(a.applies('https://example.com/paper')).toBe(false);
    const patch = await a.resolve!('https://doi.org/10.48550/arxiv.1610.02413', { now: () => 0 });
    expect(patch).toEqual({
      title: 'Equality of Opportunity in Supervised Learning',
      author: 'Moritz Hardt, Eric Price, Nathan Srebro',
    });
  });
});
