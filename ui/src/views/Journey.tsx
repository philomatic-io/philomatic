/**
 * Journey — the column browser (wireframe 1c) for browsing AND building end-to-end journeys.
 *
 * Columns: Tracks → ordered Sources → the source's Questions → its Snippets. The header shows
 * the concepts you follow (an Edit toggle reveals all concepts so you can follow more) and the
 * raised/answered legend.
 *
 * Edit mode is where building happens: the grey add box at the end of each column appears only
 * while editing, as does the drag-in palette for existing sources. Each source row carries a
 * consumed checkbox, a seal-question open-question count, and a seminal badge; each track row a
 * consumed-progress bar. Progress verbs (consume / track) are add-only — un-consuming /
 * un-following needs the deferred edge-retraction work.
 *
 * Pure client of the read + write contracts.
 */
import { useEffect, useMemo, useState } from 'react';
import { Books, PencilSimple, Play, SealQuestion, Star } from '@phosphor-icons/react';
import { derivedReading, isConceptAnchored, orderedConcepts, orderedConceptsForSources } from '../lib/topics';
import { resolveOrCreateConcept } from '../lib/concepts';
import { SnippetText } from '../lib/snippet-md';
import type { EngineClient } from '../client/transport';
import type { AssembleResult, GraphEnvelope, QuestionView, Snapshot, SnippetView, SourceView } from '../client/types';
import { Icon, sourceIcon } from '../components/Icon';
import { orderedSources } from '../lib/order';
import { SentimentTag } from '../lib/sentiment';
import { TagChip } from '../components/TagChip';
import { hierarchyLinks } from '../lib/ranks';
import { relationWord } from '../lib/relations';

type Focus = { kind: 'question' | 'snippet'; id: string };
type Rel = 'raised' | 'answered' | undefined;
interface Concept {
  id: string;
  name: string;
  tracked: boolean;
}

export function Journey({
  projection,
  snapshot,
  questions,
  concepts,
  client,
  refresh,
  notify,
  onOpenInLibrary,
}: {
  /** The shared assemble+graph, fetched once per change by App. */
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  snapshot: Snapshot;
  questions: QuestionView[];
  concepts: Concept[];
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (msg: string) => void;
  onOpenInLibrary: (id: string) => void;
}) {
  const [sylId, setSylId] = useState<string | undefined>();
  const [srcId, setSrcId] = useState<string | undefined>();
  const [focus, setFocus] = useState<Focus | undefined>();
  const [edit, setEdit] = useState(false);
  // A source drag is in flight (row or palette) — shows the drop hint + empty-track target.
  const [draggingSrc, setDraggingSrc] = useState(false);
  // Zone-based drop targeting: the WHOLE row is the surface — top third places before it,
  // bottom third after it, the middle makes a co-requisite. An insertion line / outline on the
  // row itself shows the zone (feedback: the 8px gaps were needle-threading, and the palette
  // drag painted the whole column instead of a target).
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: 'above' | 'below' | 'coreq' } | undefined>();
  // Pencil rename in edit mode (tracks + sources). A track rename mints a NEW id (the title
  // slugs it — rename-by-supersession in the engine), so the selection follows targetId.
  const [renaming, setRenaming] = useState<{ kind: 'track' | 'source'; id: string } | undefined>();
  // Read state writes the real verbs (owner request, 2026-07-19 — the un-verb exists now);
  // follows remain a visual override until un-track ships.
  const [followedOverride, setFollowedOverride] = useState<Record<string, boolean>>({});
  const isConsumed = (s: SourceView) => s.consumed;
  const isFollowed = (c: Concept) => followedOverride[c.id] ?? c.tracked;
  const toggleConsumed = (s: SourceView) => {
    void (async () => {
      try {
        if (s.consumed) {
          await client.unconsume(s.id);
          await refresh();
          notify('Marked as unread');
        } else {
          await client.consume(s.id);
          await refresh();
          notify('Marked as read ✓');
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e));
      }
    })();
  };
  const toggleFollowed = (c: Concept) => setFollowedOverride((o) => ({ ...o, [c.id]: !isFollowed(c) }));

  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));
  const conceptIdByName = new Map(concepts.map((c) => [c.name, c.id]));
  const conceptNameById = new Map(concepts.map((c) => [c.id, c.name]));
  // Declared-taxonomy links (SubfieldOf/TopicOf per the framework declarations — lib/ranks
  // reads hierarchy/hierarchyRole; no tag-name literals here). Rendered as chips on the
  // By-concept rows: taxonomy alongside the prerequisite-guarded order, two axes two sources.
  const taxLinks = useMemo(
    () => (projection ? hierarchyLinks(projection.graph.edges) : new Map<string, never[]>()),
    [projection],
  );
  const activeSyl = snapshot.tracks.find((s) => s.id === sylId) ?? snapshot.tracks[0];
  const activeSylId = activeSyl?.id;

  // Concept lens for the path column: the track's whole family, flat, prerequisite-ordered.
  const [pathView, setPathView] = useState<'sources' | 'concepts'>('sources');
  const conceptRows: { id: string; name: string; main: boolean }[] = useMemo(() => {
    if (pathView !== 'concepts' || !projection || !activeSylId) return [];
    const fam = orderedConcepts(projection.asm, projection.graph, activeSylId);
    if (fam.length > 0) return fam;
    // No INCLUDED concepts → the concepts this track's member sources are ABOUT (the
    // territory its reading covers), guarded-DFS ordered (owner request, 2026-07-20).
    const track = snapshot.tracks.find((t) => t.id === activeSylId);
    return track ? orderedConceptsForSources(projection.asm, projection.graph, orderedSources(track).map((o) => o.id)) : [];
  }, [pathView, activeSylId, projection, snapshot.tracks]);
  // PRECEDES-ordered path: co-requisites share a step number ("same line"); without any
  // ordering edges the INCLUDES order stands (one step each).
  const ordered = activeSyl ? orderedSources(activeSyl) : [];
  const levelOf = new Map(ordered.map((o) => [o.id, o.level]));
  const pathSources: SourceView[] = ordered.map((o) => sourceById.get(o.id)).filter((s): s is SourceView => !!s);
  // A concept-anchored track still has a reading order: the canonical derived reading list
  // (lib/topics.derivedReading — the ONE flatten every view shares).
  const conceptSourceOrder: { source: SourceView; concept: string }[] = useMemo(
    () =>
      projection && activeSyl && isConceptAnchored(activeSyl)
        ? derivedReading(projection.asm, projection.graph, activeSyl.id, snapshot.sources)
        : [],
    [projection, activeSyl, snapshot.sources],
  );
  const derivedSourceView = pathView === 'sources' && conceptSourceOrder.length > 0;
  const activeSrc = srcId !== undefined ? sourceById.get(srcId) : undefined;
  const upNextId = pathSources.find((s) => !isConsumed(s))?.id;

  // Snippets/questions per source, and a per-source open-question count (asked-but-unanswered).
  const snippetsOf = (id: string) => snapshot.snippets.filter((s) => s.sourceId === id);
  const openQuestionsOf = (src: SourceView): number => {
    const snpIds = new Set(snippetsOf(src.id).map((s) => s.id));
    return questions.filter((q) => !q.answered && q.raisedBy.some((r) => (r.kind === 'source' && r.id === src.id) || (r.kind === 'snippet' && snpIds.has(r.id)))).length;
  };

  // Questions "in a concept" (owner request, 2026-07-20): tied directly (ABOUT) OR reached
  // through a source the concept explains (raised-by / answered-by) — most questions are
  // source-tied, not concept-tied, so the direct set alone is usually empty.
  const questionsOfConcept = (conceptName: string): QuestionView[] => {
    const srcIds = new Set(snapshot.sources.filter((s) => s.about.includes(conceptName)).map((s) => s.id));
    const snpIds = new Set(snapshot.snippets.filter((sn) => srcIds.has(sn.sourceId)).map((sn) => sn.id));
    const via = (r: { kind: string; id: string }) => (r.kind === 'source' && srcIds.has(r.id)) || (r.kind === 'snippet' && snpIds.has(r.id));
    return questions.filter((q) => q.about.includes(conceptName) || q.raisedBy.some(via) || q.answeredBy.some(via));
  };

  const insideSnippets = activeSrc ? snippetsOf(activeSrc.id) : [];
  const insideSnippetIds = new Set(insideSnippets.map((s) => s.id));
  const insideQuestions: QuestionView[] = activeSrc
    ? questions.filter((q) => q.raisedBy.some((r) => (r.kind === 'source' && r.id === activeSrc.id) || (r.kind === 'snippet' && insideSnippetIds.has(r.id))))
    : [];

  const relOfSnippet = (s: SnippetView): Rel => {
    if (focus?.kind !== 'question') return undefined;
    const q = questions.find((x) => x.id === focus.id);
    if (!q) return undefined;
    if (q.raisedBy.some((r) => r.kind === 'snippet' && r.id === s.id)) return 'raised';
    if (q.answeredBy.some((r) => r.kind === 'snippet' && r.id === s.id)) return 'answered';
    return undefined;
  };
  const relOfQuestion = (q: QuestionView): Rel => {
    if (focus?.kind !== 'snippet') return undefined;
    const s = snapshot.snippets.find((x) => x.id === focus.id);
    if (!s) return undefined;
    if (s.raises.some((r) => r.id === q.id)) return 'raised';
    if (q.answeredBy.some((r) => r.kind === 'snippet' && r.id === focus.id)) return 'answered';
    return undefined;
  };

  const selectSyl = (id: string) => {
    setSylId(id);
    setSrcId(undefined);
    setFocus(undefined);
  };
  const selectSrc = (id: string) => {
    setSrcId(id);
    setSelectedConcept(undefined);
    setFocus(undefined);
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await refresh();
      notify(ok);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const newTrack = (title: string) => run(() => client.importPayload({ version: 2, tracks: [{ title }] }), `Created track “${title}”`);
  const addConcept = (name: string) =>
    activeSyl &&
    run(async () => {
      const c = await resolveOrCreateConcept(client, projection?.asm.levels.flat() ?? [], name);
      await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: c.id });
    }, `Included “${trunc(name, 30)}” ✓`);
  const addSource = (v: Record<string, string>) => run(() => client.captureSource({ url: v.url, title: v.title || undefined, track: activeSyl!.title }), 'Added source');
  const askQuestion = (text: string) =>
    activeSrc?.url
      ? run(() => client.captureSource({ url: activeSrc.url, raises: [text] }), 'Added question')
      : notify('This source has no URL, so a question can’t be attached here — add it from a snippet instead.');
  const addSnippet = (text: string) => run(() => client.captureSnippet({ sourceId: activeSrc!.id, text }), 'Added snippet');
  // Reference both entities by their real ids via a direct INCLUDES edge — resolving the source
  // by title would derive src_<slug> and miss sources that carry an explicit id.
  const addExistingSource = (s: SourceView) => {
    // Join at the END of the reading order (owner bug report: a bare INCLUDES has no
    // predecessors, so it topo-sorted to the TOP). PRECEDES only when an order exists.
    const last = pathSources[pathSources.length - 1];
    const pair = activeSyl!.precedes.length > 0 && last !== undefined && last.id !== s.id ? { srcId: last.id, dstId: s.id } : undefined;
    return run(async () => {
      await client.link({ srcType: 'track', srcId: activeSyl!.id, type: 'INCLUDES', dstType: 'source', dstId: s.id });
      if (pair) await client.link({ srcType: 'source', srcId: pair.srcId, type: 'PRECEDES', dstType: 'source', dstId: pair.dstId, trackContextId: activeSyl!.id });
    }, `Added “${trunc(s.title, 30)}” to ${activeSyl!.title}`);
  };

  // Member editing (owner request, 2026-07-19 — the Library track editor's ×/↑↓, here):
  const removeMember = (sid: string) => {
    if (!activeSyl) return;
    const touching = activeSyl.precedes.filter((p) => p.srcId === sid || p.dstId === sid);
    void run(async () => {
      await client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: sid });
      for (const p of touching) await client.unlink({ srcId: p.srcId, type: 'PRECEDES', dstId: p.dstId, trackContextId: activeSyl.id });
    }, 'Removed from track — the source itself stays');
  };
  const moveMember = (sid: string, dir: -1 | 1) => {
    if (!activeSyl) return;
    const order = pathSources.map((x) => x.id);
    const i = order.indexOf(sid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const oldPairs = activeSyl.precedes;
    const newPairs = order.slice(0, -1).map((a, k) => ({ srcId: a, dstId: order[k + 1]! }));
    void run(async () => {
      for (const p of oldPairs) await client.unlink({ srcId: p.srcId, type: 'PRECEDES', dstId: p.dstId, trackContextId: activeSyl.id });
      // Bulk path on purpose: a chain rewrite is one batch (one validation), not N intents.
      await client.importPayload({
        version: 2,
        edges: newPairs.map((pp) => ({ srcType: 'source', srcId: pp.srcId, type: 'PRECEDES', dstType: 'source', dstId: pp.dstId, trackContextId: activeSyl.id })),
      });
    }, 'Reordered');
  };
  // Concept structure editing (feature/journey-concept-rails, 2026-07-20): the concept column
  // is a flat guarded-DFS ordering; drag a concept ONTO the track to include it, or (with a
  // relation selected) onto another concept to author that tie.
  const [draggingConcept, setDraggingConcept] = useState<string | undefined>();
  const [conceptRel, setConceptRel] = useState<'requires' | 'prereq-of'>('prereq-of');
  // Clicking a concept shows its questions (owner request, 2026-07-20) — a concept selection
  // that supersedes the source selection in the Questions column.
  const [selectedConcept, setSelectedConcept] = useState<{ id: string; name: string } | undefined>();
  // Clicking a concept ALSO expands its direct sources inline (owner request, 2026-07-20) —
  // the drill-down to source-tied questions.
  const [expandedConcepts, setExpandedConcepts] = useState<ReadonlySet<string>>(new Set());
  const toggleConceptExpand = (cid: string) => setExpandedConcepts((prev) => {
    const n = new Set(prev);
    n.has(cid) ? n.delete(cid) : n.add(cid);
    return n;
  });
  const includeConceptToTrack = (cid: string) => {
    if (!activeSyl) return;
    const c = conceptRows.find((r) => r.id === cid);
    if (c && conceptRows.some((r) => r.id === cid) && projection?.graph.edges.some((e) => e.type === 'INCLUDES' && e.srcId === activeSyl.id && e.dstId === cid)) {
      notify(`“${c.name}” is already in this track`);
      return;
    }
    void run(() => client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: cid }), 'Included in track ✓');
  };
  const includeConceptAt = (cid: string, where: 'root' | 'end') => {
    if (!activeSyl) return;
    const anchor = where === 'root' ? conceptRows[0]?.id : conceptRows[conceptRows.length - 1]?.id;
    void run(async () => {
      await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
      if (anchor && anchor !== cid) {
        const edge = where === 'root'
          ? { srcType: 'concept', srcId: cid, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: anchor }
          : { srcType: 'concept', srcId: anchor, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: cid };
        await client.link(edge);
      }
    }, where === 'root' ? 'Included as a root ✓' : 'Included at the end ✓');
  };
  const tieConcepts = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const name = (id: string) => conceptRows.find((r) => r.id === id)?.name ?? id;
    const rel = conceptRel;
    // "from [requires|prereq-of] to": requires → to precedes from; prereq-of → from precedes to.
    const edge =
      rel === 'requires'
        ? { srcType: 'concept', srcId: toId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: fromId }
        : { srcType: 'concept', srcId: fromId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: toId };
    void run(
      () => client.link(edge),
      rel === 'requires' ? `“${name(fromId)}” requires “${name(toId)}” ✓` : `“${name(fromId)}” is a prerequisite of “${name(toId)}” ✓`,
    );
  };

  // Edit mode + concept lens: drag ANY source onto a concept → tie it (explains).
  const tieSourceToConcept = (sid: string, c: { id: string; name: string }) => {
    const src = sourceById.get(sid);
    if (!src) return;
    if (src.about.includes(c.name)) {
      notify(`“${trunc(src.title, 30)}” is already tied to ${c.name}`);
      return;
    }
    void run(
      () => client.link({ srcType: 'source', srcId: sid, type: 'ABOUT', dstType: 'concept', dstId: c.id, tags: [{ name: 'explains' }] }),
      `“${trunc(src.title, 30)}” explains → ${c.name}`,
    );
  };
  // Untie a source from a concept (owner request, 2026-07-21): cuts the source→concept ABOUT
  // edge. In a concept-anchored track a source is only on the path BY VIRTUE of this tie, so ×
  // here is how you take it off the track; the source and the concept both stay in the library.
  const untieSourceFromConcept = (sid: string, conceptName: string) => {
    const src = sourceById.get(sid);
    if (!src) return;
    void run(
      () => client.unlink({ srcId: sid, type: 'ABOUT', dstId: conceptIdByName.get(conceptName) ?? conceptName }),
      `“${trunc(src.title, 30)}” untied from ${conceptName} — both stay in your library`,
    );
  };
  // Removing a SUB-topic (owner request, 2026-07-19): subs are in the family because a
  // prerequisite chain links them under an included main — × cuts those in-family
  // prerequisite edge(s). The concept itself and its other links stay; family concepts
  // whose only path ran through it drop out with it (the family is derived).
  const removeSubConcept = (cid: string, name: string) => {
    const familySet = new Set(conceptRows.map((r) => r.id));
    void run(async () => {
      const rels = await client.getRelations(cid);
      const parents = rels.relations.filter((r) => r.type === 'PREREQUISITE_OF' && r.direction === 'in' && familySet.has(r.otherId));
      for (const pr of parents) await client.unlink({ srcId: pr.otherId, type: 'PREREQUISITE_OF', dstId: cid });
    }, `“${name}” removed from this track's concept family — the concept itself stays`);
  };
  // Concept lens editing: × un-includes a topic; ↑/↓ author the prerequisite between
  // adjacent INCLUDED concepts (in this model, concept order IS prerequisites — the swap
  // asserts moved-first and retracts the opposing direct edge; cycles are rejected by
  // validation and surface as a toast).
  const removeConcept = (cid: string) => {
    if (!activeSyl) return;
    void run(() => client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: cid }), 'Concept un-included — it stays in your library');
  };

  const commitRename = async (kind: 'track' | 'source', id: string, cur: string, next: string) => {
    setRenaming(undefined);
    const title = next.trim();
    if (!title || title === cur) return;
    try {
      const r = await client.update(id, { title });
      await refresh();
      if (kind === 'track' && activeSyl?.id === id) setSylId(r.targetId); // follow the new slug id
      notify('Renamed ✓');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const renameInput = (kind: 'track' | 'source', id: string, cur: string) => (
    <div className="col-row on">
      <input
        className="row-edit"
        autoFocus
        defaultValue={cur}
        onBlur={(e) => void commitRename(kind, id, cur, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitRename(kind, id, cur, e.currentTarget.value);
          if (e.key === 'Escape') setRenaming(undefined);
        }}
      />
    </div>
  );
  const pencil = (kind: 'track' | 'source', id: string, label: string) =>
    edit ? (
      <span
        className="row-pencil"
        role="button"
        title={`rename ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          setRenaming({ kind, id });
        }}
      >
        <PencilSimple size={12} />
      </span>
    ) : null;

  // Drop placement (drag ordering): dropping ABOVE an item makes the dragged source its
  // prerequisite, BELOW an item its post-requisite, ONTO an item its co-requisite (same step) —
  // expressed as in-context PRECEDES edges plus INCLUDES membership when new. Writes are
  // ADDITIVE: edge retraction is the deferred gap (ROADMAP §2.3), so re-ordering an already
  // ordered item can contradict its old edges — the engine's per-context cycle validation
  // rejects that cleanly and the error surfaces as a toast.
  const placeSource = (dragId: string, at: { aboveId?: string; belowId?: string; coreqId?: string }) => {
    // A neighbour that IS the dragged item is fine (prec() skips self-edges); only a self-coreq
    // is meaningless.
    if (!activeSyl || at.coreqId === dragId) return;
    const edges: Record<string, string>[] = [];
    if (!activeSyl.sourceIds.includes(dragId)) edges.push({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'source', dstId: dragId });
    const prec = (a: string, b: string) =>
      a !== b && edges.push({ srcType: 'source', srcId: a, type: 'PRECEDES', dstType: 'source', dstId: b, trackContextId: activeSyl.id });
    if (at.coreqId) {
      // Same line: share the target's predecessors, so both land on the same topological step.
      for (const e of activeSyl.precedes) if (e.dstId === at.coreqId) prec(e.srcId, dragId);
    } else {
      if (at.aboveId) prec(at.aboveId, dragId);
      if (at.belowId) prec(dragId, at.belowId);
    }
    if (edges.length === 0) return;
    const title = sourceById.get(dragId)?.title ?? dragId;
    // Bulk path on purpose: placement writes membership + ordering pairs as one batch.
    void run(() => client.importPayload({ version: 2, edges }), `Placed “${trunc(title, 30)}”`);
  };
  const zoneOf = (e: React.DragEvent): 'above' | 'below' | 'coreq' => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = (e.clientY - r.top) / r.height;
    return t < 0.3 ? 'above' : t > 0.7 ? 'below' : 'coreq';
  };
  const dropAt = (dragId: string, idx: number, zone: 'above' | 'below' | 'coreq') => {
    const row = pathSources[idx]!;
    if (zone === 'coreq') placeSource(dragId, { coreqId: row.id });
    else if (zone === 'above') placeSource(dragId, { aboveId: pathSources[idx - 1]?.id, belowId: row.id });
    else placeSource(dragId, { aboveId: row.id, belowId: pathSources[idx + 1]?.id });
  };

  const otherSources = activeSyl ? snapshot.sources.filter((s) => !activeSyl.sourceIds.includes(s.id)) : [];
  const shownConcepts = edit ? concepts : concepts.filter(isFollowed);
  const donePct = (srcs: SourceView[]) => (srcs.length > 0 ? Math.round((srcs.filter(isConsumed).length / srcs.length) * 100) : 0);
  // A track's effective sources: its members, or (concept-anchored) the canonical derived
  // reading list — so % consumed counts what the reader actually reads (owner bug, 2026-07-20).
  const effectiveSources = (track: { id: string; sourceIds: string[] }): SourceView[] => {
    if (!isConceptAnchored(track)) return track.sourceIds.map((id) => sourceById.get(id)).filter((x): x is SourceView => !!x);
    if (!projection) return [];
    return derivedReading(projection.asm, projection.graph, track.id, snapshot.sources).map((e) => e.source);
  };
  const pct = activeSyl ? donePct(effectiveSources(activeSyl)) : 0;

  return (
    <div className={edit ? 'journey editing' : 'journey'}>
      <div className="journey-head">
        <h2>Learning Journey</h2>
        <button className={edit ? 'edit-toggle on' : 'edit-toggle'} onClick={() => setEdit((e) => !e)} title="edit mode: follow concepts, drag sources, add things">
          <PencilSimple size={14} /> {edit ? 'Editing' : 'Edit'}
        </button>
        <span className="tracked-concepts">
          {shownConcepts.length === 0 && <span className="hint">{edit ? 'No concepts yet.' : 'No concepts followed — toggle Edit to follow some.'}</span>}
          {shownConcepts.map((c) => (
            <button
              key={c.id}
              className={isFollowed(c) ? 'chip concept on' : 'chip concept'}
              disabled={!edit}
              title={edit ? 'toggle following' : 'following'}
              onClick={() => edit && toggleFollowed(c)}
            >
              {isFollowed(c) && <Star size={11} weight="fill" />} {c.name}
            </button>
          ))}
        </span>
        <span className="journey-legend">
          <span className="rel-swatch raised" /> raised · <span className="rel-swatch answered" /> answered
        </span>
      </div>

      <div className="journey-cols">
        {/* 1 — Tracks */}
        <div
          className="journey-col"
          onDragOver={(e) => {
            if (edit && draggingConcept) e.preventDefault();
          }}
          onDrop={(e) => {
            const cid = e.dataTransfer.getData('text/concept');
            if (cid) {
              e.preventDefault();
              includeConceptToTrack(cid);
            }
          }}
        >
          <div className="col-head">Tracks{edit && draggingConcept ? ' — drop to include' : ''}</div>
          {snapshot.tracks.map((s) => {
            const srcs = effectiveSources(s);
            const done = donePct(srcs);
            if (renaming?.kind === 'track' && renaming.id === s.id) {
              return <div key={s.id}>{renameInput('track', s.id, s.title)}</div>;
            }
            return (
              <button
                key={s.id}
                className={[s.id === activeSyl?.id ? 'on' : '', dropTarget?.id === s.id ? 'drop-coreq' : '', 'col-row'].filter(Boolean).join(' ')}
                onClick={() => selectSyl(s.id)}
                onDragOver={(e) => { if (edit && draggingConcept) { e.preventDefault(); e.stopPropagation(); if (dropTarget?.id !== s.id) setDropTarget({ id: s.id, zone: 'coreq' }); } }}
                onDragLeave={() => setDropTarget((t) => (t?.id === s.id ? undefined : t))}
                onDrop={(e) => {
                  const cid = e.dataTransfer.getData('text/concept');
                  if (!cid) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(undefined);
                  void run(() => client.link({ srcType: 'track', srcId: s.id, type: 'INCLUDES', dstType: 'concept', dstId: cid }), `Included in “${trunc(s.title, 30)}” ✓`);
                }}
              >
                <span className="col-row-title">
                  <span style={{ color: 'var(--k-track)' }}><Icon name="track" size={14} /></span> {s.title}
                  {pencil('track', s.id, 'track')}
                </span>
                <span className="col-row-meta">{srcs.length} {srcs.length === 1 ? 'source' : 'sources'} · {done}% consumed</span>
                <span className="track-progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={100}>
                  <span className="track-progress-fill" style={{ width: `${done}%` }} />
                </span>
                {s.tags.length > 0 && <span className="col-row-tags">{s.tags.map((t) => <TagChip key={t} tag={t} />)}</span>}
              </button>
            );
          })}
          {edit && <AddBox label="new track" fields={[{ key: 'title', placeholder: 'Track name' }]} onSubmit={(v) => newTrack(v.title ?? '')} />}
        </div>

        {/* 2 — Sources */}
        <div
          className="journey-col"
          onDragOver={(e) => {
            // Empty-space drops append to the PATH — a sources-view concept only. In the
            // concept lens the only drop targets are the concept rows themselves (tying).
            if (edit && pathView === 'sources') e.preventDefault();
          }}
          onDrop={(e) => {
            if (pathView !== 'sources') return;
            e.preventDefault();
            setDropTarget(undefined);
            const id = e.dataTransfer.getData('text/source');
            const s = snapshot.sources.find((x) => x.id === id);
            if (s && activeSyl && !activeSyl.sourceIds.includes(s.id)) void addExistingSource(s);
          }}
        >
          <div className="col-head journey-lens">
            <button className={pathView === 'sources' ? 'view-pill on' : 'view-pill'} onClick={() => setPathView('sources')}>
              By sources
            </button>
            <button className={pathView === 'concepts' ? 'view-pill concepts on' : 'view-pill concepts'} onClick={() => setPathView('concepts')}>
              By concept
            </button>
            {pathView === 'sources' && activeSyl && <span className="lens-pct">{pct}%</span>}
            {edit && draggingSrc && <span className="drop-hint"> — drop on a row: top ⅓ before · middle co-req · bottom ⅓ after</span>}
          </div>
          {pathView === 'concepts' && edit && draggingConcept && (
            <div
              className={dropTarget?.id === '__root__' ? 'concept-slot over' : 'concept-slot'}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dropTarget?.id !== '__root__') setDropTarget({ id: '__root__', zone: 'coreq' }); }}
              onDragLeave={() => setDropTarget((t) => (t?.id === '__root__' ? undefined : t))}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(undefined); const cid = e.dataTransfer.getData('text/concept'); if (cid) includeConceptAt(cid, 'root'); }}
            >
              ＋ drop here to add as a root (before everything)
            </div>
          )}
          {pathView === 'concepts' &&
            (conceptRows.length === 0 ? (
              <p className="hint">no concepts in this track's family yet{edit ? ' — drag one from Library, or tie concepts below' : ''}</p>
            ) : (
              conceptRows.map((c, i) => (
                <div key={c.id}>
                <button
                  className={[dropTarget?.id === c.id ? 'drop-coreq' : '', selectedConcept?.id === c.id ? 'on' : '', 'col-row'].filter(Boolean).join(' ')}
                  draggable={edit}
                  onClick={() => { setSelectedConcept({ id: c.id, name: c.name }); setSrcId(undefined); toggleConceptExpand(c.id); }}
                  title="show this concept's sources and questions"
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/concept', c.id);
                    window.setTimeout(() => setDraggingConcept(c.id), 0);
                  }}
                  onDragEnd={() => {
                    setDraggingConcept(undefined);
                    setDropTarget(undefined);
                  }}
                  onDragOver={(e) => {
                    if (!edit || !draggingConcept || draggingConcept === c.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (dropTarget?.id !== c.id) setDropTarget({ id: c.id, zone: 'coreq' });
                  }}
                  onDragLeave={() => setDropTarget((t) => (t?.id === c.id ? undefined : t))}
                  onDrop={(e) => {
                    if (!edit) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(undefined);
                    const from = e.dataTransfer.getData('text/concept');
                    const sid = e.dataTransfer.getData('text/source');
                    if (from) tieConcepts(from, c.id);
                    else if (sid) tieSourceToConcept(sid, c);
                  }}
                >
                  <span className="col-row-title">
                    <span className="path-num">{i + 1}</span>
                    <span className={c.main ? 'concept-glyph in-track' : 'concept-glyph'}><Icon name="concept" size={c.main ? 19 : 13} /></span>
                    <span className="row-title-text">{c.name}</span>
                    {(() => { const n = questionsOfConcept(c.name).length; return n > 0 ? (
                      <span className="open-questions" title={`${n} question${n === 1 ? '' : 's'} in this concept`}><SealQuestion size={13} weight="fill" /> {n}</span>
                    ) : null; })()}
                    {(taxLinks.get(c.id) ?? []).map((l) => {
                      const nm = conceptNameById.get(l.dstId);
                      return nm === undefined ? null : (
                        <TagChip key={`${l.tag}-${l.dstId}`} tag={l.tag} label={`${l.role === 'parent' ? '⊂' : '∈'} ${nm}`} title={`${relationWord('LINK', [l.tag])} ${nm}`} />
                      );
                    })}
                    <span className="path-x row-open" role="button" title="open in Library" onClick={(e) => { e.stopPropagation(); onOpenInLibrary(c.id); }}>
                      <Books size={13} />
                    </span>
                    {edit && (
                      <span className="row-tools" onClick={(e) => e.stopPropagation()}>
                        {c.main ? (
                          <span className="path-x x-del" role="button" title="un-include from track (concept stays)" onClick={(e) => { e.stopPropagation(); removeConcept(c.id); }}>×</span>
                        ) : (
                          <span className="path-x x-include" role="button" title="include this concept in the track" onClick={(e) => { e.stopPropagation(); includeConceptToTrack(c.id); }}>+ include</span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
                {expandedConcepts.has(c.id) && (() => {
                  const tied = snapshot.sources.filter((x) => x.about.includes(c.name));
                  return tied.length === 0 ? (
                    <p className="hint concept-sub-empty">no sources tied yet{edit ? ' — drag one onto the concept' : ''}</p>
                  ) : (
                    tied.map((src) => (
                      <button key={src.id} className={src.id === activeSrc?.id ? 'col-row concept-sub on' : 'col-row concept-sub'} onClick={() => selectSrc(src.id)}>
                        <span className="col-row-title">
                          <span style={{ color: 'var(--k-source)' }}><Icon name={sourceIcon(src.modality)} size={13} /></span>
                          <span className="row-title-text">{src.title}</span>
                          {openQuestionsOf(src) > 0 && (
                            <span className="open-questions" title={`${openQuestionsOf(src)} open question${openQuestionsOf(src) === 1 ? '' : 's'}`}>
                              <SealQuestion size={13} weight="fill" /> {openQuestionsOf(src)}
                            </span>
                          )}
                          {edit && (
                            <span className="row-tools" onClick={(e) => e.stopPropagation()}>
                              <span className="path-x x-del" role="button" title="untie from this concept (source stays in your library)" onClick={(e) => { e.stopPropagation(); untieSourceFromConcept(src.id, c.name); }}>×</span>
                            </span>
                          )}
                          <span className={src.consumed ? 'read-toggle row-read on' : 'read-toggle row-read'} role="button" title={src.consumed ? 'mark as unread' : 'mark as read'} onClick={(e) => { e.stopPropagation(); toggleConsumed(src); }}>
                            {src.consumed ? '✓ read' : '○ unread'}
                          </span>
                        </span>
                      </button>
                    ))
                  );
                })()}
                </div>
              ))
            ))}
          {pathView === 'concepts' && edit && draggingConcept && conceptRows.length > 0 && (
            <div
              className={dropTarget?.id === '__end__' ? 'concept-slot over' : 'concept-slot'}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dropTarget?.id !== '__end__') setDropTarget({ id: '__end__', zone: 'coreq' }); }}
              onDragLeave={() => setDropTarget((t) => (t?.id === '__end__' ? undefined : t))}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(undefined); const cid = e.dataTransfer.getData('text/concept'); if (cid) includeConceptAt(cid, 'end'); }}
            >
              ＋ drop here to add at the end (after everything)
            </div>
          )}
                    {!activeSyl && <p className="hint">Pick a track.</p>}
          {pathView === 'sources' && edit && draggingSrc && activeSyl && pathSources.length === 0 && (
            <div
              className={dropTarget?.id === '' ? 'drop-empty over' : 'drop-empty'}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropTarget({ id: '', zone: 'coreq' });
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropTarget(undefined);
                const id = e.dataTransfer.getData('text/source');
                const s = snapshot.sources.find((x) => x.id === id);
                if (s) void addExistingSource(s);
              }}
            >
              drop here to add to this track
            </div>
          )}
          {pathView === 'sources' && pathSources.length === 0 && conceptSourceOrder.length > 0 && (
            <>
              {conceptSourceOrder.map(({ source: s, concept }, i) => (
                <button key={s.id} className={s.id === activeSrc?.id ? 'col-row on' : 'col-row'} onClick={() => selectSrc(s.id)}>
                  <span className="col-row-title">
                    <span className="path-num">{i + 1}</span>
                    <span style={{ color: 'var(--k-source)' }}><Icon name={sourceIcon(s.modality)} size={14} /></span>
                    <span className="row-title-text">{s.title}</span>
                    {openQuestionsOf(s) > 0 && (
                      <span className="open-questions" title={`${openQuestionsOf(s)} open question${openQuestionsOf(s) === 1 ? '' : 's'}`}>
                        <SealQuestion size={14} weight="fill" /> {openQuestionsOf(s)}
                      </span>
                    )}
                    {edit && (
                      <span className="row-tools" onClick={(e) => e.stopPropagation()}>
                        <span className="path-x x-del" role="button" title="untie from this concept (source stays in your library)" onClick={(e) => { e.stopPropagation(); untieSourceFromConcept(s.id, concept); }}>×</span>
                      </span>
                    )}
                    <span
                      className={isConsumed(s) ? 'read-toggle row-read on' : 'read-toggle row-read'}
                      role="button"
                      title={isConsumed(s) ? 'mark as unread' : 'mark as read'}
                      onClick={(e) => { e.stopPropagation(); toggleConsumed(s); }}
                    >
                      {isConsumed(s) ? '✓ read' : '○ unread'}
                    </span>
                  </span>
                  <span className="col-row-meta"><span className="concept-under" title="the concept this source sits under">◇ {concept}</span></span>
                </button>
              ))}
            </>
          )}
          {pathView === 'sources' && pathSources.map((s, i) => {
            const open = openQuestionsOf(s);
            if (renaming?.kind === 'source' && renaming.id === s.id) {
              return <div key={s.id}>{renameInput('source', s.id, s.title)}</div>;
            }
            const dropCls = dropTarget?.id === s.id ? ` drop-${dropTarget.zone}` : '';
            return (
              <button
                key={s.id}
                className={(s.id === activeSrc?.id ? 'col-row on' : 'col-row') + dropCls}
                onClick={() => selectSrc(s.id)}
                draggable={edit}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/source', s.id);
                  // Defer past dragstart: re-rendering NOW moves the dragged element before the
                  // browser commits the drag, which cancels it.
                  window.setTimeout(() => setDraggingSrc(true), 0);
                }}
                onDragEnd={() => {
                  setDraggingSrc(false);
                  setDropTarget(undefined);
                }}
                onDragOver={(e) => {
                  if (!edit) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const zone = zoneOf(e);
                  if (dropTarget?.id !== s.id || dropTarget.zone !== zone) setDropTarget({ id: s.id, zone });
                }}
                onDragLeave={() => setDropTarget((t) => (t?.id === s.id ? undefined : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(undefined);
                  const id = e.dataTransfer.getData('text/source');
                  if (id) dropAt(id, i, zoneOf(e));
                }}
              >
                <span className="col-row-title">
                  <span className="path-num" title={pathSources.filter((x) => levelOf.get(x.id) === levelOf.get(s.id)).length > 1 ? 'co-requisites — same step' : `step ${(levelOf.get(s.id) ?? i) + 1}`}>
                    {(levelOf.get(s.id) ?? i) + 1}
                  </span>
                  <span style={{ color: 'var(--k-source)' }}><Icon name={sourceIcon(s.modality)} size={14} /></span>
                  <span className="row-title-text">{s.title}</span>
                  {pencil('source', s.id, 'source')}
                  {open > 0 && (
                    <span className="open-questions" title={`${open} open question${open === 1 ? '' : 's'}`}>
                      <SealQuestion size={14} weight="fill" /> {open}
                    </span>
                  )}
                  {s.id === upNextId && !isConsumed(s) && <Play size={12} weight="fill" style={{ color: 'var(--accent-soft)' }} />}
                  {edit && (
                    <span className="row-tools">
                      <span className="path-x" role="button" title="move up" onClick={(e) => { e.stopPropagation(); moveMember(s.id, -1); }}>↑</span>
                      <span className="path-x" role="button" title="move down" onClick={(e) => { e.stopPropagation(); moveMember(s.id, 1); }}>↓</span>
                      <span className="path-x x-del" role="button" title="remove from this track (the source itself stays)" onClick={(e) => { e.stopPropagation(); removeMember(s.id); }}>×</span>
                    </span>
                  )}
                  <span
                    className={isConsumed(s) ? 'read-toggle row-read on' : 'read-toggle row-read'}
                    role="button"
                    title={isConsumed(s) ? 'mark as unread' : 'mark as read'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleConsumed(s);
                    }}
                  >
                    {isConsumed(s) ? '✓ read' : '○ unread'}
                  </span>
                </span>
                <span className="col-row-meta">
                  <span>{s.modality}{s.estimatedDurationMins ? ` · ${s.estimatedDurationMins} min` : ''}</span>
                  {s.tags.includes('#seminal') && <TagChip tag="#seminal" label="seminal" />}
                </span>
              </button>
            );
          })}
          {edit && activeSyl && pathView === 'sources' && !derivedSourceView && (
            <AddBox
              label="add source"
              fields={[{ key: 'url', placeholder: 'https://… (URL)' }, { key: 'title', placeholder: 'Title (optional)' }]}
              onSubmit={addSource}
            />
          )}
          {edit && activeSyl && pathView === 'concepts' && (
            <AddBox label="add concept" fields={[{ key: 'name', placeholder: 'Concept name' }]} onSubmit={(v) => addConcept(v.name ?? '')} />
          )}
          {edit && activeSyl && derivedSourceView && (
            <p className="concept-rel-hint">this track is built from concepts — tie a source to a concept (in By concept) to add it here</p>
          )}
          {edit && activeSyl && pathView === 'sources' && !derivedSourceView && otherSources.length > 0 && (
            <div className="drag-palette" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(undefined); }}>
              <div className="col-head">Drag in existing sources</div>
              {otherSources.map((s) => (
                <div
                  key={s.id}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/source', s.id); window.setTimeout(() => setDraggingSrc(true), 0); }}
                  onDragEnd={() => { setDraggingSrc(false); setDropTarget(undefined); }}
                  title="drag into the track"
                >
                  <span style={{ color: 'var(--k-source)' }}><Icon name={sourceIcon(s.modality)} size={13} /></span> {trunc(s.title, 30)}
                </div>
              ))}
            </div>
          )}
          {edit && pathView === 'concepts' && (
            <div className="concept-rel-row">
              <span className="concept-rel-label">dragging a concept onto another makes it:</span>
              <select className="order-pick" value={conceptRel} onChange={(e) => setConceptRel(e.target.value as 'requires' | 'prereq-of')}>
                <option value="prereq-of">a prerequisite →</option>
                <option value="requires">a dependent ←</option>
              </select>
            </div>
          )}
          {edit && pathView === 'concepts' && (() => {
            const shown = new Set(conceptRows.map((c) => c.id));
            const others = (projection?.asm.levels.flat() ?? []).filter((c) => !shown.has(c.id));
            return others.length === 0 ? null : (
              <div className="drag-palette" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(undefined); }}>
                <div className="col-head">Other concepts — drag onto the track or a concept</div>
                {others.map((c) => (
                  <div
                    key={c.id}
                    className="palette-item"
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/concept', c.id); window.setTimeout(() => setDraggingConcept(c.id), 0); }}
                    onDragEnd={() => { setDraggingConcept(undefined); setDropTarget(undefined); }}
                    title="drag onto the Tracks column to include, or onto a concept to link"
                  >
                    <span style={{ color: 'var(--k-concept)' }}><Icon name="concept" size={13} /></span> {trunc(c.name, 30)}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* 3 — Questions (split Open / Answered) */}
        <div className="journey-col">
          <div className="col-head">Questions{selectedConcept ? ` · ${selectedConcept.name}` : ''}</div>
          {(() => {
            const qs = selectedConcept ? questionsOfConcept(selectedConcept.name) : activeSrc ? insideQuestions : [];
            if (!selectedConcept && !activeSrc) return <p className="hint">Pick a source or concept.</p>;
            if (qs.length === 0) return <p className="hint">{selectedConcept ? `No questions in “${selectedConcept.name}” yet.` : 'No questions yet.'}</p>;
            const open = qs.filter((q) => !q.answered);
            const answered = qs.filter((q) => q.answered);
            const row = (q: QuestionView) => {
              const rel = relOfQuestion(q);
              const fromSource = activeSrc !== undefined && q.raisedBy.some((r) => r.kind === 'source' && r.id === activeSrc.id);
              const cls = ['col-row', focus?.id === q.id ? 'on' : '', rel ? `rel-${rel}` : ''].filter(Boolean).join(' ');
              return (
                <button key={q.id} className={cls} onClick={() => setFocus({ kind: 'question', id: q.id })}>
                  <span className="col-row-title">
                    <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={13} /></span> {q.text}
                    {rel === 'raised' && <span className="rel-badge raised">raised by ↑</span>}
                    {rel === 'answered' && <span className="rel-badge answered">answered by ✓</span>}
                  </span>
                  {activeSrc && (
                    <span className="col-row-meta">
                      <span className={fromSource ? 'src-badge source' : 'src-badge snippet'}>{fromSource ? 'from source' : 'from a snippet'}</span>
                    </span>
                  )}
                </button>
              );
            };
            return (
              <>
                {open.length > 0 && <div className="q-section open">Open · {open.length}</div>}
                {open.map(row)}
                {answered.length > 0 && <div className="q-section answered">Answered · {answered.length}</div>}
                {answered.map(row)}
              </>
            );
          })()}
          {edit && activeSrc && <AddBox label="ask a question" fields={[{ key: 'text', placeholder: 'What do you want to know?' }]} onSubmit={(v) => askQuestion(v.text ?? '')} />}
        </div>

        {/* 4 — Snippets */}
        <div className="journey-col">
          <div className="col-head">Snippets</div>
          {!activeSrc && <p className="hint">Pick a source.</p>}
          {activeSrc && insideSnippets.length === 0 && <p className="hint">No snippets yet.</p>}
          {(() => {
            const focusedQ = focus?.kind === 'question';
            // When a question is focused, put the snippets that RELATE to it first.
            const ordered = focusedQ
              ? [...insideSnippets].sort((a, b) => (relOfSnippet(b) ? 1 : 0) - (relOfSnippet(a) ? 1 : 0))
              : insideSnippets;
            return ordered.map((s) => {
              const rel = relOfSnippet(s);
              const cls = ['col-row', focus?.id === s.id ? 'on' : '', rel ? `rel-${rel}` : ''].filter(Boolean).join(' ');
              return (
                <button key={s.id} className={cls} onClick={() => setFocus({ kind: 'snippet', id: s.id })} onDoubleClick={() => onOpenInLibrary(s.id)}>
                  <span className="col-row-title snippet-cell">
                    <span style={{ color: 'var(--k-snippet)' }}><Icon name="snippet" size={13} /></span>
                    <span className="snippet-cell-body"><SnippetText text={s.text} images="inline" /></span>
                    {rel === 'raised' && <span className="rel-badge raised">raises ↑</span>}
                    {rel === 'answered' && <span className="rel-badge answered">answers ✓</span>}
                  </span>
                  <span className="col-row-meta">
                    {s.sentiment && <SentimentTag token={s.sentiment} />}
                    {s.raises.length > 0 && <span> · raises {s.raises.length}</span>}
                  </span>
                </button>
              );
            });
          })()}
          {edit && activeSrc && <AddBox label="add snippet" fields={[{ key: 'text', placeholder: 'Paste a passage…', textarea: true }]} onSubmit={(v) => addSnippet(v.text ?? '')} />}
        </div>
      </div>
    </div>
  );
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);



function AddBox({
  label,
  fields,
  onSubmit,
}: {
  label: string;
  fields: { key: string; placeholder: string; textarea?: boolean }[];
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (fields.every((f) => !(values[f.key] ?? '').trim())) return;
    setBusy(true);
    try {
      await onSubmit(values);
      setValues({});
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <button className="add-box" onClick={() => setOpen(true)}>+ {label}</button>;
  return (
    <div className="add-box open">
      {fields.map((f) =>
        f.textarea ? (
          <textarea key={f.key} value={values[f.key] ?? ''} placeholder={f.placeholder} rows={3} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
        ) : (
          <input
            key={f.key}
            value={values[f.key] ?? ''}
            placeholder={f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        ),
      )}
      <div className="add-actions">
        <button className="action" disabled={busy} onClick={() => void submit()}>Add</button>
        <button className="link" disabled={busy} onClick={() => setOpen(false)}>cancel</button>
      </div>
    </div>
  );
}
