/**
 * Alpha feedback round 1 — the two additive read projections (READ_VERSION stays 1):
 *   - timelineView: the engagement feed, newest first, labeled; retraction entries stay visible
 *     but a hidden target's other history folds away with it
 *   - questionsView: every live question with raised-by / answered-by provenance (snippet
 *     raisers carry their owning source's title — "which source raised this")
 * Plus the thin routes: GET /timeline and GET /questions.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { createIngestServer } from '../src/server/ingest';

const URL_A = 'https://example.com/dl';
const URL_B = 'https://example.com/answers';
const Q = 'Why does the gradient point uphill?';

function tick(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

function seed(engine: PhilomaticEngine): void {
  engine.captureSource({ url: URL_A, title: 'DL Book', tags: ['#ml'] });
  engine.captureSnippet({ url: URL_A, text: 'The gradient points uphill.', clarifies: ['Gradient Descent'], raises: [Q] });
  engine.captureSource({ url: URL_B, title: 'Answer Compendium' });
  engine.importPayload({
    version: 1,
    edges: [
      {
        srcType: 'source',
        srcId: engine.snapshot().sources.find((s) => s.title === 'Answer Compendium')!.id,
        type: 'ANSWERS',
        dstType: 'question',
        dstId: engine.questions()[0]!.id,
      },
    ],
  });
  engine.ask(Q);
}

describe('timelineView', () => {
  it('feeds every event newest first, with labeled targets', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: tick() });
    seed(engine);
    engine.consume(URL_A);
    const t = engine.timeline();
    expect(t[0]).toMatchObject({ verb: 'CONSUMED', targetKind: 'source', label: 'DL Book' });
    expect(t.map((e) => e.at)).toEqual([...t.map((e) => e.at)].sort((a, b) => b - a)); // newest first
    expect(t.some((e) => e.verb === 'ASKS' && e.label === Q)).toBe(true);
    engine.close();
  });

  it('keeps the RETRACTED entry but folds away the removed target’s other history', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: tick() });
    seed(engine);
    engine.remove({ ref: URL_A });
    const t = engine.timeline();
    expect(t[0]).toMatchObject({ verb: 'RETRACTED', label: 'DL Book' });
    expect(t.some((e) => e.verb === 'STAGED' && e.label === 'DL Book')).toBe(false); // folded
    expect(t.some((e) => e.verb === 'STAGED' && e.label === 'Answer Compendium')).toBe(true); // untouched
    engine.close();
  });
});

describe('questionsView', () => {
  it('carries raised-by (with the snippet’s owning source) and answered-by provenance', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: tick() });
    seed(engine);
    const [q] = engine.questions();
    expect(q).toMatchObject({ text: Q, asked: true, answered: false, gap: false });
    expect(q!.raisedBy).toEqual([
      { kind: 'snippet', id: expect.stringMatching(/^snp_/), label: 'The gradient points uphill.', sourceTitle: 'DL Book' },
    ]);
    expect(q!.answeredBy).toEqual([{ kind: 'source', id: expect.stringMatching(/^src_/), label: 'Answer Compendium' }]);
    engine.close();
  });

  it('reads the live world: removing the answering source reopens the gap', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: tick() });
    seed(engine);
    engine.remove({ ref: URL_B });
    const [q] = engine.questions();
    expect(q!.answeredBy).toEqual([]);
    expect(q!.gap).toBe(true);
    engine.close();
  });
});

describe('GET /timeline and /questions', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('serve versioned envelopes over the same projections', async () => {
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL_A, title: 'DL Book' }),
    });
    const tl = (await (await fetch(`${base}/timeline`)).json()) as { version: number; timeline: { verb: string }[] };
    expect(tl.version).toBe(2);
    expect(tl.timeline[0]!.verb).toBe('STAGED');
    const qs = (await (await fetch(`${base}/questions`)).json()) as { version: number; questions: unknown[] };
    expect(qs).toEqual({ version: 2, questions: [] });
  });
});
