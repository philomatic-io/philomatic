/**
 * Slice 7 — Questions (the inquiry/gap layer), Milestone 1: schema + storage round-trip.
 *   - a question round-trips through import→export
 *   - its full edge vocabulary validates: ABOUT (→concept), REFINES (→question),
 *     RAISES/ANSWERS (source→question), ASKS/ANSWERED (learner→question)
 *   - an edge to a nonexistent question is a dangling reference
 *   - re-import is an idempotent no-op
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine, DEFAULT_LEARNER } from '../src/engine';
import { questionId, conceptId, sourceId } from '../src/schema/ids';

const CPT = conceptId('Gradient Descent');
const SRC = sourceId({ title: 'Convex Optimization' });
const Q1 = questionId({ text: 'Why does gradient descent converge?' });
const Q2 = questionId({ text: 'What makes an optimizer converge?' });

function seed() {
  return {
    version: 1 as const,
    learners: [{ id: DEFAULT_LEARNER, displayName: 'default' }],
    concepts: [{ name: 'Gradient Descent' }],
    sources: [{ title: 'Convex Optimization', modality: 'text' as const }],
    questions: [
      { id: Q1, text: 'Why does gradient descent converge?' },
      { id: Q2, text: 'What makes an optimizer converge?' },
    ],
    edges: [
      { srcType: 'question' as const, srcId: Q1, type: 'ABOUT' as const, dstType: 'concept' as const, dstId: CPT },
      // v2: refinement is a framework-tagged LINK (#Refines).
      { srcType: 'question' as const, srcId: Q1, type: 'LINK' as const, dstType: 'question' as const, dstId: Q2, tags: [{ name: 'Refines' }] },
      { srcType: 'source' as const, srcId: SRC, type: 'RAISES' as const, dstType: 'question' as const, dstId: Q1 },
      { srcType: 'source' as const, srcId: SRC, type: 'ANSWERS' as const, dstType: 'question' as const, dstId: Q2 },
      { srcType: 'learner' as const, srcId: DEFAULT_LEARNER, type: 'ASKS' as const, dstType: 'question' as const, dstId: Q1 },
      { srcType: 'learner' as const, srcId: DEFAULT_LEARNER, type: 'ANSWERED' as const, dstType: 'question' as const, dstId: Q2 },
    ],
  };
}

describe('Slice 7 M1: question schema + storage', () => {
  it('round-trips questions with the full edge vocabulary', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(seed());
    const out = engine.exportAll();

    expect(out.questions.map((q) => q.id).sort()).toEqual([Q1, Q2].sort());
    const types = new Set(out.edges.map((e) => e.type));
    for (const t of ['ABOUT', 'LINK', 'RAISES', 'ANSWERS', 'ASKS', 'ANSWERED']) {
      expect(types).toContain(t);
    }
    // The refinement LINK carries its framework tag through storage.
    const refines = out.edges.find((e) => e.type === 'LINK');
    expect(refines?.tags).toContainEqual({ name: 'Refines' });
    engine.close();
  });

  it('rejects an edge to a nonexistent question (referential integrity)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Gradient Descent' }],
      edges: [{ srcType: 'question', srcId: 'qst_missing', type: 'ABOUT', dstType: 'concept', dstId: CPT }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });

  it('rejects an illegal endpoint (e.g. ABOUT from a snippet — v2 allows it from a source)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 2,
      concepts: [{ name: 'Gradient Descent' }],
      sources: [{ title: 'Convex Optimization', modality: 'text' }],
      snippets: [{ id: 'snp_x', sourceId: SRC, text: 'a passage', tags: [] }],
      questions: [{ id: Q1, text: 'Why does gradient descent converge?' }],
      edges: [{ srcType: 'snippet', srcId: 'snp_x', type: 'ABOUT', dstType: 'concept', dstId: CPT }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('illegal_endpoint');
    engine.close();
  });

  it('is an idempotent no-op on re-import', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(seed());
    const first = engine.exportAll();
    engine.importPayload(seed());
    expect(engine.exportAll()).toEqual(first);
    engine.close();
  });
});

describe('Slice 7 M2: question sugar', () => {
  const QTEXT = "How is backprop defined when ReLU isn't differentiable at 0?";
  const QID = questionId({ text: QTEXT });
  const BP = conceptId('Backpropagation');

  it('converges a snippet-raised question with a top-level declaration (same text → one id)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Backpropagation' }],
      sources: [
        {
          title: 'The Deep Learning Book, Ch. 6',
          modality: 'text',
          explains: ['Backpropagation'],
          snippets: [
            { text: 'We assume the loss is differentiable everywhere.', contradicts: ['Backpropagation'], sentiment: 'confused', raises: [QTEXT] },
          ],
        },
      ],
      questions: [{ text: QTEXT, about: ['Backpropagation'] }],
    });
    const out = engine.exportAll();

    // One question (converged), anchored to Backpropagation, raised by the snippet.
    expect(out.questions.map((q) => q.id)).toEqual([QID]);
    expect(out.edges.some((e) => e.type === 'RAISES' && e.dstType === 'question' && e.dstId === QID)).toBe(true);
    const about = out.edges.filter((e) => e.type === 'ABOUT' && e.srcId === QID);
    expect(about.map((e) => e.dstId)).toEqual([BP]);
    engine.close();
  });

  it('inherits the anchor concept from the raising snippet when no explicit about is given', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Backpropagation' }],
      sources: [
        {
          title: 'The Deep Learning Book, Ch. 6',
          modality: 'text',
          snippets: [{ text: 'We assume the loss is differentiable everywhere.', contradicts: ['Backpropagation'], raises: [QTEXT] }],
        },
      ],
      // no top-level questions → about is inherited from the snippet's `contradicts`
    });
    const out = engine.exportAll();
    expect(out.questions.map((q) => q.id)).toEqual([QID]);
    expect(out.edges.some((e) => e.type === 'ABOUT' && e.srcId === QID && e.dstId === BP)).toBe(true);
    engine.close();
  });

  it('raises without sentiment and answers existing-or-new questions (signals are orthogonal)', () => {
    const engine = PhilomaticEngine.open();
    const QRAISED = questionId({ text: 'Does entropy depend on the base of the logarithm?' });
    const QDECLARED = questionId({ text: 'What is the maximum entropy distribution?' });
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Entropy' }],
      questions: [{ text: 'What is the maximum entropy distribution?', about: ['Entropy'] }],
      sources: [
        {
          title: 'Info Theory Notes',
          modality: 'text',
          snippets: [
            // raise a question with NO sentiment/note
            { text: 'Consider a fair die versus a loaded one.', clarifies: ['Entropy'], raises: ['Does entropy depend on the base of the logarithm?'] },
            // answer a pre-declared (existing) question
            { text: 'The uniform distribution maximizes entropy.', clarifies: ['Entropy'], answers: ['What is the maximum entropy distribution?'] },
            // answer the question raised above (new-then-converged)
            { text: 'Entropy is measured in bits when using log base 2.', answers: ['Does entropy depend on the base of the logarithm?'] },
          ],
        },
      ],
    });
    const out = engine.exportAll();

    expect(out.questions.map((q) => q.id).sort()).toEqual([QRAISED, QDECLARED].sort());
    // The raise carried no sentiment/note: a RAISES edge, but zero annotations / no seeded learner.
    expect(out.edges.some((e) => e.type === 'RAISES' && e.dstId === QRAISED)).toBe(true);
    expect(out.edges.filter((e) => e.type === 'ANNOTATES')).toHaveLength(0);
    expect(out.learners).toHaveLength(0);
    // Both the existing and the new question got answered by snippets.
    expect(out.edges.filter((e) => e.type === 'ANSWERS').map((e) => e.dstId).sort()).toEqual([QRAISED, QDECLARED].sort());
    engine.close();
  });

  it('creates questions from a source raises/answers and is idempotent', () => {
    const engine = PhilomaticEngine.open();
    const payload = {
      version: 1 as const,
      sources: [
        { title: 'Survey', modality: 'text' as const, raises: ['What is open here?'], answers: ['What was settled?'] },
      ],
    };
    engine.importPayload(payload);
    const first = engine.exportAll();
    expect(first.questions.map((q) => q.id).sort()).toEqual(
      [questionId({ text: 'What is open here?' }), questionId({ text: 'What was settled?' })].sort(),
    );
    expect(first.edges.filter((e) => e.type === 'RAISES')).toHaveLength(1);
    expect(first.edges.filter((e) => e.type === 'ANSWERS')).toHaveLength(1);
    engine.importPayload(payload);
    expect(engine.exportAll()).toEqual(first);
    engine.close();
  });
});

describe('Slice 7 M3 → model v2: refinement is a framework-tagged LINK', () => {
  it('desugars `refines` into question LINK question carrying #Refines', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, questions: [{ text: 'A', refines: ['B'] }, { text: 'B' }] });
    const edge = engine.exportAll().edges.find((e) => e.type === 'LINK');
    expect(edge).toMatchObject({ srcType: 'question', dstType: 'question', tags: [{ name: 'Refines' }] });
    engine.close();
  });

  it('accepts a refinement cycle — the DAG rule retired with the type (framework rule F1 later)', () => {
    // The v1 core rejected this (`refinement_cycle`); v2 deliberately does not — acyclicity over
    // a tag-defined subgraph is opt-in framework rigidity, not engine law
    // (implementation_plan_model_v2.md §1).
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 2,
      questions: [
        { text: 'A', refines: ['B'] },
        { text: 'B', refines: ['A'] },
      ],
    });
    expect(report.ok).toBe(true);
    engine.close();
  });
});

describe('Slice 7 M4: ask/answer overlay + read model', () => {
  const Q_ANSWERED = 'What is the chain rule role in backprop?';
  const Q_GAP = "How is backprop defined when ReLU isn't differentiable at 0?";

  function seeded(): PhilomaticEngine {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Backpropagation' }],
      questions: [{ text: Q_ANSWERED, about: ['Backpropagation'] }],
      sources: [
        {
          title: 'The Deep Learning Book, Ch. 6',
          modality: 'text',
          answers: [Q_ANSWERED], // a source answers this one → not a corpus gap
          snippets: [{ text: 'We assume differentiability everywhere.', contradicts: ['Backpropagation'], raises: [Q_GAP] }],
        },
      ],
    });
    return engine;
  }

  it('ask/answer write the learner overlay and throw on a nonexistent question', () => {
    const engine = seeded();
    engine.ask(Q_GAP);
    engine.answer(Q_ANSWERED);
    const overlay = engine.exportAll().edges.filter((e) => e.type === 'ASKS' || e.type === 'ANSWERED');
    expect(overlay.map((e) => e.type).sort()).toEqual(['ANSWERED', 'ASKS']);
    expect(() => engine.ask('qst_does_not_exist')).toThrow();
    engine.close();
  });

  it('surfaces questions under their concept and derives open questions + corpus gaps', () => {
    const engine = seeded();
    engine.ask(Q_GAP);
    engine.answer(Q_ANSWERED);
    const r = engine.assemble();

    const bp = r.levels.flat().find((n) => n.name === 'Backpropagation')!;
    expect(bp.questions.map((q) => q.text).sort()).toEqual([Q_ANSWERED, Q_GAP].sort());
    const answered = bp.questions.find((q) => q.text === Q_ANSWERED)!;
    const gapQ = bp.questions.find((q) => q.text === Q_GAP)!;
    expect(answered).toMatchObject({ answered: true, gap: false });
    expect(gapQ).toMatchObject({ asked: true, answered: false, gap: true });

    // Headline views: one open question (asked & unanswered), one corpus gap (no source answers).
    expect(r.openQuestions.map((q) => q.text)).toEqual([Q_GAP]);
    expect(r.corpusGaps.map((q) => q.text)).toEqual([Q_GAP]);
    engine.close();
  });
});
