/**
 * Every shipped example obeys the membership doctrine: its sources are MEMBERS of its
 * track — `includeSources`, not just concept ties. All six examples predated the membership
 * ruling and imported as tracks full of concepts with zero readings; the arithmetic one was
 * removed outright, the rest were repaired. This pins the repair and stops the
 * next example from shipping pre-doctrine.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PhilomaticEngine } from '../src/engine';

describe('example tracks', () => {
  for (const file of readdirSync('examples').filter((f) => f.endsWith('.json'))) {
    it(`${file}: every track has member sources, not just concepts`, () => {
      // A deliberate candidate (LINKed related reading, never included) is legitimate —
      // deep-learning ships one on purpose. What must never recur is the defect:
      // a track that imports as concepts-only because its sources were tied by ABOUT alone.
      const e = PhilomaticEngine.open(':memory:');
      e.importPayload(JSON.parse(readFileSync(join('examples', file), 'utf8')));
      const snap = e.snapshot();
      expect(snap.sources.length).toBeGreaterThan(0);
      for (const t of snap.tracks) {
        expect(t.sourceIds.length, `${file}: "${t.title}" has no readings — membership is explicit INCLUDES (D12)`).toBeGreaterThan(0);
      }
    });
  }

  it('logic-going-further: concept membership survives name collisions with sources', () => {
    // The repair regression: a cleanup that stripped "source titles"
    // out of `includes` removed the CONCEPTS "Model Theory" and "The Axiom of Choice" — the
    // track has SOURCES by the same names. Every source explaining only those concepts then
    // rendered uncategorized, and their topic headings vanished. All 24 concepts are members.
    const e = PhilomaticEngine.open(':memory:');
    e.importPayload(JSON.parse(readFileSync(join('examples', 'logic-going-further.json'), 'utf8')));
    const track = e.exportAll().tracks[0]!;
    const includesConcepts = e.exportAll().edges.filter((x) => x.type === 'INCLUDES' && x.dstType === 'concept' && x.srcId === track.id).length;
    expect(includesConcepts).toBe(24);
  });
});
