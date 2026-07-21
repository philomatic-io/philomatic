/**
 * Workbench redesign — the relations + graph projections (additive, READ_VERSION 1):
 *   - relationsView(id): the typed structural edges touching an entity, from its point of view
 *     (direction in/out, other endpoint's kind + label) — the detail pane's "Connections"
 *   - graphView(): the whole knowledge graph as nodes (shape-coded by kind) + structural edges,
 *     learner-overlay verbs excluded — the Map tab
 *   - both live-filtered (retracted entities / their edges never appear)
 *   - SourceView enriched: estimatedDurationMins, consumed, staged (the metadata line)
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

const DL = 'https://example.com/dl';
const VID = 'https://example.com/vid';
const Q = 'Why does the gradient point uphill?';

function seed(engine: PhilomaticEngine): void {
  engine.captureSource({ url: DL, title: 'DL Book', track: 'Intro to DL', tags: ['#difficulty:4'] });
  engine.captureSource({ url: VID, title: '3B1B Backprop' });
  engine.importPayload({
    version: 1,
    concepts: [{ name: 'Gradient Descent' }],
    sources: [{ title: 'DL Book', directUrl: DL, modality: 'text', estimatedDurationMins: 90, explains: ['Gradient Descent'] }],
    edges: [{ srcType: 'source', srcId: engine.snapshot().sources.find((s) => s.title === 'DL Book')!.id, type: 'EXPANDS', dstType: 'source', dstId: engine.snapshot().sources.find((s) => s.title === '3B1B Backprop')!.id }],
  });
  engine.captureSnippet({ url: DL, text: 'The gradient points uphill.', clarifies: ['Gradient Descent'], raises: [Q] });
  engine.consume(VID);
}

describe('SourceView enrichment', () => {
  it('carries duration + consumed/staged state', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const dl = engine.snapshot().sources.find((s) => s.title === 'DL Book')!;
    const vid = engine.snapshot().sources.find((s) => s.title === '3B1B Backprop')!;
    expect(dl).toMatchObject({ estimatedDurationMins: 90, staged: true, consumed: false });
    expect(vid).toMatchObject({ consumed: true });
    engine.close();
  });
});

describe('relationsView', () => {
  it('lists typed edges from the focused entity’s point of view, with the other endpoint labeled', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const dlId = engine.snapshot().sources.find((s) => s.title === 'DL Book')!.id;
    const rels = engine.relations(dlId);
    // INCLUDES points track→source, so DL Book sees it inbound; ABOUT #Explains + LINK
    // #Expands outbound (v2 — the seed's v1 EXPANDS edge crossed via the migration shim).
    expect(rels).toContainEqual(expect.objectContaining({ direction: 'in', type: 'INCLUDES', otherKind: 'track', otherLabel: 'Intro to DL' }));
    expect(rels).toContainEqual(expect.objectContaining({ direction: 'out', type: 'ABOUT', tags: ['#Explains'], otherKind: 'concept', otherLabel: 'Gradient Descent' }));
    expect(rels).toContainEqual(expect.objectContaining({ direction: 'out', type: 'LINK', tags: ['#Expands'], otherKind: 'source', otherLabel: '3B1B Backprop' }));
    // Learner-overlay verbs (STAGED/CONSUMED) are state, not relations — never here.
    expect(rels.some((r) => r.type === 'STAGED' || r.type === 'CONSUMED')).toBe(false);
    engine.close();
  });

  it('is live: a removed neighbor drops out of the connections', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const dlId = engine.snapshot().sources.find((s) => s.title === 'DL Book')!.id;
    engine.remove({ ref: VID });
    expect(engine.relations(dlId).some((r) => r.type === 'LINK')).toBe(false);
    engine.close();
  });
});

describe('graphView', () => {
  it('returns shape-coded nodes + structural edges, excluding the learner overlay', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const g = engine.graph();
    const kinds = new Set(g.nodes.map((n) => n.kind));
    expect(kinds).toEqual(new Set(['track', 'concept', 'source', 'snippet', 'question']));
    expect(g.edges.some((e) => e.type === 'INCLUDES')).toBe(true);
    expect(g.edges.some((e) => e.type === 'RAISES')).toBe(true);
    // Every edge endpoint resolves to a node (no dangling, no learner nodes).
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.srcId) && ids.has(e.dstId))).toBe(true);
    expect([...ids].some((id) => id.startsWith('lnr_'))).toBe(false);
    engine.close();
  });

  it('is live: removing a source drops its node, its snippet (cascade), and their edges', () => {
    const engine = PhilomaticEngine.open();
    seed(engine);
    const dlId = engine.snapshot().sources.find((s) => s.title === 'DL Book')!.id;
    engine.remove({ ref: DL });
    const g = engine.graph();
    expect(g.nodes.some((n) => n.id === dlId)).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'snippet')).toBe(false); // ownership cascade
    expect(g.edges.some((e) => e.srcId === dlId || e.dstId === dlId)).toBe(false);
    engine.close();
  });
});

describe('snippet containment is always a visible relation (alpha orphan report, 2026-07-15)', () => {
  // The popup's "Save to library" with a highlight but NO clarifies/raises/note/sentiment
  // creates a snippet whose only graph linkage is the sourceId FIELD — zero edge rows. The
  // projections must synthesize the containment edge or the snippet floats as an "orphan"
  // in the Map and shows an empty Connections list.
  it('a bare snippet (no annotations) is connected to its source in graphView and relationsView', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://en.wikipedia.org/wiki/P-value', title: 'p-value - Wikipedia', track: 'Stats' });
    engine.captureSnippet({ url: 'https://en.wikipedia.org/wiki/P-value', text: 'In null-hypothesis significance testing…' });

    const snap = engine.snapshot();
    const src = snap.sources.find((s) => s.title === 'p-value - Wikipedia')!;
    const snp = snap.snippets.find((s) => s.sourceId === src.id)!;

    // Map: the synthesized SNIPPET_OF edge ties the bare snippet to its source.
    const g = engine.graph();
    expect(g.edges).toContainEqual({ srcId: snp.id, dstId: src.id, type: 'SNIPPET_OF', tags: [] });

    // Connections, from both sides.
    expect(engine.relations(snp.id)).toContainEqual(
      { direction: 'out', type: 'SNIPPET_OF', tags: [], otherId: src.id, otherKind: 'source', otherLabel: 'p-value - Wikipedia' },
    );
    expect(engine.relations(src.id).some((r) => r.direction === 'in' && r.type === 'SNIPPET_OF' && r.otherId === snp.id)).toBe(true);

    // Removing the source cascades: the containment edge disappears with the snippet.
    engine.remove({ ref: src.id });
    expect(engine.graph().edges.some((e) => e.type === 'SNIPPET_OF' && e.srcId === snp.id)).toBe(false);
    engine.close();
  });
});

describe('argument diagramming (the first non-core framework) — snippet↔snippet LINKs', () => {
  it('imports #Supports/#Opposes passage links and surfaces the tags in relations', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://ex.com/a', title: 'A' });
    engine.captureSnippet({ url: 'https://ex.com/a', text: 'Thesis.' });
    engine.captureSnippet({ url: 'https://ex.com/a', text: 'Counter.' });
    const [thesis, counter] = engine.snapshot().snippets.map((s) => s.id);
    engine.importPayload({
      version: 2,
      edges: [{ srcType: 'snippet', srcId: counter!, type: 'LINK', dstType: 'snippet', dstId: thesis!, tags: [{ name: 'Opposes' }] }],
    });
    expect(engine.relations(thesis!)).toContainEqual(
      expect.objectContaining({ direction: 'in', type: 'LINK', tags: ['#Opposes'], otherKind: 'snippet' }),
    );
    engine.close();
  });
});

describe('linked (conjoint) premises — the tag-subtype bundle convention', () => {
  it('distinguishes jointly-sufficient premises from an independent line of support', () => {
    const engine = PhilomaticEngine.open();
    engine.captureSource({ url: 'https://ex.com/argue', title: 'Argue' });
    for (const text of ['Conclusion.', 'Premise one.', 'Premise two.', 'Lone premise.']) {
      engine.captureSnippet({ url: 'https://ex.com/argue', text });
    }
    const id = (text: string): string => engine.snapshot().snippets.find((s) => s.text === text)!.id;
    const link = (src: string, tag: { name: string; subtype?: string }) => ({
      srcType: 'snippet', srcId: id(src), type: 'LINK', dstType: 'snippet', dstId: id('Conclusion.'), tags: [tag],
    });
    engine.importPayload({
      version: 2,
      edges: [
        link('Premise one.', { name: 'Supports', subtype: 'a' }), // ┐ one conjoint bundle:
        link('Premise two.', { name: 'Supports', subtype: 'a' }), // ┘ neither supports alone
        link('Lone premise.', { name: 'Supports' }), // an independent (convergent) line
      ],
    });

    // Reading the argument back is a pure fold: group inbound #Supports by subtype bundle.
    const inbound = engine.relations(id('Conclusion.')).filter((r) => r.direction === 'in' && r.type === 'LINK');
    const bundles = new Map<string, string[]>();
    for (const r of inbound) {
      for (const t of r.tags) {
        const [, subtype] = t.replace('#', '').split(':'); // tagLabel round-trip: '#Supports:a'
        const key = subtype ?? '(independent)';
        bundles.set(key, [...(bundles.get(key) ?? []), r.otherLabel]);
      }
    }
    expect(bundles.get('a')!.sort()).toEqual(['Premise one.', 'Premise two.']); // the linked argument
    expect(bundles.get('(independent)')).toEqual(['Lone premise.']); // convergent, on its own
    engine.close();
  });
});
