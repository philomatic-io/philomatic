/**
 * The detail rail — kind dispatch. Each body lives in its own module (maintainability
 * phase 2a): this file decides WHICH body renders and supplies the shared header.
 */
import { Icon } from '../../components/Icon';
import { ModalityPicker } from '../../components/ModalityPicker';
import { useAction, useEngine } from '../../engine-context';
import { applyPlan, invert, isEmpty, merge, planAdd, planMove, planRemove, type Plan } from '../../lib/reorder';
import { SnippetText } from '../../lib/snippet-md';
import { nextMoves } from '../../lib/topics';
import { Code, CopySimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { AssembleResult, GraphEnvelope, QuestionView, Relation, Snapshot } from '../../client/types';
import type { Item } from '../../lib/items';
import { createSource } from '../../lib/sources';
import { ConceptAnchors } from './ConceptAnchors';
import { Connections } from './Connections';
import { NextReading } from './NextReading';
import { QuestionBody } from './QuestionBody';
import { ReadingOrder } from './ReadingOrder';
import { SnippetBody } from './SnippetBody';
import { SourceBody } from './SourceBody';
import { TitleEditor } from './TitleEditor';
import { AddToTrackRow } from './AddMemberRow';
import { TrackBody } from './TrackBody';
import { trackShows } from './TrackSection';
import { TrackPublishing } from './TrackPublishing';
import { PATH_EDGES } from './shared';

// Next reading — brought back 2026-07-24 (owner): the go deeper / wider / shallower moves,
// alongside compact track links, replace the full per-track lists that crowded a source page.
export const SHOW_NEXT_READING: boolean = true;

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
    sids: string[],
  ) => {
    // One undoable batch for however many were picked (owner, 2026-07-24: multiselect add).
    const plan = sids.reduce<Plan>((acc, sid) => merge(acc, planAdd(tr, sid)), { unlink: [], link: [] });
    if (isEmpty(plan)) return;
    const n = plan.link.length;
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `add to “${tr.title}”`, invert: () => applyPlan(client, invert(plan)) };
    }, `Added ${n === 1 ? 'a source' : `${n} sources`} to “${tr.title}”`);
  };
  /** Create a new source from a typed URL and add it to the track in one undoable action — the
   *  source picker's "＋ create …". A name plus an OPTIONAL url — url given makes a link (url =
   *  identity), blank makes an offline source titled the name (a physical book). Both idempotent;
   *  undo un-mints only what this gesture created. */
  const createSourceInTrack = async (
    tr: { id: string; title: string; sourceIds: string[]; sourceLevels: string[][]; precedes: { srcId: string; dstId: string }[] },
    text: string,
    url?: string,
  ) => {
    const t = text.trim();
    await act(async () => {
      const { id: sid, created } = await createSource(client, { title: t, url });
      const plan = planAdd(tr, sid);
      await applyPlan(client, plan);
      return {
        label: `add “${t.slice(0, 40)}”`,
        invert: async () => {
          await applyPlan(client, invert(plan));
          if (created) await client.remove(sid); // un-mint only if the gesture created it
        },
      };
    }, `Added a source to “${tr.title}”`);
  };
  /** Put ONE source on several tracks at once (the source page's picker) — one batch. */
  const addSourceToTracks = async (sid: string, trackIds: string[]) => {
    const chosen = trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => t !== undefined);
    const plan = chosen.reduce<Plan>((acc, tr) => merge(acc, planAdd(tr, sid)), { unlink: [], link: [] });
    if (isEmpty(plan)) return;
    await act(async () => {
      await applyPlan(client, plan);
      return { label: `add to ${chosen.length} track${chosen.length === 1 ? '' : 's'}`, invert: () => applyPlan(client, invert(plan)) };
    }, `Added to ${chosen.length} track${chosen.length === 1 ? '' : 's'}`);
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
          sourceMeta={(sid) => {
            const snpIds = new Set(snapshot.snippets.filter((sn) => sn.sourceId === sid).map((sn) => sn.id));
            const openQuestions = questions.filter((q) => !q.answered && q.raisedBy.some((r) => (r.kind === 'source' && r.id === sid) || (r.kind === 'snippet' && snpIds.has(r.id)))).length;
            return { openQuestions, snippets: snpIds.size };
          }}
          onNavigate={onNavigate}
          onAddMember={(sids) => void addToTrack(track, sids)}
          onCreateMember={(title, url) => void createSourceInTrack(track, title, url)}
        />
      )}

      {/* The tracks this source appears in — compact LINKS, not full lists (owner, 2026-07-24:
          a source in many tracks made this page a wall of reading lists). The reading itself is
          on each track's own page; here it's "which tracks am I in", with the × to leave a
          member track. A source shown only via a concept is tagged, since there's no × for it. */}
      {source &&
        projection &&
        (() => {
          const inTracks = snapshot.tracks.filter((t) => trackShows(projection, t, snapshot.sources, item.id));
          if (inTracks.length === 0) return null;
          return (
            <>
              <div className="detail-section">In tracks ({inTracks.length})</div>
              <div className="source-tracks">
                {inTracks.map((t) => {
                  const isMember = t.sourceIds.includes(item.id);
                  return (
                    <div key={t.id} className="source-track">
                      <button className="link-btn track-link" onClick={() => onNavigate(t.id)} title="open the track">
                        <span style={{ color: 'var(--k-track)' }}>
                          <Icon name="track" size={13} />
                        </span>{' '}
                        {t.title}
                      </button>
                      {isMember ? (
                        <button className="path-x" title="remove from this track (the source itself stays)" onClick={() => void removeFromTrack(t, item.id)}>
                          ×
                        </button>
                      ) : (
                        <span className="source-track-tag" title="this source appears via a concept, not as an explicit member">via concept</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}

      {/* Put this source on a track from the source's own page (owner request, 2026-07-23) —
          the mirror of the track editor's add row, so membership can be managed from either
          end of the relationship. */}
      {source && <AddToTrackRow source={source} snapshot={snapshot} onAdd={(tids) => void addSourceToTracks(source.id, tids)} />}

      <Connections relations={connRelations} onNavigate={onNavigate} />

      {track && <TrackPublishing track={track} />}

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
