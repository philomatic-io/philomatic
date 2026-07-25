import { Icon, sourceIcon } from '../../components/Icon';
import type { SourceView } from '../../client/types';
import type { TopicGroup } from '../../lib/topics';
import { PickerBox } from './PickerBox';
import { SourceRow } from './SourceRow';

/** The compact topic listing (rail scale) — TrackBody's By-concept view AND the
 *  concept-track section a non-member source shows (owner request, 2026-07-20).
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
}: {
  topics: (TopicGroup & { emptyConcepts?: { id: string; name: string }[]; candidates?: SourceView[] })[];
  onNavigate: (id: string) => void;
  highlightId?: string;
  /** Present → each source row gets a read/unread chip (Journey reading view). */
  sourceReadState?: (sourceId: string) => { consumed: boolean; onToggle: () => void } | undefined;
  /** Per-source current-position + open-question / snippet counts (owner, 2026-07-24). */
  sourceMeta?: (sourceId: string) => { current?: boolean; openQuestions?: number; snippets?: number } | undefined;
  /** Present → tie chips get a × (see SourceRow). */
  onUntie?: (sourceId: string, concept: { id: string; name: string }) => void;
  /** Present → each concept heading gets a × that removes the concept from the track. */
  onRemoveConcept?: (conceptId: string, name: string) => void;
  /** Present → each source row gets a × that removes the SOURCE from the track (leaving its
   *  ABOUT edges, so it demotes to a candidate). Distinct from the tie chip's untie ×. */
  onRemoveMember?: (sourceId: string) => void;
  /** Present → the candidate pool is shown as a picker; promotes the checked sources into the
   *  track (owner, 2026-07-23). Absent → candidates are hidden entirely (source-page use). */
  onPromote?: (sourceIds: string[]) => void;
}) {
  return (
    <div className="rail-topics">
      {topics.map((g, i) => (
        <div key={g.conceptId} className="rail-topic">
          <div className="rail-topic-headrow">
            <button className="rail-topic-head" onClick={() => onNavigate(g.conceptId)}>
              <span className="rail-topic-n">{i + 1}</span>
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
            {/* Concepts in this hierarchy that nothing is tied to yet (owner, 2026-07-23).
                Without this an empty concept is invisible — no row, no chip, nowhere to drop
                a source onto. Dimmed, because the chip is a gap, not a fact. */}
            {(g.emptyConcepts ?? []).map((c) => (
              <button
                key={c.id}
                className="outline-cchip empty"
                title={`nothing is tied to “${c.name}” yet`}
                onClick={() => onNavigate(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
          {g.sources.map(({ source: src, ties }) => (
            <SourceRow
              key={src.id}
              source={src}
              ties={ties}
              highlight={src.id === highlightId}
              readState={sourceReadState?.(src.id)}
              current={sourceMeta?.(src.id)?.current}
              openQuestions={sourceMeta?.(src.id)?.openQuestions}
              snippets={sourceMeta?.(src.id)?.snippets}
              onUntie={onUntie ? (c) => onUntie(src.id, c) : undefined}
              onRemove={onRemoveMember ? () => onRemoveMember(src.id) : undefined}
              onNavigate={onNavigate}
            />
          ))}
          {onPromote && (g.candidates ?? []).length > 0 && (
            <Candidates candidates={g.candidates ?? []} onPromote={onPromote} />
          )}
        </div>
      ))}
    </div>
  );
}

/** The candidate pool for one concept: sources ABOUT it that aren't on the track. A dropdown
 *  box you pick from (owner, 2026-07-23) — the same purple picker as adding a source, so a
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
