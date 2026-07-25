/**
 * The experimental frameworks (owner request, 2026-07-16): propositional-logic and hermeneutics
 * as F0 data files with seed tracks in examples/, plus the snippet-link sugar that makes the
 * seeds authorable (`links: [{to, tag}]` — by TEXT, per the id doctrine: humans never
 * hand-derive snippet ids). defeasible-deontic.json stays a DRAFT: deliberately unregistered
 * (vocabulary nothing lints is a trap — its own notes say when it may register).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAMEWORKS, HERMENEUTICS, PROPOSITIONAL_LOGIC, PhilomaticEngine, edgeTagsFor, metadataVocabulary } from '../src/engine';
import { desugar } from '../src/io/sugar';

const ROOT = join(__dirname, '..');
const example = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, 'examples', name), 'utf8'));

describe('snippet `links` sugar — framework LINKs by text', () => {
  const payload = (links: object[]): unknown => ({
    version: 2,
    sources: [
      {
        title: 'A',
        modality: 'text',
        snippets: [{ text: 'Conclusion.' }, { text: 'Premise.', links }],
      },
    ],
  });

  it('resolves a target by text and carries the lexed tag', () => {
    const p = desugar(payload([{ to: 'Conclusion.', tag: '#Implies:k' }]));
    const link = p.edges.find((e) => e.type === 'LINK' && e.srcType === 'snippet');
    expect(link).toBeDefined();
    expect(link!.dstType).toBe('snippet');
    expect(link!.tags).toEqual([{ name: 'Implies', subtype: 'k' }]);
    const src = p.snippets.find((s) => s.text === 'Premise.')!;
    const dst = p.snippets.find((s) => s.text === 'Conclusion.')!;
    expect(link!.srcId).toBe(src.id);
    expect(link!.dstId).toBe(dst.id);
  });

  it('a missing target is an authoring error, loudly', () => {
    expect(() => desugar(payload([{ to: 'No such passage.', tag: '#Implies' }]))).toThrow(/not found/);
  });

  it('the same text under two sources is ambiguous until `source` disambiguates', () => {
    const two = {
      version: 2,
      sources: [
        { title: 'A', modality: 'text', snippets: [{ text: 'Same words.' }] },
        {
          title: 'B',
          modality: 'text',
          snippets: [{ text: 'Same words.' }, { text: 'Linker.', links: [{ to: 'Same words.', tag: '#Interprets' }] }],
        },
      ],
    };
    expect(() => desugar(two)).toThrow(/ambiguous/);
    const disambiguated = JSON.parse(JSON.stringify(two)) as { sources: { snippets: { links?: { source?: string }[] }[] }[] };
    disambiguated.sources[1]!.snippets[1]!.links![0]!.source = 'A';
    expect(() => desugar(disambiguated)).not.toThrow();
  });
});

describe('propositional-logic + hermeneutics frameworks (F0)', () => {
  it('both are registered; the defeasible-deontic draft is not', () => {
    const names = FRAMEWORKS.map((f) => f.framework);
    expect(names).toContain('propositional-logic');
    expect(names).toContain('hermeneutics');
    expect(names).not.toContain('defeasible-deontic');
  });

  it('propositional connectives scope to passages, with #Implies bundling conjoint antecedents', () => {
    const tags = edgeTagsFor(PROPOSITIONAL_LOGIC, 'LINK', 'snippet', 'snippet');
    expect(tags.map((t) => t.name)).toEqual(['Implies', 'EquivalentTo', 'Negates']);
    expect(tags.find((t) => t.name === 'Implies')!.subtypeRole).toBe('bundle');
  });

  it('hermeneutics declares passage readings, work relations, and the quadriga overlay vocabulary', () => {
    expect(edgeTagsFor(HERMENEUTICS, 'LINK', 'snippet', 'snippet').map((t) => t.name)).toEqual([
      'Interprets', 'ParallelPassage', 'Alludes', 'TypeOf', 'Tension',
    ]);
    expect(edgeTagsFor(HERMENEUTICS, 'LINK', 'source', 'source').map((t) => t.name)).toEqual(['CommentaryOn', 'TranslationOf']);
    expect(metadataVocabulary(HERMENEUTICS, 'ANNOTATES', 'sense').map((v) => v.token)).toEqual([
      'literal', 'allegorical', 'tropological', 'anagogical',
    ]);
  });
});

describe('the seed tracks import cleanly and read back', () => {
  it('propositional-logic seed: a conjoint bundle, two case-analysis lines, and a negation', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(example('propositional-logic.json'));
    const snap = engine.snapshot();
    const conclusion = snap.snippets.find((s) => s.text.startsWith('Death, the most awful'))!;
    const inbound = engine.relations(conclusion.id).filter((r) => r.direction === 'in' && r.type === 'LINK');
    expect(inbound.filter((r) => r.tags.includes('#Implies:epicurus'))).toHaveLength(2); // conjoint pair
    expect(inbound.filter((r) => r.tags.includes('#Implies'))).toHaveLength(2); // the dilemma's cases
    expect(inbound.filter((r) => r.tags.includes('#Negates'))).toHaveLength(1); // Nagel
    expect(snap.tracks.find((sy) => sy.framework === 'propositional-logic')).toBeDefined();
    engine.close();
  });

  it('hermeneutics seed: rival readings of one passage, disputing via #Opposes across frameworks', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload(example('hermeneutics.json'));
    const snap = engine.snapshot();
    const firstDay = snap.snippets.find((s) => s.text.startsWith('And the evening'))!;
    const rel = engine.relations(firstDay.id);
    expect(rel.filter((r) => r.tags.includes('#Interprets') && r.direction === 'in')).toHaveLength(2); // Basil + Augustine
    expect(rel.filter((r) => r.tags.includes('#Tension'))).toHaveLength(1); // Gen 2:4, kept not resolved
    const basil = snap.snippets.find((s) => s.text.includes('Twenty-four hours'))!;
    expect(engine.relations(basil.id).some((r) => r.tags.includes('#Opposes') && r.direction === 'in')).toBe(true);
    // The dispute closes the gap: both readings ANSWER the raised question (corpus-level
    // provenance — `answered` is the learner overlay verb, not asserted here).
    const q = engine.questions().find((x) => x.text.includes('twenty-four hours'));
    expect(q?.answeredBy).toHaveLength(2);
    engine.close();
  });
});
