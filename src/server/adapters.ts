/**
 * Source Adapters (adapters) — the community-extensible enrichment layer
 * between ingestion and presentation. Adapters live in the imperative SHELL (here), never the pure
 * engine: they may be async, do I/O, and be non-deterministic (APIs, LLMs).
 *
 * This module RESERVES the seam. `ADAPTERS` is empty, so every pass is a no-op today — but the
 * invariants are enforced now so they can never be violated once real adapters land:
 *   - precedence ladder: user > deterministic resolver > LLM (LLM never overwrites)
 *   - fill-empty-only + first-capture-only clobber policy (enforced by the caller, `ingest()`)
 *   - failure isolation: a throwing/timed-out adapter is skipped; capture never breaks
 *
 * `resolve` is WRITE-time (durable facts folded into the graph). `enrich` is READ-time (volatile /
 * personal data for the view only, never persisted).
 */
import type { SourceView } from '../engine';
// The write-time patch shape is part of the engine's capture contract (identity-safe fields
// only: `title`, `author`, `estimatedDurationMins`, `tags` — `author` joined in model v2 when
// it left the URL-derived source id and became a pure attribute).
import type { ResolvePatch } from '../engine/capture';
import { arxivAdapter } from './arxiv-adapter';
import { githubAdapter } from './github-adapter';
import { amazonAdapter } from './amazon-adapter';
import { scholarAdapter } from './scholar-adapter';

export type { ResolvePatch };

/** Per-request context handed to adapters. `now` matches the engine's injected clock. */
export interface AdapterCtx {
  now: () => number;
  /** Reserved for per-request timeout/cancellation once the async runner exists. */
  signal?: AbortSignal;
}

/**
 * One community unit per source type/host. `applies` is the selector (only matching adapters run
 * for a given URL — the "don't run everything" rule). Both hooks are optional; `cost` drives the
 * future sync-vs-async latency policy.
 */
export interface SourceAdapter {
  name: string;
  applies(url: string): boolean;
  cost?: 'cheap' | 'expensive';
  /** WRITE-time: fetch durable facts. Folded fill-empty-only by `ingest()`. */
  resolve?(url: string, ctx: AdapterCtx): Promise<ResolvePatch>;
  /** READ-time: volatile/personal data for the view only. Namespaced under the adapter's name. */
  enrich?(view: SourceView, ctx: AdapterCtx): Promise<unknown>;
  /** ACQUIRE-time: better fetch targets for this URL, best first — e.g. arXiv abs →
   *  its LaTeXML /html/ build. Sync + deterministic (pure URL knowledge, no I/O); the
   *  acquisition service appends the original URL as the last resort and owns the fallback. */
  acquireUrls?(url: string): string[];
}

/** The registered adapters. arXiv is the first — the one was gated on. */
export const ADAPTERS: SourceAdapter[] = [arxivAdapter(), githubAdapter(), scholarAdapter(), amazonAdapter()];

/**
 * The preferred-fetch ladder: every matching adapter contributes its better URLs
 * (registration order), the original is always the last resort. Composition by registry fold,
 * never adapter-calls-adapter — failure isolation and ordering stay explicit here.
 */
export function acquisitionUrls(url: string, adapters: readonly SourceAdapter[] = ADAPTERS): string[] {
  const out: string[] = [];
  for (const a of adapters) {
    if (!a.acquireUrls || !safeApplies(a, url)) continue;
    try {
      out.push(...a.acquireUrls(url));
    } catch {
      /* a bad adapter never breaks acquisition */
    }
  }
  out.push(url);
  return [...new Set(out)];
}

/**
 * Run every matching adapter's `resolve` and fold the results into a single patch. Precedence among
 * resolvers is registration order (earlier wins); the caller (`ingest()`) then applies
 * user > resolver. Each scalar field is filled only while still empty; tags accumulate.
 * Failure-isolated: a throwing/rejecting adapter is skipped. Returns `{}` when nothing applies —
 * the no-op case today.
 */
export async function applyResolvers(
  url: string,
  ctx: AdapterCtx,
  adapters: readonly SourceAdapter[] = ADAPTERS,
): Promise<ResolvePatch> {
  const out: ResolvePatch = {};
  const tags: unknown[] = [];
  for (const a of adapters) {
    if (!a.resolve || !safeApplies(a, url)) continue;
    let patch: ResolvePatch;
    try {
      patch = await a.resolve(url, ctx);
    } catch {
      continue; // failure-isolated — a bad adapter never breaks capture
    }
    if (out.title === undefined && patch.title?.trim()) out.title = patch.title.trim();
    if (out.author === undefined && patch.author?.trim()) out.author = patch.author.trim();
    if (out.estimatedDurationMins === undefined && typeof patch.estimatedDurationMins === 'number') {
      out.estimatedDurationMins = patch.estimatedDurationMins;
    }
    if (patch.tags?.length) tags.push(...patch.tags);
  }
  if (tags.length) out.tags = tags;
  return out;
}

/**
 * Run every matching adapter's `enrich` into a namespaced, view-only bag (never persisted).
 * RESERVED: not yet wired into the read routes (the registry is empty). Failure-isolated.
 */
export async function enrichView(
  view: SourceView,
  ctx: AdapterCtx,
  adapters: readonly SourceAdapter[] = ADAPTERS,
): Promise<Record<string, unknown>> {
  const bag: Record<string, unknown> = {};
  for (const a of adapters) {
    if (!a.enrich || !safeApplies(a, view.url ?? '')) continue;
    try {
      bag[a.name] = await a.enrich(view, ctx);
    } catch {
      continue;
    }
  }
  return bag;
}

function safeApplies(a: SourceAdapter, url: string): boolean {
  try {
    return a.applies(url);
  } catch {
    return false;
  }
}

// ── Text resolvers (write-time, deterministic) ─────────────────────────────────────────────────
// The same adapter doctrine applied to TEXT — one shared family, two stages:
//   TEXT_RESOLVERS  — plain text. Runs on snippet capture (BEFORE the engine sees it, because
//                     text participates in snippet identity: sha(sourceId|text)) AND as the
//                     final stage of page acquisition, so a pasted snippet and an acquired page
//                     get identical treatment by construction.
//   HTML_RESOLVERS  — raw HTML, acquisition only, BEFORE the tag strip: recover the TeX every
//                     renderer ships in its markup while the markup still exists.
// All deterministic, synchronous, failure-isolated. Ordering is registry order; a resolver may
// deliberately emit an artifact a LATER STAGE owns (the html math resolvers leave
// `{\displaystyle …}` blobs raw for `tex-paste-artifacts` to rewrite — hierarchy, not
// duplication).

export interface TextResolver {
  name: string;
  applies(url: string, text: string): boolean;
  resolve(text: string): string;
}

/** Balanced-brace scan for `{\displaystyle …}` / `{\textstyle …}` / `{\scriptstyle …}` blobs
 *  (regexes can't nest braces), rewriting each to inline math `$…$`. */
function rewriteTexArtifacts(text: string): string {
  const OPENERS = ['{\\displaystyle', '{\\textstyle', '{\\scriptstyle'];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const opener = OPENERS.find((o) => text.startsWith(o, i));
    if (!opener) {
      out += text[i];
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + opener.length;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    if (depth > 0) {
      // Unbalanced (truncated selection) — leave the tail untouched rather than guess.
      out += text.slice(i);
      break;
    }
    const tex = text.slice(i + opener.length, j - 1).trim();
    out += tex === '' ? '' : `$${tex}$`;
    i = j;
  }
  // The artifact often trails the unicode-rendered duplicate; collapse doubled spaces it leaves.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export const TEXT_RESOLVERS: TextResolver[] = [
  {
    name: 'tex-paste-artifacts',
    applies: (_url, text) => /\{\\(?:display|text|script)style/.test(text),
    resolve: rewriteTexArtifacts,
  },
];

/** Wrap recovered TeX in math delimiters — UNLESS it is a `{\displaystyle …}`-family blob,
 *  which is left raw for `tex-paste-artifacts` (the text stage) to rewrite. Wrapping those
 *  here would double-delimit downstream. */
function wrapTex(tex: string, display: boolean): string {
  if (/^\{\\(?:display|text|script)style/.test(tex)) return ` ${tex} `;
  return display ? ` $$${tex}$$ ` : ` $${tex}$ `;
}

/** Acquisition-stage resolvers: TeX recovery per renderer, run on raw HTML before the strip. */
export const HTML_RESOLVERS: TextResolver[] = [
  {
    // MathML (LaTeXML/arXiv; KaTeX's mathml half): TeX rides in an x-tex annotation or alttext.
    name: 'mathml-tex',
    applies: (_url, html) => /<math\b/i.test(html),
    resolve: (html) =>
      html.replace(/<math\b([^>]*)>([\s\S]*?)<\/math>/gi, (whole, attrs: string, inner: string) => {
        const ann = /<annotation[^>]*application\/x-tex[^>]*>([\s\S]*?)<\/annotation>/i.exec(inner);
        const alt = /alttext="([^"]*)"/i.exec(attrs);
        const tex = (ann?.[1] ?? alt?.[1])?.trim();
        if (!tex) return whole;
        return wrapTex(tex, /display="block"|mode="display"/i.test(attrs));
      }),
  },
  {
    // MathJax source scripts — must run BEFORE the generic <script> strip eats them.
    name: 'mathjax-tex',
    applies: (_url, html) => /<script[^>]*type="math\/tex/i.test(html),
    resolve: (html) =>
      html.replace(/<script[^>]*type="math\/tex([^"]*)"[^>]*>([\s\S]*?)<\/script>/gi, (_w, mode: string, tex: string) =>
        wrapTex(tex.trim(), /display/i.test(mode)),
      ),
  },
  {
    // Fallback-image math (Wikipedia's mwe-math-*, generic "latex" classes): TeX in the alt.
    name: 'imgalt-tex',
    applies: (_url, html) => /<img\b[^>]*class="[^"]*(?:mwe-math|latex)/i.test(html),
    resolve: (html) =>
      html.replace(/<img\b[^>]*class="[^"]*(?:mwe-math|latex)[^"]*"[^>]*>/gi, (whole) => {
        const alt = /alt="([^"]+)"/i.exec(whole);
        const tex = alt?.[1]?.trim();
        return tex ? wrapTex(tex, false) : whole;
      }),
  },
];

/** Fold every applicable resolver over the text, failure-isolated like resolve(). The one
 *  generic fold behind both stages — pass `HTML_RESOLVERS` for the acquisition html stage. */
export function normalizeText(
  url: string,
  text: string,
  resolvers: readonly TextResolver[] = TEXT_RESOLVERS,
): string {
  let out = text;
  for (const r of resolvers) {
    try {
      if (r.applies(url, out)) out = r.resolve(out);
    } catch {
      // a broken resolver never breaks capture
    }
  }
  return out;
}
