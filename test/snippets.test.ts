/**
 * Slice 6 — Snippets (the Annotation Vault), Milestone 1: schema + storage round-trip.
 *   - a snippet (passage) round-trips through import→export
 *   - a snippet CLARIFIES/CONTRADICTS a concept (ontology anchor) and validates
 *   - a learner ANNOTATES a snippet, carrying note/sentiment in edge metadata
 *   - re-import is an idempotent no-op
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine, DEFAULT_LEARNER } from '../src/engine';
import { snippetId, sourceId, conceptId } from '../src/schema/ids';

const SRC = sourceId({ title: 'The Deep Learning Book, Ch. 6' });
const CPT = conceptId('Backpropagation');
const SNP = snippetId({ sourceId: SRC, text: 'The chain rule applied recursively yields the gradient.' });

function seed() {
  return {
    version: 1 as const,
    learners: [{ id: DEFAULT_LEARNER, displayName: 'default' }],
    concepts: [{ name: 'Backpropagation' }],
    sources: [{ title: 'The Deep Learning Book, Ch. 6', modality: 'text' as const }],
    snippets: [
      { id: SNP, sourceId: SRC, text: 'The chain rule applied recursively yields the gradient.' },
    ],
    edges: [
      { srcType: 'snippet' as const, srcId: SNP, type: 'CLARIFIES' as const, dstType: 'concept' as const, dstId: CPT },
      {
        srcType: 'learner' as const, srcId: DEFAULT_LEARNER, type: 'ANNOTATES' as const,
        dstType: 'snippet' as const, dstId: SNP,
        metadata: { note: "Finally clicked — it's just chain-rule bookkeeping.", sentiment: 'aha' },
      },
    ],
  };
}

describe('Slice 6 M1: snippet schema + storage', () => {
  it('round-trips a snippet with its concept anchor and learner annotation', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(seed());
    const out = engine.exportAll();

    expect(out.snippets).toHaveLength(1);
    expect(out.snippets[0]).toMatchObject({ id: SNP, sourceId: SRC, text: expect.stringContaining('chain rule') });

    const clarifies = out.edges.find((e) => e.type === 'CLARIFIES');
    expect(clarifies).toMatchObject({ srcId: SNP, dstId: CPT });

    const annotates = out.edges.find((e) => e.type === 'ANNOTATES');
    expect(annotates).toMatchObject({ srcId: DEFAULT_LEARNER, dstId: SNP });
    expect(annotates?.metadata).toMatchObject({ sentiment: 'aha' });
    engine.close();
  });

  it('rejects an ANNOTATES/CLARIFIES edge whose snippet does not exist (referential integrity)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Backpropagation' }],
      edges: [{ srcType: 'snippet', srcId: 'snp_missing', type: 'CLARIFIES', dstType: 'concept', dstId: CPT }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });

  it('is an idempotent no-op on re-import', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(seed());
    const first = engine.exportAll();
    engine.importPayload(seed());
    const second = engine.exportAll();
    expect(second).toEqual(first);
    engine.close();
  });
});

describe('Slice 6 M2: inline snippet sugar', () => {
  const inline = {
    version: 1 as const,
    concepts: [{ name: 'Backpropagation' }],
    sources: [
      {
        title: 'The Deep Learning Book, Ch. 6',
        modality: 'text' as const,
        explains: ['Backpropagation'],
        snippets: [
          { text: 'The chain rule applied recursively yields the gradient.', clarifies: ['Backpropagation'], note: 'Clicked.', sentiment: 'aha' },
          { text: 'We assume the loss is differentiable everywhere.', contradicts: ['Backpropagation'], note: "But ReLU isn't differentiable at 0.", sentiment: 'confused' },
        ],
      },
    ],
  };

  it('desugars inline snippets into passages, concept anchors, and an annotation overlay', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(inline);
    const out = engine.exportAll();

    // Two passages, both owned by the source, ids derived from source + text.
    expect(out.snippets.map((s) => s.id).sort()).toEqual(
      [
        snippetId({ sourceId: SRC, text: 'The chain rule applied recursively yields the gradient.' }),
        snippetId({ sourceId: SRC, text: 'We assume the loss is differentiable everywhere.' }),
      ].sort(),
    );
    expect(out.snippets.every((s) => s.sourceId === SRC)).toBe(true);

    // The clarifying passage anchors via CLARIFIES; the confused one via CONTRADICTS.
    expect(out.edges.filter((e) => e.type === 'CLARIFIES')).toHaveLength(1);
    expect(out.edges.filter((e) => e.type === 'CONTRADICTS')).toHaveLength(1);

    // Each note/sentiment became a learner ANNOTATES edge; the default learner was seeded.
    const annotations = out.edges.filter((e) => e.type === 'ANNOTATES');
    expect(annotations).toHaveLength(2);
    expect(annotations.map((a) => a.metadata?.sentiment).sort()).toEqual(['aha', 'confused']);
    expect(out.learners.map((l) => l.id)).toContain(DEFAULT_LEARNER);
    engine.close();
  });

  it('re-imports inline snippets idempotently (text-derived ids converge)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(inline);
    const first = engine.exportAll();
    engine.importPayload(inline);
    expect(engine.exportAll()).toEqual(first);
    engine.close();
  });

  it('rejects a snippet whose source does not exist (M3 referential integrity)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      snippets: [{ id: 'snp_orphan', sourceId: 'src_missing', text: 'floating passage' }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });

  it('surfaces snippets under their anchored concept, with the learner annotation (M4)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(inline);
    const backprop = engine.assemble().levels.flat().find((n) => n.name === 'Backpropagation')!;

    expect(backprop.snippets).toHaveLength(2);
    const clarifies = backprop.snippets.find((s) => s.relation === 'clarifies')!;
    const contradicts = backprop.snippets.find((s) => s.relation === 'contradicts')!;
    expect(clarifies.sentiment).toBe('aha');
    expect(clarifies.sourceId).toBe(SRC);
    expect(contradicts.sentiment).toBe('confused');
    expect(contradicts.note).toContain('ReLU');
    engine.close();
  });
});
