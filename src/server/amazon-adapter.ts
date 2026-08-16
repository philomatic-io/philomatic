/**
 * The Amazon source adapter — resolve-time durable facts for book
 * (product) URLs: title and author, so a pasted Amazon link captures as a real bibliographic
 * entry instead of a bare URL.
 *
 * Two rungs, honest about Amazon's hostility to robots:
 *   1. The URL SLUG — `/Deep-Learning-Adaptive-Computation/dp/0262035618` carries the title in
 *      the path. Pure URL knowledge, zero network, cannot fail. Always computed.
 *   2. The product page — `#productTitle` / `#bylineInfo` when Amazon deigns to serve us HTML
 *      (datacenter IPs often get a bot wall; a short timeout and any failure falls back to the
 *      slug rung silently).
 *
 * `applies` is host-anchored to amazon.* product paths, which also makes it safe to run from
 * the PUBLIC ask route: the only URL this adapter will ever fetch is an Amazon product page.
 */
import type { ResolvePatch, SourceAdapter } from './adapters';

/** The hostname must BE an Amazon domain — anchored at both ends. A URL-substring match let
 *  `https://amazon.abc.io/dp/…` through (attacker registers abc.io, points DNS anywhere),
 *  turning this adapter into an SSRF primitive. */
const AMAZON_HOST = /^(?:www\.|smile\.)?amazon\.(?:com|co\.uk|co\.jp|com\.au|com\.br|com\.mx|com\.tr|ca|de|fr|it|es|nl|se|pl|in|sg|ae|sa|eg|cn)$/i;
const PRODUCT_PATH = /^\/(?:[^/]+\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?#]|$)/i;

function isAmazonProduct(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https only: an http product URL would be a downgrade, and the scheme check also rejects
  // javascript:/data:/file: outright.
  return u.protocol === 'https:' && AMAZON_HOST.test(u.hostname) && PRODUCT_PATH.test(u.pathname + u.search);
}
const SLUG = /amazon\.[a-z.]{2,10}\/([^/]{4,})\/(?:dp|gp\/product)\//i;

/** The slug rung: `Matrix-Computations-Johns-Hopkins` → `Matrix Computations Johns Hopkins`.
 *  Exported for tests — deterministic, no I/O. */
export function amazonSlugTitle(url: string): string | undefined {
  const m = SLUG.exec(url);
  if (!m) return undefined;
  const words = decodeURIComponent(m[1]!).replace(/\+/g, ' ').replace(/-/g, ' ').trim();
  // A slug that is only an ASIN-ish token or too short is not a title.
  return words.length >= 4 && !/^[A-Z0-9]{10}$/.test(words) ? words : undefined;
}

const strip = (s: string): string => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** The page rung — best-effort; failure falls back to the slug. Exported for tests (html in). */
export function amazonParse(html: string): { title?: string; author?: string } {
  const title = /<span[^>]*id="productTitle"[^>]*>([\s\S]{1,400}?)<\/span>/.exec(html)?.[1];
  // The byline block lists contributors; the `.author` spans hold `<a>author name</a>`.
  const byline = /<div[^>]*id="bylineInfo"[^>]*>([\s\S]{0,2500}?)<\/div>/.exec(html)?.[1] ?? '';
  const authors = [...byline.matchAll(/class="[^"]*\bauthor\b[^"]*"[\s\S]{0,300}?<a[^>]*>([^<]{2,80})<\/a>/g)]
    .map((m) => strip(m[1]!))
    .filter((a) => a !== '' && !/^visit\b/i.test(a));
  return {
    ...(title !== undefined && strip(title) !== '' ? { title: strip(title) } : {}),
    ...(authors.length > 0 ? { author: [...new Set(authors)].join(', ') } : {}),
  };
}

export function amazonAdapter(): SourceAdapter {
  return {
    name: 'amazon',
    cost: 'expensive',
    applies: (url) => isAmazonProduct(url),
    resolve: async (url): Promise<ResolvePatch> => {
      const fallback: ResolvePatch = (() => {
        const t = amazonSlugTitle(url);
        return t !== undefined ? { title: t } : {};
      })();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(4000),
          headers: {
            // A browser-ish UA — Amazon serves a bot wall to the default node UA outright.
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            accept: 'text/html',
          },
        });
        if (!res.ok) return fallback;
        const page = amazonParse(await res.text());
        return { ...fallback, ...page };
      } catch {
        return fallback;
      }
    },
  };
}
