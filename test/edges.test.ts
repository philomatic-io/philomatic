/**
 * Slice 2 — sources, relation-by-name desugaring, and the two-tier parser:
 *   - `explains` / `prerequisites` sugar expand into correctly-typed, correctly-directed edges
 *   - sources + edges round-trip through storage
 *   - Tier 1 rejects illegal endpoints and dangling references
 *   - Tier 2 rejects PREREQUISITE_OF cycles, including cycles that span payload + store
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { desugar } from '../src/io/sugar';
import { ValidationError } from '../src/parser/report';

describe('Slice 2: sources, relations, parser', () => {
  it('desugars source `explains` into a source→concept ABOUT edge tagged #Explains (v2)', () => {
    const p = desugar({
      version: 1,
      concepts: [{ name: 'Multiplication' }],
      sources: [{ title: 'Khan: Multiplication', modality: 'video', explains: ['Multiplication'] }],
    });
    expect(p.edges).toContainEqual(
      expect.objectContaining({
        srcType: 'source',
        type: 'ABOUT',
        dstType: 'concept',
        dstId: 'cpt_multiplication',
        tags: [{ name: 'Explains' }],
      }),
    );
  });

  it('desugars concept `prerequisites` with correct direction (prereq → owner)', () => {
    const p = desugar({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication', prerequisites: ['Addition'] }],
    });
    expect(p.edges).toContainEqual(
      expect.objectContaining({
        srcType: 'concept',
        srcId: 'cpt_addition',
        type: 'PREREQUISITE_OF',
        dstType: 'concept',
        dstId: 'cpt_multiplication',
      }),
    );
  });

  it('round-trips sources + edges through storage', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication', prerequisites: ['Addition'] }],
      sources: [
        {
          title: 'Khan: Multiplication',
          directUrl: 'https://khanacademy.org/x',
          modality: 'video',
          explains: ['Multiplication'],
        },
      ],
    });
    const out = engine.exportAll();
    expect(out.concepts.map((c) => c.id)).toEqual(['cpt_addition', 'cpt_multiplication']);
    expect(out.sources).toHaveLength(1);
    expect(out.edges.map((e) => e.type).sort()).toEqual(['ABOUT', 'PREREQUISITE_OF']);
    engine.close();
  });

  it('rejects an illegal edge endpoint (Tier 1)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication' }],
      edges: [
        { srcType: 'concept', srcId: 'cpt_addition', type: 'EXPLAINS', dstType: 'concept', dstId: 'cpt_multiplication' },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('illegal_endpoint');
    engine.close();
  });

  it('rejects a dangling edge reference (Tier 1)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [{ name: 'Multiplication' }],
      sources: [{ title: 'X', modality: 'text', explains: ['Nonexistent Concept'] }],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('dangling_reference');
    engine.close();
  });

  it('detects a PREREQUISITE_OF cycle within a payload (Tier 2)', () => {
    const engine = PhilomaticEngine.open();
    const report = engine.validate({
      version: 1,
      concepts: [
        { name: 'A', prerequisites: ['B'] },
        { name: 'B', prerequisites: ['A'] },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('prerequisite_cycle');
    engine.close();
  });

  it('detects a cycle spanning the payload and the store', () => {
    const engine = PhilomaticEngine.open();
    // Store: A PREREQUISITE_OF B
    engine.importPayload({ version: 1, concepts: [{ name: 'A' }, { name: 'B', prerequisites: ['A'] }] });
    // Incoming: B PREREQUISITE_OF A -> closes the loop against the store
    const report = engine.validate({ version: 1, concepts: [{ name: 'A', prerequisites: ['B'] }] });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('prerequisite_cycle');
    engine.close();
  });

  it('importPayload throws ValidationError on invalid input', () => {
    const engine = PhilomaticEngine.open();
    expect(() =>
      engine.importPayload({
        version: 1,
        concepts: [
          { name: 'A', prerequisites: ['B'] },
          { name: 'B', prerequisites: ['A'] },
        ],
      }),
    ).toThrow(ValidationError);
    engine.close();
  });
});
