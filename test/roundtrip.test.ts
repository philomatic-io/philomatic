/**
 * Slice 1 — proves the engine's spine end-to-end:
 *   sugared payload -> desugar (id derivation + tag lexing) -> validate -> upsert (SQLite)
 *   -> export -> round-trip equality, plus idempotency.
 */
import { describe, it, expect } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { desugar } from '../src/io/sugar';
import { lexTag } from '../src/schema/tags';
import { conceptId, slugify } from '../src/schema/ids';

describe('Slice 1: concept round-trip', () => {
  it('lexes typed-tag strings (degree vs subtype)', () => {
    expect(lexTag('#difficulty:2')).toEqual({ name: 'difficulty', degree: 2 });
    expect(lexTag('#closed:paywall')).toEqual({ name: 'closed', subtype: 'paywall' });
    expect(lexTag('#beginner')).toEqual({ name: 'beginner' });
  });

  it('derives deterministic concept ids from names', () => {
    expect(slugify('The French Revolution')).toBe('the-french-revolution');
    expect(conceptId('Multiplication')).toBe('cpt_multiplication');
  });

  it('desugars a concept: derives id, lexes tags', () => {
    const canonical = desugar({
      version: 1,
      concepts: [
        { name: 'Multiplication', description: 'Repeated addition.', tags: ['#difficulty:2'] },
      ],
    });
    expect(canonical.concepts[0]).toEqual({
      id: 'cpt_multiplication',
      name: 'Multiplication',
      description: 'Repeated addition.',
      aliases: [],
      tags: [{ name: 'difficulty', degree: 2 }],
    });
  });

  it('round-trips a sugared concept through storage (import -> export)', () => {
    const engine = PhilomaticEngine.open();
    const imported = engine.importPayload({
      version: 1,
      concepts: [
        { name: 'Multiplication', description: 'Repeated addition.', tags: ['#difficulty:2'] },
      ],
    });
    const exported = engine.exportAll();
    expect(exported).toEqual(imported);
    engine.close();
  });

  it('re-imports its OWN export — canonical (object) tags round-trip through desugar', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Multiplication', tags: ['#difficulty:2', '#topic:arithmetic'] }],
    });
    const exported = engine.exportAll(); // tags are canonical objects here, not sugar strings
    // Feeding the export back in must not throw (objects accepted) and must be an exact no-op.
    engine.importPayload(exported);
    expect(engine.exportAll()).toEqual(exported);
    engine.close();
  });

  it('is idempotent: re-importing the same payload merges, no duplicates', () => {
    const engine = PhilomaticEngine.open();
    const payload = { version: 1, concepts: [{ name: 'Addition', tags: ['#difficulty:1'] }] };
    engine.importPayload(payload);
    engine.importPayload(payload); // second import must not duplicate
    const exported = engine.exportAll();
    expect(exported.concepts).toHaveLength(1);
    expect(exported.concepts[0]!.id).toBe('cpt_addition');
    engine.close();
  });
});
