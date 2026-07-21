/**
 * Slice 3 (+ Slice 7 M5) — the read-side payoff: topological assembly, the question overlay
 * (which replaced self-claimed mastery), and Mermaid.
 *   - concepts order into prerequisite levels
 *   - answering a question rolls up to its concept (behavioral progress)
 *   - Mermaid highlights concepts the learner has answered a question about
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

function seeded(): PhilomaticEngine {
  const engine = PhilomaticEngine.open();
  engine.importPayload({
    version: 1,
    concepts: [
      { name: 'Addition' },
      { name: 'Multiplication', prerequisites: ['Addition'] },
      { name: 'Exponentiation', prerequisites: ['Multiplication'] },
    ],
  });
  return engine;
}

describe('Slice 3/7: assembly, question overlay, mermaid', () => {
  it('orders concepts topologically (prerequisites first)', () => {
    const e = seeded();
    const order = e.assemble().levels.flat().map((n) => n.id);
    expect(order.indexOf('cpt_addition')).toBeLessThan(order.indexOf('cpt_multiplication'));
    expect(order.indexOf('cpt_multiplication')).toBeLessThan(order.indexOf('cpt_exponentiation'));
    expect(e.assemble().levels).toHaveLength(3);
    e.close();
  });

  it('answering a question rolls up to its concept (progress replaces mastery)', () => {
    const e = seeded();
    e.importPayload({ version: 1, questions: [{ text: 'What is 2 + 2?', about: ['Addition'] }] });
    e.answer('What is 2 + 2?');
    const r = e.assemble();
    expect(r.answeredCount).toBe(1);
    expect(r.total).toBe(3);
    expect(r.levels.flat().find((n) => n.id === 'cpt_addition')?.answered).toBe(true);
    expect(r.levels.flat().find((n) => n.id === 'cpt_multiplication')?.answered).toBe(false);
    e.close();
  });

  it('ask/answer are idempotent and validate the question exists', () => {
    const e = seeded();
    e.importPayload({ version: 1, questions: [{ text: 'What is 2 + 2?', about: ['Addition'] }] });
    e.answer('What is 2 + 2?');
    e.answer('What is 2 + 2?');
    expect(e.assemble().answeredCount).toBe(1);
    expect(() => e.ask('a question that was never authored')).toThrow();
    e.close();
  });

  it('exportMermaid() renders nodes, prerequisite arrows, and highlights answered concepts', () => {
    const e = seeded();
    e.importPayload({ version: 1, questions: [{ text: 'What is 2 + 2?', about: ['Addition'] }] });
    e.answer('What is 2 + 2?');
    const m = e.exportMermaid();
    expect(m).toContain('graph TD');
    expect(m).toContain('cpt_addition --> cpt_multiplication');
    expect(m).toMatch(/class cpt_addition answered/);
    e.close();
  });
});
