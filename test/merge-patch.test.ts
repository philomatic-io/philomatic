/**
 * MERGE-PATCH import semantics. At the ONE write gate (importPayload → upsert), per field
 * on an entity that already has a row:
 *
 *     absent        → keep what the store has
 *     explicit null → clear (optional scalars only)
 *     value present → replace (a present [] clears tags/aliases)
 *
 * Create-defaults (status 'active', modality 'other', locked false, validationState 'PENDING',
 * empty arrays) apply only to a brand-new row. This closes the clobber door at the gate
 * instead of guarding each writer — without it, an adapter could null estimatedDurationMins
 * and a propose skeleton could wipe author/duration/tags/modality.
 */
import { describe, it, expect } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import {
  ConceptPatchSchema,
  QuestionPatchSchema,
  SnippetPatchSchema,
  SourcePatchSchema,
  TrackPatchSchema,
} from '../src/schema/entities';

const open = () => PhilomaticEngine.open(':memory:', { now: (() => { let t = 1000; return () => (t += 10); })() });

const FULL_SOURCE = {
  version: 2,
  sources: [{
    id: 'src_talk', title: 'A Talk', author: 'Jane Doe', directUrl: 'https://x.test/talk',
    modality: 'video', estimatedDurationMins: 90, status: 'active',
    tags: [{ name: 'keep' }], personalUrl: 'notes://talk',
  }],
};

describe('merge-patch import: absent = keep', () => {
  it('a skeleton re-import (the §1.1 propose shape) keeps every unmentioned field', () => {
    const engine = open();
    engine.importPayload(FULL_SOURCE);
    // What the propose chain pins: id + title + url, nothing else — the incident-2 payload.
    engine.importPayload({ version: 2, sources: [{ id: 'src_talk', title: 'A Talk', directUrl: 'https://x.test/talk' }] });
    expect(engine.exportAll().sources[0]).toMatchObject({
      author: 'Jane Doe', modality: 'video', estimatedDurationMins: 90,
      tags: [{ name: 'keep' }], personalUrl: 'notes://talk', status: 'active',
    });
    engine.close();
  });

  it('a bare question REFERENCE (source raises an existing text) keeps the question\'s fields', () => {
    const engine = open();
    engine.importPayload({
      version: 2,
      questions: [{ text: 'Why?', description: 'The deep one.', tags: ['#hard'] }],
    });
    // A later capture merely RAISES the same text — desugar mints the reference entity.
    engine.importPayload({
      version: 2,
      sources: [{ id: 'src_talk', title: 'A Talk', directUrl: 'https://x.test/talk', raises: ['Why?'] }],
    });
    const q = engine.exportAll().questions.find((x) => x.text === 'Why?')!;
    expect(q.description).toBe('The deep one.');
    expect(q.tags).toEqual([{ name: 'hard' }]);
    engine.close();
  });

  it('a concept re-import by name keeps description and tags', () => {
    const engine = open();
    engine.importPayload({ version: 2, concepts: [{ name: 'Logic', description: 'The study of inference.', tags: ['#core'] }] });
    engine.importPayload({ version: 2, concepts: [{ name: 'Logic' }] });
    expect(engine.exportAll().concepts[0]).toMatchObject({
      description: 'The study of inference.', tags: [{ name: 'core' }],
    });
    engine.close();
  });

  it('a track re-import keeps goal, tags and validationState', () => {
    const engine = open();
    engine.importPayload({ version: 2, tracks: [{ title: 'T', goal: 'learn', validationState: 'VALID', tags: ['#pinned'] }] });
    engine.importPayload({ version: 2, tracks: [{ title: 'T' }] });
    expect(engine.exportAll().tracks[0]).toMatchObject({
      goal: 'learn', validationState: 'VALID', tags: [{ name: 'pinned' }],
    });
    engine.close();
  });

  it('a snippet re-import keeps anchor and tags', () => {
    const engine = open();
    engine.importPayload({
      version: 2,
      sources: [{ id: 'src_talk', title: 'A Talk', directUrl: 'https://x.test/talk' }],
      snippets: [{ id: 'snp_1', sourceId: 'src_talk', text: 'A passage.', anchor: 'p3', tags: [{ name: 'probe', subtype: 'why' }] }],
    });
    engine.importPayload({ version: 2, snippets: [{ id: 'snp_1', sourceId: 'src_talk', text: 'A passage.' }] });
    expect(engine.exportAll().snippets[0]).toMatchObject({ anchor: 'p3', tags: [{ name: 'probe', subtype: 'why' }] });
    engine.close();
  });
});

describe('merge-patch import: explicit null = clear, present value = replace', () => {
  it('null clears an optional scalar; a value replaces it', () => {
    const engine = open();
    engine.importPayload(FULL_SOURCE);
    engine.importPayload({ version: 2, sources: [{ id: 'src_talk', title: 'A Talk', author: null, estimatedDurationMins: 45 }] });
    const s = engine.exportAll().sources[0]!;
    expect(s.author).toBeUndefined();
    expect(s.estimatedDurationMins).toBe(45);
    expect(s.modality).toBe('video'); // untouched fields still keep
    engine.close();
  });

  it('a present [] clears tags (empty is expressible; absence is not emptiness)', () => {
    const engine = open();
    engine.importPayload(FULL_SOURCE);
    engine.importPayload({ version: 2, sources: [{ id: 'src_talk', title: 'A Talk', tags: [] }] });
    expect(engine.exportAll().sources[0]!.tags).toEqual([]);
    engine.close();
  });
});

describe('merge-patch import: create-defaults on new rows; round-trips unchanged', () => {
  it('a brand-new minimal source gets the create-defaults', () => {
    const engine = open();
    engine.importPayload({ version: 2, sources: [{ title: 'Bare' }] });
    expect(engine.exportAll().sources[0]).toMatchObject({ modality: 'other', status: 'active', tags: [] });
    engine.close();
  });

  it('exportAll → importPayload is still an exact no-op (full payloads are valid patches)', () => {
    const engine = open();
    // One payload: cross-payload title refs derive slug ids (known limit, not under test).
    engine.importPayload({ ...FULL_SOURCE, tracks: [{ title: 'T', includeSources: ['A Talk'], goal: 'g' }] });
    const exported = engine.exportAll();
    engine.importPayload(exported);
    expect(engine.exportAll()).toEqual(exported);
    engine.close();
  });
});

describe('the drift guard: patch schemas apply NO entity-field defaults', () => {
  // A field later added to a base schema with .default(...) must be overridden in its patch
  // variant, or the default re-erases absence and the clobber door silently reopens. This
  // parses a minimal entity through every patch schema and asserts nothing was invented.
  const cases: [string, { parse: (v: unknown) => Record<string, unknown> }, Record<string, unknown>][] = [
    ['concept', ConceptPatchSchema, { id: 'c', name: 'n' }],
    ['track', TrackPatchSchema, { id: 't', creatorId: 'l', title: 'x' }],
    ['source', SourcePatchSchema, { id: 's', title: 'x' }],
    ['snippet', SnippetPatchSchema, { id: 'p', sourceId: 's', text: 'x' }],
    ['question', QuestionPatchSchema, { id: 'q', text: 'x' }],
  ];
  for (const [kind, schema, minimal] of cases) {
    it(`${kind}: a minimal object parses with no defaulted fields appearing`, () => {
      const parsed = schema.parse(minimal);
      const invented = Object.entries(parsed).filter(([k, v]) => !(k in minimal) && v !== undefined);
      expect(invented, `defaults leaked into the ${kind} patch: ${invented.map(([k]) => k).join(', ')}`).toEqual([]);
    });
  }
});
