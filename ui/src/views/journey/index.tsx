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
import { derivedReading, isConceptAnchored, orderedConcepts, orderedConceptsForSources } from '../../lib/topics';
import { resolveOrCreateConcept } from '../../lib/concepts';
import { SnippetText } from '../../lib/snippet-md';
import type { AssembleResult, GraphEnvelope, QuestionView, Snapshot, SnippetView, SourceView } from '../../client/types';
import { Icon, sourceIcon } from '../../components/Icon';
import { orderedSources } from '../../lib/order';
import { SentimentTag } from '../../lib/sentiment';
import { TagChip } from '../../components/TagChip';
import { useAction, useEngine } from '../../engine-context';
import { AddBox } from './AddBox';
import { QuestionsColumn } from './QuestionsColumn';
import { SnippetsColumn } from './SnippetsColumn';
import { trunc, type Rel } from './shared';
import { applyPlan, invert, isEmpty, planAdd, planMove, planPlace, planRemove } from '../../lib/reorder';
import { useJourneyState } from './useJourneyState';
import { hierarchyLinks } from '../../lib/ranks';
import { relationWord } from '../../lib/relations';

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
  const { client, refresh, notify } = useEngine();
  const act = useAction();
  const {
    sylId, setSylId,
    srcId, setSrcId,
    focus, setFocus,
    edit, setEdit,
    draggingSrc, setDraggingSrc,
    dropTarget, setDropTarget,
    renaming, setRenaming,
    followedOverride, setFollowedOverride,
    pathView, setPathView,
    draggingConcept, setDraggingConcept,
    conceptRel, setConceptRel,
    selectedConcept, setSelectedConcept,
    expandedConcepts, toggleConceptExpand,
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
  const unorderedIds = new Set(ordered.filter((o) => o.unordered).map((o) => o.id));
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
  const addConcept = (name: string) =>
    activeSyl &&
    act(async () => {
      const c = await resolveOrCreateConcept(client, projection?.asm.levels.flat() ?? [], name);
      await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: c.id });
      return {
        label: `include “${trunc(name, 30)}”`,
        invert: async () => {
          await client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: c.id });
          if (c.created) await client.remove(c.id); // the gesture minted it — un-mint too
        },
      };
    }, `Included “${trunc(name, 30)}” ✓`);
  const addSource = (v: Record<string, string>) =>
    act(async () => {
      const r = (await client.captureSource({ url: v.url, title: v.title || undefined, track: activeSyl!.title })) as { sourceId?: string };
      const sid = r.sourceId;
      // Conservative inverse: take it back OFF the track (the source stays in the library —
      // capture is idempotent, so it may have existed before this gesture).
      return {
        label: 'add source to track',
        invert: async () => {
          if (sid !== undefined) await client.unlink({ srcId: activeSyl!.id, type: 'INCLUDES', dstId: sid });
        },
      };
    }, 'Added source');
  const askQuestion = (text: string) =>
    activeSrc?.url
      ? act(async () => {
          await client.captureSource({ url: activeSrc.url, raises: [text] });
          return {
            label: `ask “${trunc(text, 30)}”`,
            invert: async () => {
              const q = (await client.getQuestions()).questions.find((x) => x.text === text);
              if (q) await client.remove(q.id);
            },
          };
        }, 'Added question')
      : notify('This source has no URL, so a question can’t be attached here — add it from a snippet instead.');
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
  const addExistingSource = (s: SourceView) =>
    // MEMBERSHIP ONLY (owner ruling 2026-07-22) — planned in lib/reorder like every other
    // ordering gesture, so Journey and Detail can't drift apart on the rules again.
    act(async () => {
      const plan = planAdd(activeSyl!, s.id);
      await applyPlan(client, plan);
      return { label: `add “${trunc(s.title, 30)}” to track`, invert: () => applyPlan(client, invert(plan)) };
    }, `Added “${trunc(s.title, 30)}” to ${activeSyl!.title}`);

  // Member editing (owner request, 2026-07-19 — the Library track editor's ×/↑↓, here):
  const removeMember = (sid: string) => {
    if (!activeSyl) return;
    const plan = planRemove(activeSyl, sid);
    void act(async () => {
      await applyPlan(client, plan);
      return { label: 'remove from track', invert: () => applyPlan(client, invert(plan)) };
    }, 'Removed from track — the source itself stays');
  };
  const moveMember = (sid: string, dir: -1 | 1) => {
    if (!activeSyl) return;
    const plan = planMove(activeSyl, sid, dir);
    if (isEmpty(plan)) return;
    void act(async () => {
      await applyPlan(client, plan);
      return { label: 'reorder', invert: () => applyPlan(client, invert(plan)) };
    }, 'Reordered');
  };
  const includeConceptToTrack = (cid: string) => {
    if (!activeSyl) return;
    const c = conceptRows.find((r) => r.id === cid);
    if (c && conceptRows.some((r) => r.id === cid) && projection?.graph.edges.some((e) => e.type === 'INCLUDES' && e.srcId === activeSyl.id && e.dstId === cid)) {
      notify(`“${c.name}” is already in this track`);
      return;
    }
    void act(async () => {
      await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
      return { label: 'include concept', invert: () => client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: cid }) };
    }, 'Included in track ✓');
  };
  const includeConceptAt = (cid: string, where: 'root' | 'end') => {
    if (!activeSyl) return;
    const anchor = where === 'root' ? conceptRows[0]?.id : conceptRows[conceptRows.length - 1]?.id;
    void act(async () => {
      await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
      const edge =
        anchor && anchor !== cid
          ? where === 'root'
            ? { srcId: cid, dstId: anchor }
            : { srcId: anchor, dstId: cid }
          : undefined;
      if (edge) await client.link({ srcType: 'concept', srcId: edge.srcId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: edge.dstId });
      return {
        label: 'include concept',
        invert: async () => {
          if (edge) await client.unlink({ srcId: edge.srcId, type: 'PREREQUISITE_OF', dstId: edge.dstId });
          await client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: cid });
        },
      };
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
    void act(
      async () => {
        await client.link(edge);
        return { label: 'tie concepts', invert: () => client.unlink({ srcId: edge.srcId, type: 'PREREQUISITE_OF', dstId: edge.dstId }) };
      },
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
    void act(
      async () => {
        await client.link({ srcType: 'source', srcId: sid, type: 'ABOUT', dstType: 'concept', dstId: c.id, tags: [{ name: 'explains' }] });
        return { label: `tie “${trunc(src.title, 30)}” → ${c.name}`, invert: () => client.unlink({ srcId: sid, type: 'ABOUT', dstId: c.id }) };
      },
      `“${trunc(src.title, 30)}” explains → ${c.name}`,
    );
  };
  // Untie a source from a concept (owner request, 2026-07-21): cuts the source→concept ABOUT
  // edge. In a concept-anchored track a source is only on the path BY VIRTUE of this tie, so ×
  // here is how you take it off the track; the source and the concept both stay in the library.
  const untieSourceFromConcept = (sid: string, conceptName: string) => {
    const src = sourceById.get(sid);
    if (!src) return;
    const cid = conceptIdByName.get(conceptName) ?? conceptName;
    void act(
      async () => {
        await client.unlink({ srcId: sid, type: 'ABOUT', dstId: cid });
        // Re-tie restores the UI's own creation shape (#explains); other tags the edge may
        // have carried are the assertion-layer gap (ROADMAP §2.1).
        return {
          label: `untie “${trunc(src.title, 30)}”`,
          invert: () => client.link({ srcType: 'source', srcId: sid, type: 'ABOUT', dstType: 'concept', dstId: cid, tags: [{ name: 'explains' }] }),
        };
      },
      `“${trunc(src.title, 30)}” untied from ${conceptName} — both stay in your library`,
    );
  };
  // Removing a SUB-topic (owner request, 2026-07-19): subs are in the family because a
  // prerequisite chain links them under an included main — × cuts those in-family
  // prerequisite edge(s). The concept itself and its other links stay; family concepts
  // whose only path ran through it drop out with it (the family is derived).
  const removeSubConcept = (cid: string, name: string) => {
    const familySet = new Set(conceptRows.map((r) => r.id));
    void act(async () => {
      const rels = await client.getRelations(cid);
      const parents = rels.relations.filter((r) => r.type === 'PREREQUISITE_OF' && r.direction === 'in' && familySet.has(r.otherId));
      for (const pr of parents) await client.unlink({ srcId: pr.otherId, type: 'PREREQUISITE_OF', dstId: cid });
      return {
        label: `remove “${trunc(name, 30)}” from family`,
        invert: async () => {
          for (const pr of parents) await client.link({ srcType: 'concept', srcId: pr.otherId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: cid });
        },
      };
    }, `“${name}” removed from this track's concept family — the concept itself stays`);
  };
  // Concept lens editing: × un-includes a topic; ↑/↓ author the prerequisite between
  // adjacent INCLUDED concepts (in this model, concept order IS prerequisites — the swap
  // asserts moved-first and retracts the opposing direct edge; cycles are rejected by
  // validation and surface as a toast).
  const removeConcept = (cid: string) => {
    if (!activeSyl) return;
    const familySet = new Set(conceptRows.map((r) => r.id));
    void act(async () => {
      // × means "off this track" — so cut the in-family PREREQUISITE_OF ties too (owner bug
      // 2026-07-22: un-including alone left the concept in the FAMILY via the positioning
      // edge that including it wrote, so it reappeared as a child of the last concept).
      const rels = await client.getRelations(cid);
      const ties = rels.relations
        .filter((r) => r.type === 'PREREQUISITE_OF' && familySet.has(r.otherId))
        .map((r) => (r.direction === 'in' ? { srcId: r.otherId, dstId: cid } : { srcId: cid, dstId: r.otherId }));
      await client.unlink({ srcId: activeSyl.id, type: 'INCLUDES', dstId: cid });
      for (const t of ties) await client.unlink({ srcId: t.srcId, type: 'PREREQUISITE_OF', dstId: t.dstId });
      return {
        label: 'un-include concept',
        invert: async () => {
          await client.link({ srcType: 'track', srcId: activeSyl.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
          for (const t of ties) await client.link({ srcType: 'concept', srcId: t.srcId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: t.dstId });
        },
      };
    }, 'Removed from this track — the concept stays in your library');
  };

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
  const placeSource = (dragId: string, at: { aboveId?: string; belowId?: string; coreqId?: string }) => {
    if (!activeSyl) return;
    const plan = planPlace(activeSyl, dragId, at);
    if (isEmpty(plan)) return;
    const title = sourceById.get(dragId)?.title ?? dragId;
    void act(async () => {
      await applyPlan(client, plan);
      return { label: `place “${trunc(title, 30)}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Placed “${trunc(title, 30)}”`);
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
                  void act(async () => {
                    await client.link({ srcType: 'track', srcId: s.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
                    return { label: 'include concept', invert: () => client.unlink({ srcId: s.id, type: 'INCLUDES', dstId: cid }) };
                  }, `Included in “${trunc(s.title, 30)}” ✓`);
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
                  <span className="path-num" title={unorderedIds.has(s.id) ? 'unordered — drag into the path to give it a place' : pathSources.filter((x) => levelOf.get(x.id) === levelOf.get(s.id)).length > 1 ? 'co-requisites — same step' : `step ${(levelOf.get(s.id) ?? i) + 1}`}>
                    {unorderedIds.has(s.id) ? '·' : (levelOf.get(s.id) ?? i) + 1}
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




