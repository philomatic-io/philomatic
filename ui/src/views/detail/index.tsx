/**
 * The detail rail — kind dispatch. Each body lives in its own module (maintainability
 * phase 2a): this file decides WHICH body renders and supplies the shared header.
 */
import { Icon } from '../../components/Icon';
import { ModalityPicker } from '../../components/ModalityPicker';
import { useAction, useEngine } from '../../engine-context';
import { applyPlan, invert, isEmpty, planAdd, planMove, planRemove } from '../../lib/reorder';
import { SnippetText } from '../../lib/snippet-md';
import { buildTopics, isConceptAnchored, nextMoves } from '../../lib/topics';
import { Code, CopySimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { AssembleResult, GraphEnvelope, QuestionView, Relation, Snapshot } from '../../client/types';
import type { Item } from '../../lib/items';
import { ConceptAnchors } from './ConceptAnchors';
import { Connections } from './Connections';
import { NextReading } from './NextReading';
import { QuestionBody } from './QuestionBody';
import { RailTopics } from './RailTopics';
import { ReadingOrder } from './ReadingOrder';
import { SnippetBody } from './SnippetBody';
import { SourceBody } from './SourceBody';
import { TitleEditor } from './TitleEditor';
import { TrackBody } from './TrackBody';
import { TrackPath } from './TrackPath';
import { TrackPublishing } from './TrackPublishing';
import { PATH_EDGES } from './shared';

// Next reading deprecated 2026-07-21 (owner: revisit later) — flip to re-enable the section.
export const SHOW_NEXT_READING: boolean = false;

export function Detail({
  projection,
  item,
  snapshot,
  questions,
  concepts,
  onNavigate,
  onViewInMap,
}: {
  item: Item;
  snapshot: Snapshot;
  questions: QuestionView[];
  /** The shared assemble+graph, fetched once per change by App. */
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  /** The selected item was just created — open its title editor for naming. */
  /** The concept list (assemble projection) — the anchor editor's picker. */
  concepts: { id: string; name: string; tracked: boolean }[];
  onNavigate: (id: string) => void;
  onViewInMap: (id: string) => void;
}) {
  const { client, refresh, notify, pushUndo, epoch } = useEngine();
  const act = useAction();
  const [relations, setRelations] = useState<Relation[]>([]);

  useEffect(() => {
    let stale = false;
    client.getRelations(item.id).then((r) => !stale && setRelations(r.relations)).catch(() => !stale && setRelations([]));
    return () => {
      stale = true;
    };
  }, [client, item.id, epoch]);

  // Raw-source toggle → EDITOR (owner rulings, 2026-07-18): the </> view shows the exact
  // stored markdown, editable. Saving is edit-by-supersession (text hashes into the id): the
  // engine mints the new snippet, migrates edges + annotations, retracts the old — so the UI
  // navigates to the new id and the undo stack gets remove-new + restore-old.
  const [rawMd, setRawMd] = useState(false);
  const [rawText, setRawText] = useState(item.title);
  const [rawBusy, setRawBusy] = useState(false);
  useEffect(() => {
    setRawMd(false);
    setRawText(item.title);
  }, [item.id, item.title]);
  const saveRaw = async () => {
    const next = rawText.trim();
    if (next === '' || next === item.title || rawBusy) return;
    setRawBusy(true);
    try {
      const prevText = item.title;
      const r = await client.update(item.id, { text: next });
      await refresh();
      if (r.targetId === item.id) {
        // Formatting-only change: same normalized identity, updated in place — no superseded
        // version exists to restore, so undo re-edits the text back instead.
        pushUndo('edit snippet text', async () => {
          await client.update(item.id, { text: prevText });
        });
        notify('Snippet updated in place — formatting-only change, same identity');
      } else {
        pushUndo('edit snippet text', async () => {
          await client.remove(r.targetId);
          await client.restore(item.id);
        });
        notify('Snippet updated — superseded; the old version is in Removed');
        onNavigate(r.targetId);
      }
      setRawMd(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setRawBusy(false);
    }
  };

  const remove = async () => {
    try {
      await client.remove(item.id);
      await refresh();
      pushUndo(`remove “${item.title.slice(0, 30)}”`, () => client.restore(item.id));
      notify(`Removed “${item.title.length > 40 ? `${item.title.slice(0, 40)}…` : item.title}”`, item.id);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // Remove a source FROM a track (owner request, 2026-07-18): un-assert the INCLUDES plus any
  // in-context PRECEDES pairs touching it (ordering must not keep ghosts). The source itself
  // stays in the library; Ctrl+Z re-asserts the whole membership.
  const removeFromTrack = async (tr: { id: string; title: string; sourceIds: string[]; precedes: { srcId: string; dstId: string }[] }, sid: string) => {
    const plan = planRemove(tr, sid);
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `remove from “${tr.title}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Removed from “${tr.title}” — the source itself stays`);
  };
  const reorderInTrack = async (
    tr: { id: string; title: string; sourceLevels: string[][]; sourceIds: string[]; precedes: { srcId: string; dstId: string }[] },
    sid: string,
    dir: -1 | 1,
  ) => {
    const plan = planMove(tr, sid, dir);
    if (isEmpty(plan)) return;
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `reorder “${tr.title}”`, invert: () => applyPlan(client, invert(plan)) };
    }, 'Reordered');
  };
  const addToTrack = async (
    tr: { id: string; title: string; sourceIds: string[]; sourceLevels: string[][]; precedes: { srcId: string; dstId: string }[] },
    sid: string,
  ) => {
    const plan = planAdd(tr, sid);
    if (isEmpty(plan)) return;
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `add to “${tr.title}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Added to “${tr.title}”`);
  };

  // Copy a track (owner request, 2026-07-18): a NEW track with the same members and reading
  // order under "<title> (copy)" — the local twin of forking, for reworking without touching
  // the original. Ctrl+Z removes the copy.
  const copyTrack = async () => {
    const tr = item.kind === 'track' ? snapshot.tracks.find((t) => t.id === item.id) : undefined;
    if (!tr) return;
    const titles = new Set(snapshot.tracks.map((t) => t.title));
    let title = `${tr.title} - Copy`;
    for (let n = 2; titles.has(title); n += 1) title = `${tr.title} - Copy ${n}`;
    try {
      // Two steps: mint the track, then assert membership as CANONICAL edges with the REAL
      // source ids — title-based includeSources would re-derive slug ids that don't match
      // URL-derived sources (the dangling-reference failure the owner hit).
      await client.importPayload({
        version: 2,
        tracks: [{ title, ...(tr.goal !== undefined ? { goal: tr.goal } : {}) }],
      });
      const made = (await client.getSnapshot()).tracks.find((t) => t.title === title);
      if (made) {
        await client.importPayload({
          version: 2,
          edges: [
            ...tr.sourceIds.map((sid) => ({
              srcType: 'track', srcId: made.id, type: 'INCLUDES', dstType: 'source', dstId: sid,
            })),
            ...tr.precedes.map((pr) => ({
              srcType: 'source', srcId: pr.srcId, type: 'PRECEDES', dstType: 'source', dstId: pr.dstId, trackContextId: made.id,
            })),
          ],
        });
      }
      await refresh();
      if (made) {
        pushUndo(`copy track “${tr.title}”`, () => client.remove(made.id));
        onNavigate(made.id);
      }
      notify(`Copied as “${title}”`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const source = item.kind === 'source' ? snapshot.sources.find((s) => s.id === item.id) : undefined;
  const snippet = item.kind === 'snippet' ? snapshot.snippets.find((s) => s.id === item.id) : undefined;
  const question = item.kind === 'question' ? questions.find((q) => q.id === item.id) : undefined;
  const track = item.kind === 'track' ? snapshot.tracks.find((s) => s.id === item.id) : undefined;

  // The ordered reading path (INCLUDES + PRECEDES + SEMINAL) is rendered as a track block on
  // both a source detail (the tracks it belongs to) and a track detail (its own members),
  // so those edges are dropped from the generic Connections for both kinds.
  const memberships = source ? snapshot.tracks.filter((sy) => sy.sourceIds.includes(source.id)) : [];
  const conceptMembers = track
    ? relations.filter((r) => r.type === 'INCLUDES' && r.direction === 'out' && r.otherKind === 'concept')
    : [];
  const isAnchor = (r: Relation): boolean =>
    r.direction === 'out' &&
    r.otherKind === 'concept' &&
    (source ? r.type === 'ABOUT' : snippet ? r.type === 'CLARIFIES' || r.type === 'CONTRADICTS' : false);
  const connRelations = (source || track ? relations.filter((r) => !PATH_EDGES.has(r.type)) : relations).filter(
    (r) => !isAnchor(r),
  );

  return (
    <div className="pane detail">
      <div className="detail-top">
        {source ? (
          <ModalityPicker
            badge
            value={source.modality}
            onChange={(m) => {
              const before = source.modality;
              void act(async () => {
                await client.update(source.id, { modality: m });
                return { label: 'change type', invert: () => client.update(source.id, { modality: before }) };
              }, `Type set to ${m} ✓`);
            }}
          />
        ) : (
          <span className="kind-badge" style={{ color: `var(--k-${item.kind})` }}>
            <Icon name={item.kind} size={17} />
          </span>
        )}
        <span className="kind-label">{item.kind}</span>
        <span style={{ flex: 1 }}>{item.meta}</span>
        {source && (
          <button
            className={source.consumed ? 'read-toggle on' : 'read-toggle'}
            title={source.consumed ? 'mark as unread' : 'mark as read'}
            onClick={() => {
              void (async () => {
                try {
                  if (source.consumed) {
                    await client.unconsume(source.id);
                    pushUndo('mark unread', () => client.consume(source.id));
                    await refresh();
                    notify('Marked as unread — back to the Backlog');
                  } else {
                    await client.consume(source.id);
                    pushUndo('mark read', () => client.unconsume(source.id));
                    await refresh();
                    notify('Marked as read ✓');
                  }
                } catch (e) {
                  notify(e instanceof Error ? e.message : String(e));
                }
              })();
            }}
          >
            {source.consumed ? '✓ read' : '○ unread'}
          </button>
        )}
        {item.kind === 'snippet' && (
          <button
            className={rawMd ? 'raw-toggle on' : 'raw-toggle'}
            title={rawMd ? 'show rendered' : 'show raw markdown source'}
            onClick={() => setRawMd((v) => !v)}
          >
            <Code size={14} />
          </button>
        )}
      </div>
      {item.kind === 'source' || item.kind === 'track' ? (
        <TitleEditor id={item.id} title={item.title} onRenamed={onNavigate} />
      ) : item.kind === 'snippet' && rawMd ? (
        <>
          <textarea
            className="raw-md raw-edit"
            value={rawText}
            rows={Math.min(14, Math.max(5, rawText.split('\n').length + 1))}
            spellCheck={false}
            onChange={(e) => setRawText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setRawText(item.title);
                setRawMd(false);
              }
            }}
          />
          <div className="detail-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
            <button className="link-btn publish-go" disabled={rawText.trim() === item.title || rawText.trim() === '' || rawBusy} onClick={() => void saveRaw()}>
              Save (supersedes)
            </button>
            <button
              className="link-btn"
              onClick={() => void navigator.clipboard.writeText(rawText).then(() => notify('Raw markdown copied ✓'))}
            >
              Copy raw
            </button>
            <span className="hint" style={{ fontSize: 12 }}>saving re-mints the snippet; connections move with it</span>
          </div>
        </>
      ) : item.kind === 'snippet' ? (
        // A passage reads as PROSE, not a heading (owner feedback): full block rendering —
        // real paragraphs, centered display math — at reading size and normal weight.
        <div className="snippet-display">
          <SnippetText text={item.title} />
        </div>
      ) : (
        <h2>{item.title}</h2>
      )}

      {source && <SourceBody source={source} snapshot={snapshot} onNavigate={onNavigate} />}
      {snippet && <SnippetBody snippet={snippet} questions={questions} onNavigate={onNavigate} />}
      {(source || snippet) && (
        <ConceptAnchors
          kind={source ? 'source' : 'snippet'}
          id={item.id}
          anchored={relations.filter(isAnchor)}
          concepts={concepts}
         
         
         
         
          onNavigate={onNavigate}
        />
      )}
      {source && (
        <ReadingOrder
          source={source}
          precedes={relations.filter((r) => r.type === 'PRECEDES')}
          snapshot={snapshot}
         
         
         
         
          onNavigate={onNavigate}
        />
      )}
      {/* Next reading — DEPRECATED 2026-07-21 (owner: revisit later). The NextReading component
          and its nextMoves plumbing are kept below, just not rendered; flip SHOW_NEXT_READING
          to bring it back. */}
      {SHOW_NEXT_READING && source && <NextReading source={source} snapshot={snapshot} projection={projection} onNavigate={onNavigate} />}
      {question && <QuestionBody question={question} snapshot={snapshot} onNavigate={onNavigate} />}
      {track && (
        <TrackBody
          track={track}
          snapshot={snapshot}
          conceptMembers={conceptMembers}
          projection={projection}
         
         
         
          onNavigate={onNavigate}
          onRemoveMember={(sid) => void removeFromTrack(track, sid)}
          onMoveMember={(sid, dir) => void reorderInTrack(track, sid, dir)}
          onAddMember={(sid) => void addToTrack(track, sid)}
         
        />
      )}

      {memberships.map((sy) => (
        <TrackPath key={sy.id} track={sy} snapshot={snapshot} currentId={item.id} showHeader onNavigate={onNavigate} onRemoveMember={(sid) => void removeFromTrack(sy, sid)} />
      ))}
      {/* A source that isn't a MEMBER anywhere can still sit in a concept-anchored track's
          family — show that track's topic view with this source highlighted, the mirror of
          the member TrackPath above (owner request, 2026-07-20). */}
      {source &&
        projection &&
        snapshot.tracks
          .filter((t) => !t.sourceIds.includes(item.id))
          .flatMap((t) => {
            const topics = buildTopics(projection.asm, projection.graph, t.id, snapshot.sources);
            return topics.some((g) => g.sources.some((e) => e.source.id === item.id)) ? [{ t, topics }] : [];
          })
          .map(({ t, topics }) => (
            <div key={t.id}>
              <div className="detail-section">
                <button className="link-btn track-link" onClick={() => onNavigate(t.id)} title="open the track">
                  {t.title}
                </button>{' '}
                · by concept
              </div>
              <RailTopics topics={topics} onNavigate={onNavigate} highlightId={item.id} />
            </div>
          ))}

      <Connections relations={connRelations} onNavigate={onNavigate} />

      {track && <TrackPublishing track={track} conceptAnchored={conceptMembers.length > 0 && isConceptAnchored(track)} />}

      <div className="detail-actions">
        <button className="link-btn" onClick={() => onViewInMap(item.id)}>
          ✳ View in map
        </button>
        {track && (
          <button className="link-btn" title="duplicate this track (same sources and order) under a new name" onClick={() => void copyTrack()}>
            <CopySimple size={14} /> Copy track
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="remove" title="remove" onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </div>
  );
}
