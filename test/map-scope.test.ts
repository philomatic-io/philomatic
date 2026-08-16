/**
 * The map-scope rule — "this thing, in context, with its contents".
 *
 * Two entry points reach it: a double-click on the Map and "View in map" from the Library. They
 * must mean the SAME thing, so the definition lives in one function and this pins both halves —
 * the one-hop context and the recursive contents — plus the boundaries that keep a scope from
 * quietly becoming the whole map again.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhilomaticEngine } from '../src/engine';
import { scopeOf, type ScopeEdge } from '../ui/src/lib/map-scope';

/** The live store's edges in the shape the map hands the rule (tags as display labels). */
function edgesOf(engine: PhilomaticEngine): ScopeEdge[] {
  return engine.exportLive().edges.map((e) => ({
    srcId: e.srcId,
    dstId: e.dstId,
    type: e.type,
    tags: (e.tags ?? []).map((t) => `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}`),
  }));
}

function build(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(join(mkdtempSync(join(tmpdir(), 'pm-scope-')), 'db.sqlite'));
  engine.importPayload({
    version: 2,
    concepts: [{ name: 'Algebra for Logic' }, { name: 'Boolean Algebras' }, { name: 'Unrelated' }],
    tracks: [{ title: 'Mine', includes: ['Algebra for Logic'] }, { title: 'Theirs', includes: ['Unrelated'] }],
    sources: [
      { title: 'Halmos', modality: 'text', about: ['Boolean Algebras'] },
      { title: 'Outsider', modality: 'text', about: ['Unrelated'] },
    ],
  });
  engine.link({ srcType: 'track', srcId: 'syl_mine', type: 'INCLUDES', dstType: 'source', dstId: 'src_halmos' });
  engine.link({ srcType: 'track', srcId: 'syl_theirs', type: 'INCLUDES', dstType: 'source', dstId: 'src_outsider' });
  // Boolean Algebras is a topic OF Algebra for Logic.
  engine.link({
    srcType: 'concept',
    srcId: 'cpt_boolean-algebras',
    type: 'LINK',
    dstType: 'concept',
    dstId: 'cpt_algebra-for-logic',
    tags: [{ name: 'TopicOf' }],
  });
  return engine;
}

describe('map scope — context plus contents, one rule', () => {
  it('CONTENTS: a track pulls in its members, their topics, and the sources under those', () => {
    const engine = build();
    const ids = scopeOf('syl_mine', edgesOf(engine));
    expect(ids.has('cpt_algebra-for-logic')).toBe(true);
    expect(ids.has('cpt_boolean-algebras')).toBe(true); // #TopicOf is an ATTACHMENT role — it still descends
    expect(ids.has('src_halmos')).toBe(true);
    // Nothing from the other track leaks in.
    expect(ids.has('syl_theirs')).toBe(false);
    expect(ids.has('src_outsider')).toBe(false);
    expect(ids.has('cpt_unrelated')).toBe(false);
    engine.close();
  });

  it('CONTEXT: a concept keeps the track above it — context is not only what is beneath', () => {
    // An entity is shown IN CONTEXT, so what it belongs to is part
    // of the answer rather than an intrusion.
    const engine = build();
    const ids = scopeOf('cpt_algebra-for-logic', edgesOf(engine));
    expect(ids.has('cpt_boolean-algebras')).toBe(true); // contents
    expect(ids.has('src_halmos')).toBe(true); // contents, one level down
    expect(ids.has('syl_mine')).toBe(true); // context — the track that includes it
    engine.close();
  });

  it('CONTEXT: a concept shows the concepts it is a prerequisite of', () => {
    // The reported miss: double-clicking Model Theory dropped Formal Arithmetic, tied to it by
    // PREREQUISITE_OF alone. Prerequisites are context, so they arrive with the hop.
    const engine = build();
    engine.link({
      srcType: 'concept',
      srcId: 'cpt_algebra-for-logic',
      type: 'PREREQUISITE_OF',
      dstType: 'concept',
      dstId: 'cpt_unrelated',
    });
    expect(scopeOf('cpt_algebra-for-logic', edgesOf(engine)).has('cpt_unrelated')).toBe(true);
    engine.close();
  });

  it('context is ONE hop: a prerequisite arrives, its own prerequisite does not', () => {
    // Chaining would walk the lattice and hand back the map the reader was narrowing away from.
    const engine = build();
    engine.importPayload({ version: 2, concepts: [{ name: 'Far Downstream' }] });
    engine.link({ srcType: 'concept', srcId: 'cpt_algebra-for-logic', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_unrelated' });
    engine.link({ srcType: 'concept', srcId: 'cpt_unrelated', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_far-downstream' });
    const ids = scopeOf('cpt_algebra-for-logic', edgesOf(engine));
    expect(ids.has('cpt_unrelated')).toBe(true);
    expect(ids.has('cpt_far-downstream')).toBe(false);
    engine.close();
  });

  it('a neighbour arrives WITHOUT its subtree — descent starts at the seed only', () => {
    // Halmos's context includes its track; the track must not then unpack its own world.
    const engine = build();
    const ids = scopeOf('src_halmos', edgesOf(engine));
    expect(ids.has('syl_mine')).toBe(true); // the track is context
    expect(ids.has('cpt_algebra-for-logic')).toBe(false); // but not everything the track contains
    engine.close();
  });

  it('CONSISTENCY: a source with contents and one without answer the SAME question', () => {
    // The bug this rule replaced: a source with nothing under it fell back to "show what it
    // touches", while its neighbour in the same track showed only its contents — two adjacent
    // sources drawing completely unalike. Both must now report their track and their concept.
    const engine = build();
    engine.importPayload({ version: 2, questions: [{ text: 'Why lattices?' }] });
    const qid = engine.exportLive().questions.find((q) => q.text === 'Why lattices?')!.id;
    engine.link({ srcType: 'source', srcId: 'src_halmos', type: 'RAISES', dstType: 'question', dstId: qid });

    const withContents = scopeOf('src_halmos', edgesOf(engine));
    const without = scopeOf('src_outsider', edgesOf(engine));
    expect(withContents.has(qid)).toBe(true); // its contents
    expect(withContents.has('syl_mine')).toBe(true); // AND its context
    expect(withContents.has('cpt_boolean-algebras')).toBe(true);
    expect(without.has('syl_theirs')).toBe(true); // the childless one reports the same shape
    expect(without.has('cpt_unrelated')).toBe(true);
    engine.close();
  });

  it('reading order is context, not containment: the next source, never the one after it', () => {
    const engine = build();
    engine.importPayload({ version: 2, sources: [{ title: 'Third', modality: 'text' }] });
    engine.link({ srcType: 'source', srcId: 'src_halmos', type: 'PRECEDES', dstType: 'source', dstId: 'src_outsider', trackContextId: 'syl_mine' });
    engine.link({ srcType: 'source', srcId: 'src_outsider', type: 'PRECEDES', dstType: 'source', dstId: 'src_third', trackContextId: 'syl_mine' });
    const ids = scopeOf('src_halmos', edgesOf(engine));
    expect(ids.has('src_outsider')).toBe(true); // one hop
    expect(ids.has('src_third')).toBe(false); // not a chain to follow
    engine.close();
  });
});
