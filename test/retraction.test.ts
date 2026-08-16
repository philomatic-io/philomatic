/**
 * The retraction core fold (DATA_MODEL.md's removal doctrine):
 *   - RETRACTED/RESTORED are event-only observations; liveness is a pure latest-wins fold
 *     (same-ms ties → RESTORED wins)
 *   - ownership cascade: retracting a source hides its snippets; restore revives the subtree
 *   - reference cascade: retracting a concept hides only its edges — snippets fall to global
 *   - the `removed` projection is the complement (slim trash bin, cascade dependents listed)
 *   - portability: retractions ride the canonical payload; re-import is an idempotent no-op
 *   - validation: retraction targets content kinds that exist, never tenants
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine, DEFAULT_LEARNER } from '../src/engine';
import { conceptId, snippetId, sourceId } from '../src/schema/ids';

const SRC = sourceId({ title: 'Deep Learning Book' });
const CPT = conceptId('Gradient Descent');
const SNIP_TEXT = 'The gradient points uphill.';
const SNP = snippetId({ sourceId: SRC, text: SNIP_TEXT });

const TIME0 = 1_720_000_000_000;
const TIME1 = TIME0 + 1_000;
const TIME2 = TIME0 + 2_000;

/** A payload carrying one editorial event (the declarative-import write path). */
const ev = (targetId: string, targetType: string, verb: 'RETRACTED' | 'RESTORED', occurredAt: number) => ({
  version: 1,
  events: [{ learnerId: DEFAULT_LEARNER, verb, targetType, targetId, occurredAt }],
});

/** Source→concept→snippet(+annotation) plus a CONSUMED engagement at TIME0. */
function seed(): PhilomaticEngine {
  const engine = PhilomaticEngine.open();
  engine.importPayload({
    version: 1,
    learners: [{ id: DEFAULT_LEARNER, displayName: 'default' }],
    concepts: [{ name: 'Gradient Descent' }],
    sources: [
      {
        title: 'Deep Learning Book',
        modality: 'text',
        explains: ['Gradient Descent'],
        snippets: [{ text: SNIP_TEXT, clarifies: ['Gradient Descent'], note: 'crisp intuition' }],
      },
    ],
    events: [{ learnerId: DEFAULT_LEARNER, verb: 'CONSUMED', targetType: 'source', targetId: SRC, occurredAt: TIME0 }],
  });
  return engine;
}

describe('edit M1: the liveness fold', () => {
  it('retract hides from every view; restore brings the subtree back (ownership cascade)', () => {
    const engine = seed();
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    let snap = engine.snapshot();
    expect(snap.sources).toEqual([]);
    expect(snap.snippets).toEqual([]); // owned by the retracted source

    engine.importPayload(ev(SRC, 'source', 'RESTORED', TIME2));
    snap = engine.snapshot();
    expect(snap.sources.map((s) => s.id)).toEqual([SRC]);
    expect(snap.snippets.map((s) => s.id)).toEqual([SNP]);
    expect(snap.snippets[0]!.clarifies).toEqual(['Gradient Descent']); // edges revived too
    engine.close();
  });

  it('liveness is latest-wins; a same-ms tie resolves RESTORED', () => {
    const engine = seed();
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    engine.importPayload(ev(SRC, 'source', 'RESTORED', TIME1)); // same occurredAt
    expect(engine.snapshot().sources).toHaveLength(1); // tie → restored wins

    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME2)); // strictly later → hides again
    expect(engine.snapshot().sources).toEqual([]);
    engine.close();
  });

  it('retracting a concept hides only its edges — snippets fall to global space (reference cascade)', () => {
    const engine = seed();
    engine.importPayload(ev(CPT, 'concept', 'RETRACTED', TIME1));
    const snap = engine.snapshot();
    expect(snap.snippets.map((s) => s.id)).toEqual([SNP]); // survives its anchor
    expect(snap.snippets[0]!.clarifies).toEqual([]); // anchor edge folded away

    const asm = engine.assemble();
    expect(asm.levels.flat()).toEqual([]); // concept gone from the path
    expect(asm.sourceOrder.flat().map((s) => s.id)).toEqual([SRC]); // source falls to the loose reading list
    engine.close();
  });

  it('a retracted source stops feeding recency', () => {
    const engine = seed();
    expect(engine.assemble().levels.flat()[0]!.lastEngagedAt).toBe(TIME0);
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    const concept = engine.assemble().levels.flat().find((c) => c.id === CPT)!;
    expect(concept.lastEngagedAt).toBeUndefined(); // its engagement rode the hidden source
    engine.close();
  });
});

describe('edit M1: the removed projection', () => {
  it('lists retracted items with cascade-hidden dependents, newest first', () => {
    const engine = seed();
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    engine.importPayload(ev(CPT, 'concept', 'RETRACTED', TIME2));
    const removed = engine.removed();
    expect(removed.map((r) => r.id)).toEqual([CPT, SRC]); // newest first
    expect(removed[0]).toMatchObject({ kind: 'concept', label: 'Gradient Descent', removedAt: TIME2, hides: [] });
    expect(removed[1]).toMatchObject({ kind: 'source', label: 'Deep Learning Book', removedAt: TIME1, removedBy: DEFAULT_LEARNER });
    expect(removed[1]!.hides).toEqual([{ kind: 'snippet', id: SNP, label: SNIP_TEXT }]);
    engine.close();
  });

  it('is empty when nothing is retracted, and after restore', () => {
    const engine = seed();
    expect(engine.removed()).toEqual([]);
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    expect(engine.removed()).toHaveLength(1);
    engine.importPayload(ev(SRC, 'source', 'RESTORED', TIME2));
    expect(engine.removed()).toEqual([]);
    engine.close();
  });
});

describe('edit M1: portability and the write path', () => {
  it('retractions ride the canonical payload; export→import reproduces the live view; re-import is a no-op', () => {
    const engine = seed();
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));

    const value = engine.exportAll();
    expect(value.sources).toHaveLength(1); // the full value: nothing physically deleted
    expect(value.snippets).toHaveLength(1);
    expect(value.events.filter((e) => e.verb === 'RETRACTED')).toHaveLength(1);
    expect(value.edges.map((e) => e.type as string)).not.toContain('RETRACTED'); // event-only: no fact edge

    const other = PhilomaticEngine.open();
    other.importPayload(value);
    expect(other.snapshot().sources).toEqual([]); // the retraction traveled
    other.importPayload(other.exportAll()); // idempotent no-op
    expect(other.exportAll()).toEqual(value);
    engine.close();
    other.close();
  });

  it('exportMermaid renders only the live graph', () => {
    const engine = seed();
    expect(engine.exportMermaid()).toContain(SRC);
    engine.importPayload(ev(SRC, 'source', 'RETRACTED', TIME1));
    const mermaid = engine.exportMermaid();
    expect(mermaid).not.toContain(SRC);
    expect(mermaid).toContain(CPT); // the concept itself is live
    engine.close();
  });

  it('rejects retracting a tenant or a missing target', () => {
    const engine = seed();
    const tenant = engine.validate(ev(DEFAULT_LEARNER, 'learner', 'RETRACTED', TIME1));
    expect(tenant.ok).toBe(false);
    expect(tenant.errors.map((e) => e.code)).toContain('illegal_endpoint');

    const missing = engine.validate(ev('src_does-not-exist', 'source', 'RETRACTED', TIME1));
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });
});
