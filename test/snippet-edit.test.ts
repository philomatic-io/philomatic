/**
 * Snippet text edit-by-supersession (owner ruling, 2026-07-18 — the raw-source toggle made
 * text edits an obvious gesture): text hashes into the id, so update({text}) mints the snippet
 * under its NEW id, migrates every edge (anchors, question ties, argument links, the ANNOTATES
 * row with its note/sentiment), and retracts the old — restorable like any removal. The
 * track-rename pattern, applied to passages.
 */
import { describe, expect, it } from 'vitest';
import { CaptureError, PhilomaticEngine } from '../src/engine';

function build(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(':memory:', { now: () => 1_000 });
  engine.importPayload({
    version: 2,
    concepts: [{ name: 'Variance' }],
    sources: [
      {
        id: 'src_a',
        title: 'A',
        modality: 'text',
        snippets: [
          { text: 'Old passage.', clarifies: ['Variance'], raises: ['Why?'], note: 'my note', sentiment: 'aha' },
          { text: 'Anchor passage.' },
        ],
      },
    ],
  });
  const [snp] = engine.snapshot().snippets.filter((s) => s.text === 'Old passage.');
  engine.importPayload({
    version: 2,
    edges: [{ srcType: 'snippet', srcId: engine.snapshot().snippets.find((s) => s.text === 'Anchor passage.')!.id, type: 'LINK', dstType: 'snippet', dstId: snp!.id, tags: [{ name: 'Supports' }] }],
  });
  return engine;
}

describe('update({text}) on a snippet', () => {
  it('supersedes: new id, edges + annotation migrated, old retracted and restorable', () => {
    const engine = build();
    const oldId = engine.snapshot().snippets.find((s) => s.text === 'Old passage.')!.id;

    const r = engine.update({ ref: oldId, patch: { text: 'New passage.' } });
    expect(r.changed).toBe(true);
    expect(r.targetId).not.toBe(oldId);

    const snap = engine.snapshot();
    const next = snap.snippets.find((s) => s.id === r.targetId)!;
    expect(next.text).toBe('New passage.');
    expect(next.clarifies).toEqual(['Variance']); // anchor migrated
    expect(next.note).toBe('my note'); // ANNOTATES row moved with its metadata
    expect(next.sentiment).toBe('aha');
    expect(snap.snippets.some((s) => s.id === oldId)).toBe(false); // old folded away

    const rel = engine.relations(r.targetId);
    expect(rel.some((x) => x.type === 'RAISES' && x.otherLabel === 'Why?')).toBe(true);
    expect(rel.some((x) => x.type === 'LINK' && x.tags.includes('#Supports') && x.direction === 'in')).toBe(true);

    // The old version is a retraction, not a deletion.
    expect(engine.removed().some((x) => x.id === oldId)).toBe(true);
    engine.restore({ ref: oldId });
    expect(engine.snapshot().snippets.some((s) => s.id === oldId)).toBe(true);
    engine.close();
  });

  it('a text collision with a live snippet is refused (merge = Phase-2 dedup)', () => {
    const engine = build();
    const oldId = engine.snapshot().snippets.find((s) => s.text === 'Old passage.')!.id;
    expect(() => engine.update({ ref: oldId, patch: { text: 'Anchor passage.' } })).toThrow(CaptureError);
    engine.close();
  });

  it('a formatting-only edit (same normalized id) updates in place — no self-collision', () => {
    // The id normalizes whitespace and case, so "Old passage." → "Old  Passage." hashes to the
    // SAME id. Post-reset the owner hit the collision error on exactly this: the supersession
    // path refused the snippet against itself. It must be an in-place text update instead.
    const engine = build();
    const oldId = engine.snapshot().snippets.find((s) => s.text === 'Old passage.')!.id;
    const r = engine.update({ ref: oldId, patch: { text: 'Old  Passage.' } });
    expect(r.changed).toBe(true);
    expect(r.targetId).toBe(oldId); // identity unchanged

    const snap = engine.snapshot();
    const same = snap.snippets.find((s) => s.id === oldId)!;
    expect(same.text).toBe('Old  Passage.'); // stored text updated
    expect(same.clarifies).toEqual(['Variance']); // edges untouched
    expect(same.note).toBe('my note');
    expect(engine.removed().some((x) => x.id === oldId)).toBe(false); // no retraction happened
    engine.close();
  });

  it('a same-slug retitle updates the track in place — no self-collision', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, tracks: [{ title: 'First Name' }] });
    const r = engine.update({ ref: 'First Name', patch: { title: 'First  NAME' } });
    expect(r.targetId).toBe('syl_first-name');
    expect(engine.snapshot().tracks.map((s) => s.title)).toEqual(['First  NAME']);
    engine.close();
  });

  it('text + note in one patch land together on the new snippet', () => {
    const engine = build();
    const oldId = engine.snapshot().snippets.find((s) => s.text === 'Old passage.')!.id;
    const r = engine.update({ ref: oldId, patch: { text: 'Rewritten.', note: 'better note' } });
    const next = engine.snapshot().snippets.find((s) => s.id === r.targetId)!;
    expect(next.text).toBe('Rewritten.');
    expect(next.note).toBe('better note');
    expect(next.sentiment).toBe('aha'); // untouched metadata carried
    engine.close();
  });
});

describe('the round-trip (owner bug, 2026-07-18): edit away and back again', () => {
  it('editing back to the original text revives the original snippet — nothing vanishes', () => {
    const engine = build();
    const oldId = engine.snapshot().snippets.find((s) => s.text === 'Old passage.')!.id;
    const r1 = engine.update({ ref: oldId, patch: { text: 'New passage.' } });
    const r2 = engine.update({ ref: r1.targetId, patch: { text: 'Old passage.' } });
    expect(r2.targetId).toBe(oldId); // content-derived ids reconverge

    const snap = engine.snapshot();
    const back = snap.snippets.find((s) => s.id === oldId);
    expect(back).toBeDefined(); // the vanish: without the revive, BOTH versions stayed folded
    expect(back!.text).toBe('Old passage.');
    expect(back!.clarifies).toEqual(['Variance']); // ties intact through the round-trip
    expect(back!.note).toBe('my note');
    expect(snap.snippets.some((s) => s.text === 'New passage.')).toBe(false); // the detour retracted
    engine.close();
  });

  it('the same round-trip works for track renames (the latent original)', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, tracks: [{ title: 'First Name' }] });
    const a = engine.update({ ref: 'First Name', patch: { title: 'Second Name' } });
    const b = engine.update({ ref: a.targetId, patch: { title: 'First Name' } });
    expect(b.targetId).toBe('syl_first-name');
    expect(engine.snapshot().tracks.map((s) => s.title)).toEqual(['First Name']);
    engine.close();
  });
});
