/**
 * Snippet text resolvers (owner request, 2026-07-18): deterministic write-time normalization,
 * BEFORE the engine derives identity (text participates in the snippet id). First resolver:
 * MediaWiki's math paste artifact — {\displaystyle x^{2}} → $x^{2}$.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSnippetText, SNIPPET_TEXT_RESOLVERS } from '../src/server/adapters';
import { PhilomaticEngine } from '../src/engine';
import { createIngestServer } from '../src/server/ingest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const N = (t: string) => normalizeSnippetText('https://en.wikipedia.org/wiki/Normality_test', t);

describe('tex-paste-artifacts resolver', () => {
  it('rewrites displaystyle blobs to inline math, nested braces included', () => {
    expect(N('The variance {\\displaystyle \\sigma ^{2}} measures spread.')).toBe(
      'The variance $\\sigma ^{2}$ measures spread.',
    );
    expect(N('{\\displaystyle x_{\\{i\\}}={\\frac {a}{b}}}')).toBe('$x_{\\{i\\}}={\\frac {a}{b}}$');
    expect(N('inline {\\textstyle \\sum _{i}x_{i}} and {\\scriptstyle O(n)} both')).toBe(
      'inline $\\sum _{i}x_{i}$ and $O(n)$ both',
    );
  });

  it('collapses the doubled spaces the artifact leaves and survives truncation', () => {
    expect(N('mean  {\\displaystyle \\mu }  here')).toBe('mean $\\mu$ here');
    // Truncated selection (unbalanced braces): left untouched rather than guessed at.
    expect(N('cut {\\displaystyle \\frac {a')).toBe('cut {\\displaystyle \\frac {a');
  });

  it('leaves math-free text byte-identical and is failure-isolated', () => {
    const plain = 'No math here — just prose with {braces} and $dollars$.';
    expect(N(plain)).toBe(plain);
    const boom = [{ name: 'boom', applies: () => true, resolve: () => { throw new Error('x'); } }];
    expect(normalizeSnippetText('u', 'text', boom)).toBe('text');
  });
});

describe('POST /snippet runs the resolvers before identity derivation', () => {
  let server: Server | undefined;
  it('captures the CLEANED text (one snippet, cleaned id)', async () => {
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify({ url: 'https://en.wikipedia.org/wiki/Variance', title: 'Variance' }) });
    await fetch(`${base}/snippet`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://en.wikipedia.org/wiki/Variance', text: 'Variance is {\\displaystyle \\sigma ^{2}} by definition.' }),
    });
    const snap = await (await fetch(`${base}/snapshot`)).json() as { snippets: { text: string }[] };
    expect(snap.snippets.map((s) => s.text)).toEqual(['Variance is $\\sigma ^{2}$ by definition.']);
    server.close();
  });
});
