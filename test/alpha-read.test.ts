/**
 * Alpha UI M1 — read-contract additions + the assemble route (implementation_plan_alpha_ui.md §2.2):
 *   - SourceView.about: concept names via EXPLAINS (S1's concept facet for sources)
 *   - SnippetView.raises: the snippet's questions with asked/answered/gap overlay (S3)
 *   - both are ADDITIVE: every v1 field is still present, READ_VERSION is 2 (the explains→about + track rename cleanup)
 *   - both read the live world (retraction fold composes)
 *   - GET /assemble[?track=] serves the journey projection as JSON, thin
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { createIngestServer } from '../src/server/ingest';
import { conceptId, questionId } from '../src/schema/ids';

const URL_A = 'https://example.com/dl';
const QUESTION = 'Why does the gradient point uphill?';

function seed(engine: PhilomaticEngine): void {
  engine.captureSource({ url: URL_A, title: 'DL Book', tags: ['#ml'], track: 'Optimization 101' });
  engine.importPayload({
    version: 1,
    concepts: [{ name: 'Gradient Descent' }, { name: 'Backprop' }],
    sources: [{ title: 'DL Book', directUrl: URL_A, modality: 'text', about: ['Gradient Descent', 'Backprop'] }],
  });
  engine.captureSnippet({ url: URL_A, text: 'The gradient points uphill.', clarifies: ['Gradient Descent'], raises: [QUESTION] });
}

describe('alpha M1: read-contract additions', () => {
  it('SourceView.about lists the concept names, sorted', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const src = engine.snapshot().sources[0]!;
    expect(src.about).toEqual(['Backprop', 'Gradient Descent']);
    engine.close();
  });

  it('SnippetView.raises carries the asked/answered/gap overlay and tracks verbs', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const qid = questionId({ text: QUESTION });

    let raises = engine.snapshot().snippets[0]!.raises;
    expect(raises).toEqual([{ id: qid, text: QUESTION, asked: false, answered: false, gap: true }]);

    engine.ask(QUESTION);
    raises = engine.snapshot().snippets[0]!.raises;
    expect(raises[0]).toMatchObject({ asked: true, answered: false });

    engine.answer(QUESTION);
    engine.captureSnippet({ url: URL_A, text: 'Because steepest ascent.', clarifies: [] });
    engine.importPayload({
      version: 1,
      edges: [{ srcType: 'source', srcId: engine.snapshot().sources[0]!.id, type: 'ANSWERS', dstType: 'question', dstId: qid }],
    });
    raises = engine.snapshot().snippets.find((s) => s.raises.length > 0)!.raises;
    expect(raises[0]).toMatchObject({ answered: true, gap: false }); // corpus now answers it
    engine.close();
  });

  it('TrackView.sourceLevels layers members by in-context PRECEDES; co-requisites share a level', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/a', title: 'A', track: 'Track' });
    engine.captureSource({ url: 'https://example.com/b', title: 'B', track: 'Track' });
    engine.captureSource({ url: 'https://example.com/c', title: 'C', track: 'Track' });

    // No ordering edges yet: one level holding every member (INCLUDES order stands for display).
    let syl = engine.snapshot().tracks[0]!;
    expect(syl.sourceLevels).toEqual([[...syl.sourceIds].sort()]);
    expect(syl.precedes).toEqual([]);

    // A PRECEDES B in this track's context: A and C stay level 0 (co-requisites), B level 1.
    const [idA, idB] = [...syl.sourceIds];
    engine.importPayload({
      version: 1,
      edges: [{ srcType: 'source', srcId: idA!, type: 'PRECEDES', dstType: 'source', dstId: idB!, trackContextId: syl.id }],
    });
    syl = engine.snapshot().tracks[0]!;
    expect(syl.sourceLevels).toEqual([syl.sourceIds.filter((id) => id !== idB).sort(), [idB]]);
    expect(syl.precedes).toEqual([{ srcId: idA, dstId: idB }]);

    // A PRECEDES edge scoped to ANOTHER context does not reorder this track.
    engine.importPayload({ version: 1, tracks: [{ title: 'Other' }] });
    const other = engine.snapshot().tracks.find((s) => s.title === 'Other')!;
    engine.importPayload({
      version: 1,
      edges: [{ srcType: 'source', srcId: idB!, type: 'PRECEDES', dstType: 'source', dstId: idA!, trackContextId: other.id }],
    });
    syl = engine.snapshot().tracks.find((s) => s.title !== 'Other')!;
    expect(syl.precedes).toEqual([{ srcId: idA, dstId: idB }]);
    engine.close();
  });

  it('is additive: every v1 field survives and READ_VERSION is 2 (the explains→about + track rename cleanup)', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const snap = engine.snapshot();
    expect(snap.version).toBe(2);
    // The v1 client shape, field by field — an old client reading these keys sees no change.
    expect(Object.keys(snap.sources[0]!)).toEqual(expect.arrayContaining(['id', 'title', 'modality', 'url', 'tags']));
    expect(Object.keys(snap.snippets[0]!)).toEqual(
      expect.arrayContaining(['id', 'text', 'sourceId', 'source', 'clarifies', 'contradicts', 'tags']),
    );
    expect(Object.keys(snap.tracks[0]!)).toEqual(expect.arrayContaining(['id', 'title', 'sourceIds']));
    engine.close();
  });

  it('reads the live world: a removed concept drops out of explains and anchors', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    engine.remove({ ref: 'Backprop' });
    expect(engine.snapshot().sources[0]!.about).toEqual(['Gradient Descent']);
    engine.remove({ ref: QUESTION });
    expect(engine.snapshot().snippets[0]!.raises).toEqual([]);
    engine.close();
  });
});

describe('alpha M1: GET /assemble', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(): Promise<string> {
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('serves the global journey projection with a version envelope', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL_A, title: 'DL Book' }),
    });
    await fetch(`${base}/snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL_A, text: 'A passage.', clarifies: ['Gradient Descent'] }),
    });

    const r = (await (await fetch(`${base}/assemble`)).json()) as {
      version: number;
      levels: { id: string; name: string; snippets: unknown[] }[][];
      total: number;
      openQuestions: unknown[];
      corpusGaps: unknown[];
    };
    expect(r.version).toBe(2);
    expect(r.total).toBe(1);
    expect(r.levels.flat().map((c) => c.id)).toEqual([conceptId('Gradient Descent')]);
    expect(r.levels.flat()[0]!.snippets).toHaveLength(1);
  });

  it('scopes to a track via ?track=<title>', async () => {
    const base = await start();
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL_A, title: 'DL Book', track: 'Optimization 101' }),
    });

    const r = (await (await fetch(`${base}/assemble?track=${encodeURIComponent('Optimization 101')}`)).json()) as {
      title?: string;
      trackId?: string;
      sourceOrder: { title: string }[][];
    };
    expect(r.title).toBe('Optimization 101');
    expect(r.sourceOrder.flat().map((s) => s.title)).toEqual(['DL Book']);
  });
});
