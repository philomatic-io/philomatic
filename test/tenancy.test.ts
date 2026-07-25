/**
 * Tenancy prep (self-serve plan T4) — the engine stays tenancy-free; learners are data:
 *   - writes accept a learnerId and land the overlay (edges + events) under it
 *   - reads take an optional learnerId that scopes the behavioral overlay; omitted = the
 *     all-learners fold (the pre-T4 single-tenant view, unchanged)
 *   - the server resolves "who is acting" at ONE seam (body > ?learner= > instance > default)
 *   - rekeyLearner is the pure A3 migration: lnr_default graphs move to real ids, never merging
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createIngestServer } from '../src/server/ingest';
import { DEFAULT_LEARNER, PhilomaticEngine, rekeyLearner, CaptureError } from '../src/engine';

describe('T4: learner-scoped writes and reads (engine)', () => {
  it('captureSource stages under the given learnerId', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/a', title: 'A', learnerId: 'lnr_ada' });
    const out = engine.exportAll();
    expect(out.events.some((ev) => ev.verb === 'STAGED' && ev.learnerId === 'lnr_ada')).toBe(true);
    expect(out.edges.some((e) => e.type === 'STAGED' && e.srcId === 'lnr_ada')).toBe(true);
    expect(out.learners.some((l) => l.id === 'lnr_ada')).toBe(true);
    engine.close();
  });

  it('snapshot/questions scope the overlay to a learner; omitted folds all learners', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/a', title: 'A', learnerId: 'lnr_ada' });
    engine.captureSnippet({ url: 'https://example.com/a', text: 'passage', raises: ['Why?'], learnerId: 'lnr_ada' });
    engine.consume('https://example.com/a', { learnerId: 'lnr_ada' });
    engine.ask('Why?', { learnerId: 'lnr_ada' });

    const ada = engine.snapshot('lnr_ada');
    const bob = engine.snapshot('lnr_bob');
    const all = engine.snapshot();
    expect(ada.sources[0]!.consumed).toBe(true);
    expect(bob.sources[0]!.consumed).toBe(false);
    expect(all.sources[0]!.consumed).toBe(true); // the fold — any learner counts

    expect(engine.questions('lnr_ada').find((q) => q.text === 'Why?')!.asked).toBe(true);
    expect(engine.questions('lnr_bob').find((q) => q.text === 'Why?')!.asked).toBe(false);
    engine.close();
  });
});

describe('T4: the session→learner seam (server)', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(opts: Parameters<typeof createIngestServer>[0] = {}): Promise<string> {
    server = createIngestServer({ db: ':memory:', ...opts });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const post = (base: string, path: string, body: unknown): Promise<Response> =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('body learnerId > ?learner= > instance learner > default', async () => {
    const base = await start({ learner: 'lnr_instance' });
    const ok = async (p: Promise<Response>): Promise<void> => expect((await p).status).toBe(200);
    await ok(post(base, '/ingest', { url: 'https://example.com/b', title: 'B', learnerId: 'lnr_body' }));
    // Mint the concept first — TRACKS needs an existing concept (clarifies creates unseen ones).
    await ok(post(base, '/snippet', { url: 'https://example.com/b', text: 'x', clarifies: ['SomeConcept'] }));
    await ok(post(base, '/consume?learner=lnr_query', { ref: 'https://example.com/b' }));
    await ok(post(base, '/track', { ref: 'SomeConcept' })); // falls to the instance learner

    const exported = (await (await fetch(`${base}/export`)).json()) as {
      events: { verb: string; learnerId: string }[];
    };
    expect(exported.events.find((e) => e.verb === 'STAGED')!.learnerId).toBe('lnr_body');
    expect(exported.events.find((e) => e.verb === 'CONSUMED')!.learnerId).toBe('lnr_query');
    expect(exported.events.find((e) => e.verb === 'TRACKS')!.learnerId).toBe('lnr_instance');
  });

  it('reads scope via ?learner= (and default to the instance learner when configured)', async () => {
    const base = await start({ learner: 'lnr_me' });
    await post(base, '/ingest', { url: 'https://example.com/c', title: 'C' }); // lands as lnr_me
    await post(base, '/consume', { ref: 'https://example.com/c' });

    const mine = (await (await fetch(`${base}/snapshot`)).json()) as { sources: { consumed: boolean }[] };
    expect(mine.sources[0]!.consumed).toBe(true); // instance learner is the read default
    const other = (await (await fetch(`${base}/snapshot?learner=lnr_other`)).json()) as {
      sources: { consumed: boolean }[];
    };
    expect(other.sources[0]!.consumed).toBe(false);
  });
});

describe('T4/A3: rekeyLearner — the pure lnr_default migration', () => {
  function seeded(): PhilomaticEngine {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://example.com/d', title: 'D', track: 'Track' }); // lnr_default overlay
    engine.captureSnippet({ url: 'https://example.com/d', text: 'quote', sentiment: 'aha' });
    engine.consume('https://example.com/d');
    return engine;
  }

  it('moves the learner row, creatorId, overlay edges, and events — nothing else', () => {
    const engine = seeded();
    const before = engine.exportAll();
    const after = rekeyLearner(before, DEFAULT_LEARNER, 'lnr_real');

    expect(after.learners.map((l) => l.id)).toEqual(['lnr_real']);
    expect(after.tracks[0]!.creatorId).toBe('lnr_real');
    expect(after.events.every((ev) => ev.learnerId === 'lnr_real')).toBe(true);
    expect(after.edges.filter((e) => e.srcType === 'learner').every((e) => e.srcId === 'lnr_real')).toBe(true);
    // Content untouched: sources/snippets/questions identical.
    expect(after.sources).toEqual(before.sources);
    expect(after.snippets).toEqual(before.snippets);
    // And the input payload was not mutated (pure).
    expect(before.learners[0]!.id).toBe(DEFAULT_LEARNER);

    // The migrated payload imports into a fresh store and reads back under the new id.
    const fresh = PhilomaticEngine.open();
    fresh.importPayload(after);
    expect(fresh.snapshot('lnr_real').sources[0]!.consumed).toBe(true);
    expect(fresh.snapshot(DEFAULT_LEARNER).sources[0]!.consumed).toBe(false);
    fresh.close();
    engine.close();
  });

  it('refuses to merge into an existing learner, and to rekey a missing one', () => {
    const engine = seeded();
    const payload = engine.exportAll();
    expect(() => rekeyLearner(payload, 'lnr_ghost', 'lnr_x')).toThrow(CaptureError);
    const withTwo = rekeyLearner(payload, DEFAULT_LEARNER, 'lnr_a');
    withTwo.learners.push({ id: 'lnr_b', displayName: 'b' });
    expect(() => rekeyLearner(withTwo, 'lnr_a', 'lnr_b')).toThrow(/never merges/);
    engine.close();
  });
});
