import { Icon } from '../../components/Icon';
import { useAction, useEngine } from '../../engine-context';
import { relationEdge } from '../../lib/concepts';
import { applyPlan, invert, isEmpty, planRemove, planUntieConcept } from '../../lib/reorder';
import { trackViewModel, type TrackViewModel } from '../../lib/topics';
import { useMemo, type ReactNode } from 'react';
import type { AssembleResult, GraphEnvelope, Snapshot } from '../../client/types';
import { RailTopics } from './RailTopics';
import { SourceRow } from './SourceRow';

export interface TrackSectionTrack {
  id: string;
  title: string;
  sourceIds: string[];
  sourceLevels?: string[][];
  precedes?: { srcId: string; dstId: string }[];
}

/** ONE rendering of a track's contents, wherever a track's contents are shown (owner,
 *  2026-07-23: "make sure that conditional logic is removed in other views").
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
  /** Present → each concept HEADING carries a × that removes the concept from the track (owner,
   *  2026-07-23: the included concepts live only here now, not as chips at the top). */
  onRemoveConcept?: (conceptId: string, name: string) => void;
  /** Slot under the Concepts heading — the "include a concept by name…" row. Its presence also
   *  keeps the Concepts section visible for a track with none yet, so the first can be added. */
  conceptAdder?: ReactNode;
  /** Present → each source row shows a read/unread chip (Journey's reading view — the one
   *  addition over the Library track list; owner, 2026-07-24). */
  sourceReadState?: (sourceId: string) => { consumed: boolean; onToggle: () => void } | undefined;
  /** Per-source current-position + open-question / snippet counts (owner, 2026-07-24). Shown in
   *  both the Library track view and Journey. */
  sourceMeta?: (sourceId: string) => { current?: boolean; openQuestions?: number; snippets?: number } | undefined;
  onNavigate: (id: string) => void;
}) {
  const { client } = useEngine();
  const act = useAction();
  const vm = useMemo(
    (): TrackViewModel => (projection ? trackViewModel(projection.asm, projection.graph, track, snapshot.sources) : { spine: [], concepts: [] }),
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

  /** The row × on any source row: leave the track entirely (owner, 2026-07-23). Cuts INCLUDES
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

  return (
    <>
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
      {/* "Sources (uncategorized)" — members not filed under a concept, any modality (not just
          reading). The count says the rest: at 0 the section is simply empty, no explanatory
          hint needed (owner, 2026-07-23). */}
      <div className="detail-section">Sources (uncategorized){projection !== undefined ? ` · ${vm.spine.length}` : ''}</div>
      {vm.spine.length > 0 && (
        <div className="rail-topics">
          {/* `spine` so a selector can tell the reading path from a concept group: both are
              rail-topics, and a SOURCE can share a CONCEPT's name. */}
          <div className="rail-topic spine">
            {vm.spine.map((e, i) => (
              <SourceRow
                key={e.source.id}
                source={e.source}
                ties={e.topics}
                marker={e.unordered ? '' : String(i + 1)}
                markerTitle={e.unordered ? 'unordered — nothing asserts a place for it yet' : undefined}
                highlight={e.source.id === highlightId}
                readState={sourceReadState?.(e.source.id)}
                current={sourceMeta?.(e.source.id)?.current}
                openQuestions={sourceMeta?.(e.source.id)?.openQuestions}
                snippets={sourceMeta?.(e.source.id)?.snippets}
                // An uncategorized source stays uncategorized after untying — the concept was
                // never included, so cutting the ABOUT edge only drops the chip (owner,
                // 2026-07-23). Same × as the concept section, for consistency.
                onUntie={(c) => void untie(e.source.id, c)}
                onRemove={canManage ? () => void removeMember(e.source.id) : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      )}
      {spineFooter && <div className="spine-footer-slot">{spineFooter}</div>}
      {(vm.concepts.length > 0 || conceptAdder) && (
        <>
          <div className="detail-section">Concepts</div>
          {/* The add-a-concept row sits directly under the heading (owner, 2026-07-23), and its
              presence keeps this section visible for a track with no concepts yet. The slot
              adds breathing room before the listing starts. */}
          {conceptAdder && <div className="concept-adder-slot">{conceptAdder}</div>}
          {/* The by-concept listing: the INCLUDED concept heads the cluster of sources under
              it and each row carries its own ties as chips — the structure is implied, not
              drawn (owner, 2026-07-23). Each heading carries the × that removes it. */}
          {vm.concepts.length > 0 && (
            <RailTopics
              topics={vm.concepts}
              onNavigate={onNavigate}
              highlightId={highlightId}
              onUntie={(sourceId, concept) => void untie(sourceId, concept)}
              onPromote={onPromote}
              onRemoveConcept={onRemoveConcept}
              onRemoveMember={canManage ? (sourceId) => void removeMember(sourceId) : undefined}
              sourceReadState={sourceReadState}
              sourceMeta={sourceMeta}
            />
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
