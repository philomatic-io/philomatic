/**
 * The staged lifecycle. STAGED is the
 * PENDING-VALIDATION state for ANY entity — an adapter/LLM proposal or something parked by
 * hand — and it leaves that state three ways. An un- verb may only ever REVERSE its verb, so
 * the two VERDICTS get their own words:
 *   accept  → ordinary entity (marker off) + an ACCEPTED verdict event
 *   reject  → retracted (append-only)      + a REJECTED verdict event
 *   unstage → marker off, NO verdict       + an UNSTAGED event (symmetric with UNCONSUMED)
 * Pinned here: entity-level staging, each exit, the no-op cases, that verdicts survive an
 * export/import round-trip (the disposition log), and that CONSUMED stays source-only read
 * state — the conflation this slice settles.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

const URL = 'https://example.com/paper';

/** An INCREMENTING clock: event identity is (learner, verb, target, occurredAt), so a frozen
 *  clock would dedupe a re-stage into its earlier twin and leave the log unordered. */
function ticking(start = 1_000): () => number {
  let t = start;
  return () => (t += 10);
}

function seeded(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(':memory:', { now: ticking() });
  engine.captureSource({ url: URL, title: 'Paper', stage: false });
  engine.importPayload({
    version: 2,
    concepts: [{ name: 'Ultraproducts' }],
    questions: [{ text: 'What do ultrafilters buy us?' }],
  });
  return engine;
}

const verbs = (e: PhilomaticEngine, id: string): string[] =>
  e.exportAll().events
    .filter((ev) => ev.targetId === id)
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .map((ev) => ev.verb);

describe('staged — entity-level pending validation', () => {
  it('stages every entity kind, not just sources', () => {
    const engine = seeded();
    const src = engine.snapshot().sources[0]!;
    const q = engine.questions()[0]!;

    engine.stage(src.id);
    engine.stage('Ultraproducts');
    engine.stage(q.id);

    expect(engine.snapshot().sources[0]!.staged).toBe(true);
    expect(engine.questions()[0]!.staged).toBe(true);
    // the concept's marker is a real STAGED edge, whatever view renders it
    const staged = engine.exportAll().edges.filter((e) => e.type === 'STAGED');
    expect(staged).toHaveLength(3);
    expect(staged.map((e) => e.dstType).sort()).toEqual(['concept', 'question', 'source']);
    engine.close();
  });

  it('accept: the marker folds away and the entity stays — verdict logged', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);

    expect(engine.accept(id).changed).toBe(true);
    expect(engine.snapshot().sources[0]!.staged).toBe(false);
    expect(engine.snapshot().sources).toHaveLength(1); // still an ordinary entity
    expect(verbs(engine, id)).toEqual(['STAGED', 'ACCEPTED']);
    engine.close();
  });

  it('reject: the proposal is retracted (restorable) — verdict logged', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);

    expect(engine.reject(id).changed).toBe(true);
    expect(engine.snapshot().sources).toHaveLength(0); // hidden by the retraction fold
    expect(verbs(engine, id)).toEqual(['STAGED', 'REJECTED', 'RETRACTED']);

    // rejections are signal, never deletions: it restores, and the verdict survives
    engine.restore({ ref: id });
    expect(engine.snapshot().sources).toHaveLength(1);
    expect(verbs(engine, id)).toContain('REJECTED');
    engine.close();
  });

  it('unstage: reverses the staging with NO verdict', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);

    expect(engine.unstage(id).changed).toBe(true);
    expect(engine.snapshot().sources[0]!.staged).toBe(false);
    expect(engine.snapshot().sources).toHaveLength(1); // NOT retracted — no verdict was given
    expect(verbs(engine, id)).toEqual(['STAGED', 'UNSTAGED']);
    engine.close();
  });

  it('every exit is a no-op when nothing is staged', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    expect(engine.unstage(id).changed).toBe(false);
    expect(engine.accept(id).changed).toBe(false);
    expect(engine.reject(id).changed).toBe(false);
    expect(verbs(engine, id)).toEqual([]);
    expect(engine.snapshot().sources).toHaveLength(1);
    engine.close();
  });

  it('tracks stage too (D12a): accept keeps the track — its INCLUDES membership with it', () => {
    const engine = seeded();
    const src = engine.snapshot().sources[0]!;
    engine.importPayload({ version: 2, tracks: [{ title: 'Proposed Survey Track' }] });
    const track = engine.snapshot().tracks[0]!;
    engine.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'source', dstId: src.id });

    engine.stage(track.id);
    expect(engine.snapshot().tracks[0]!.staged).toBe(true);

    // accept: the explicit INCLUDES gesture at track granularity — membership stands
    engine.accept(track.id);
    expect(engine.snapshot().tracks[0]!).toMatchObject({ staged: false, sourceIds: [src.id] });
    expect(verbs(engine, track.id)).toEqual(['STAGED', 'ACCEPTED']);

    // reject a re-staged track: the track retracts and takes its membership reading with it
    engine.stage(track.id);
    engine.reject(track.id);
    expect(engine.snapshot().tracks).toHaveLength(0);
    engine.close();
  });

  it('re-staging after a verdict works — the loop can run again', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);
    engine.accept(id);
    engine.stage(id);
    expect(engine.snapshot().sources[0]!.staged).toBe(true);
    expect(verbs(engine, id)).toEqual(['STAGED', 'ACCEPTED', 'STAGED']);
    engine.close();
  });

  it('the disposition log survives an export/import round-trip', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);
    engine.accept(id);
    const payload = engine.exportAll();
    engine.close();

    const fresh = PhilomaticEngine.open(':memory:', { now: ticking(9_000) });
    fresh.importPayload(payload);
    expect(verbs(fresh, id)).toEqual(['STAGED', 'ACCEPTED']);
    expect(fresh.snapshot().sources[0]!.staged).toBe(false); // the marker stayed off
    fresh.close();
  });

  it('staged and consumed are independent — the conflation this slice settles', () => {
    const engine = seeded();
    const id = engine.snapshot().sources[0]!.id;
    engine.stage(id);
    engine.consume(id);
    expect(engine.snapshot().sources[0]!).toMatchObject({ staged: true, consumed: true });

    engine.accept(id); // a verdict on the proposal must not touch read state
    expect(engine.snapshot().sources[0]!).toMatchObject({ staged: false, consumed: true });

    engine.unconsume(id); // and un-reading must not re-open the validation state
    expect(engine.snapshot().sources[0]!).toMatchObject({ staged: false, consumed: false });
    engine.close();
  });
});

describe('liveness folds over RETRACTED/RESTORED only', () => {
  it('a later non-retraction event cannot resurrect a removed entity', () => {
    // Were `retractedIds` to fold EVERY event-only verb latest-wins, an UNCONSUMED/ACCEPTED
    // landing after a RETRACTED would read as "latest, not RETRACTED" ⇒ live.
    const engine = PhilomaticEngine.open(':memory:', { now: ticking() });
    engine.captureSource({ url: URL, title: 'Paper', stage: false });
    const id = engine.snapshot().sources[0]!.id;
    engine.consume(id);
    engine.remove({ ref: id });
    expect(engine.snapshot().sources).toHaveLength(0);

    engine.importPayload({
      version: 2,
      events: [{ learnerId: 'lnr_default', verb: 'UNCONSUMED', targetType: 'source', targetId: id, occurredAt: 9_999 }],
    });
    expect(engine.snapshot().sources).toHaveLength(0); // still removed
    engine.close();
  });
});
