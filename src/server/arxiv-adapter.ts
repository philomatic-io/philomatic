/**
 * The arXiv source adapter — the FIRST real adapter (ROADMAP §2.5 was gated on one landing to
 * pin the runtime's requirements). WRITE-time resolve only: title + authors from arXiv's free
 * Atom API (https://info.arxiv.org/help/api/), folded fill-empty/first-capture-only by the
 * engine, so a hand-typed title always wins. Deliberately narrow: it fires only for
 * arxiv.org/abs|pdf URLs — the server contacts arXiv about a paper the learner already visited,
 * never anything else. Failure-isolated by `applyResolvers`: arXiv down = capture proceeds
 * with the URL as title, exactly as before.
 *
 * Known limitation (Phase-2 source identity): the abs/ and pdf/ URLs of one paper mint two
 * different sources — the adapter enriches both identically but does NOT canonicalize the URL,
 * because URL participates in source identity and silent rewriting is an identity decision.
 */
import type { AdapterCtx, ResolvePatch, SourceAdapter } from './adapters';

/** arXiv id out of an abs/pdf URL: modern `2101.01234(v2)` and legacy `math.GT/0309136`. */
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

export const arxivId = (url: string): string | undefined => ARXIV_URL.exec(url)?.[1];

/** The five entities Atom actually emits in practice. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&amp;/g, '&');

const clean = (s: string): string => decodeEntities(s.replace(/\s+/g, ' ').trim());

/**
 * `fetcher` is injectable for tests; production uses global fetch with a 2.5s guard so a slow
 * arXiv (it rate-limits hard) can never stall a save noticeably — re-capture retries the fill.
 */
export function arxivAdapter(fetcher: typeof fetch = fetch): SourceAdapter {
  return {
    name: 'arxiv',
    cost: 'cheap',
    applies: (url) => arxivId(url) !== undefined,
    async resolve(url: string, ctx: AdapterCtx): Promise<ResolvePatch> {
      const id = arxivId(url)!;
      const res = await fetcher(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
        signal: ctx.signal ?? AbortSignal.timeout(2500),
      });
      if (!res.ok) return {};
      const xml = await res.text();
      const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
      if (entry === undefined) return {};
      const title = clean(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '');
      // A bad id still returns an entry — titled "Error for arXiv.org api request".
      if (title === '' || /^Error/.test(title)) return {};
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1]!)).filter((a) => a !== '');
      return {
        title,
        ...(authors.length > 0 ? { author: authors.join(', ') } : {}),
      };
    },
  };
}
