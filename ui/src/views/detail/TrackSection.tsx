import { Icon } from '../../components/Icon';
import { useAction, useEngine } from '../../engine-context';
import { relationEdge } from '../../lib/concepts';
import { applyPlan, invert, isEmpty, planCutPrecedes, planRemove, planUntieConcept } from '../../lib/reorder';
import { resolveDrop, wouldCycle, type DragItem, type DropTarget } from '../../lib/drag';
import { trackViewModel, type TrackViewModel } from '../../lib/topics';
import { ConnectionAdd } from './Connections';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AssembleResult, GraphEnvelope, Snapshot } from '../../client/types';
import { RailTopics } from './RailTopics';
import { SourceRow } from './SourceRow';
import { PickerBox } from './PickerBox';
import { GapStrips, type GapDragCtx } from './GapStrips';
import { useEditMode } from './shared';
import { orderedSources, numberRows, placedSources } from '../../lib/order';

export interface TrackSectionTrack {
  id: string;
  title: string;
  sourceIds: string[];
  sourceLevels?: string[][];
  precedes?: { srcId: string; dstId: string }[];
}

/** ONE rendering of a track's contents, wherever a track's contents are shown ("make sure that conditional logic is removed in other views").
 *
 *  The reading spine, then the included concepts with whatever reading the spine hasn't
 *  claimed — the same two halves, in the same row component, with no branch on how the
 *  track happens to be anchored. A source-anchored track fills the top half; a
 *  concept-anchored one fills the bottom; a mixed one fills both. That is the ONLY
 *  difference between them, and it falls out of the data instead of an `if`.
 *
 *  On a TRACK's own page the header is dropped (the page title already names it); on a
 *  SOURCE's page it names the track and `highlightId` marks the row you came from. */
export function TrackSection({
  track,
  snapshot,
  projection,
  highlightId,
  showHeader = false,
  onRemove,
  spineFooter,
  onPromote,
  onRemoveConcept,
  conceptAdder,
  sourceReadState,
  sourceMeta,
  onNavigate,
}: {
  track: TrackSectionTrack;
  snapshot: Snapshot;
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  /** Marks one row — the source whose page this is. */
  highlightId?: string;
  showHeader?: boolean;
  /** Present → a × on the header: leave this track (the source itself stays). */
  onRemove?: () => void;
  /** Slot under the spine — the track editor's "add a source by title…" row. */
  spineFooter?: ReactNode;
  /** Present → the concept groups show their candidate pool, which adds the checked sources to
   *  the track. Only the track's OWN page passes this; a source page shows the track
   *  read-only. */
  onPromote?: (sourceIds: string[]) => void;
  /** Present → each concept HEADING carries a × that removes the concept from the track (the included concepts live only here now, not as chips at the top). */
  onRemoveConcept?: (conceptId: string, name: string) => void;
  /** Slot under the Concepts heading — the "include a concept by name…" row. Its presence also
   *  keeps the Concepts section visible for a track with none yet, so the first can be added. */
  conceptAdder?: ReactNode;
  /** Present → each source row shows a read/unread chip (Journey's reading view — the one
   *  addition over the Library track list; owner). */
  sourceReadState?: (sourceId: string) => { consumed: boolean; onToggle: () => void } | undefined;
  /** Per-source current-position + open-question / snippet counts. Shown in
   *  both the Library track view and Journey. */
  sourceMeta?: (sourceId: string) => { current?: boolean; openQuestions?: number; snippets?: number } | undefined;
  onNavigate: (id: string) => void;
}) {
  const { client } = useEngine();
  const act = useAction();
  const vm = useMemo(
    (): TrackViewModel => (projection ? trackViewModel(projection.asm, projection.graph, track, snapshot.sources) : { spine: [], concepts: [], blocks: [], numberOf: {} }),
    [projection, track, snapshot.sources],
  );
  /** The × inside a tie chip: this source is no longer about that concept. The edge's current
   *  role tag is read at click time so the inverse restores it faithfully; the plan adds the
   *  source to the track only when the cut takes its last tie here (lib/reorder). */
  const untie = async (sourceId: string, concept: { id: string; name: string }) => {
    await act(async () => {
      const rels = await client.getRelations(sourceId);
      const abouts = rels.relations.filter((r) => r.type === 'ABOUT' && r.direction === 'out');
      const tie = abouts.find((r) => r.otherId === concept.id);
      const flavour = tie === undefined ? 'EXPLAINS' : (relationEdge({ id: sourceId, kind: 'source' }, tie).tags[0]?.name ?? 'EXPLAINS');
      const family = new Set(vm.concepts.flatMap((g) => [g.conceptId, ...g.emptyConcepts.map((c) => c.id), ...g.sources.flatMap((e) => e.ties.map((t) => t.id))]));
      const others = abouts.map((r) => r.otherId).filter((id) => id !== concept.id && family.has(id));
      const plan = planUntieConcept({ ...track, precedes: track.precedes ?? [] }, sourceId, { id: concept.id, flavour }, [concept.id, ...others]);
      if (isEmpty(plan)) return { label: 'untie', invert: async () => {} };
      await applyPlan(client, plan);
      return { label: `untie “${concept.name.slice(0, 30)}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `No longer about “${concept.name}”`);
  };

  /** The row × on any source row: leave the track entirely. Cuts INCLUDES
   *  and the source's PRECEDES only — its ABOUT edges are global facts and stay, so a
   *  categorized source demotes to a candidate in its concept group rather than vanishing.
   *  Undoable as one action. Only the track's own editable page wires this (see `canManage`). */
  const removeMember = async (sourceId: string) => {
    const plan = planRemove({ ...track, precedes: track.precedes ?? [] }, sourceId);
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `remove from “${track.title.slice(0, 30)}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Removed from “${track.title}” — the source itself stays`);
  };
  // The editable track page passes onPromote (and conceptAdder); a source page shows the track
  // read-only, so the row × only appears where managing membership makes sense.
  const canManage = onPromote !== undefined;

  // ── DRAG: edit-mode only, on the track's own page ─────────────────────
  // The DOM's whole job is (DragItem, DropTarget); lib/drag resolves, lib/reorder plans, and
  // the write flows through act() like every other gesture — one undo per drop.
  const editing = useEditMode() && canManage;
  const [dragItem, setDragItem] = useState<DragItem | undefined>();
  const scrollParentOf = (el: Element | null): HTMLElement | null => {
    for (let n = el?.parentElement ?? null; n !== null; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if (o === 'auto' || o === 'scroll') return n;
    }
    return null;
  };
  // A newly added source lands in the unordered tail — often OFF-SCREEN (
  // adds sort by add time, which is right; the surprise was not seeing them land). Scroll the
  // first new row into view, and only when it is actually out of view (block: 'nearest').
  const prevIds = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const prev = prevIds.current;
    prevIds.current = new Set(track.sourceIds);
    if (prev === undefined || !canManage) return;
    const added = track.sourceIds.find((id) => !prev.has(id));
    if (added === undefined) return;
    requestAnimationFrame(() => {
      // 'nearest' scrolled the MINIMUM and parked the row flush at the viewport edge ("just barely out of view") — check visibility ourselves, then CENTER.
      const el = document.querySelector(`[data-source-id="${added}"]`);
      if (!(el instanceof HTMLElement)) return;
      const pane = scrollParentOf(el);
      if (pane === null) return;
      const pr = pane.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.top < pr.top + 8 || er.bottom > pr.bottom - 8) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.sourceIds.join(' ')]);
  const titleOf = (id: string): string => snapshot.sources.find((s) => s.id === id)?.title ?? id;
  const tieIdsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of vm.spine) m.set(e.source.id, e.topics.map((t) => t.id));
    for (const g of vm.concepts) for (const e of g.sources) m.set(e.source.id, [...(m.get(e.source.id) ?? []), ...e.ties.map((t) => t.id)]);
    return m;
  }, [vm]);
  // Long pages: dragging to a distant gap needs the page to MOVE. While
  // a drag is in flight, nearing the detail pane's top/bottom edge scrolls it — speed scales
  // with how deep into the 72px edge zone the cursor sits (some browsers do this natively for
  // inner scrollers, some don't; now all do).
  const scrollSentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dragItem === undefined) return;
    const pane = scrollParentOf(scrollSentinel.current);
    if (pane === null) return;
    // Firefox fires dragover only while the mouse MOVES — so
    // events just record the cursor, and an animation-frame loop does the scrolling: hold
    // still in the 96px edge zone and the page glides, speed scaling with depth.
    const EDGE = 96;
    let y: number | undefined;
    const onOver = (e: globalThis.DragEvent) => { y = e.clientY; };
    let raf = requestAnimationFrame(function tick() {
      if (y !== undefined) {
        const r = pane.getBoundingClientRect();
        if (y < r.top + EDGE) pane.scrollTop -= Math.ceil((r.top + EDGE - y) / 6);
        else if (y > r.bottom - EDGE) pane.scrollTop += Math.ceil((y - (r.bottom - EDGE)) / 6);
      }
      raf = requestAnimationFrame(tick);
    });
    window.addEventListener('dragover', onOver);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('dragover', onOver);
    };
  }, [dragItem]);

  const planFor = (item: DragItem, target: DropTarget) =>
    resolveDrop(item, target, {
      track: { ...track, precedes: track.precedes ?? [] },
      aboutFlavour: 'Explains',
      aboutOf: (sid) => tieIdsOf.get(sid) ?? [],
    });
  const dropOn = (target: DropTarget) => {
    const item = dragItem;
    setDragItem(undefined);
    if (item === undefined) return;
    const plan = planFor(item, target);
    if (isEmpty(plan)) return;
    const joined = plan.link.some((e) => e.type === 'INCLUDES') ? 'Added to the track — ' : '';
    // ABOUT is a GLOBAL fact (the standing rules doc) — the toast says so, since the gesture
    // happened inside one track but the write isn't track-scoped.
    const conceptNameOf = (id: string): string =>
      (projection?.graph.nodes.find((n) => n.id === id) as { label?: string } | undefined)?.label ?? id;
    const label =
      target.kind === 'gap'
        ? target.aboveId !== undefined && target.belowId !== undefined
          ? `${joined}reads between “${titleOf(target.aboveId)}” and “${titleOf(target.belowId)}” ✓`
          : target.aboveId !== undefined
            ? `${joined}reads after “${titleOf(target.aboveId)}” ✓`
            : `${joined}reads before “${titleOf(target.belowId!)}” ✓`
        : target.kind === 'concept'
          ? `“${titleOf(item.id)}” is now about “${conceptNameOf(target.id)}” ✓ — a global fact, everywhere it appears`
          : item.kind === 'concept'
            ? `“${titleOf(target.id)}” is now about “${conceptNameOf(item.id)}” ✓ — a global fact, everywhere it appears`
            : 'Tied ✓';
    void act(async () => {
      try {
        await applyPlan(client, plan);
      } catch {
        throw new Error('That ordering would loop back on itself — remove one of the source’s existing relations first (its circles in edit mode)');
      }
      return { label: 'arrange sources', invert: () => applyPlan(client, invert(plan)) };
    }, label);
  };
  /** The relation circles' ×: cut exactly one in-context PRECEDES edge, undoably.
   *  This is the toast's promised fix for a loop refusal, and the only remover of accidental
   *  or multi-relations — drops assert, badges retract. */
  const cutPrecedes = (srcId: string, dstId: string) => {
    const plan = planCutPrecedes({ ...track, precedes: track.precedes ?? [] }, srcId, dstId);
    if (isEmpty(plan)) return;
    // When the cut takes a source's LAST ordering it goes unordered and SINKS to the end of
    // its group (the standing sort rule) — say so, or the move reads as removal (it
    // report: "it removes the source from the track view").
    const remaining = (track.precedes ?? []).filter((p) => !(p.srcId === srcId && p.dstId === dstId));
    const sank = [srcId, dstId]
      .filter((id) => !remaining.some((p) => p.srcId === id || p.dstId === id))
      .map((id) => `“${titleOf(id)}”`);
    const note = sank.length > 0 ? ` — ${sank.join(' and ')} now unordered (sorts to the end of its group)` : '';
    void act(async () => {
      await applyPlan(client, plan);
      return { label: 'remove ordering', invert: () => applyPlan(client, invert(plan)) };
    }, `“${titleOf(dstId)}” no longer reads after “${titleOf(srcId)}” ✓${note}`);
  };
  /** One badge per DIRECT edge touching the row: `(n→)` = reads after step n,
   *  `(→n)` = reads before step n. Numbers are the page's own (`numberOf`, unique). */
  type OrderBadge = { key: string; n?: number; title: string; onCut: () => void };
  /** ONE mark per relation, on the PREDECESSOR only (both-ends badges
   *  doubled every fact) — `↓②` in the gutter under row 1's own circle reads "1 comes before
   *  2", aligned with the numbers it references. Deduped by partner (a library can hold the
   *  same pair twice from older write paths; one × cuts them all), lowest number first,
   *  stale partners (not on the track — no number) last. */
  const orderBadgesOf = (sid: string): OrderBadge[] => {
    const byPartner = new Map<string, OrderBadge>();
    for (const p of track.precedes ?? []) {
      if (p.srcId !== sid || p.dstId === sid || byPartner.has(p.dstId)) continue;
      const n = vm.numberOf[p.dstId];
      byPartner.set(p.dstId, { key: p.dstId, ...(n !== undefined ? { n } : {}), title: titleOf(p.dstId), onCut: () => cutPrecedes(p.srcId, p.dstId) });
    }
    return [...byPartner.values()].sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.title.localeCompare(b.title));
  };
  const dragCtx: GapDragCtx | undefined = editing
    ? {
        active: dragItem?.kind === 'source',
        dragKind: dragItem?.kind,
        start: (id, from) => setDragItem({ kind: 'source', id, from }),
        startConcept: (id) => setDragItem({ kind: 'concept', id }),
        end: () => setDragItem(undefined),
        drop: dropOn,
        titleOf,
        ...(dragItem?.kind === 'source' ? { dragTitle: titleOf(dragItem.id) } : {}),
        // Inert when the drop writes nothing OR any of its edges would loop — a strip that
        // can't do what it says goes light instead of bouncing off the engine's refusal.
        wouldWrite: (target) => {
          if (dragItem === undefined) return false;
          const plan = planFor(dragItem, target);
          if (isEmpty(plan)) return false;
          const pre = track.precedes ?? [];
          return !plan.link.some((e) => e.type === 'PRECEDES' && wouldCycle(pre, e.srcId, e.dstId));
        },
      }
    : undefined;

  /** File an uncategorized source under a concept: ONE gesture writes the
   *  ABOUT tie and, when the track does not hold that concept yet, the INCLUDES too — writing
   *  only the tie would leave the row exactly where it was and read as a bug (the concept must
   *  be a member for the row to move under it). Undone as one action, and the INCLUDES is only
   *  reverted when this gesture created it. */
  const fileUnder = async (sourceId: string, conceptIds: string[]) => {
    const g = projection?.graph;
    if (g === undefined || conceptIds.length === 0) return;
    const nameOf = (id: string): string => (g.nodes.find((n) => n.id === id) as { label?: string } | undefined)?.label ?? id;
    const included = new Set(g.edges.filter((x) => x.type === 'INCLUDES' && x.srcId === track.id).map((x) => x.dstId));
    await act(async () => {
      const undo: (() => Promise<unknown>)[] = [];
      for (const cid of conceptIds) {
        await client.link({ srcType: 'source', srcId: sourceId, type: 'ABOUT', dstType: 'concept', dstId: cid, tags: [{ name: 'Explains' }] });
        undo.push(() => client.unlink({ srcId: sourceId, type: 'ABOUT', dstId: cid }));
        if (!included.has(cid)) {
          await client.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'concept', dstId: cid });
          undo.push(() => client.unlink({ srcId: track.id, type: 'INCLUDES', dstId: cid }));
        }
      }
      return {
        label: `file under “${nameOf(conceptIds[0]!).slice(0, 30)}”`,
        invert: async () => {
          for (const u of undo.reverse()) await u();
        },
      };
    }, `Filed under ${conceptIds.map((c) => `“${nameOf(c)}”`).join(', ')} ✓`);
  };

  /** Every concept in the library this source is not already about — the filing picker's list. */
  const fileOptions = (tied: readonly { id: string }[]): { id: string; label: string; icon: 'concept' }[] => {
    const g = projection?.graph;
    if (g === undefined) return [];
    const already = new Set(tied.map((t) => t.id));
    return g.nodes
      .filter((n) => n.kind === 'concept' && !already.has(n.id))
      .map((n) => ({ id: n.id, label: (n as { label: string }).label, icon: 'concept' as const }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  // THE NUMBER IS THE PLACE IN THE SUGGESTED READING, and it comes from the view model that
  // arranged the page — not from a second walk here. This page computed its
  // own, so when the walk learned to respect the concept lattice the arrangement moved and the
  // numbers did not: the workbench went on opening `Axiom of Choice` at 1 while everything else
  // had been fixed. One derivation, handed down.
  const numberOf = vm.numberOf;
  const hasConcepts = vm.blocks.some((b) => b.kind === 'concept');

  return (
    <>
      <div ref={scrollSentinel} aria-hidden="true" />
      {showHeader && (
        <div className="detail-section track-section-head">
          <button className="link-btn track-link" onClick={() => onNavigate(track.id)} title="open the track">
            <span style={{ color: 'var(--k-track)' }}>
              <Icon name="track" size={13} />
            </span>{' '}
            {track.title}
          </button>
          {onRemove && (
            <button className="path-x" title="remove from this track (the source itself stays)" onClick={onRemove}>
              ×
            </button>
          )}
        </div>
      )}
      {/* The blocks IN THE ORDER THE TRACK READS — the unclassified
          runs and each concept group, each sorted by the author's reading order and placed where
          its numbers put it. `lib/topics` decides; this only draws what it hands over.

          ONE listing, not two sections: an uncategorized run renders exactly
          like a concept group — same font, same spacing, same slot under the Concepts heading —
          with a grey, iconless "Uncategorized" where the concept name would be. It used to be its
          own "Sources (uncategorized)" section, which made the same rows read as a different KIND
          of thing depending on whether the author had filed them yet. */}
      {hasConcepts && (
        <>
          <div className="detail-section">Concepts</div>
          {/* The add-a-concept row sits directly under the heading; the
              add-a-source row rides just below it (it lived at the very
              bottom, a scroll away from every other adder). */}
          {conceptAdder && (
            <div className="concept-adder-slot">
              <ConnectionAdd groupKind="concept" selfKind="track">{conceptAdder}</ConnectionAdd>
            </div>
          )}
          {spineFooter && (
            <div className="spine-footer-slot">
              <ConnectionAdd groupKind="source" selfKind="track">{spineFooter}</ConnectionAdd>
            </div>
          )}
        </>
      )}
      {vm.blocks.map((block, i) =>
        block.kind === 'spine' ? (
          (block.spine.length > 0 || !hasConcepts) && (
            <Fragment key={`spine-${i}`}>
              {/* A source-only track keeps its plain section header — with no concepts anywhere,
                  "Uncategorized" would name nothing (same call as the public page). */}
              {!hasConcepts && (
                <div className="detail-section">Sources (uncategorized){projection !== undefined ? ` · ${block.spine.length}` : ''}</div>
              )}
              {block.spine.length > 0 && (
                <div className="rail-topics">
                  {/* `spine` so a selector can tell an uncategorized run from a concept group:
                      both are rail-topics, and a SOURCE can share a CONCEPT's name. */}
                  {/* `uncat` only beside real concept groups — a source-only track marks
                      nothing, because with no filed rows there is no contrast to draw. */}
                  <div className={hasConcepts ? 'rail-topic spine uncat' : 'rail-topic spine'}>
                    {block.spine.map((e, idx) => (
                      <Fragment key={e.source.id}>
                      {/* The gap ABOVE this row: at the run's top a lone "reads before";
                          between rows, all three strips. */}
                      {dragCtx && (
                        <GapStrips
                          {...(idx > 0 ? { aboveId: block.spine[idx - 1]!.source.id } : {})}
                          belowId={e.source.id}
                          ctx={dragCtx}
                        />
                      )}
                      <SourceRow
                        source={e.source}
                        ties={e.topics}
                        marker={numberOf[e.source.id] !== undefined ? String(numberOf[e.source.id]) : ''}
                        highlight={e.source.id === highlightId}
                        readState={sourceReadState?.(e.source.id)}
                        current={sourceMeta?.(e.source.id)?.current}
                        openQuestions={sourceMeta?.(e.source.id)?.openQuestions}
                        snippets={sourceMeta?.(e.source.id)?.snippets}
                        // The chip × is a WRITE, so it follows canManage like every other
                        // membership gesture — reading a track offers none.
                        onUntie={canManage ? (c) => void untie(e.source.id, c) : undefined}
                        onRemove={canManage ? () => void removeMember(e.source.id) : undefined}
                        onNavigate={onNavigate}
                        drag={dragCtx ? { onStart: () => dragCtx.start(e.source.id, 'spine'), onEnd: dragCtx.end } : undefined}
                        chipDragStart={dragCtx ? (cid) => dragCtx.startConcept(cid) : undefined}
                        dropTargets={dragCtx ? { kind: dragCtx.dragKind, onConcept: (cid) => dragCtx.drop({ kind: 'concept', id: cid }), onRow: () => dragCtx.drop({ kind: 'source-row', id: e.source.id }) } : undefined}
                        orderBadges={editing ? orderBadgesOf(e.source.id) : undefined}
                      />
                      {canManage && (
                        <div className="uncat-file-slot">
                          <PickerBox
                            options={fileOptions(e.topics)}
                            placeholder="add concept to this source…"
                            variant="file"
                            onPick={(ids) => void fileUnder(e.source.id, ids)}
                          />
                        </div>
                      )}
                      </Fragment>
                    ))}
                    {/* The run's bottom gap: a lone "reads after the last row". */}
                    {dragCtx && block.spine.length > 0 && (
                      <GapStrips aboveId={block.spine[block.spine.length - 1]!.source.id} ctx={dragCtx} />
                    )}
                  </div>
                </div>
              )}
            </Fragment>
          )
        ) : (
          <Fragment key={block.group.conceptId}>
            {/* The by-concept listing: the INCLUDED concept heads the cluster of sources under
                it and each row carries its own ties as chips — the structure is implied, not
                drawn. Each heading carries the × that removes it. */}
            <RailTopics
              topics={[block.group]}
              onNavigate={onNavigate}
              highlightId={highlightId}
              onUntie={canManage ? (sourceId, concept) => void untie(sourceId, concept) : undefined}
              onPromote={onPromote}
              onRemoveConcept={onRemoveConcept}
              onRemoveMember={canManage ? (sourceId) => void removeMember(sourceId) : undefined}
              sourceReadState={sourceReadState}
              sourceMeta={sourceMeta}
              numberOf={numberOf}
              dragCtx={dragCtx}
              orderBadgesOf={editing ? orderBadgesOf : undefined}
            />
          </Fragment>
        ),
      )}
      {/* A track with no concepts yet still offers both adders, in the same order. */}
      {!hasConcepts && (
        <>
          {conceptAdder && (
            <>
              <div className="detail-section">Concepts</div>
              <div className="concept-adder-slot">
                <ConnectionAdd groupKind="concept" selfKind="track">{conceptAdder}</ConnectionAdd>
              </div>
            </>
          )}
          {spineFooter && (
            <div className="spine-footer-slot">
              <ConnectionAdd groupKind="source" selfKind="track">{spineFooter}</ConnectionAdd>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Does this source show up anywhere in the track's view — on the path, or under one of its
 *  concepts? The one test for "list this track on that source's page", replacing the old
 *  member-vs-concept-family split. */
export function trackShows(
  projection: { asm: AssembleResult; graph: GraphEnvelope },
  track: TrackSectionTrack,
  allSources: { id: string }[],
  sourceId: string,
): boolean {
  const vm = trackViewModel(projection.asm, projection.graph, track, allSources as never);
  return vm.spine.some((e) => e.source.id === sourceId) || vm.concepts.some((g) => g.sources.some((e) => e.source.id === sourceId));
}
