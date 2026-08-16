/**
 * Step 0 of the propose chain: URL → text the rest of the chain can trust.
 *
 * A thin ORCHESTRATOR that owns no site or renderer knowledge itself — it composes the
 * adapter registries:
 *   1. fetch ladder — `acquisitionUrls()` asks matching SourceAdapters for better targets
 *      (arXiv abs → its LaTeXML /html/ build, GitHub blob → raw), original last, fallback on
 *      failure;
 *   2. markdown/plain negotiation — a text source passes through verbatim (math already TeX,
 *      newlines kept); content-type is sniffed, not trusted;
 *   3. html math recovery — the `HTML_RESOLVERS` fold replaces math markup with its recovered
 *      TeX BEFORE the tag strip throws it away;
 *   4. strip, then the shared `TEXT_RESOLVERS` fold — the same family snippet capture runs,
 *      so an acquired page and a pasted snippet get identical treatment (e.g. Wikipedia's
 *      `{\displaystyle …}` artifact rewritten to clean `$…$`).
 *
 * Math is canonicalized before the verbatim gate ever sees the text, so the gate stays sound
 * (the LLM quotes and the check compare against the same acquired form) — and an extracted
 * equation snippet renders in snippet-md for free, which speaks exactly these delimiters.
 */
import { acquisitionUrls, HTML_RESOLVERS, normalizeText } from './adapters';
import type { Fetcher } from './llm';

export { acquisitionUrls };

export interface PageLink {
  text: string;
  href: string;
}

/** One document section: its heading, depth, and the SAME cleaned text the flat view
 *  gets — a parallel structured view for the survey pass, sliced from the raw source so the
 *  flat `text` stays byte-identical to what the verbatim gate has always seen. */
export interface PageSection {
  /** '' for the preamble before the first heading. */
  heading: string;
  /** 1–4 from <h1>–<h4> / markdown #s; 0 for the preamble. */
  level: number;
  text: string;
}

export interface Acquired {
  text: string;
  /** Delimited TeX present in the final text — a heuristic (currency can false-positive). */
  hasMath: boolean;
  /** Which tier produced the text — surfaced in the proposal notes. */
  via: 'markdown' | 'html' | 'pdf';
  /** The page's outbound links (anchor text → absolute href), harvested in code BEFORE the
   *  strip. The propose chain attaches these to recommended readings by text match — a URL
   *  must come from the page mechanically, never from the LLM (fabrication risk). */
  links: PageLink[];
  /** The heading-structured view of the same document — what the survey pass walks. */
  sections: PageSection[];
}

const CAP = 24_000;

/** Absolute-href anchors with real text, deduped, capped — link spam (navs) is harmless here
 *  because links are only ever LOOKED UP by matched text, never fed to the LLM. */
export function harvestLinks(html: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2]!.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (text.length < 3) continue;
    const key = `${text.toLowerCase()}|${m[1]!}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href: m[1]! });
    if (out.length >= 500) break;
  }
  return out;
}

/** The markdown twin: `[text](https://…)` links. */
function harvestMdLinks(md: string): PageLink[] {
  return [...md.matchAll(/\[([^\]]{3,})\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ text: m[1]!.trim(), href: m[2]! }));
}

const SECTION_CAP = 12_000; // per-section text cap — the survey pass makes one LLM call each
const SECTIONS_MAX = 40;

/** Split raw HTML on <h1>–<h4> and clean each chunk with the SAME pipeline as the flat text. */
export function sectionizeHtml(url: string, html: string): PageSection[] {
  const clean = (chunk: string): string =>
    normalizeText(url, stripHtml(normalizeText(url, chunk, HTML_RESOLVERS)).slice(0, SECTION_CAP));
  const out: PageSection[] = [];
  const re = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let last = 0;
  let heading = '';
  let level = 0;
  for (const m of html.matchAll(re)) {
    const body = clean(html.slice(last, m.index));
    if (body !== '' || heading !== '') out.push({ heading, level, text: body });
    heading = stripHtml(m[2]!);
    level = Number(m[1]);
    last = m.index! + m[0].length;
    if (out.length >= SECTIONS_MAX) break;
  }
  const tail = clean(html.slice(last));
  if (tail !== '' || heading !== '') out.push({ heading, level, text: tail });
  return out;
}

/** The markdown twin: split on `#`-heading lines. */
export function sectionizeMd(md: string): PageSection[] {
  const out: PageSection[] = [];
  let heading = '';
  let level = 0;
  let buf: string[] = [];
  const push = (): void => {
    const text = buf.join('\n').trim().slice(0, SECTION_CAP);
    if (text !== '' || heading !== '') out.push({ heading, level, text });
    buf = [];
  };
  for (const line of md.split('\n')) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (m !== null && out.length < SECTIONS_MAX) {
      push();
      level = m[1]!.length;
      heading = m[2]!.trim();
    } else {
      buf.push(line);
    }
  }
  push();
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    // a stripped inline tag leaves " ." / " ," artifacts (…<a>Model Theory</a>. → "Theory .")
    // that break verbatim matching for quotes that include the punctuation
    .replace(/ ([.,;:!?])(\s|$)/g, '$1$2')
    .trim();
}

const hasMath = (text: string): boolean => /\$[^$\n]+\$/.test(text);

/** Fixed-size windows as anonymous sections — the PDF has no recoverable headings, but the
 *  survey pass still wants per-chunk extraction over the FULL text, not just the 24k cap. */
const pdfSections = (text: string): PageSection[] => {
  const out: PageSection[] = [];
  for (let i = 0; i < text.length && out.length < 40; i += 10_000) {
    out.push({ heading: '', level: 0, text: text.slice(i, i + 12_000) });
  }
  return out;
};

export async function acquireText(url: string, fetchPage: Fetcher = fetch): Promise<Acquired> {
  let got: { body: string; type: string } | undefined;
  let lastStatus = 0;
  let pdfFailed = false;
  for (const candidate of acquisitionUrls(url)) {
    try {
      const r = await fetchPage(candidate);
      if (!r.ok) {
        lastStatus = r.status;
        continue;
      }
      const type = r.headers.get('content-type') ?? '';
      // PDFs get their OWN extraction (pdfjs) — stripping one as if it were HTML yields
      // binary soup that gates away to nothing while later steps hallucinate on the
      // emptiness. Extraction failure falls down the ladder.
      if (/\bpdf\b/i.test(type)) {
        try {
          const { pdfToText } = await import('./pdf');
          const pdf = await pdfToText(await r.arrayBuffer());
          const text = normalizeText(url, pdf.text.slice(0, CAP));
          return { text, hasMath: hasMath(text), via: 'pdf', links: [], sections: pdfSections(pdf.text) };
        } catch {
          pdfFailed = true;
          continue;
        }
      }
      const body = await r.text();
      if (body.startsWith('%PDF')) {
        // mislabeled content-type — re-fetch as bytes for a real extraction pass
        try {
          const { pdfToText } = await import('./pdf');
          const pdf = await pdfToText(await (await fetchPage(candidate)).arrayBuffer());
          const text = normalizeText(url, pdf.text.slice(0, CAP));
          return { text, hasMath: hasMath(text), via: 'pdf', links: [], sections: pdfSections(pdf.text) };
        } catch {
          pdfFailed = true;
          continue;
        }
      }
      got = { body, type };
      break;
    } catch {
      /* an unreachable preferred tier falls through to the next candidate */
    }
  }
  if (!got) {
    throw new Error(
      pdfFailed
        ? `acquire: "${url}" resolves to a PDF whose text could not be extracted (image-only scan?)`
        : `acquire: ${lastStatus || 'no response'} for ${url}`,
    );
  }
  const { body, type } = got;
  // Markdown/plain — keep it verbatim (newlines included: markdown structure IS whitespace,
  // and the verbatim gate normalizes whitespace on both sides anyway). text/plain is a
  // notorious server default, so sniff: a body that opens with HTML markup takes the HTML
  // path regardless of what the header claims.
  const looksHtml = /^\s*<(?:!doctype|html|head|body|div|p|article|section|script)\b/i.test(body);
  if ((/text\/(?:markdown|plain)\b/i.test(type) || /\.md(?:[?#]|$)/i.test(url)) && !looksHtml) {
    const text = normalizeText(url, body.trim().slice(0, CAP));
    return { text, hasMath: hasMath(text), via: 'markdown', links: harvestMdLinks(body), sections: sectionizeMd(body) };
  }
  // HTML: recover TeX while the markup still exists, strip, then the shared text stage.
  const text = normalizeText(url, stripHtml(normalizeText(url, body, HTML_RESOLVERS)).slice(0, CAP));
  return { text, hasMath: hasMath(text), via: 'html', links: harvestLinks(body), sections: sectionizeHtml(url, body) };
}
