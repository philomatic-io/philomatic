/**
 * The outline invariant — the test that exists to end a bug CLASS, not a bug.
 *
 * "How is this track organised?" used to be re-derived per surface from whatever data that
 * surface held: the workbench from its snapshot, the published page from a bundle via a
 * synthesised assemble projection, TrackGraph from bare ABOUT edges. Four derivations drifted
 * four different ways in a single afternoon — dropped edge tags (taxonomy invisible), a
 * concept-anchored gate (mixed tracks went flat), an empty grouping disabling a fallback, and a
 * component inventing groups the workbench would never show.
 *
 * So this pins the property that matters: for the SAME track, the workbench's input and the
 * published bundle's input produce the SAME outline. Any future surface that adapts into
 * `OutlineInput` inherits the guarantee; any adapter that drops a field fails here.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhilomaticEngine } from '../src/engine';
import { trackOutline, outlineFromBundle, type OutlineInput } from '../ui/src/lib/outline';
import { trackViewModel } from '../ui/src/lib/topics';

/** The workbench's own data (snapshot + graph) → the one input shape. */
function fromWorkbench(engine: PhilomaticEngine, trackId: string): OutlineInput {
  const store = engine.exportLive();
  const snap = engine.snapshot();
  const track = snap.tracks.find((t) => t.id === trackId)!;
  const label = (t: unknown): string => {
    const g = t as { name: string; subtype?: string; degree?: number };
    return `#${g.name}${g.subtype !== undefined ? `:${g.subtype}` : ''}${g.degree !== undefined ? `:${g.degree}` : ''}`;
  };
  const nameById = new Map(store.concepts.map((c) => [c.id, c.name]));
  const about = new Map<string, string[]>();
  for (const e of store.edges) {
    if (e.type === 'ABOUT' && e.dstType === 'concept') {
      const n = nameById.get(e.dstId);
      if (n !== undefined) about.set(e.srcId, [...(about.get(e.srcId) ?? []), n]);
    }
  }
  return {
    trackId,
    concepts: store.concepts.map((c) => ({ id: c.id, name: c.name, tags: c.tags.map(label) })),
    sources: store.sources.map((s) => ({ id: s.id, title: s.title, about: about.get(s.id) ?? [] })),
    edges: store.edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, type: e.type, tags: (e.tags ?? []).map(label) })),
    memberOrder: [...track.sourceIds],
  };
}

/** The published bundle → the one input shape (the adapter the /t/ page uses). */
function fromBundle(engine: PhilomaticEngine, trackId: string, memberOrder: string[]): OutlineInput {
  const bundle = engine.publication(trackId)!;
  const payload = bundle.payload as Record<string, unknown>;
  return outlineFromBundle({ ...payload, memberOrder } as Parameters<typeof outlineFromBundle>[0]);
}

/** Build a track, then assert the workbench and the published bundle agree about its shape. */
function bothAgree(build: (e: PhilomaticEngine) => void, trackId: string): ReturnType<typeof trackOutline> {
  // File-backed: publishing signs with the author key that lives beside the DB.
  const engine = PhilomaticEngine.open(join(mkdtempSync(join(tmpdir(), 'pm-outline-')), 'db.sqlite'));
  build(engine);
  engine.publish({ ref: trackId, license: 'CC-BY-SA-4.0' });
  const wb = trackOutline(fromWorkbench(engine, trackId));
  const pub = trackOutline(fromBundle(engine, trackId, fromWorkbench(engine, trackId).memberOrder));
  expect(pub.groups.map((g) => [g.conceptName, g.sourceIds])).toEqual(wb.groups.map((g) => [g.conceptName, g.sourceIds]));
  expect(pub.order).toEqual(wb.order);
  expect(pub.numberOf).toEqual(wb.numberOf);
  expect(pub.groupOf).toEqual(wb.groupOf);
  // THE numbering invariant, asserted on EVERY fixture in this file rather than in a test of its
  // own — numbering has regressed twice in one day before, and both times the fixture
  // that would have caught it existed, untested for this property.
  //
  // The number is the place in the READING, not the row's place on the page.
  // So it may descend or skip as you walk down a grouped page — those gaps are the interleaving —
  // but three things must always hold:
  //
  //   1. every number is unique, so no two members claim the same place;
  //   2. the numbers are exactly 1..N over the members some PRECEDES edge touches, so the count
  //      is dense and nobody is skipped;
  //   3. every PRECEDES edge is respected: if a comes before b, a's number is lower.
  //
  // (3) is the one that matters. It is the property the old page-walk numbering could not have,
  // and it is what makes a number mean something the author actually asserted.
  const nums = Object.values(wb.numberOf);
  expect(new Set(nums).size, 'numbers are unique').toBe(nums.length);
  expect([...nums].sort((a, b) => a - b)).toEqual(nums.map((_, i) => i + 1));
  for (const p of orderingEdges(engine, trackId)) {
    const [a, b] = [wb.numberOf[p.srcId], wb.numberOf[p.dstId]];
    if (a === undefined || b === undefined) continue;
    expect(a, `${p.srcId} precedes ${p.dstId}, so it must read earlier`).toBeLessThan(b);
  }
  // …and the WORKBENCH lays the same track out in the same sequence. It renders through
  // `trackViewModel`, not through this outline, so the arrangement rule (blocks in reading
  // order) has two implementations and this is what stops them drifting —
  // which is exactly how the numbering they feed went wrong twice before.
  expect(workbenchWalk(engine, trackId)).toEqual(wb.order);
  // …and the numbers it MARKS those rows with. Comparing only the walk let the workbench keep a
  // second numbering of its own: when the reading walk learned the concept lattice, the outline
  // moved and TrackSection went on numbering from the old one, so the workbench still opened on
  // `Axiom of Choice` at 1 after the outline itself was fixed.
  expect(workbenchNumbers(engine, trackId)).toEqual(wb.numberOf);
  engine.close();
  return wb;
}

/** This track's own PRECEDES edges, member-to-member — what the numbers must not contradict. */
function orderingEdges(engine: PhilomaticEngine, trackId: string): { srcId: string; dstId: string }[] {
  const snap = engine.snapshot();
  const members = new Set(snap.tracks.find((t) => t.id === trackId)!.sourceIds);
  const g = engine.graph() as { edges: { srcId: string; dstId: string; type: string }[] };
  return g.edges.filter((e) => e.type === 'PRECEDES' && members.has(e.srcId) && members.has(e.dstId));
}

/** The numbers the workbench MARKS its rows with — `TrackSection` reads exactly this. */
function workbenchNumbers(engine: PhilomaticEngine, trackId: string): Record<string, number> {
  const snap = engine.snapshot();
  const track = snap.tracks.find((t) => t.id === trackId)!;
  return trackViewModel(engine.assemble(trackId) as never, engine.graph() as never, track, snap.sources as never).numberOf;
}

/** The workbench's own renderer walk: blocks in order, rows in order. */
function workbenchWalk(engine: PhilomaticEngine, trackId: string): string[] {
  const snap = engine.snapshot();
  const track = snap.tracks.find((t) => t.id === trackId)!;
  const vm = trackViewModel(engine.assemble(trackId) as never, engine.graph() as never, track, snap.sources as never);
  return vm.blocks.flatMap((b) => (b.kind === 'spine' ? b.spine : b.group.sources).map((e) => e.source.id));
}

describe('track outline — one answer for every surface', () => {
  it('a SOURCE-anchored track is flat in both (it includes no concepts, so nothing groups)', () => {
    // The bug class: the published page invented concept groups from ABOUT ties while the
    // workbench showed a flat list. Aboutness is not membership.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Fairness' }, { name: 'AI Risk' }],
        tracks: [{ title: 'Flat Track', includes: [] }],
        sources: [
          { title: 'Paper A', modality: 'text', about: ['Fairness'] },
          { title: 'Paper B', modality: 'text', about: ['AI Risk'] },
        ],
      });
      for (const t of ['src_paper-a', 'src_paper-b']) {
        e.link({ srcType: 'track', srcId: 'syl_flat-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
    }, 'syl_flat-track');
    expect(outline.groups).toHaveLength(0);
    expect(outline.order).toHaveLength(2);
    // Nothing is numbered: the track authors no PRECEDES, so it is a SET, not a sequence, and
    // INCLUDES order must never masquerade as a reading order.
    expect(outline.numberOf).toEqual({});
  });

  it('a track that INCLUDES concepts groups identically in both', () => {
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Set Theory' }, { name: 'Forcing' }],
        tracks: [{ title: 'Grouped Track', includes: ['Set Theory', 'Forcing'] }],
        sources: [
          { title: 'Kunen', modality: 'text', about: ['Forcing'] },
          { title: 'Halmos', modality: 'text', about: ['Set Theory'] },
        ],
      });
      for (const t of ['src_kunen', 'src_halmos']) {
        e.link({ srcType: 'track', srcId: 'syl_grouped-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
    }, 'syl_grouped-track');
    expect(outline.groups.length).toBeGreaterThan(0);
    expect(Object.keys(outline.groupOf)).toHaveLength(2);
  });

  it('taxonomy nesting survives the bundle: a child concept rolls up into its parent', () => {
    // The tag-dropping bug: the bundle adapter emitted edges with `tags: []`, so #TopicOf was
    // invisible, every concept became top-level, and children rendered as EMPTY headings.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Model Theory' }, { name: 'Ultraproducts' }],
        tracks: [{ title: 'Nested Track', includes: ['Model Theory', 'Ultraproducts'] }],
        sources: [{ title: 'Chang', modality: 'text', about: ['Ultraproducts'] }],
      });
      e.link({ srcType: 'track', srcId: 'syl_nested-track', type: 'INCLUDES', dstType: 'source', dstId: 'src_chang' });
      e.link({
        srcType: 'concept',
        srcId: 'cpt_ultraproducts',
        type: 'PREREQUISITE_OF',
        dstType: 'concept',
        dstId: 'cpt_model-theory',
        tags: [{ name: 'TopicOf' }],
      });
    }, 'syl_nested-track');
    // One heading, not two: the child rolled up rather than standing as an empty group.
    expect(outline.groups.filter((g) => g.sourceIds.length > 0)).toHaveLength(1);
    expect(outline.groups.every((g) => g.sourceIds.length > 0 || g.conceptName !== '')).toBe(true);
  });

  it('inside a group, the parent concept’s reading comes before a child topic’s', () => {
    // From a real logic track: "Axiom of Choice" (about a child topic of
    // Set Theory) sat above "Set Theory: The Third Millennium Edition" (about Set Theory
    // itself). Neither had a PRECEDES tie to the other, so the order fell through to whatever
    // sequence the store handed the sources over — an accident, not a claim. The concept
    // lattice already says the parent comes first; a group now uses it.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Set Theory' }, { name: 'Choice' }],
        // BOTH concepts are included: membership is explicit, taxonomy only arranges.
        // Included only the parent, the child-anchored source falls OUT of the group entirely
        // and this would pass without testing the ordering at all.
        tracks: [{ title: 'Anchored Track', includes: ['Set Theory', 'Choice'] }],
        sources: [
          // Deliberately imported CHILD-first, so insertion order would put it on top.
          { title: 'A Choice Monograph', modality: 'text', about: ['Choice'] },
          { title: 'A Set Theory Textbook', modality: 'text', about: ['Set Theory'] },
        ],
      });
      for (const t of ['src_a-choice-monograph', 'src_a-set-theory-textbook']) {
        e.link({ srcType: 'track', srcId: 'syl_anchored-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      e.link({ srcType: 'concept', srcId: 'cpt_choice', type: 'LINK', dstType: 'concept', dstId: 'cpt_set-theory', tags: [{ name: 'TopicOf' }] });
      e.link({ srcType: 'concept', srcId: 'cpt_set-theory', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_choice' });
    }, 'syl_anchored-track');
    // Guard: both sources must be in ONE group, or this asserts nothing about group ordering.
    expect(outline.ungrouped).toEqual([]);
    expect(outline.groups.filter((g) => g.sourceIds.length > 0)).toHaveLength(1);
    // Asserted on the GROUP's own sequence, not on numberOf: numbering follows the authored
    // reading order, and this fixture authors none — so neither source is
    // numbered at all, which is correct and says nothing about grouping either way.
    expect(outline.groups[0]!.sourceIds).toEqual(['src_a-set-theory-textbook', 'src_a-choice-monograph']);
  });

  it('an authored PRECEDES still outranks the concept lattice', () => {
    // The lattice only decides where the author has said nothing. Same shape as above, but the
    // child topic's reading is explicitly placed FIRST — and must stay there.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Set Theory' }, { name: 'Choice' }],
        tracks: [{ title: 'Authored Track', includes: ['Set Theory', 'Choice'] }],
        sources: [
          { title: 'A Choice Monograph', modality: 'text', about: ['Choice'] },
          { title: 'A Set Theory Textbook', modality: 'text', about: ['Set Theory'] },
        ],
      });
      for (const t of ['src_a-choice-monograph', 'src_a-set-theory-textbook']) {
        e.link({ srcType: 'track', srcId: 'syl_authored-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      e.link({ srcType: 'concept', srcId: 'cpt_choice', type: 'LINK', dstType: 'concept', dstId: 'cpt_set-theory', tags: [{ name: 'TopicOf' }] });
      e.link({ srcType: 'concept', srcId: 'cpt_set-theory', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_choice' });
      e.link({
        srcType: 'source',
        srcId: 'src_a-choice-monograph',
        type: 'PRECEDES',
        dstType: 'source',
        dstId: 'src_a-set-theory-textbook',
        trackContextId: 'syl_authored-track',
      });
    }, 'syl_authored-track');
    expect(outline.ungrouped).toEqual([]);
    expect(outline.numberOf['src_a-choice-monograph']).toBe(1);
    expect(outline.numberOf['src_a-set-theory-textbook']).toBe(2);
  });

  it('CATEGORIES run in prerequisite order, even when the reading starts in a later one', () => {
    // The rule, in the words that set it: "categories should be in prerequisite order and
    // sources should be in reading order" — two orders answering two questions, what you must
    // understand first and what to read first. Ranking the categories by their earliest
    // reading instead scrambles a lattice modelled by hand: Algebra for Logic → Model Theory
    // → Formal Arithmetic → Proof Theory/Set Theory → Type Theory came out as Set Theory,
    // Formal Arithmetic, Model Theory, Type Theory, Algebra for Logic, Proof Theory.
    //
    // Here the two orders disagree on purpose: Basics is a PREREQUISITE of Advanced, and the
    // reading starts in Advanced. Basics still leads, because prerequisites order categories.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Basics' }, { name: 'Advanced' }],
        tracks: [{ title: 'Lattice Track', includes: ['Basics', 'Advanced'] }],
        sources: [
          { title: 'Hard', modality: 'text', about: ['Advanced'] },
          { title: 'Easy', modality: 'text', about: ['Basics'] },
        ],
      });
      e.link({ srcType: 'concept', srcId: 'cpt_basics', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_advanced' });
      for (const t of ['src_hard', 'src_easy']) {
        e.link({ srcType: 'track', srcId: 'syl_lattice-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      // The author says to read Hard first — which is in the LATER category.
      e.link({ srcType: 'source', srcId: 'src_hard', type: 'PRECEDES', dstType: 'source', dstId: 'src_easy' });
    }, 'syl_lattice-track');

    expect(outline.groups.map((g) => g.conceptName)).toEqual(['Basics', 'Advanced']);
    expect(outline.order).toEqual(['src_easy', 'src_hard']);
  });

  it('including a concept MOVES a block; it never reshuffles the reading inside one', () => {
    // A hybrid track, shaped from a real one. A chain of four crosses the grouping: the first two
    // are about a CHILD concept, the third is about nothing, the fourth about the parent.
    // Including the child rolls its sources into the parent's group — and before the arrangement
    // rule, that renumbered the whole track, because the spine always rendered first and a
    // group's rows came out in aboutness order rather than the author's.
    const build = (include: string[]) => (e: PhilomaticEngine) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Fairness' }, { name: 'Impossibility' }],
        tracks: [{ title: 'Hybrid Track', includes: include }],
        sources: [
          { title: 'One', modality: 'text', about: ['Impossibility'] },
          { title: 'Two', modality: 'text', about: ['Impossibility'] },
          { title: 'Three', modality: 'text' },
          { title: 'Four', modality: 'text', about: ['Fairness'] },
        ],
      });
      e.link({ srcType: 'concept', srcId: 'cpt_impossibility', type: 'PREREQUISITE_OF', dstType: 'concept', dstId: 'cpt_fairness', tags: [{ name: 'TopicOf' }] });
      for (const t of ['src_one', 'src_two', 'src_three', 'src_four']) {
        e.link({ srcType: 'track', srcId: 'syl_hybrid-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      // The author's order: One → Two → Three → Four.
      for (const [a, b] of [['src_one', 'src_two'], ['src_two', 'src_three'], ['src_three', 'src_four']]) {
        e.link({ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b! });
      }
    };

    // Only the parent included: One/Two/Three are unclassified, Four is filed. The spine leads
    // because the reading starts there, and the page IS the author's order.
    const parentOnly = bothAgree(build(['Fairness']), 'syl_hybrid-track');
    expect(parentOnly.order).toEqual(['src_one', 'src_two', 'src_three', 'src_four']);

    // Now include the child too. One and Two roll up into Fairness, so that block now holds the
    // reading that STARTS the track — and the block moves to the front, carrying its rows in the
    // author's order. Three, unclassified and stranded between grouped neighbours, is the single
    // row grouping cannot hold in place: contiguous blocks have nowhere to put it.
    const both = bothAgree(build(['Fairness', 'Impossibility']), 'syl_hybrid-track');
    expect(both.order).toEqual(['src_one', 'src_two', 'src_four', 'src_three']);
    // What must NOT happen: the sequence inside the block scrambled by aboutness.
    expect(both.groups.find((g) => g.sourceIds.length > 0)!.sourceIds).toEqual(['src_one', 'src_two', 'src_four']);
    // And the numbers no longer count down the PAGE — they count down the READING, so grouping
    // shows up as a descent. The 4th row is the 3rd thing to read; that is
    // the interleaving being visible rather than being flattened away.
    expect(both.order.map((id) => both.numberOf[id])).toEqual([1, 2, 4, 3]);
  });

  it('numbering is the place in the READING, and an unplaced member claims none', () => {
    // THE invariant, and the reason numbering kept regressing: it used to be computed from the
    // PRECEDES chain while the page laid its rows out by concept group, so the two disagreed
    // whenever arrangement and chain diverged — a page reading 6, 16, 21, 24, 25.
    // Here they deliberately diverge: `Two` is about the INCLUDED concept (so it
    // groups), `One` is not (so it stays on the spine) — and One precedes Two.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Alpha' }, { name: 'Elsewhere' }],
        tracks: [{ title: 'Numbered Track', includes: ['Alpha'] }],
        sources: [
          { title: 'One', modality: 'text', about: ['Elsewhere'] },
          { title: 'Two', modality: 'text', about: ['Alpha'] },
          { title: 'Loose', modality: 'text' },
        ],
      });
      for (const t of ['src_one', 'src_two', 'src_loose']) {
        e.link({ srcType: 'track', srcId: 'syl_numbered-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      e.link({
        srcType: 'source', srcId: 'src_one', type: 'PRECEDES', dstType: 'source', dstId: 'src_two',
        trackContextId: 'syl_numbered-track',
      });
    }, 'syl_numbered-track');

    // Uncategorized members are never one block: each sits where its
    // NUMBER puts it. `One` is read first, so it leads; the concept group follows; `Loose` has no
    // PRECEDES edge at all, so it claims no position and trails everything — the same rule
    // `byReading` applies inside a run, applied to the page.
    expect(outline.order).toEqual(['src_one', 'src_two', 'src_loose']);
    // The numbers are the reading, not the walk: One reads 1st, Two 2nd, and Loose is unnumbered
    // because nothing orders it. A number would assert a position it does not have.
    expect(outline.order.map((id) => outline.numberOf[id])).toEqual([1, 2, undefined]);
    // Two separate uncategorized runs, which is the whole point — one before the category and one
    // after, where a single block could only ever be in one place.
    expect(outline.blocks.map((b) => [b.conceptId !== undefined, b.sourceIds])).toEqual([
      [false, ['src_one']],
      [true, ['src_two']],
      [false, ['src_loose']],
    ]);
  });

});

/**
 * The uncategorized rule.
 *
 * Shaped from a real track. `Interview Bias and Fairness in ML` holds one concept and two members
 * that belong to none — one read near the start, one at the very end. A single "uncategorized"
 * block has to pick an end and be wrong about the other, which is what made its placement look
 * arbitrary. Each one now sits where its NUMBER puts it, and the category is never split to
 * accommodate it.
 */
describe('uncategorized members go where their number puts them', () => {
  it('brackets a category instead of piling up at one end', () => {
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Fairness' }],
        tracks: [{ title: 'Bias Track', includes: ['Fairness'] }],
        sources: [
          { title: 'Opener', modality: 'text' },
          { title: 'Survey', modality: 'text', about: ['Fairness'] },
          { title: 'Harm', modality: 'text', about: ['Fairness'] },
          { title: 'Closer', modality: 'text' },
        ],
      });
      for (const t of ['src_opener', 'src_survey', 'src_harm', 'src_closer']) {
        e.link({ srcType: 'track', srcId: 'syl_bias-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      // Opener → Survey → Harm → Closer: one loose member at each end of the reading.
      for (const [a, b] of [['src_opener', 'src_survey'], ['src_survey', 'src_harm'], ['src_harm', 'src_closer']]) {
        e.link({ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b!, trackContextId: 'syl_bias-track' });
      }
    }, 'syl_bias-track');

    // TWO uncategorized runs, one either side of the category — the thing a single block cannot do.
    expect(outline.blocks.map((b) => [b.conceptId !== undefined, b.sourceIds])).toEqual([
      [false, ['src_opener']],
      [true, ['src_survey', 'src_harm']],
      [false, ['src_closer']],
    ]);
    expect(outline.numberOf).toEqual({ src_opener: 1, src_survey: 2, src_harm: 3, src_closer: 4 });
  });

  it('places by the NEAREST edge of a category, so an early member is not sunk to the bottom', () => {
    // The bug this rule replaced: comparing against a category's START sank `AI Risk Management
    // Framework` — a prerequisite of the track's opening source, read 2nd of 8 — below every
    // Fairness row, because Fairness happened to start at 1. Here `Early` reads 2nd of 5 and must
    // lead the category it is nearer the front of.
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Fairness' }],
        tracks: [{ title: 'Near Track', includes: ['Fairness'] }],
        sources: [
          { title: 'Head', modality: 'text', about: ['Fairness'] },
          { title: 'Early', modality: 'text' },
          { title: 'Mid', modality: 'text', about: ['Fairness'] },
          { title: 'Tail', modality: 'text', about: ['Fairness'] },
        ],
      });
      for (const t of ['src_head', 'src_early', 'src_mid', 'src_tail']) {
        e.link({ srcType: 'track', srcId: 'syl_near-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      for (const [a, b] of [['src_head', 'src_early'], ['src_early', 'src_mid'], ['src_mid', 'src_tail']]) {
        e.link({ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b!, trackContextId: 'syl_near-track' });
      }
    }, 'syl_near-track');

    // Fairness spans 1..4, midpoint 2.5; Early is 2, nearer the start, so it LEADS the category
    // even though one Fairness row is read before it.
    expect(outline.numberOf).toEqual({ src_head: 1, src_early: 2, src_mid: 3, src_tail: 4 });
    expect(outline.blocks.map((b) => [b.conceptId !== undefined, b.sourceIds])).toEqual([
      [false, ['src_early']],
      [true, ['src_head', 'src_mid', 'src_tail']],
    ]);
  });

  it('never splits a category — a member past its midpoint trails it, and its number says so', () => {
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Fairness' }],
        tracks: [{ title: 'Split Track', includes: ['Fairness'] }],
        sources: [
          { title: 'First', modality: 'text', about: ['Fairness'] },
          { title: 'Middle', modality: 'text' },
          { title: 'Last', modality: 'text', about: ['Fairness'] },
        ],
      });
      for (const t of ['src_first', 'src_middle', 'src_last']) {
        e.link({ srcType: 'track', srcId: 'syl_split-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      for (const [a, b] of [['src_first', 'src_middle'], ['src_middle', 'src_last']]) {
        e.link({ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b!, trackContextId: 'syl_split-track' });
      }
    }, 'syl_split-track');

    // `Middle` is read 2nd, between two Fairness sources. Fairness stays whole and Middle follows
    // it — no "Fairness (cont.)" anywhere — and the number 2 is what says where it belongs.
    expect(outline.blocks.map((b) => [b.conceptId !== undefined, b.sourceIds])).toEqual([
      [true, ['src_first', 'src_last']],
      [false, ['src_middle']],
    ]);
    expect(outline.numberOf).toEqual({ src_first: 1, src_middle: 2, src_last: 3 });
    // Which means the page descends: 1, 3, then 2. The gap IS the interleaving.
    expect(outline.order.map((id) => outline.numberOf[id])).toEqual([1, 3, 2]);
  });
});

/**
 * The suggested reading respects the CONCEPT lattice, not just the source chain — the failure
 * it pins, in the words that reported it: "you're suggesting I first read Axiom of Choice —
 * how are we saying to start with this paper?"
 *
 * The real failure, reduced. `Going Further in Mathematical Logic` opened on a paper about The
 * Axiom of Choice — a concept whose prerequisite is Set Theory, whose prerequisites run back
 * through Formal Arithmetic and Model Theory to Algebra for Logic. It got there honestly: nothing
 * PRECEDES that source, so it is a root of the source chain, and the walk never looked at
 * anything else. The model was fine; the algorithm was using half of it.
 */
describe('the suggested reading uses the concept lattice too', () => {
  it('does not open on a deep concept just because no source precedes it', () => {
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        // Basics → Advanced, so a source about Advanced must not be suggested first.
        concepts: [{ name: 'Basics' }, { name: 'Advanced', prerequisites: ['Basics'] }],
        tracks: [{ title: 'Lattice Track', includes: ['Basics', 'Advanced'] }],
        sources: [
          { title: 'Deep Paper', modality: 'text', about: ['Advanced'] },
          { title: 'Deep Sequel', modality: 'text', about: ['Advanced'] },
          { title: 'Primer', modality: 'text', about: ['Basics'] },
          { title: 'Follow Up', modality: 'text', about: ['Basics'] },
        ],
      });
      for (const t of ['src_deep-paper', 'src_deep-sequel', 'src_primer', 'src_follow-up']) {
        e.link({ srcType: 'track', srcId: 'syl_lattice-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      // TWO independent chains, each with a root. `Deep Paper` is a root exactly like the real
      // `Axiom of Choice` was — nothing precedes it, though its concept sits behind Basics.
      for (const [a, b] of [['src_primer', 'src_follow-up'], ['src_deep-paper', 'src_deep-sequel']]) {
        e.link({ srcType: 'source', srcId: a!, type: 'PRECEDES', dstType: 'source', dstId: b!, trackContextId: 'syl_lattice-track' });
      }
    }, 'syl_lattice-track');

    // Primer opens the reading because Basics is a prerequisite of Advanced — not Deep Paper,
    // which the source chain alone would have put first.
    expect(outline.numberOf['src_primer']).toBe(1);
    expect(outline.numberOf['src_deep-paper']!).toBeGreaterThan(outline.numberOf['src_primer']!);
  });

  it('still never breaks a PRECEDES edge to satisfy the lattice', () => {
    const outline = bothAgree((e) => {
      e.importPayload({
        version: 2,
        concepts: [{ name: 'Basics' }, { name: 'Advanced', prerequisites: ['Basics'] }],
        tracks: [{ title: 'Hard Track', includes: ['Basics', 'Advanced'] }],
        sources: [
          { title: 'Advanced First', modality: 'text', about: ['Advanced'] },
          { title: 'Basics After', modality: 'text', about: ['Basics'] },
        ],
      });
      for (const t of ['src_advanced-first', 'src_basics-after']) {
        e.link({ srcType: 'track', srcId: 'syl_hard-track', type: 'INCLUDES', dstType: 'source', dstId: t });
      }
      // The author says this Advanced source comes first. The lattice prefers Basics; the author
      // wins, because PRECEDES is a constraint and the lattice is only a preference.
      e.link({
        srcType: 'source', srcId: 'src_advanced-first', type: 'PRECEDES', dstType: 'source', dstId: 'src_basics-after',
        trackContextId: 'syl_hard-track',
      });
    }, 'syl_hard-track');

    expect(outline.numberOf).toEqual({ 'src_advanced-first': 1, 'src_basics-after': 2 });
  });
});
