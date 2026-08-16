import { Fragment } from 'react';
import { Icon, sourceIcon } from '../../components/Icon';
import type { SourceView } from '../../client/types';
import type { TopicGroup } from '../../lib/topics';
import { PickerBox } from './PickerBox';
import { SourceRow } from './SourceRow';
import { GapStrips, type GapDragCtx } from './GapStrips';

/** The compact topic listing (rail scale) — TrackBody's By-concept view AND the
 *  concept-track section a non-member source shows.
 *  `highlightId` marks one source row the way TrackPath marks the current member. */
export function RailTopics({
  topics,
  onNavigate,
  highlightId,
  onUntie,
  onPromote,
  onRemoveConcept,
  onRemoveMember,
  sourceReadState,
  sourceMeta,
  numberOf,
  dragCtx,
  orderBadgesOf,
}: {
  topics: (TopicGroup & { emptyConcepts?: { id: string; name: string }[]; candidates?: SourceView[] })[];
  onNavigate: (id: string) => void;
  highlightId?: string;
  /** Present → each source row gets a read/unread chip (Journey reading view). */
  sourceReadState?: (sourceId: string) => { consumed: boolean; onToggle: () => void } | undefined;
  /** sourceId → its place in the track's authored reading order (lib/order). A concept group's
   *  rows carried NO number before, so the same source read as numbered on
   *  the spine and unnumbered here — one track, two apparent orders. */
  numberOf?: Record<string, number>;
  /** Per-source current-position + open-question / snippet counts. */
  sourceMeta?: (sourceId: string) => { current?: boolean; openQuestions?: number; snippets?: number } | undefined;
  /** Present → tie chips get a × (see SourceRow). */
  onUntie?: (sourceId: string, concept: { id: string; name: string }) => void;
  /** Present → each concept heading gets a × that removes the concept from the track. */
  onRemoveConcept?: (conceptId: string, name: string) => void;
  /** Present → each source row gets a × that removes the SOURCE from the track (leaving its
   *  ABOUT edges, so it demotes to a candidate). Distinct from the tie chip's untie ×. */
  onRemoveMember?: (sourceId: string) => void;
  /** Present → the candidate pool is shown as a picker; promotes the checked sources into the
   *  track. Absent → candidates are hidden entirely (source-page use). */
  onPromote?: (sourceIds: string[]) => void;
  /** Present → EDIT MODE drag: rows drag as `{from:'group'}`, gap strips render
   *  between them while a drag is in flight, and row navigation is off. */
  dragCtx?: GapDragCtx;
  /** Present → the relation circles per row. */
  orderBadgesOf?: (sourceId: string) => { key: string; n?: number; title: string; onCut: () => void }[];
}) {
  return (
    <div className="rail-topics">
      {topics.map((g) => (
        <div key={g.conceptId} className="rail-topic">
          <div className="rail-topic-headrow">
            {/* No number: numbering means READING ORDER, which belongs to sources.
                A concept is an arrangement, not a step. */}
            <button
              className="rail-topic-head"
              onClick={() => onNavigate(g.conceptId)}
              onDragOver={dragCtx?.dragKind === 'source' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; e.currentTarget.classList.add('drop'); } : undefined}
              onDragLeave={dragCtx?.dragKind === 'source' ? (e) => e.currentTarget.classList.remove('drop') : undefined}
              onDrop={dragCtx?.dragKind === 'source' ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); dragCtx.drop({ kind: 'concept', id: g.conceptId }); } : undefined}
            >
              <Icon name="concept" size={14} />
              {g.conceptName}
            </button>
            {onRemoveConcept && (
              <button
                className="path-x concept-x"
                title="remove this concept from the track (it stays in your library)"
                onClick={() => onRemoveConcept(g.conceptId, g.conceptName)}
              >
                ×
              </button>
            )}
            {/* Concepts in this hierarchy that nothing is tied to yet.
                Without this an empty concept is invisible — no row, no chip, nowhere to drop
                a source onto. Dimmed, because the chip is a gap, not a fact. */}
            {(g.emptyConcepts ?? []).map((c) => (
              <button
                key={c.id}
                className="outline-cchip empty"
                title={`nothing is tied to “${c.name}” yet`}
                onClick={() => onNavigate(c.id)}
                onDragOver={dragCtx?.dragKind === 'source' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; e.currentTarget.classList.add('drop'); } : undefined}
                onDragLeave={dragCtx?.dragKind === 'source' ? (e) => e.currentTarget.classList.remove('drop') : undefined}
                onDrop={dragCtx?.dragKind === 'source' ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); dragCtx.drop({ kind: 'concept', id: c.id }); } : undefined}
              >
                {c.name}
              </button>
            ))}
          </div>
          {/* `about`, not `ties`: the chips state what the source IS ABOUT, including concepts
              this track has not included. `ties` stays the in-family list because it decides
              filing and membership. */}
          {g.sources.map(({ source: src, about }, idx) => (
            <Fragment key={src.id}>
              {dragCtx && (
                <GapStrips
                  {...(idx > 0 ? { aboveId: g.sources[idx - 1]!.source.id } : {})}
                  belowId={src.id}
                  ctx={dragCtx}
                />
              )}
              <SourceRow
                source={src}
                ties={about}
                marker={numberOf?.[src.id] !== undefined ? String(numberOf[src.id]) : ''}
                highlight={src.id === highlightId}
                readState={sourceReadState?.(src.id)}
                current={sourceMeta?.(src.id)?.current}
                openQuestions={sourceMeta?.(src.id)?.openQuestions}
                snippets={sourceMeta?.(src.id)?.snippets}
                onUntie={onUntie ? (c) => onUntie(src.id, c) : undefined}
                onRemove={onRemoveMember ? () => onRemoveMember(src.id) : undefined}
                onNavigate={onNavigate}
                drag={dragCtx ? { onStart: () => dragCtx.start(src.id, 'group'), onEnd: dragCtx.end } : undefined}
                chipDragStart={dragCtx ? (cid) => dragCtx.startConcept(cid) : undefined}
                dropTargets={dragCtx ? { kind: dragCtx.dragKind, onConcept: (cid) => dragCtx.drop({ kind: 'concept', id: cid }), onRow: () => dragCtx.drop({ kind: 'source-row', id: src.id }) } : undefined}
                orderBadges={orderBadgesOf?.(src.id)}
              />
            </Fragment>
          ))}
          {dragCtx && g.sources.length > 0 && (
            <GapStrips aboveId={g.sources[g.sources.length - 1]!.source.id} ctx={dragCtx} />
          )}
          {onPromote && (g.candidates ?? []).length > 0 && (
            <Candidates candidates={g.candidates ?? []} onPromote={onPromote} />
          )}
        </div>
      ))}
    </div>
  );
}

/** The candidate pool for one concept: sources ABOUT it that aren't on the track. A dropdown
 *  box you pick from — the same purple picker as adding a source, so a
 *  concept 500 sources explain stays one compact control (the fan-out warning made UI). */
function Candidates({ candidates, onPromote }: { candidates: SourceView[]; onPromote: (sourceIds: string[]) => void }) {
  return (
    <div className="rail-candidates">
      <PickerBox
        options={candidates.map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }))}
        placeholder="add more from this concept…"
        variant="candidate"
        onPick={onPromote}
      />
    </div>
  );
}
