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
import { PencilSimple, Star } from '@phosphor-icons/react';
import { derivedReading, isConceptAnchored, trackViewModel } from '../../lib/topics';
import { resolveOrCreateConcept } from '../../lib/concepts';
import { createSource } from '../../lib/sources';
import type { AssembleResult, GraphEnvelope, QuestionView, Snapshot, SnippetView, SourceView } from '../../client/types';
import { Icon } from '../../components/Icon';
import { TagChip } from '../../components/TagChip';
import { useAction, useEngine } from '../../engine-context';
import { AddBox } from './AddBox';
import { QuestionsColumn } from './QuestionsColumn';
import { SnippetsColumn } from './SnippetsColumn';
import { trunc, type Rel } from './shared';
import { applyPlan, invert, isEmpty, merge, planAdd, type Plan } from '../../lib/reorder';
import { useJourneyState } from './useJourneyState';
import { TrackSection } from '../detail/TrackSection';
import { AddMemberRow } from '../detail/AddMemberRow';
import { AddConceptRow } from '../detail/AddConceptRow';

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
  onOpenInLibrary,
}: {
  /** The shared assemble+graph, fetched once per change by App. */
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  snapshot: Snapshot;
  questions: QuestionView[];
  concepts: Concept[];
  onOpenInLibrary: (id: string) => void;
}) {
  // The engine seam: no client/refresh/notify/pushUndo props (maintainability phase 1).
  const { client } = useEngine();
  const act = useAction();
  const {
    sylId, setSylId,
    srcId, setSrcId,
    focus, setFocus,
    edit, setEdit,
    renaming, setRenaming,
    followedOverride, setFollowedOverride,
    selectedConcept, setSelectedConcept,
  } = useJourneyState();
  const isConsumed = (s: SourceView) => s.consumed;
  const isFollowed = (c: Concept) => followedOverride[c.id] ?? c.tracked;
  const toggleConsumed = (s: SourceView) => {
    void act(
      async () => {
        if (s.consumed) {
          await client.unconsume(s.id);
          return { label: `mark “${trunc(s.title, 30)}” unread`, invert: () => client.consume(s.id) };
        }
        await client.consume(s.id);
        return { label: `mark “${trunc(s.title, 30)}” read`, invert: () => client.unconsume(s.id) };
      },
      s.consumed ? 'Marked as unread' : 'Marked as read ✓',
    );
  };
  const toggleFollowed = (c: Concept) => setFollowedOverride((o) => ({ ...o, [c.id]: !isFollowed(c) }));

  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));
  const activeSyl = snapshot.tracks.find((s) => s.id === sylId) ?? snapshot.tracks[0];
  const activeSylId = activeSyl?.id;

  const activeSrc = srcId !== undefined ? sourceById.get(srcId) : undefined;

  // Snippets/questions per source, and a per-source open-question count (asked-but-unanswered).
  const snippetsOf = (id: string) => snapshot.snippets.filter((s) => s.sourceId === id);
  const openQuestionsOf = (sid: string): number => {
    const snpIds = new Set(snippetsOf(sid).map((s) => s.id));
    return questions.filter((q) => !q.answered && q.raisedBy.some((r) => (r.kind === 'source' && r.id === sid) || (r.kind === 'snippet' && snpIds.has(r.id)))).length;
  };
  // The reader's position: the first unread source in the active track's reading order (spine,
  // then each concept group) — the ▸ "you are here" marker on that row.
  const readingVm = activeSyl && projection ? trackViewModel(projection.asm, projection.graph, activeSyl, snapshot.sources) : undefined;
  const upNextId = readingVm
    ? [...readingVm.spine.map((e) => e.source), ...readingVm.concepts.flatMap((g) => g.sources.map((e) => e.source))].find((s) => !s.consumed)?.id
    : undefined;
  const readingMeta = (sid: string) => ({ current: sid === upNextId, openQuestions: openQuestionsOf(sid), snippets: snippetsOf(sid).length });

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

  const newTrack = (title: string) =>
    act(async () => {
      await client.importPayload({ version: 2, tracks: [{ title }] });
      // The inverse resolves the id at UNDO time — no conditional, so the write can never
      // land without a way back.
      return {
        label: `create track “${trunc(title, 30)}”`,
        invert: async () => {
          const id = (await client.getSnapshot()).tracks.find((t) => t.title === title)?.id;
          if (id !== undefined) await client.remove(id);
        },
      };
    }, `Created track “${title}”`);
  // Author the question and tie a source-level RAISES edge straight to activeSrc (owner,
  // 2026-07-24). The old path captured-by-URL, which silently dropped the question for a url-less
  // source; linking to the id works whether or not the source has a URL. Mirrors
  // SnippetBody.createAndTie: re-assert an existing question, only remove it on undo if we made it.
  const askQuestion = (text: string) => {
    const value = text.trim();
    if (!activeSrc || !value) return;
    return act(async () => {
      let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
      let created = false;
      if (q === undefined) {
        await client.importPayload({ version: 2, questions: [{ text: value }] });
        q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
        created = true;
      }
      if (q === undefined) throw new Error('could not resolve the question');
      const qId = q.id;
      const edge = { srcType: 'source' as const, srcId: activeSrc.id, type: 'RAISES' as const, dstType: 'question' as const, dstId: qId };
      await client.link(edge);
      return {
        label: `ask “${trunc(value, 30)}”`,
        invert: async () => {
          await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
          if (created) await client.remove(qId);
        },
      };
    }, 'Added question');
  };
  const addSnippet = (text: string) =>
    act(async () => {
      const r = (await client.captureSnippet({ sourceId: activeSrc!.id, text })) as { snippetId?: string };
      const nid = r.snippetId;
      return {
        label: 'capture snippet',
        invert: async () => {
          if (nid !== undefined) await client.remove(nid);
        },
      };
    }, 'Added snippet');
  // Reference both entities by their real ids via a direct INCLUDES edge — resolving the source
  // by title would derive src_<slug> and miss sources that carry an explicit id.

  // Member editing (owner request, 2026-07-19 — the Library track editor's ×/↑↓, here):

  // Edit mode + concept lens: drag ANY source onto a concept → tie it (explains).
  // Untie a source from a concept (owner request, 2026-07-21): cuts the source→concept ABOUT
  // edge. In a concept-anchored track a source is only on the path BY VIRTUE of this tie, so ×
  // here is how you take it off the track; the source and the concept both stay in the library.
  // Removing a SUB-topic (owner request, 2026-07-19): subs are in the family because a
  // prerequisite chain links them under an included main — × cuts those in-family
  // prerequisite edge(s). The concept itself and its other links stay; family concepts
  // whose only path ran through it drop out with it (the family is derived).
  // Concept lens editing: × un-includes a topic; ↑/↓ author the prerequisite between
  // adjacent INCLUDED concepts (in this model, concept order IS prerequisites — the swap
  // asserts moved-first and retracts the opposing direct edge; cycles are rejected by
  // validation and surface as a toast).

  const commitRename = async (kind: 'track' | 'source', id: string, cur: string, next: string) => {
    setRenaming(undefined);
    const title = next.trim();
    if (!title || title === cur) return;
    await act(async () => {
      const r = await client.update(id, { title });
      if (kind === 'track' && activeSyl?.id === id) setSylId(r.targetId); // follow the new slug id
      return { label: `rename “${trunc(title, 30)}”`, invert: () => client.update(r.targetId, { title: cur }) };
    }, 'Renamed ✓');
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

  const shownConcepts = edit ? concepts : concepts.filter(isFollowed);
  const donePct = (srcs: SourceView[]) => (srcs.length > 0 ? Math.round((srcs.filter(isConsumed).length / srcs.length) * 100) : 0);
  // A track's effective sources: its members, or (concept-anchored) the canonical derived
  // reading list — so % consumed counts what the reader actually reads (owner bug, 2026-07-20).
  const effectiveSources = (track: { id: string; sourceIds: string[] }): SourceView[] => {
    if (!isConceptAnchored(track)) return track.sourceIds.map((id) => sourceById.get(id)).filter((x): x is SourceView => !!x);
    if (!projection) return [];
    return derivedReading(projection.asm, projection.graph, track.id, snapshot.sources).map((e) => e.source);
  };

  // The reading column adopts the Library track-list editing (owner, 2026-07-24): ONE unified
  // TrackSection — uncategorized on top, concepts below — instead of the by-sources/by-concept
  // lens toggle and its drag machinery. Membership is managed via the picker, like the Library.
  const trackForPlan = activeSyl
    ? { id: activeSyl.id, title: activeSyl.title, sourceIds: activeSyl.sourceIds, sourceLevels: activeSyl.sourceLevels ?? [], precedes: activeSyl.precedes ?? [] }
    : undefined;
  const addToTrack = async (sids: string[]) => {
    if (!trackForPlan) return;
    const plan = sids.reduce<Plan>((acc, sid) => merge(acc, planAdd(trackForPlan, sid)), { unlink: [], link: [] });
    if (isEmpty(plan)) return;
    const n = plan.link.length;
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `add to “${trackForPlan.title}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Added ${n === 1 ? 'a source' : `${n} sources`} to “${trackForPlan.title}”`);
  };
  // A new source from the picker's "＋ create": a name plus an OPTIONAL url — url given makes a
  // link, blank makes an offline source titled the name. Both idempotent, so an existing source
  // just gets added; undo un-mints only what we created.
  const createSourceInTrack = async (text: string, url?: string) => {
    if (!trackForPlan) return;
    const t = text.trim();
    await act(async () => {
      const { id: sid, created } = await createSource(client, { title: t, url });
      const plan = planAdd(trackForPlan, sid);
      await applyPlan(client, plan);
      return { label: `add “${t.slice(0, 40)}”`, invert: async () => { await applyPlan(client, invert(plan)); if (created) await client.remove(sid); } };
    }, `Added a source to “${trackForPlan.title}”`);
  };
  const trackConceptIds = new Set(
    (projection?.graph.edges ?? []).filter((e) => e.type === 'INCLUDES' && e.srcId === activeSylId && e.dstId.startsWith('cpt_')).map((e) => e.dstId),
  );
  const allConceptRefs = (projection?.asm.levels.flat() ?? []).map((c) => ({ id: c.id, name: c.name }));
  const includeConcepts = async (names: string[]) => {
    if (!activeSyl) return;
    const track = activeSyl;
    await act(async () => {
      const made: { id: string; name: string; created?: boolean }[] = [];
      for (const name of names) {
        const c = await resolveOrCreateConcept(client, allConceptRefs, name);
        await client.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'concept', dstId: c.id });
        made.push(c);
      }
      return {
        label: `include ${made.length === 1 ? `“${made[0]!.name.slice(0, 30)}”` : `${made.length} concepts`}`,
        invert: async () => {
          for (const c of made) {
            await client.unlink({ srcId: track.id, type: 'INCLUDES', dstId: c.id });
            if (c.created) await client.remove(c.id);
          }
        },
      };
    }, `Included ${names.length === 1 ? 'a concept' : `${names.length} concepts`} ✓`);
  };
  const unIncludeConcept = async (conceptId: string, name: string) => {
    if (!activeSyl) return;
    const track = activeSyl;
    const siblings = new Set([...trackConceptIds].filter((id) => id !== conceptId));
    await act(async () => {
      const rels = await client.getRelations(conceptId);
      const ties = rels.relations
        .filter((r) => r.type === 'PREREQUISITE_OF' && siblings.has(r.otherId))
        .map((r) => (r.direction === 'in' ? { srcId: r.otherId, dstId: conceptId } : { srcId: conceptId, dstId: r.otherId }));
      await client.unlink({ srcId: track.id, type: 'INCLUDES', dstId: conceptId });
      for (const t of ties) await client.unlink({ srcId: t.srcId, type: 'PREREQUISITE_OF', dstId: t.dstId });
      return {
        label: `un-include “${name.slice(0, 30)}”`,
        invert: async () => {
          await client.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'concept', dstId: conceptId });
          for (const t of ties) await client.link({ srcType: 'concept', srcId: t.srcId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: t.dstId });
        },
      };
    }, `Removed “${name}” from the track — the concept stays`);
  };
  // Clicking a row: a source selects it (drives the Questions/Snippets columns); a concept
  // heading selects the concept (its questions). Chips still open in Library via onOpenInLibrary.
  const readingReadState = (sid: string) => {
    const s = sourceById.get(sid);
    return s ? { consumed: s.consumed, onToggle: () => toggleConsumed(s) } : undefined;
  };
  const navigateInReading = (id: string) => {
    if (id.startsWith('cpt_')) {
      setSelectedConcept({ id, name: allConceptRefs.find((c) => c.id === id)?.name ?? '' });
      setSrcId(undefined);
    } else {
      selectSrc(id);
    }
  };

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
        <div className="journey-col">
          <div className="col-head">Tracks</div>
          {snapshot.tracks.map((s) => {
            const srcs = effectiveSources(s);
            const done = donePct(srcs);
            if (renaming?.kind === 'track' && renaming.id === s.id) {
              return <div key={s.id}>{renameInput('track', s.id, s.title)}</div>;
            }
            return (
              <button
                key={s.id}
                className={[s.id === activeSyl?.id ? 'on' : '', 'col-row'].filter(Boolean).join(' ')}
                onClick={() => selectSyl(s.id)}
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

        {/* 2 — Reading: the ONE track view (owner, 2026-07-24) — the same TrackSection the
            Library shows (uncategorized on top, concepts below), plus a read/unread chip and
            no modality text. No by-sources/by-concept lens toggle, no drag; membership is
            managed with the picker, exactly like the Library track page. */}
        <div className="journey-col reading-col">
          {!activeSyl ? (
            <p className="hint">Pick a track.</p>
          ) : (
            <TrackSection
              track={activeSyl}
              snapshot={snapshot}
              projection={projection}
              highlightId={activeSrc?.id}
              sourceReadState={readingReadState}
              sourceMeta={readingMeta}
              onNavigate={navigateInReading}
              {...(edit
                ? {
                    spineFooter: <AddMemberRow track={activeSyl} snapshot={snapshot} onAdd={(sids) => void addToTrack(sids)} onCreate={(t, u) => void createSourceInTrack(t, u)} />,
                    onPromote: (sids: string[]) => void addToTrack(sids),
                    onRemoveConcept: (id: string, name: string) => void unIncludeConcept(id, name),
                    conceptAdder: <AddConceptRow concepts={allConceptRefs} includedIds={trackConceptIds} onAdd={(names) => void includeConcepts(names)} />,
                  }
                : {})}
            />
          )}
        </div>
        <QuestionsColumn
          selectedConcept={selectedConcept}
          activeSrc={activeSrc}
          insideQuestions={insideQuestions}
          questionsOfConcept={questionsOfConcept}
          relOfQuestion={relOfQuestion}
          focus={focus}
          setFocus={setFocus}
          edit={edit}
          askQuestion={askQuestion}
        />

        <SnippetsColumn
          activeSrc={activeSrc}
          insideSnippets={insideSnippets}
          relOfSnippet={relOfSnippet}
          focus={focus}
          setFocus={setFocus}
          edit={edit}
          addSnippet={addSnippet}
          onOpenInLibrary={onOpenInLibrary}
        />
      </div>
    </div>
  );
}




