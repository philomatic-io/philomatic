/**
 * trackViewModel — the ONE shape the Library rail renders a track in (owner design
 * 2026-07-23): the authored reading spine first, then the INCLUDED concepts as top-level
 * groups carrying whatever reading the spine hasn't claimed. No hierarchy is drawn — a group
 * heads a cluster and each row's own ties ride as chips. Cross-dependencies are FLAGGED,
 * never reordered.
 */
import { describe, expect, it } from 'vitest';
import { trackViewModel } from '../ui/src/lib/topics';

/** Concepts: Basics → Advanced (Basics is a prerequisite of Advanced). */
const concept = (id: string, name: string) => ({ id, name, tags: [], answered: false, sources: [], snippets: [], questions: [], following: false });
const asm = {
  version: 2,
  levels: [[concept('cpt_basics', 'Basics')], [concept('cpt_adv', 'Advanced')]],
  sourceOrder: [], total: 2, answeredCount: 0, openQuestions: [], corpusGaps: [], trackId: 'syl_m', title: 'Mixed',
} as any;

const src = (id: string, title: string, about: string[] = []) =>
  ({ id, title, modality: 'text', tags: [], about, consumed: false, staged: false }) as any;

const graph = (includes: string[]) =>
  ({
    version: 2,
    nodes: [
      { id: 'cpt_basics', kind: 'concept', label: 'Basics', tags: [] },
      { id: 'cpt_adv', kind: 'concept', label: 'Advanced', tags: [] },
    ],
    edges: [
      { srcId: 'cpt_basics', dstId: 'cpt_adv', type: 'PREREQUISITE_OF', tags: [] },
      ...includes.map((dstId) => ({ srcId: 'syl_m', dstId, type: 'INCLUDES', tags: [] })),
    ],
  }) as any;

const SOURCES = [
  src('s_read1', 'Read Me First', ['Advanced']), // a MEMBER, about Advanced
  src('s_read2', 'Read Me Second'), // a MEMBER, no concept
  src('s_basics', 'Basics Primer', ['Basics']), // NOT a member — comes via the concept
];

describe('trackViewModel — the spine is UNCLASSIFIED members only (owner rule, 2026-07-23)', () => {
  const track = { id: 'syl_m', sourceIds: ['s_read1', 's_read2'], sourceLevels: [['s_read1'], ['s_read2']], precedes: [{ srcId: 's_read1', dstId: 's_read2' }] };

  it('with no concepts included, every member is unclassified — all on the spine', () => {
    const vm = trackViewModel(asm, graph([]), track, SOURCES);
    expect(vm.spine.map((e) => e.source.title)).toEqual(['Read Me First', 'Read Me Second']);
  });

  it('a spine source still shows the concepts it is ABOUT as chips, even when none are included', () => {
    // The Interview-Bias shape: sources tied to a concept the track has NOT included. They
    // stay on the spine (unclassified within the track) but the aboutness is visible (owner,
    // 2026-07-23) — so you can decide to include that concept and file them.
    const vm = trackViewModel(asm, graph([]), track, SOURCES);
    expect(vm.spine.find((e) => e.source.id === 's_read1')!.topics.map((t) => t.name)).toEqual(['Advanced']);
    expect(vm.spine.find((e) => e.source.id === 's_read2')!.topics).toEqual([]); // no tie, no chip
  });

  it('a member tied to an included concept LEAVES the spine and lives under that concept', () => {
    // Read Me First is ABOUT Advanced; include Advanced and it is classified — off the top,
    // under the concept. Read Me Second has no tie, so it stays on the spine. No duplicates.
    const vm = trackViewModel(asm, graph(['cpt_adv']), track, SOURCES);
    expect(vm.spine.map((e) => e.source.title)).toEqual(['Read Me Second']);
    const advanced = vm.concepts.find((c) => c.conceptName === 'Advanced')!;
    expect(advanced.sources.map((e) => e.source.title)).toEqual(['Read Me First']);
  });
});

describe('trackViewModel — the MIXED case (members AND included concepts)', () => {
  // The track includes two sources AND the Basics concept. Read Me First is about Advanced.
  const track = { id: 'syl_m', sourceIds: ['s_read1', 's_read2'], sourceLevels: [['s_read1'], ['s_read2']], precedes: [{ srcId: 's_read1', dstId: 's_read2' }] };
  const vm = () => trackViewModel(asm, graph(['cpt_basics', 'cpt_adv']), track, SOURCES);

  it('a classified member is under its concept; an unclassified one is on the spine — never both', () => {
    // Read Me First (about Advanced) → under Advanced. Read Me Second (no tie) → on the spine.
    expect(vm().spine.map((e) => e.source.title)).toEqual(['Read Me Second']);
    expect(vm().concepts.find((c) => c.conceptName === 'Advanced')!.sources.map((e) => e.source.title)).toEqual(['Read Me First']);
    // and no member appears twice, anywhere
    const seen = [...vm().spine.map((e) => e.source.id), ...vm().concepts.flatMap((c) => c.sources.map((e) => e.source.id))];
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a non-member ABOUT an included concept is a CANDIDATE, not content', () => {
    const basics = vm().concepts.find((c) => c.conceptName === 'Basics')!;
    // Basics Primer is ABOUT Basics but was never added — a candidate to promote.
    expect(basics.sources.map((e) => e.source.title)).toEqual([]);
    expect(basics.candidates.map((s) => s.title)).toContain('Basics Primer');
  });

  // The spine still numbers what remains, and an unordered member on it shows no marker.
  describe('spine ordering survives the filter', () => {
    // Two unclassified members: Read Me Second → Filler is the chain; Extra trails unordered.
    const WITH = [...SOURCES, src('s_filler', 'Filler'), src('s_extra', 'Extra')];
    const loose = {
      id: 'syl_m',
      sourceIds: ['s_read2', 's_filler', 's_extra'],
      sourceLevels: [['s_read2'], ['s_filler']],
      precedes: [{ srcId: 's_read2', dstId: 's_filler' }],
    };
    const lvm = () => trackViewModel(asm, graph(['cpt_basics', 'cpt_adv']), loose, WITH);

    it('orders the classified-free spine and marks the untouched member unordered', () => {
      expect(lvm().spine.map((e) => [e.source.title, e.unordered])).toEqual([
        ['Read Me Second', false],
        ['Filler', false],
        ['Extra', true],
      ]);
    });
  });
});

describe('trackViewModel — a concept-anchored track', () => {
  // A track that includes concepts but has explicitly added Basics Primer as its one member.
  const track = { id: 'syl_m', sourceIds: ['s_basics'], sourceLevels: [], precedes: [] };
  it('the concept groups show the MEMBER, not every source about the concept', () => {
    const vm = trackViewModel(asm, graph(['cpt_basics', 'cpt_adv']), track, SOURCES);
    // spine has the member; the group shows it too (your reading, by concept)
    expect(vm.concepts.map((c) => c.conceptName)).toEqual(['Basics', 'Advanced']);
    expect(vm.concepts.find((c) => c.conceptName === 'Basics')!.sources.map((e) => e.source.title)).toEqual(['Basics Primer']);
  });
});

/**
 * The candidate pool (owner, 2026-07-23): including a concept contributes framing, never
 * content — a source is on the track only via an explicit INCLUDES. Every other source ABOUT
 * the concept is a CANDIDATE, never auto-pulled. This is the membership invariant of record,
 * finally enforced in the view.
 */
describe('trackViewModel — a concept contributes framing, not content', () => {
  // The track includes Basics but has added NO sources. Basics Primer is ABOUT Basics.
  const track = { id: 'syl_m', sourceIds: [], sourceLevels: [], precedes: [] };
  const vm = () => trackViewModel(asm, graph(['cpt_basics']), track, SOURCES);

  it('a source ABOUT an included concept is NOT auto-pulled into the group', () => {
    const basics = vm().concepts.find((c) => c.conceptName === 'Basics')!;
    expect(basics.sources).toEqual([]); // nothing was deliberately added
  });

  it('it appears as a CANDIDATE instead', () => {
    const basics = vm().concepts.find((c) => c.conceptName === 'Basics')!;
    expect(basics.candidates.map((s) => s.title)).toContain('Basics Primer');
  });

  it('adding it as a member moves it OUT of candidates and INTO the group', () => {
    const withMember = trackViewModel(asm, graph(['cpt_basics']), { ...track, sourceIds: ['s_basics'] }, SOURCES);
    const basics = withMember.concepts.find((c) => c.conceptName === 'Basics')!;
    expect(basics.sources.map((e) => e.source.title)).toEqual(['Basics Primer']);
    expect(basics.candidates.map((s) => s.title)).not.toContain('Basics Primer');
  });
});

/**
 * Empty concepts (owner, 2026-07-23): "each topic concept should have a chip next to it for
 * every concept in its hierarchy that currently does not have any sources tied to it."
 *
 * The worked example: × the one source under Stability Theory and it leaves both Stability
 * Theory and Model Theory for the track's path — at which point Stability Theory has nothing
 * tied to it, and appears as a chip on Model Theory.
 */
describe('trackViewModel — concepts with nothing tied to them', () => {
  const cpt = (id: string, name: string) => ({ id, name, tags: [], answered: false, sources: [], snippets: [], questions: [], following: false });
  const asmMT = {
    version: 2,
    levels: [[cpt('cpt_mt', 'Model Theory')], [cpt('cpt_stab', 'Stability Theory'), cpt('cpt_ultra', 'Ultraproducts')]],
    sourceOrder: [], total: 3, answeredCount: 0, openQuestions: [], corpusGaps: [], trackId: 'syl', title: 'MT',
  } as any;
  const graphMT = {
    version: 2,
    nodes: [
      { id: 'cpt_mt', kind: 'concept', label: 'Model Theory', tags: [] },
      { id: 'cpt_stab', kind: 'concept', label: 'Stability Theory', tags: [] },
      { id: 'cpt_ultra', kind: 'concept', label: 'Ultraproducts', tags: [] },
    ],
    edges: [
      { srcId: 'cpt_mt', dstId: 'cpt_stab', type: 'PREREQUISITE_OF', tags: [] },
      { srcId: 'cpt_mt', dstId: 'cpt_ultra', type: 'PREREQUISITE_OF', tags: [] },
      { srcId: 'syl', dstId: 'cpt_mt', type: 'INCLUDES', tags: [] },
    ],
  } as any;
  // s1 is a MEMBER now — emptiness keys off member ties, not the candidate pool.
  const track = { id: 'syl', sourceIds: ['s1'], sourceLevels: [], precedes: [] };
  const group = (sources: any[]) => trackViewModel(asmMT, graphMT, track, sources).concepts.find((c) => c.conceptName === 'Model Theory')!;

  it('lists a hierarchy concept no MEMBER is tied to', () => {
    const g = group([src('s1', 'A Course in Model Theory', ['Stability Theory'])]);
    expect(g.emptyConcepts.map((c) => c.name)).toEqual(['Ultraproducts']); // Stability has s1
  });

  it("the owner's worked example: dropping the last tie makes that concept a chip", () => {
    // before: Stability Theory has a member. after the × removed its ABOUT edges: it doesn't.
    expect(group([src('s1', 'A Course in Model Theory', ['Stability Theory'])]).emptyConcepts.map((c) => c.name)).not.toContain('Stability Theory');
    expect(group([src('s1', 'A Course in Model Theory', [])]).emptyConcepts.map((c) => c.name)).toEqual(['Stability Theory', 'Ultraproducts']);
  });

  it('never lists the heading as a chip on itself', () => {
    expect(trackViewModel(asmMT, graphMT, { ...track, sourceIds: [] }, []).concepts.find((c) => c.conceptName === 'Model Theory')!.emptyConcepts.map((c) => c.name)).not.toContain('Model Theory');
  });

  it('an INCLUDED concept is listed even with nothing under it at all', () => {
    const vm = trackViewModel(asmMT, graphMT, { ...track, sourceIds: [] }, []);
    expect(vm.concepts.map((c) => c.conceptName)).toEqual(['Model Theory']);
    expect(vm.concepts[0]!.sources).toEqual([]);
  });
});

/**
 * A concept tied ACROSS topics (owner, 2026-07-23): "when we remove concept c from source s1
 * under topic T1 but concept c is also tied to source s2 in topic T2… there is still a path
 * between T1 and c but no longer s1 in it."
 *
 * A source anchors at its EARLIEST-ranked tie, so its other ties can reach into a topic it
 * doesn't display under. C is owned by T1, but the only remaining source on C shows under T2.
 * Asked globally, "is anything tied to C?" says yes and T1 goes on hiding it. Asked of the
 * group — the question the heading is actually answering — T1 has nothing on C, and says so.
 */
describe('trackViewModel — a concept tied across two topics', () => {
  const cpt = (id: string, name: string) => ({ id, name, tags: [], answered: false, sources: [], snippets: [], questions: [], following: false });
  // T2 ranks before T1, so a source tied to both D and C anchors under T2.
  const asmX = {
    version: 2,
    levels: [[cpt('t2', 'T2'), cpt('t1', 'T1')], [cpt('d', 'D'), cpt('c', 'C')]],
    sourceOrder: [], total: 4, answeredCount: 0, openQuestions: [], corpusGaps: [], trackId: 'syl', title: 'X',
  } as any;
  const graphX = {
    version: 2,
    nodes: ['t1', 't2', 'c', 'd'].map((id) => ({ id, kind: 'concept', label: id.toUpperCase(), tags: [] })),
    edges: [
      { srcId: 't1', dstId: 'c', type: 'PREREQUISITE_OF', tags: [] }, // C is owned by T1
      { srcId: 't2', dstId: 'd', type: 'PREREQUISITE_OF', tags: [] }, // D is owned by T2
      { srcId: 'syl', dstId: 't1', type: 'INCLUDES', tags: [] },
      { srcId: 'syl', dstId: 't2', type: 'INCLUDES', tags: [] },
    ],
  } as any;
  // both sources are MEMBERS — the cross-topic reach is about member ties.
  const track = { id: 'syl', sourceIds: ['s1', 's2'], sourceLevels: [], precedes: [] };
  const s2 = src('s2', 'Lives under T2', ['D', 'C']); // anchors at D → displays under T2
  const view = (sources: any[]) => trackViewModel(asmX, graphX, track, sources);
  const emptyOn = (v: any, main: string) => v.concepts.find((g: any) => g.conceptName === main)!.emptyConcepts.map((c: any) => c.name);

  it('the setup really does put the two sources in different topics', () => {
    const v = view([src('s1', 'Lives under T1', ['C']), s2]);
    expect(v.concepts.find((g) => g.conceptName === 'T1')!.sources.map((e) => e.source.id)).toEqual(['s1']);
    expect(v.concepts.find((g) => g.conceptName === 'T2')!.sources.map((e) => e.source.id)).toEqual(['s2']);
  });

  it('while T1 still has a source on C, C is not a chip there', () => {
    expect(emptyOn(view([src('s1', 'Lives under T1', ['C']), s2]), 'T1')).not.toContain('C');
  });

  it('once T1 has none, C becomes a chip on T1 — even though s2 elsewhere is still tied to it', () => {
    const v = view([src('s1', 'Lives under T1', []), s2]);
    expect(emptyOn(v, 'T1')).toContain('C');
    // …and s2 keeps its C chip over in T2, because that tie is untouched.
    expect(v.concepts.find((g) => g.conceptName === 'T2')!.sources[0]!.ties.map((t) => t.name)).toContain('C');
  });
});
