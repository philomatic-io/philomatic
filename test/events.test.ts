/**
 * Slice 8a — event log + recency, Milestone 1: event schema + storage round-trip.
 *   - a timestamped event round-trips through import→export
 *   - the log is append-only and idempotent by (learner, verb, target, occurredAt)
 *   - re-recording the SAME event is a no-op; a different occurredAt appends a second event
 *   - an event referencing a missing learner/target is a dangling reference
 *   - the core graph still round-trips deterministically (time lives only in `events`)
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine, DEFAULT_LEARNER } from '../src/engine';
import { recencyByConcept } from '../src/graph/recency';
import { sourceId, conceptId } from '../src/schema/ids';

const SRC = sourceId({ title: 'Convex Optimization' });
const CPT = conceptId('Gradient Descent');

function base() {
  return {
    version: 1 as const,
    learners: [{ id: DEFAULT_LEARNER, displayName: 'default' }],
    concepts: [{ name: 'Gradient Descent' }],
    sources: [{ title: 'Convex Optimization', modality: 'text' as const }],
  };
}

function withEvent(occurredAt: number, verb = 'CONSUMED', targetType = 'source', targetId = SRC) {
  return {
    ...base(),
    events: [{ learnerId: DEFAULT_LEARNER, verb, targetType, targetId, occurredAt }],
  };
}

describe('Slice 8a M1: event log schema + storage', () => {
  it('round-trips a timestamped event', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(withEvent(1_720_000_000_000));
    const out = engine.exportAll();
    expect(out.events).toEqual([
      { learnerId: DEFAULT_LEARNER, verb: 'CONSUMED', targetType: 'source', targetId: SRC, occurredAt: 1_720_000_000_000 },
    ]);
    engine.close();
  });

  it('is append-only: re-recording the same event is a no-op, a new time appends', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(withEvent(1_720_000_000_000));
    engine.importPayload(withEvent(1_720_000_000_000)); // identical → dedup
    expect(engine.exportAll().events).toHaveLength(1);
    engine.importPayload(withEvent(1_720_000_500_000)); // later engagement → second event
    const events = engine.exportAll().events;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.occurredAt)).toEqual([1_720_000_000_000, 1_720_000_500_000]); // sorted
    engine.close();
  });

  it('rejects an event referencing a missing learner or target', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Gradient Descent' }],
      events: [{ learnerId: 'lnr_ghost', verb: 'TRACKS', targetType: 'concept', targetId: CPT }].map((e) => ({ ...e, occurredAt: 1 })),
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });

  it('keeps the core graph deterministic — time lives only in `events`', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(withEvent(1_720_000_000_000));
    const first = engine.exportAll();
    engine.importPayload(withEvent(1_720_000_000_000));
    // Whole payload (core + events) is unchanged on idempotent re-import.
    expect(engine.exportAll()).toEqual(first);
    engine.close();
  });
});

describe('Slice 8a M2: write-both verb API', () => {
  function seeded(now: () => number): PhilomaticEngine {
    const engine = PhilomaticEngine.open(':memory:', { now });
    engine.importPayload(base());
    return engine;
  }

  it('records BOTH the fact edge and the timestamped event, from the injected clock', () => {
    const engine = seeded(() => 1000);
    engine.consume('Convex Optimization');
    engine.track('Gradient Descent');
    const out = engine.exportAll();

    expect(out.edges.some((e) => e.type === 'CONSUMED' && e.srcId === DEFAULT_LEARNER && e.dstId === SRC)).toBe(true);
    expect(out.edges.some((e) => e.type === 'TRACKS' && e.dstId === CPT)).toBe(true);
    expect(out.events.map((e) => [e.verb, e.occurredAt])).toEqual(
      expect.arrayContaining([['CONSUMED', 1000], ['TRACKS', 1000]]),
    );
    engine.close();
  });

  it('appends a second event on re-engagement but keeps a single fact edge', () => {
    let t = 1000;
    const engine = seeded(() => t);
    engine.consume('Convex Optimization');
    t = 2000;
    engine.consume('Convex Optimization');
    const out = engine.exportAll();
    expect(out.edges.filter((e) => e.type === 'CONSUMED')).toHaveLength(1);
    expect(out.events.filter((e) => e.verb === 'CONSUMED').map((e) => e.occurredAt)).toEqual([1000, 2000]);
    engine.close();
  });

  it('honors an explicit occurredAt (backfill) over the clock', () => {
    const engine = seeded(() => 9999);
    engine.consume('Convex Optimization', { occurredAt: 1_720_000_000_000 });
    expect(engine.exportAll().events.find((e) => e.verb === 'CONSUMED')?.occurredAt).toBe(1_720_000_000_000);
    engine.close();
  });
});

describe('Slice 8a M3: recency projection', () => {
  // Engagement (CONSUMED at 1000 then 2000) rolls up to Gradient Descent via EXPLAINS; TRACKS
  // marks it followed; a later STAGED (3000) must NOT count as engagement.
  function engaged(): PhilomaticEngine {
    let t = 0;
    const engine = PhilomaticEngine.open(':memory:', { now: () => t });
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Gradient Descent' }, { name: 'Backprop' }],
      sources: [{ title: 'Convex Optimization', modality: 'text', explains: ['Gradient Descent'] }],
    });
    t = 1000;
    engine.consume('Convex Optimization');
    t = 2000;
    engine.consume('Convex Optimization');
    engine.track('Gradient Descent');
    t = 3000;
    engine.stage('Convex Optimization');
    return engine;
  }

  it('rolls engagement up to the concept — most-recent wins, staging excluded (pure fn)', () => {
    const engine = engaged();
    const recency = recencyByConcept(engine.exportAll(), DEFAULT_LEARNER);
    expect(recency.get(CPT)).toBe(2000); // the later CONSUMED, not the 3000 STAGED
    expect(recency.has(conceptId('Backprop'))).toBe(false); // never engaged
    engine.close();
  });

  it('surfaces lastEngagedAt + following on the assembled concept', () => {
    const engine = engaged();
    const levels = engine.assemble().levels.flat();
    const gd = levels.find((n) => n.name === 'Gradient Descent')!;
    const bp = levels.find((n) => n.name === 'Backprop')!;
    expect(gd.lastEngagedAt).toBe(2000);
    expect(gd.following).toBe(true);
    expect(bp.lastEngagedAt).toBeUndefined();
    expect(bp.following).toBe(false);
    engine.close();
  });
});

describe('behavioral verbs resolve URL refs (alpha UI M4 regression)', () => {
  it('consume(<url>) matches the id captureSource({url}) derived', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: () => 1_720_000_000_000 });
    const { sourceId: captured } = engine.captureSource({ url: 'https://example.com/calc', title: 'Calc Primer' });
    engine.consume('https://example.com/calc'); // was: slugged the URL as a title → dangling ref
    expect(engine.exportAll().events.filter((e) => e.verb === 'CONSUMED')).toEqual([
      {
        learnerId: DEFAULT_LEARNER,
        verb: 'CONSUMED',
        targetType: 'source',
        targetId: captured,
        occurredAt: 1_720_000_000_000,
      },
    ]);
    engine.close();
  });
});
