/**
 * Edit plan M2 — the generic primitives (now DATA_MODEL.md §6; plan retired 2026-07):
 *   - remove/restore dispatch on the ref's id prefix; natural refs resolve against the store
 *     (URL → source; text → whichever kind knows it; ambiguity names the typed-id escape)
 *   - idempotent no-ops: removing the removed / restoring the live returns changed:false
 *   - minimal-ancestors restore: restoring a snippet revives its removed source
 *   - update is engine-centralized RMW: only provided fields change (anti-clobber), tags
 *     replace, note/sentiment merge into the ANNOTATES edge, identity fields are rejected
 *     with the reason, editing a removed entity demands restore first
 *   - re-capture revives: captureSource/captureSnippet append explicit RESTORED events
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine, DEFAULT_LEARNER, CaptureError } from '../src/engine';
import { conceptId, questionId, snippetId, sourceId, trackId } from '../src/schema/ids';

const URL = 'https://example.com/dl-book';
const SRC = sourceId({ title: URL, directUrl: URL });
const CPT = conceptId('Gradient Descent');
const QST = questionId({ text: 'Why does the gradient point uphill?' });
const SYL = trackId('Optimization 101');
const SNIP_TEXT = 'The gradient points uphill.';
const SNP = snippetId({ sourceId: SRC, text: SNIP_TEXT });

let t = 1_720_000_000_000;
const tick = () => ++t;

// NB: no `author` at capture — author participates in sourceId (ROADMAP §1.2), so an authored
// capture and a URL-only snippet capture would derive two different sources.
function seed(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(':memory:', { now: tick });
  engine.captureSource({ url: URL, title: 'Deep Learning Book', tags: ['#ml'] });
  engine.captureSnippet({
    url: URL,
    text: SNIP_TEXT,
    clarifies: ['Gradient Descent'],
    raises: ['Why does the gradient point uphill?'],
    note: 'crisp intuition',
    sentiment: 'golden',
  });
  engine.importPayload({ version: 1, tracks: [{ title: 'Optimization 101', includes: ['Gradient Descent'] }] });
  return engine;
}

describe('edit M2: remove / restore', () => {
  it('removes and restores every kind by typed id (round trip through the views)', () => {
    const engine = seed();
    for (const [id, gone] of [
      [SNP, (e: PhilomaticEngine) => e.snapshot().snippets.length === 0],
      [CPT, (e: PhilomaticEngine) => e.assemble().levels.flat().length === 0],
      [SYL, (e: PhilomaticEngine) => e.snapshot().tracks.length === 0],
      [SRC, (e: PhilomaticEngine) => e.snapshot().sources.length === 0],
    ] as const) {
      const removed = engine.remove({ ref: id });
      expect(removed).toMatchObject({ targetId: id, changed: true });
      expect(gone(engine)).toBe(true);
      expect(engine.restore({ ref: id })).toMatchObject({ targetId: id, changed: true });
      expect(gone(engine)).toBe(false);
    }
    engine.close();
  });

  it('resolves natural references: URL, concept name, question text, track title', () => {
    const engine = seed();
    expect(engine.remove({ ref: URL })).toMatchObject({ kind: 'source', targetId: SRC });
    expect(engine.remove({ ref: 'Gradient Descent' })).toMatchObject({ kind: 'concept', targetId: CPT });
    expect(engine.remove({ ref: 'Why does the gradient point uphill?' })).toMatchObject({ kind: 'question', targetId: QST });
    expect(engine.remove({ ref: 'Optimization 101' })).toMatchObject({ kind: 'track', targetId: SYL });
    expect(engine.removed().map((r) => r.kind).sort()).toEqual(['concept', 'question', 'source', 'track']);
    engine.close();
  });

  it('is idempotent: remove-removed and restore-live are no-ops', () => {
    const engine = seed();
    expect(engine.remove({ ref: SRC }).changed).toBe(true);
    expect(engine.remove({ ref: SRC }).changed).toBe(false); // already removed
    expect(engine.restore({ ref: SRC }).changed).toBe(true);
    expect(engine.restore({ ref: SRC }).changed).toBe(false); // already live
    engine.close();
  });

  it('restore is minimal-ancestors: restoring a snippet revives its removed source', () => {
    const engine = seed();
    engine.remove({ ref: SRC }); // hides the snippet by ownership cascade
    expect(engine.snapshot().snippets).toEqual([]);

    const result = engine.restore({ ref: SNP });
    expect(result).toMatchObject({ kind: 'snippet', targetId: SNP, changed: true });
    const snap = engine.snapshot();
    expect(snap.sources.map((s) => s.id)).toEqual([SRC]); // ancestor revived
    expect(snap.snippets.map((s) => s.id)).toEqual([SNP]);
    engine.close();
  });

  it('rejects unknown and ambiguous references with the typed-id escape', () => {
    const engine = seed();
    expect(() => engine.remove({ ref: 'src_does-not-exist' })).toThrow(CaptureError);
    expect(() => engine.remove({ ref: 'Nothing By This Name' })).toThrow(/unknown reference/);

    // A concept and a track sharing a name make the bare text ambiguous.
    engine.importPayload({
      version: 1,
      concepts: [{ name: 'Optimization 101' }],
    });
    expect(() => engine.remove({ ref: 'Optimization 101' })).toThrow(/ambiguous.*typed id/s);
    engine.close();
  });
});

describe('edit M2: update (RMW supersession)', () => {
  it('changes only provided fields — the anti-clobber guarantee', () => {
    const engine = seed();
    const result = engine.update({ ref: SRC, patch: { title: 'DL Book (2016)', estimatedDurationMins: 900 } });
    expect(result).toMatchObject({ kind: 'source', targetId: SRC, changed: true });

    const src = engine.exportAll().sources.find((s) => s.id === SRC)!;
    expect(src.title).toBe('DL Book (2016)');
    expect(src.estimatedDurationMins).toBe(900);
    expect(src.directUrl).toBe(URL); // untouched fields survive the full-replace upsert
    expect(src.tags.map((tg) => tg.name)).toEqual(['ml']);
    expect(src.modality).toBe('text');
    expect(src.id).toBe(SRC); // URL-derived id unaffected by a title edit
    engine.close();
  });

  it('tags replace the list; an identical patch is a no-op', () => {
    const engine = seed();
    expect(engine.update({ ref: SRC, patch: { tags: ['#optimization', '#book'] } }).changed).toBe(true);
    expect(engine.exportAll().sources[0]!.tags.map((tg) => tg.name)).toEqual(['optimization', 'book']);
    expect(engine.update({ ref: SRC, patch: { tags: ['#optimization', '#book'] } }).changed).toBe(false);
    engine.close();
  });

  it('merges note/sentiment into the ANNOTATES edge without clobbering the other', () => {
    const engine = seed();
    engine.update({ ref: SNP, patch: { note: 'even crisper on re-read' } });
    let snip = engine.snapshot().snippets[0]!;
    expect(snip.note).toBe('even crisper on re-read');
    expect(snip.sentiment).toBe('golden'); // survived the note patch

    engine.update({ ref: SNP, patch: { sentiment: 'confusing' } });
    snip = engine.snapshot().snippets[0]!;
    expect(snip.note).toBe('even crisper on re-read'); // survived the sentiment patch
    expect(snip.sentiment).toBe('confusing');
    engine.close();
  });

  it('rejects identity fields with the reason, and unknown fields per kind', () => {
    const engine = seed();
    // `author` left the rejection list with model v2 (a pure attribute now) — it just edits.
    expect(engine.update({ ref: SRC, patch: { author: 'Bengio' } }).changed).toBe(true);
    expect(() => engine.update({ ref: SRC, patch: { url: 'https://elsewhere' } })).toThrow(/identity field.*re-capture/s);
    // snippet text left the identity-rejection list 2026-07-18: update({text}) is now
    // edit-by-supersession (test/snippet-edit.test.ts owns that behavior).
    expect(engine.update({ ref: SNP, patch: { text: 'edited' } }).targetId).not.toBe(SNP);
    expect(() => engine.update({ ref: CPT, patch: { name: 'SGD' } })).toThrow(/identity field/);
    expect(() => engine.update({ ref: CPT, patch: { goal: 'x' } })).toThrow(CaptureError); // track field on a concept

    // title on a URL-less source derives the id → identity for that instance.
    engine.importPayload({ version: 1, sources: [{ title: 'Paper Notes', modality: 'text' }] });
    expect(() => engine.update({ ref: 'Paper Notes', patch: { title: 'Renamed' } })).toThrow(/identity field/);
    engine.close();
  });

  it('updates concepts and tracks non-identity fields', () => {
    const engine = seed();
    engine.update({ ref: CPT, patch: { description: 'First-order optimization', aliases: ['GD'] } });
    const cpt = engine.exportAll().concepts.find((c) => c.id === CPT)!;
    expect(cpt).toMatchObject({ name: 'Gradient Descent', description: 'First-order optimization', aliases: ['GD'] });

    engine.update({ ref: SYL, patch: { goal: 'Master the basics', locked: true } });
    const syl = engine.exportAll().tracks.find((s) => s.id === SYL)!;
    expect(syl).toMatchObject({ title: 'Optimization 101', goal: 'Master the basics', locked: true });
    expect(engine.snapshot().tracks[0]!.goal).toBe('Master the basics');
    engine.close();
  });

  it('refuses to edit a removed entity (restore first)', () => {
    const engine = seed();
    engine.remove({ ref: SRC });
    expect(() => engine.update({ ref: SRC, patch: { title: 'x' } })).toThrow(/removed — restore/);
    expect(() => engine.update({ ref: SNP, patch: { note: 'x' } })).toThrow(/source is removed/);
    engine.close();
  });
});

describe('edit: track rename-by-supersession', () => {
  it('mints the new id, carries fields + edges (incl. PRECEDES contexts), retracts the old', () => {
    const engine = seed();
    engine.captureSource({ url: URL, track: 'Optimization 101' });
    engine.captureSource({ url: 'https://example.com/b', title: 'B', track: 'Optimization 101' });
    const before = engine.snapshot().tracks.find((s) => s.id === SYL)!;
    const [a, b] = [...before.sourceIds];
    engine.importPayload({
      version: 1,
      edges: [{ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b!, trackContextId: SYL }],
    });
    engine.update({ ref: SYL, patch: { goal: 'descend well' } });

    const result = engine.update({ ref: 'Optimization 101', patch: { title: 'Optimization 201' } });
    const newId = trackId('Optimization 201');
    expect(result).toMatchObject({ kind: 'track', targetId: newId, changed: true });

    const after = engine.snapshot().tracks.find((s) => s.id === newId)!;
    expect(after.title).toBe('Optimization 201');
    expect(after.goal).toBe('descend well'); // non-title fields carried
    expect([...after.sourceIds].sort()).toEqual([...before.sourceIds].sort()); // membership carried
    expect(after.precedes).toEqual([{ srcId: a, dstId: b }]); // ordering re-asserted in the NEW context
    const conceptEdge = engine.exportAll().edges.find((e) => e.type === 'INCLUDES' && e.srcId === newId && e.dstType === 'concept');
    expect(conceptEdge).toBeDefined(); // concept membership carried too

    // The old identity is retracted (folded out of views), not deleted — restorable history.
    expect(engine.snapshot().tracks.some((s) => s.id === SYL)).toBe(false);
    expect(engine.removed().some((r) => r.id === SYL)).toBe(true);
    engine.close();
  });

  it('rejects a rename onto an existing live track (merge is Phase-2 dedup)', () => {
    const engine = seed();
    engine.importPayload({ version: 1, tracks: [{ title: 'Other Track' }] });
    expect(() => engine.update({ ref: 'Other Track', patch: { title: 'Optimization 101' } })).toThrow(/already exists/);
    // Same title back is a no-op, not a rename.
    expect(engine.update({ ref: 'Other Track', patch: { title: 'Other Track' } }).changed).toBe(false);
    engine.close();
  });
});

describe('edit M2: re-capture revives', () => {
  it('captureSource on a removed URL restores it with an explicit RESTORED event', () => {
    const engine = seed();
    engine.remove({ ref: SRC });
    expect(engine.snapshot().sources).toEqual([]);

    const result = engine.captureSource({ url: URL });
    expect(result).toMatchObject({ sourceId: SRC, created: false, revived: true });
    expect(engine.snapshot().sources.map((s) => s.id)).toEqual([SRC]);
    // The log reads as the user's actual history: captured → retracted → restored.
    const verbs = engine.exportAll().events.filter((e) => e.targetId === SRC).map((e) => e.verb);
    expect(verbs).toContain('RETRACTED');
    expect(verbs).toContain('RESTORED');
    engine.close();
  });

  it('captureSnippet revives its removed owning source and a removed snippet', () => {
    const engine = seed();
    engine.remove({ ref: SNP }); // independent snippet removal
    engine.remove({ ref: SRC });

    const result = engine.captureSnippet({ url: URL, text: SNIP_TEXT });
    expect(result).toMatchObject({ snippetId: SNP, created: false, revived: true });
    const snap = engine.snapshot();
    expect(snap.sources.map((s) => s.id)).toEqual([SRC]);
    expect(snap.snippets.map((s) => s.id)).toEqual([SNP]);
    engine.close();
  });

  it('a plain first capture does not claim revival', () => {
    const engine = PhilomaticEngine.open(':memory:', { now: tick });
    expect(engine.captureSource({ url: URL }).revived).toBe(false);
    expect(engine.captureSnippet({ url: URL, text: 'fresh' }).revived).toBe(false);
    engine.close();
  });
});
