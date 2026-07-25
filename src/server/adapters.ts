/**
 * Source Adapters (adapters) — the community-extensible enrichment layer
 * between ingestion and presentation. Adapters live in the imperative SHELL (here), never the pure
 * engine: they may be async, do I/O, and be non-deterministic (APIs, LLMs).
 *
 * This module RESERVES the seam. `ADAPTERS` is empty, so every pass is a no-op today — but the
 * invariants are enforced now so they can never be violated once real adapters land:
 *   - precedence ladder: user > deterministic resolver > LLM (LLM never overwrites; §2.3/§2.4)
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
 * future sync-vs-async latency policy (§2.5).
 */
export interface SourceAdapter {
  name: string;
  applies(url: string): boolean;
  cost?: 'cheap' | 'expensive';
  /** WRITE-time: fetch durable facts. Folded fill-empty-only by `ingest()`. */
  resolve?(url: string, ctx: AdapterCtx): Promise<ResolvePatch>;
  /** READ-time: volatile/personal data for the view only. Namespaced under the adapter's name. */
  enrich?(view: SourceView, ctx: AdapterCtx): Promise<unknown>;
}

/** The registered adapters. arXiv (2026-07-18) is the first — the one §2.5 was gated on. */
export const ADAPTERS: SourceAdapter[] = [arxivAdapter()];

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

// ── Snippet text resolvers (write-time, deterministic) ─────────────────────────────────────────
// The same adapter doctrine applied to a snippet's TEXT — and deliberately BEFORE the engine
// sees it, because text participates in snippet identity (sha(sourceId|text)): normalizing
// after capture would mint a different snippet. Deterministic, synchronous, failure-isolated;
// the first resolver un-mangles the math paste artifact every MediaWiki page produces
// ({\displaystyle x^{2}} → $x^{2}$).

export interface SnippetTextResolver {
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

export const SNIPPET_TEXT_RESOLVERS: SnippetTextResolver[] = [
  {
    name: 'tex-paste-artifacts',
    applies: (_url, text) => /\{\\(?:display|text|script)style/.test(text),
    resolve: rewriteTexArtifacts,
  },
];

/** Fold every applicable text resolver over the snippet text, failure-isolated like resolve(). */
export function normalizeSnippetText(
  url: string,
  text: string,
  resolvers: readonly SnippetTextResolver[] = SNIPPET_TEXT_RESOLVERS,
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
