import { useAction, useEngine } from '../../engine-context';
import { resolveOrCreateConcept } from '../../lib/concepts';
import { PencilSimple } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { AssembleResult, GraphEnvelope, Relation, Snapshot } from '../../client/types';
import { AddConceptRow } from './AddConceptRow';
import { includeConceptsInTrack, unIncludeConceptFromTrack } from '../../lib/ties';
import { useEditMode } from './shared';
import { TrackSection } from './TrackSection';
import { TagEditor } from './TagEditor';
import { AddMemberRow } from './AddMemberRow';

/** The track detail body (feedback round 3): its goal, editable tags, concept members as
 *  chips, and its ordered source list — the same reading-path view a source shows, now for the
 *  track itself (replacing the wall of "includes →" connection rows). */
export function TrackBody({
  track,
  snapshot,
  conceptMembers,
  projection,
  sourceMeta,
  onNavigate,
  onAddMember,
  onCreateMember,
}: {
  track: { id: string; title: string; goal?: string; tags: string[]; sourceIds: string[]; sourceLevels?: string[][]; published?: { at: number; license: string } };
  snapshot: Snapshot;
  conceptMembers: Relation[];
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  /** Per-source open-question / snippet counts — shown on each source row. */
  sourceMeta?: (sourceId: string) => { current?: boolean; openQuestions?: number; snippets?: number } | undefined;
  onNavigate: (id: string) => void;
  /** Add one or more sources to the track — one undoable batch. */
  onAddMember: (sids: string[]) => void;
  /** Create a new (offline, title-only) source and add it — the picker's "＋ create …". */
  onCreateMember: (title: string, url?: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const editMode = useEditMode();
  const asm = projection?.asm;
  const includedConceptIds = new Set(conceptMembers.map((c) => c.otherId));
  const allConceptRefs = (asm?.levels.flat() ?? []).map((c) => ({ id: c.id, name: c.name }));
  const unIncludeConcept = async (conceptId: string, name: string) => {
    await act(
      () => unIncludeConceptFromTrack(client, track.id, { id: conceptId, name }, conceptMembers.map((c) => c.otherId)),
      `Removed “${name}” from the track — the concept stays`,
    );
  };
  const includeConcepts = async (names: string[]) => {
    // ONE gesture implementation (lib/ties) shared with Journey and the concept rail — and
    // through act(), so the batch is one typed-inverse undo (this site once hand-rolled
    // pushUndo; the one-write-path invariant).
    await act(() => includeConceptsInTrack(client, track.id, names, allConceptRefs), `Included ${names.length === 1 ? 'a concept' : `${names.length} concepts`} ✓`);
  };

  // Goal (the track's description) is a plain updatable field — pencil-toggled like the title.
  const [editingGoal, setEditingGoal] = useState(false);
  const [goal, setGoal] = useState(track.goal ?? '');
  useEffect(() => setGoal(track.goal ?? ''), [track.id, track.goal]);
  const saveGoal = async () => {
    setEditingGoal(false);
    if (goal.trim() === (track.goal ?? '')) return;
    try {
      const before = track.goal ?? '';
      await client.update(track.id, { goal: goal.trim() });
      pushUndo('edit goal', () => client.update(track.id, { goal: before }));
      await refresh();
      notify('Saved ✓');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {editingGoal ? (
        <textarea
          className="goal-edit"
          style={{ marginTop: '-0.2rem' }}
          autoFocus
          value={goal}
          rows={2}
          placeholder="what is this track for?"
          onChange={(e) => setGoal(e.target.value)}
          onBlur={() => void saveGoal()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void saveGoal();
            if (e.key === 'Escape') {
              setGoal(track.goal ?? '');
              setEditingGoal(false);
            }
          }}
        />
      ) : track.goal !== undefined && track.goal !== '' ? (
        <p className="detail-field title-row" style={{ marginTop: '-0.2rem' }}>
          <span
            className={editMode ? 'editable-text' : undefined}
            style={{ padding: 0 }}
            title={editMode ? 'click to edit the goal' : undefined}
            onClick={() => editMode && setEditingGoal(true)}
          >
            {track.goal}
          </span>
          <button className="title-pencil" title="edit goal" onClick={() => setEditingGoal(true)}>
            <PencilSimple size={13} />
          </button>
        </p>
      ) : editMode ? (
        /* No goal yet: the prompt to write one is an AUTHORING affordance, so it appears only
           while editing. A reader was being shown "what is this track for?" as though it were
           the answer. */
        <p className="detail-field title-row" style={{ marginTop: '-0.2rem' }}>
          <span className="hint editable-text" style={{ padding: 0 }} title="click to edit the goal" onClick={() => setEditingGoal(true)}>
            what is this track for?
          </span>
          <button className="title-pencil" title="edit goal" onClick={() => setEditingGoal(true)}>
            <PencilSimple size={13} />
          </button>
        </p>
      ) : null}
      <TagEditor id={track.id} tags={track.tags} />

      {/* ONE track view — no by-sources/by-concept toggle and no
          branch on how the track is anchored. The included concepts are NOT repeated as chips
          up here: they are the numbered headings in the Concepts section,
          where each carries the × that removes it and the add row sits under the heading. */}
      <TrackSection
        track={track}
        snapshot={snapshot}
        projection={projection}
        {...(editMode
          ? {
              // Membership is MANAGED only in edit mode: the pickers, the
              // chip ×s and the row ×s all follow this one conditional, exactly as the Journey
              // already gated them on its Editing toggle. Reading a track offers no writes.
              spineFooter: <AddMemberRow track={track} snapshot={snapshot} onAdd={onAddMember} onCreate={onCreateMember} />,
              onPromote: onAddMember,
              onRemoveConcept: (id: string, name: string) => void unIncludeConcept(id, name),
              conceptAdder: <AddConceptRow concepts={allConceptRefs} includedIds={includedConceptIds} onAdd={(names) => void includeConcepts(names)} />,
            }
          : {})}
        sourceMeta={sourceMeta}
        onNavigate={onNavigate}
      />

    </>
  );
}
