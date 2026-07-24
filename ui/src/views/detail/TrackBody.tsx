import { useAction, useEngine } from '../../engine-context';
import { resolveOrCreateConcept } from '../../lib/concepts';
import { shortAuthors } from '../../lib/items';
import { derivedReading, isConceptAnchored, topicsForTrack } from '../../lib/topics';
import { PencilSimple } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { AssembleResult, GraphEnvelope, Relation, Snapshot } from '../../client/types';
import { AddConceptRow } from './AddConceptRow';
import { RailTopics } from './RailTopics';
import { TagEditor } from './TagEditor';
import { AddMemberRow, TrackPath } from './TrackPath';

/** The track detail body (feedback round 3): its goal, editable tags, concept members as
 *  chips, and its ordered source list — the same reading-path view a source shows, now for the
 *  track itself (replacing the wall of "includes →" connection rows). */
export function TrackBody({
  track,
  snapshot,
  conceptMembers,
  projection,
  onNavigate,
  onRemoveMember,
  onMoveMember,
  onAddMember,
}: {
  track: { id: string; title: string; goal?: string; tags: string[]; sourceIds: string[]; sourceLevels?: string[][]; published?: { at: number; license: string } };
  snapshot: Snapshot;
  conceptMembers: Relation[];
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  onNavigate: (id: string) => void;
  onRemoveMember: (sid: string) => void;
  onMoveMember: (sid: string, dir: -1 | 1) => void;
  onAddMember: (sid: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  // Source vs concept view (experiment, 2026-07-19): the track's own shape picks the
  // default lens — whichever membership is larger (concepts win ties: a concepts-only
  // track is the model where this view matters) — and a toggle reaches the other.
  const autoView: 'sources' | 'concepts' = conceptMembers.length >= track.sourceIds.length && conceptMembers.length > 0 ? 'concepts' : 'sources';
  const [view, setViewState] = useState<'sources' | 'concepts'>(autoView);
  // conceptMembers arrive async (relations fetch) — keep auto-picking until the user chooses.
  const [manual, setManual] = useState(false);
  useEffect(() => setManual(false), [track.id]);
  useEffect(() => {
    if (!manual) setViewState(autoView);
  }, [track.id, autoView, manual]);
  const setView = (v: 'sources' | 'concepts') => {
    setManual(true);
    setViewState(v);
  };
  const topics = useMemo(
    () => (projection && view === 'concepts' ? topicsForTrack(projection.asm, projection.graph, track, snapshot.sources) : []),
    [projection, view, track, snapshot.sources],
  );
  const asm = projection?.asm;
  const includedConceptIds = new Set(conceptMembers.map((c) => c.otherId));
  // Concept-anchored track: its By-sources view is the canonical derived reading list
  // (lib/topics.derivedReading — the same order Journey shows, by construction).
  const derived = useMemo(
    () => (projection && isConceptAnchored(track) ? derivedReading(projection.asm, projection.graph, track.id, snapshot.sources) : []),
    [projection, track, snapshot.sources],
  );
  const allConceptRefs = (asm?.levels.flat() ?? []).map((c) => ({ id: c.id, name: c.name }));
  const unIncludeConcept = async (conceptId: string, name: string) => {
    // Mirror of Journey's × (owner bug 2026-07-22): also cut PREREQUISITE_OF ties to the
    // track's other included concepts, or the positioning edge that Journey's drop-at-end
    // writes would keep this concept in the family as a child of its anchor.
    const siblings = new Set(conceptMembers.map((c) => c.otherId).filter((id) => id !== conceptId));
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
  const includeConcept = async (name: string) => {
    try {
      const c = await resolveOrCreateConcept(client, allConceptRefs, name);
      await client.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'concept', dstId: c.id });
      pushUndo(`include “${c.name.slice(0, 30)}”`, async () => {
        await client.unlink({ srcId: track.id, type: 'INCLUDES', dstId: c.id });
        if (c.created) await client.remove(c.id); // the gesture minted it — un-mint too
      });
      await refresh();
      notify(`Included “${c.name}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
          className="detail-field"
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
      ) : (
        <p className="detail-field title-row" style={{ marginTop: '-0.2rem' }}>
          <span className={track.goal ? '' : 'hint'} style={{ padding: 0 }}>{track.goal || 'what is this track for?'}</span>
          <button className="title-pencil" title="edit goal" onClick={() => setEditingGoal(true)}>
            <PencilSimple size={13} />
          </button>
        </p>
      )}
      <TagEditor id={track.id} tags={track.tags} />

      <div className="detail-section">Concepts covered</div>
      {conceptMembers.length > 0 && (
        <div className="detail-tags">
          {conceptMembers.map((c) => (
            <span key={c.otherId} className="chip concept removable">
              <button className="chip-label" onClick={() => onNavigate(c.otherId)}>{c.otherLabel}</button>
              <button className="chip-x" title="remove from this track (the concept stays in your library)" onClick={() => void unIncludeConcept(c.otherId, c.otherLabel)}>×</button>
            </span>
          ))}
        </div>
      )}
      <AddConceptRow concepts={allConceptRefs} includedIds={includedConceptIds} onAdd={(name) => void includeConcept(name)} />
      <div className="detail-section view-toggle-row">
        <button className={view === 'sources' ? 'view-pill on' : 'view-pill'} onClick={() => setView('sources')}>
          By sources{track.sourceIds.length > 0 ? ` (${track.sourceIds.length})` : ''}
        </button>
        <button className={view === 'concepts' ? 'view-pill concepts on' : 'view-pill concepts'} onClick={() => setView('concepts')}>
          By concept{conceptMembers.length > 0 ? ` (${conceptMembers.length})` : ''}
        </button>
      </div>
      {view === 'sources' ? (
        isConceptAnchored(track) && derived.length > 0 ? (
          <ol className="track-path">
            {derived.map(({ source: src }, i) => (
              <li key={src.id} className="path-row">
                <button className="path-source" onClick={() => onNavigate(src.id)}>
                  <span className="path-num">{i + 1}</span>
                  <span className="path-texts">
                    <span className="connection-target">{src.title}</span>
                    {src.author !== undefined && <span className="path-author">{shortAuthors(src.author)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
        <>
          <TrackPath track={track} snapshot={snapshot} sectionLabel="Sources" showHeader={false} onNavigate={onNavigate} onRemoveMember={onRemoveMember} onMoveMember={onMoveMember} />
          <AddMemberRow track={track} snapshot={snapshot} onAdd={onAddMember} />
        </>
        )
      ) : topics.length === 0 ? (
        <p className="hint" style={{ padding: '0.3rem 0' }}>{!asm ? 'loading…' : isConceptAnchored(track) ? 'no concepts included yet' : 'no member sources tied to concepts yet'}</p>
      ) : (
        <RailTopics topics={topics} onNavigate={onNavigate} />
      )}

    </>
  );
}
