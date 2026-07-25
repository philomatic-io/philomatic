/**
 * Browser ingestion — Stage 0 (browser plan §5, Definition of Done).
 *   - POST /ingest creates a URL-derived source, infers modality, and stages it
 *   - re-sending the same URL is an idempotent no-op (created:false), the "remember for free" claim
 *   - the engine stays a thin pass-through: the source + STAGED event land in the same graph
 *   - CORS preflight + health + token guard + bad input behave
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIngestServer } from '../src/server/ingest';
import { inferModality, CaptureError } from '../src/engine/capture';
import { applyResolvers, type SourceAdapter } from '../src/server/adapters';
import { PhilomaticEngine } from '../src/engine';
import { sourceId, snippetId } from '../src/schema/ids';

describe('Stage 0: inferModality', () => {
  it('maps hosts and extensions to a modality, defaulting to text', () => {
    expect(inferModality('https://www.youtube.com/watch?v=abc')).toBe('video');
    expect(inferModality('https://youtu.be/abc')).toBe('video');
    expect(inferModality('https://open.spotify.com/episode/x')).toBe('audio');
    expect(inferModality('https://cdn.example.com/talk.mp3')).toBe('audio');
    expect(inferModality('https://arxiv.org/abs/1706.03762')).toBe('text');
    expect(inferModality('not a url')).toBe('text');
  });
});

describe('Stage 0: ingest() over the engine', () => {
  it('creates a URL-derived source, infers modality, and stages it', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: () => 1_700_000_000_000 });
    const res = engine.captureSource({ url: 'https://youtu.be/aircAruvnKk', title: '3Blue1Brown — NN' });

    const expectedId = sourceId({ title: '3Blue1Brown — NN', directUrl: 'https://youtu.be/aircAruvnKk' });
    expect(res).toEqual({ version: 1, sourceId: expectedId, created: true, staged: true, revived: false, raised: 0 });

    const out = engine.exportAll();
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ id: expectedId, modality: 'video' });
    // Staging left a STAGED edge AND a timestamped event (write-both).
    expect(out.edges.some((e) => e.type === 'STAGED' && e.dstId === expectedId)).toBe(true);
    expect(out.events.some((ev) => ev.verb === 'STAGED' && ev.targetId === expectedId)).toBe(true);
    engine.close();
  });

  it('is idempotent: re-sending the same URL reports created:false and does not duplicate', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/a', title: 'A' });
    const again = engine.captureSource({ url: 'https://example.com/a', title: 'A' });
    expect(again.created).toBe(false);
    expect(engine.exportAll().sources).toHaveLength(1);
    engine.close();
  });

  it('canonicalizes the URL so tracking params collapse to one source', () => {
    const engine = PhilomaticEngine.open();
    const a = engine.captureSource({ url: 'https://example.com/a?utm_source=x', title: 'A' });
    const b = engine.captureSource({ url: 'https://example.com/a', title: 'A' });
    expect(b.sourceId).toBe(a.sourceId);
    expect(engine.exportAll().sources).toHaveLength(1);
    engine.close();
  });

  it('can skip staging and can file the source into a track', () => {
    const engine = PhilomaticEngine.open();
    const res = engine.captureSource({ url: 'https://example.com/b', title: 'B', stage: false, track: 'Reading List' });
    expect(res.staged).toBe(false);

    const out = engine.exportAll();
    expect(out.edges.some((e) => e.type === 'STAGED')).toBe(false);
    const included = out.edges.find((e) => e.type === 'INCLUDES' && e.dstType === 'source');
    expect(included?.dstId).toBe(res.sourceId);
    engine.close();
  });

  it('rejects a missing or malformed URL with a CaptureError', () => {
    const engine = PhilomaticEngine.open();
    expect(() => engine.captureSource({ url: '' })).toThrow(CaptureError);
    expect(() => engine.captureSource({ url: 'not-a-url' })).toThrow(/valid URL/);
    engine.close();
  });
});

describe('Stage 0b: snippet() over the engine', () => {
  it('creates the source-if-unseen and captures a bare highlight', () => {
    const engine = PhilomaticEngine.open();
    const res = engine.captureSnippet({ url: 'https://example.com/a', text: '  Gradients flow backward.  ' });

    const expectedSid = sourceId({ title: 'https://example.com/a', directUrl: 'https://example.com/a' });
    expect(res).toEqual({
      version: 1,
      snippetId: snippetId({ sourceId: expectedSid, text: 'Gradients flow backward.' }),
      sourceId: expectedSid,
      created: true,
      annotated: false,
      raised: 0,
      revived: false,
    });
    const out = engine.exportAll();
    expect(out.sources.map((s) => s.id)).toContain(expectedSid);
    expect(out.snippets).toHaveLength(1);
    expect(out.snippets[0]).toMatchObject({ sourceId: expectedSid, text: 'Gradients flow backward.' });
    expect(out.edges.some((e) => e.type === 'ANNOTATES')).toBe(false);
    engine.close();
  });

  it('attaches a note/sentiment as an ANNOTATES edge and anchors concepts', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 1, concepts: [{ name: 'Backpropagation' }] });
    const res = engine.captureSnippet({
      url: 'https://example.com/dl',
      text: 'The chain rule applied recursively yields the gradient.',
      note: 'clicked',
      sentiment: 'aha',
      clarifies: ['Backpropagation'],
    });
    expect(res.annotated).toBe(true);

    const out = engine.exportAll();
    const clarifies = out.edges.find((e) => e.type === 'CLARIFIES');
    expect(clarifies).toMatchObject({ srcId: res.snippetId, dstId: 'cpt_backpropagation' });
    const annotates = out.edges.find((e) => e.type === 'ANNOTATES');
    expect(annotates?.metadata).toMatchObject({ note: 'clicked', sentiment: 'aha' });
    // The passage now surfaces under its concept in the assembled plan.
    const backprop = engine.assemble().levels.flat().find((n) => n.name === 'Backpropagation')!;
    expect(backprop.snippets[0]).toMatchObject({ relation: 'clarifies', sentiment: 'aha' });
    engine.close();
  });

  it('re-highlighting the same passage is an idempotent no-op (created:false)', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSnippet({ url: 'https://example.com/a', text: 'Same passage.' });
    const again = engine.captureSnippet({ url: 'https://example.com/a', text: 'same   passage.' }); // normalized-equal
    expect(again.created).toBe(false);
    expect(engine.exportAll().snippets).toHaveLength(1);
    engine.close();
  });

  it('does not clobber an existing source when a snippet references it', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/a', title: 'Real Title', modality: 'video' });
    engine.captureSnippet({ url: 'https://example.com/a', text: 'a highlight' });
    const src = engine.exportAll().sources.find((s) => s.title === 'Real Title');
    expect(src?.modality).toBe('video'); // untouched by the snippet capture
    engine.close();
  });

  it('rejects an unknown sourceId with no url to create it', () => {
    const engine = PhilomaticEngine.open();
    expect(() => engine.captureSnippet({ sourceId: 'src_missing', text: 'x' })).toThrow(/ingest the source first/);
    expect(() => engine.captureSnippet({ url: 'https://example.com/a', text: '' })).toThrow(/text is required/);
    engine.close();
  });

  it('raises a question (snippet RAISES question) and tags the snippet', () => {
    const engine = PhilomaticEngine.open();
    const res = engine.captureSnippet({
      url: 'https://example.com/a',
      text: 'A claim worth probing.',
      raises: ['What is the evidence?', '  ', 'What is the evidence?'], // deduped, blanks dropped
      tags: ['#important'],
    });
    expect(res.raised).toBe(1);

    const out = engine.exportAll();
    expect(out.questions.map((q) => q.text)).toContain('What is the evidence?');
    const snip = out.snippets.find((s) => s.id === res.snippetId)!;
    expect(snip.tags.map((t) => t.name)).toContain('important');
    const raises = out.edges.filter((e) => e.type === 'RAISES' && e.srcId === res.snippetId);
    expect(raises).toHaveLength(1);
    expect(raises[0]!.dstType).toBe('question');
    engine.close();
  });
});

describe('Stage 0: read-back views', () => {
  it('snapshot() joins snippets to their source, note/sentiment, and concept anchors', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 1, concepts: [{ name: 'Backpropagation' }] });
    engine.captureSource({ url: 'https://youtu.be/x', title: 'NN video' });
    engine.captureSnippet({
      url: 'https://youtu.be/x',
      text: 'chain rule bookkeeping',
      note: 'clicked',
      sentiment: 'aha',
      clarifies: ['Backpropagation'],
    });

    const snap = engine.snapshot();
    expect(snap.sources).toEqual([
      {
        id: expect.any(String),
        title: 'NN video',
        modality: 'video',
        url: 'https://youtu.be/x',
        tags: [],
        about: [],
        consumed: false,
        staged: true, // captureSource stages by default (write-both STAGED edge)
      },
    ]);
    expect(snap.snippets).toHaveLength(1);
    expect(snap.snippets[0]).toMatchObject({
      text: 'chain rule bookkeeping',
      source: 'NN video',
      note: 'clicked',
      sentiment: 'aha',
      clarifies: ['Backpropagation'],
      contradicts: [],
    });
    engine.close();
  });

});

describe('Source adapters — write-time enrichment (reservation)', () => {
  const NOW = () => 0;

  it('applyResolvers folds matching adapters fill-empty, skips non-matching, is failure-isolated', async () => {
    const good: SourceAdapter = {
      name: 'yt', applies: (u) => u.includes('youtu'),
      resolve: async () => ({ title: 'Canonical', estimatedDurationMins: 12, tags: ['#video'] }),
    };
    const boom: SourceAdapter = { name: 'boom', applies: () => true, resolve: async () => { throw new Error('down'); } };
    const off: SourceAdapter = { name: 'off', applies: () => false, resolve: async () => ({ title: 'nope' }) };

    const patch = await applyResolvers('https://youtu.be/x', { now: NOW }, [boom, good, off]);
    expect(patch).toMatchObject({ title: 'Canonical', estimatedDurationMins: 12 });
    expect(patch.tags).toEqual(['#video']); // only the matching, non-throwing adapter contributed
  });

  it('empty registry leaves ingest unchanged (the no-op default)', () => {
    const engine = PhilomaticEngine.open();
    const r = engine.captureSource({ url: 'https://ex.com/a', title: 'A' }); // resolved defaults to {}
    expect(r.created).toBe(true);
    const s = engine.exportAll().sources[0]!;
    expect(s.title).toBe('A');
    expect(s.estimatedDurationMins ?? undefined).toBeUndefined();
    engine.close();
  });

  it('folds resolver output on first capture, with user > resolver precedence', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://youtu.be/x', title: 'My Title', resolved: { title: 'Canonical', estimatedDurationMins: 9, tags: ['#video'] } });
    const s = engine.exportAll().sources[0]!;
    expect(s.title).toBe('My Title'); // user-provided title beats the resolver's
    expect(s.estimatedDurationMins).toBe(9); // resolver fills the empty field
    expect(s.tags.map((t) => t.name)).toContain('video');
    engine.close();
  });

  it('re-capture: stored values are never clobbered, but STILL-EMPTY fields fill (retry gesture)', () => {
    // Amended 2026-07-18: first-capture-only made a failed enrichment permanent (the owner's
    // first arXiv capture hit a 429). Re-capture now retries the fill; existing values stick.
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://youtu.be/x', resolved: { estimatedDurationMins: 9 } }); // first capture sets 9
    const r2 = engine.captureSource({ url: 'https://youtu.be/x', resolved: { estimatedDurationMins: 99, author: 'Late Facts' } });
    expect(r2.created).toBe(false);
    const s = engine.exportAll().sources.find((x) => x.directUrl === 'https://youtu.be/x')!;
    expect(s.estimatedDurationMins).toBe(9); // stored value sticks — never overwritten by 99
    expect(s.author).toBe('Late Facts'); // the empty field fills on retry
    engine.close();
  });

  it('a URL-as-title is the FALLBACK, not a value — a later resolver upgrades it', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://arxiv.org/abs/2503.05731' }); // adapter down: title falls back to the URL
    expect(engine.exportAll().sources[0]!.title).toBe('https://arxiv.org/abs/2503.05731');
    engine.captureSource({ url: 'https://arxiv.org/abs/2503.05731', resolved: { title: 'Real Paper Title' } });
    expect(engine.exportAll().sources[0]!.title).toBe('Real Paper Title');
    engine.close();
  });

  it('author (model v2: a pure attribute) resolves, carries forward, and never re-keys the source', () => {
    const engine = PhilomaticEngine.open();
    // Resolver fills author on first capture — the enrichment the id change unlocked (ROADMAP §1.2).
    const r1 = engine.captureSource({ url: 'https://ex.com/paper', title: 'Paper', resolved: { author: 'Vaswani et al.' } });
    // Bare re-capture (the popup path) must not NULL the stored author via the full-replace upsert…
    const r2 = engine.captureSource({ url: 'https://ex.com/paper' });
    expect(r2).toMatchObject({ created: false, sourceId: r1.sourceId }); // …and identity never moved
    const s = engine.exportAll().sources.find((x) => x.id === r1.sourceId)!;
    expect(s.author).toBe('Vaswani et al.');
    engine.close();
  });
});

describe('Stage 0: HTTP surface', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(opts: Parameters<typeof createIngestServer>[0] = {}): Promise<string> {
    server = createIngestServer({ db: ':memory:', ...opts });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('answers GET /health', async () => {
    const base = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('answers the CORS preflight with the allow headers', async () => {
    const base = await start();
    const r = await fetch(`${base}/ingest`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-headers')).toContain('X-Ingest-Token');
  });

  it('POST /ingest captures a source and GET /sources reflects it', async () => {
    const base = await start();
    const r = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', title: 'X' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ created: true, staged: true });

    const list = (await (await fetch(`${base}/sources`)).json()) as { sources: { title: string }[] };
    expect(list.sources).toHaveLength(1);
    expect(list.sources[0]!.title).toBe('X');
  });

  it('GET /tracks lists a track with its member source ids', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/m', title: 'M', track: 'ML basics' }),
    });
    const json = (await (await fetch(`${base}/tracks`)).json()) as {
      tracks: { title: string; sourceIds: string[] }[];
    };
    expect(json.tracks).toHaveLength(1);
    expect(json.tracks[0]!.title).toBe('ML basics');
    expect(json.tracks[0]!.sourceIds).toHaveLength(1);
  });

  it('POST /snippet attaches a highlight to a captured source', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/z', title: 'Z' }),
    });
    const r = await fetch(`${base}/snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/z', text: 'a memorable line', sentiment: 'aha' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { created: boolean; annotated: boolean };
    expect(body).toMatchObject({ created: true, annotated: true });
  });

  it('GET /snippets returns captured highlights as JSON (the read contract the viewer consumes)', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/q', title: 'Q' }),
    });
    await fetch(`${base}/snippet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/q', text: 'a saved line', sentiment: 'aha' }),
    });

    const json = (await (await fetch(`${base}/snippets`)).json()) as { snippets: { text: string; sentiment?: string }[] };
    expect(json.snippets).toHaveLength(1);
    expect(json.snippets[0]).toMatchObject({ text: 'a saved line', sentiment: 'aha', source: 'Q' });
  });

  it('GET / + /assets/* serve the built React viewer from ui/dist (allow-listed static files)', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ui-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="./assets/index-abc.js"></script>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log("viewer")');
    const base = await start({ uiDist: dist });

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<div id="root">'); // the viewer stays a client of the JSON contract

    const asset = await fetch(`${base}/assets/index-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');

    // Only index.html and assets/ are servable — traversal out of dist is a 404, not a file read.
    // (`..%2f` survives client URL normalization; the server decodes then allow-list-checks.)
    const traversal = await fetch(`${base}/assets/..%2f..%2fpackage.json`);
    expect(traversal.status).toBe(404);
  });

  it('GET / explains how to build the viewer when ui/dist is absent', async () => {
    const base = await start({ uiDist: mkdtempSync(join(tmpdir(), 'ui-empty-')) });
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('pnpm ui:build');
  });

  it('GET /snapshot returns the whole versioned read envelope in one round trip', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/snap', title: 'Snap', track: 'S' }),
    });
    const snap = (await (await fetch(`${base}/snapshot`)).json()) as {
      version: number;
      tracks: unknown[];
      sources: { title: string }[];
      snippets: unknown[];
    };
    expect(snap.version).toBe(2);
    expect(snap.sources.map((s) => s.title)).toEqual(['Snap']);
    expect(snap.tracks).toHaveLength(1);
    expect(snap.snippets).toEqual([]);
  });

  it('POST /ask and /answer record the learner overlay on a raised question', async () => {
    const base = await start();
    const q = 'Why does the gradient point uphill?';
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/verbs', title: 'V' }),
    });
    await fetch(`${base}/snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/verbs', text: 'A passage.', raises: [q] }),
    });

    const asked = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    expect(await asked.json()).toEqual({ ok: true });

    const answered = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    expect(answered.status).toBe(200);

    const snap = (await (await fetch(`${base}/snapshot`)).json()) as {
      snippets: { raises: { text: string; asked: boolean; answered: boolean }[] }[];
    };
    expect(snap.snippets[0]!.raises[0]).toMatchObject({ text: q, asked: true, answered: true });

    // A question nothing RAISES doesn't exist yet — the engine's "author it first" → 400.
    const unknown = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Never captured?' }),
    });
    expect(unknown.status).toBe(400);
  });

  it('rejects a bad body with 400 and an unknown route with 404', async () => {
    const base = await start();
    const bad = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });

  it('enforces X-Ingest-Token when configured', async () => {
    const base = await start({ token: 'secret' });
    const unauth = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/y', title: 'Y' }),
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': 'secret' },
      body: JSON.stringify({ url: 'https://example.com/y', title: 'Y' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('source-level raises (feedback round 2)', () => {
  it('captureSource({raises}) creates unseen questions and RAISES source→question edges', () => {
    const engine = PhilomaticEngine.open();
    const res = engine.captureSource({
      url: 'https://example.com/talk',
      title: 'Talk',
      raises: ['Why does this work?', '  Why does this work?  '], // dedupes after trim
    });
    expect(res.raised).toBe(1);
    const out = engine.exportAll();
    expect(out.questions.map((q) => q.text)).toEqual(['Why does this work?']);
    expect(out.edges.filter((e) => e.type === 'RAISES')).toEqual([
      expect.objectContaining({ srcType: 'source', srcId: res.sourceId, dstType: 'question' }),
    ]);
    // The question shows in the provenance view with the source as raiser.
    expect(engine.questions()[0]).toMatchObject({
      text: 'Why does this work?',
      raisedBy: [{ kind: 'source', id: res.sourceId, label: 'Talk' }],
    });
    engine.close();
  });
});

describe('POST /import (workbench redesign — restore/bulk load)', () => {
  let server: import('node:http').Server | undefined;
  afterEach(() => server?.close());
  async function start(): Promise<string> {
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as import('node:net').AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('accepts sugared JSON, desugars + merges, and reflects it in /snapshot', async () => {
    const base = await start();
    const sugared = {
      version: 1,
      concepts: [{ name: 'Gradient Descent' }],
      sources: [{ title: 'DL Book', directUrl: 'https://example.com/dl', modality: 'text', explains: ['Gradient Descent'] }],
    };
    const r = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sugared),
    });
    expect(await r.json()).toEqual({ imported: true });
    const snap = (await (await fetch(`${base}/snapshot`)).json()) as { sources: { title: string; about: string[] }[] };
    expect(snap.sources.map((s) => s.title)).toEqual(['DL Book']);
    expect(snap.sources[0]!.about).toEqual(['Gradient Descent']);
  });

  it('surfaces a validation error as 400', async () => {
    const base = await start();
    const bad = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, snippets: [{ id: 'snp_x', sourceId: 'src_missing', text: 'orphan', tags: [] }] }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('T3: the SSE change feed (/changes)', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(): Promise<string> {
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('streams an event after a successful write, and none for a failed one', async () => {
    const base = await start();
    const res = await fetch(`${base}/changes`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (predicate: (buf: string) => boolean): Promise<void> => {
      while (!predicate(buffer)) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    await readUntil((b) => b.includes('retry:')); // connected (header flush)

    // A failed write (empty body → 400) must NOT broadcast.
    const bad = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' });
    expect(bad.status).toBe(400);

    // A successful write broadcasts one event.
    const ok = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/sse', title: 'SSE' }),
    });
    expect(ok.status).toBe(200);
    await readUntil((b) => b.includes('data:'));
    const events = [...buffer.matchAll(/data: (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1]!) as { seq: number });
    expect(events).toHaveLength(1); // the 400 produced nothing
    expect(events[0]!.seq).toBe(1);
    await reader.cancel();
  });

  it('close() completes even with a connected SSE client (streams are ended first)', async () => {
    const base = await start();
    const res = await fetch(`${base}/changes`);
    void res.body!.getReader().read(); // hold the stream open like a viewer would
    await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
    server = undefined; // afterEach must not double-close
  });
});
