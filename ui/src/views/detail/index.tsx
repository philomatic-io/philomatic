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
import { CopySimple, Share, StarFour } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AssembleResult, GraphEnvelope, QuestionView, Relation, Snapshot } from '../../client/types';
import { shortAuthors } from '../../lib/items';
import type { Item } from '../../lib/items';
import { createSource } from '../../lib/sources';
import { includeInNewTrack } from '../../lib/ties';
import { ConceptAnchors } from './ConceptAnchors';
import { Connections } from './Connections';
import { NextReading } from './NextReading';
import { AddPrecedesRow } from './AddPrecedesRow';
import { AddQuestionRow } from './AddQuestionRow';
import { AddSnippetRow } from './AddSnippetRow';
import { QuestionBody, QuestionConceptAdder, QuestionTieAdder } from './QuestionBody';
import { SnippetBody } from './SnippetBody';
import { hasSameKindLinkTags, LinkAdder } from './LinkAdder';
import { SourceBody, SourceSnippets } from './SourceBody';
import { TitleEditor } from './TitleEditor';
import { AddToTrackRow } from './AddMemberRow';
import { TrackBody } from './TrackBody';
import { trackShows } from './TrackSection';
import { TrackPublishing } from './TrackPublishing';
import { PubStateChip } from '../../components/PubStateChip';
import { EditModeCtx, PATH_EDGES, StagedBanner } from './shared';
import { needsServer, unavailable } from '../../lib/capabilities';
import { currentBackend } from '../../lib/backend-pref';

// Next reading: the go deeper / wider / shallower moves,
// alongside compact track links, replace the full per-track lists that crowded a source page.
export const SHOW_NEXT_READING: boolean = true;

/**
 * The amber pending frame — or NOTHING at all, deliberately, rather than a class-less wrapper
 * div. A plain div here is the containing block for the sticky header inside it, and it ends a
 * few lines later, so the header unstuck itself the moment that wrapper scrolled away
 *. Only a staged entity, whose header is short and whose frame must enclose it,
 * gets a real element.
 */
function StagedFrame({ staged, children }: { staged: boolean; children: ReactNode }): ReactNode {
  return staged ? <div className="staged-frame">{children}</div> : <>{children}</>;
}

export function Detail({
  projection,
  item,
  snapshot,
  questions,
  concepts,
  onNavigate,
  onViewInMap,
  editNew,
  onClose,
  onPropose,
  proposing,
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
  /** Just-created entity id — its rail opens with editing ON (unified create). */
  editNew?: string;
  /** Present on a PINNED rail — renders the close × beside the edit toggle. */
  onClose?: () => void;
  /** The propose pass — sources with a URL offer "suggest structure". */
  onPropose?: (id: string) => void;
  /** The one LLM job in flight, if any — the button disables; kind picks the busy label. */
  proposing?: { id: string; kind: 'structure' | 'track' };
}) {
  const { client, refresh, notify, pushUndo, epoch } = useEngine();
  const act = useAction();
  const backend = currentBackend();
  const [relations, setRelations] = useState<Relation[]>([]);
  // Per-RAIL edit mode: OFF = reading view; a just-created entity opens ON.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editNew !== undefined && editNew === item.id) setEditing(true);
  }, [editNew, item.id]);

  useEffect(() => {
    let stale = false;
    client.getRelations(item.id).then((r) => !stale && setRelations(r.relations)).catch(() => !stale && setRelations([]));
    return () => {
      stale = true;
    };
  }, [client, item.id, epoch]);

  // Raw-source toggle → EDITOR: the </> view shows the exact
  // stored markdown, editable. Saving is edit-by-supersession (text hashes into the id): the
  // engine mints the new snippet, migrates edges + annotations, retracts the old — so the UI
  // navigates to the new id and the undo stack gets remove-new + restore-old.
  // A snippet's passage renders raw + editable whenever the rail is editing (the separate </> raw-markdown toggle retired — edit mode IS the raw view).
  const [rawText, setRawText] = useState(item.title);
  const [rawBusy, setRawBusy] = useState(false);
  useEffect(() => {
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
      setEditing(false);
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

  // Remove a source FROM a track: un-assert the INCLUDES plus any
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
    // One undoable batch for however many were picked (multiselect add).
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

  // Copy a track: a NEW track with the same members and reading
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
      // URL-derived sources (a dangling-reference failure otherwise).
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
  /** This source's own passages — rendered as the last group of its Connections. */
  const ownSnippets = source === undefined ? [] : snapshot.snippets.filter((s) => s.sourceId === source.id);
  const question = item.kind === 'question' ? questions.find((q) => q.id === item.id) : undefined;
  const track = item.kind === 'track' ? snapshot.tracks.find((s) => s.id === item.id) : undefined;

  // The ordered reading path (INCLUDES + PRECEDES + SEMINAL) is rendered as a track block on
  // both a source detail (the tracks it belongs to) and a track detail (its own members),
  // so those edges are dropped from the generic Connections for both kinds.
  const conceptMembers = track
    ? relations.filter((r) => r.type === 'INCLUDES' && r.direction === 'out' && r.otherKind === 'concept')
    : [];
  // EVERY connection renders in the unified Connections list; the
  // per-kind editors are now that list's end-of-group ADD affordances. Exclusions that remain:
  // a track's INCLUDES/PRECEDES render as the track body itself; a source's INCLUDES render as
  // the compact tracks block; SNIPPET_OF is containment (the snippet list / the header meta),
  // not a relation row. A source's PRECEDES now SHOW here — the ReadingOrder editor retired.
  const connRelations = relations.filter((r) => {
    // A snippet's owning source SHOWS (read-only containment row); other SNIPPET_OF stay out.
    if (r.type === 'SNIPPET_OF') return snippet !== undefined && r.direction === 'out';
    if (track) return !PATH_EDGES.has(r.type);
    return true;
  });

  return (
    <EditModeCtx.Provider value={editing}>
    <div className={editing ? 'pane detail editing' : 'pane detail'}>
      {/* A STAGED entity's whole header — kind row, byline, title — sits inside the amber
          pending frame, verdicts on the frame's bottom row. */}
      <StagedFrame staged={item.staged === true}>
      {/* FROZEN: kind, edit, close and the title stay put while the body
          scrolls under them — a long track's rail otherwise loses every clue about what you are
          reading and how to leave it. A passage opts out: its title IS its prose, so freezing it
          would pin the whole entity to the top of its own page. */}
      <div className={item.kind === 'snippet' ? undefined : 'detail-head-stick'}>
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
            <Icon name={item.kind} size={17} filled />
          </span>
        )}
        <span className="kind-label">{item.kind}</span>
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
      <span style={{ flex: 1 }} />
        <button className={editing ? 'edit-toggle on' : 'edit-toggle'} title={editing ? 'done editing' : 'edit this entity'} onClick={() => setEditing((v) => !v)}>
          {editing ? '✓ done' : '✎ edit'}
        </button>
        {onClose && (
          <button className="pinned-x" title="close this rail" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {item.kind === 'source' || item.kind === 'track' ? (
        <TitleEditor id={item.id} title={item.title} onRenamed={onNavigate} />
      ) : item.kind === 'snippet' && editing ? (
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
                setEditing(false);
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
        // A passage reads as PROSE, not a heading: full block rendering —
        // real paragraphs, centered display math — at reading size and normal weight.
        <div className="snippet-display">
          <SnippetText text={item.title} />
        </div>
      ) : (
        <h2>{item.title}</h2>
      )}
      {item.kind === 'track' && <PubStateChip trackId={item.id} />}
      </div>
      {/* The kind meta reads UNDER the title — a track's counts and goal
          were introducing an entity the reader had not been told the name of yet. Sources show
          just the author (modality is the badge); tracks their counts + goal line. It scrolls:
          only the identity above it is frozen. */}
      {(source ? source.author !== undefined : (item.counts ?? item.meta) !== '') && (
        <div className="detail-top-meta">{source ? shortAuthors(source.author ?? '') : (item.counts ?? item.meta)}</div>
      )}
      {item.staged === true && <StagedBanner id={item.id} title={item.title} />}
      </StagedFrame>

      {source && <SourceBody source={source} snapshot={snapshot} onNavigate={onNavigate} />}
      {/* Same-kind framework links: appears exactly when an active framework
          declares relations for this kind — the visible half of turning a framework ON. */}
      {source && (
        <LinkAdder
          kind="source"
          id={source.id}
          peers={snapshot.sources.filter((s) => s.id !== source.id).map((s) => ({ id: s.id, label: s.title, icon: `source:${s.modality}` as const }))}
        />
      )}
      {snippet && <SnippetBody snippet={snippet} questions={questions} onNavigate={onNavigate} />}
      {/* Next reading — DEPRECATED (revisit later). The NextReading component
          and its nextMoves plumbing are kept below, just not rendered; flip SHOW_NEXT_READING
          to bring it back. */}
      {SHOW_NEXT_READING && source && <NextReading source={source} snapshot={snapshot} projection={projection} onNavigate={onNavigate} />}
      {question && <QuestionBody question={question} />}
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



      <Connections
        self={{ id: item.id, kind: item.kind }}
        relations={connRelations}
        onNavigate={onNavigate}
        overrideRemove={(r) => {
          if (source && r.type === 'INCLUDES' && r.otherKind === 'track') {
            const tr = snapshot.tracks.find((t) => t.id === r.otherId);
            if (tr) {
              void removeFromTrack(tr, item.id);
              return true;
            }
          }
          return false;
        }}
        /* Adders only while EDITING — and since a group renders when it has
           rows OR an adder, gating them here is what makes an empty category disappear from the
           reading view while staying available to add to in edit mode. */
        addByKind={
          editing && source
            ? {
                track: (
                  <AddToTrackRow
                    source={source}
                    snapshot={snapshot}
                    onAdd={(tids) => void addSourceToTracks(source.id, tids)}
                    onCreate={(title) => void act(() => includeInNewTrack(client, title, { kind: 'source', id: item.id }), `Created track “${title.trim().slice(0, 30)}” ✓`)}
                  />
                ),
                concept: <ConceptAnchors kind="source" id={item.id} concepts={concepts} />,
                source: <AddPrecedesRow sourceId={item.id} snapshot={snapshot} />,
                question: <AddQuestionRow srcType="source" srcId={item.id} questions={questions} />,
                snippet: <AddSnippetRow sourceId={item.id} />,
              }
            : snippet
              ? {
                  concept: <ConceptAnchors kind="snippet" id={item.id} concepts={concepts} />,
                  question: <AddQuestionRow srcType="snippet" srcId={item.id} questions={questions} />,
                  // Framework relations between passages: the Snippets
                  // group, in the standard add-entity skin — present exactly when an active
                  // framework declares snippet↔snippet relations and peers exist.
                  ...(hasSameKindLinkTags('snippet') && snapshot.snippets.length > 1
                    ? {
                        snippet: (
                          <LinkAdder
                            slot
                            kind="snippet"
                            id={item.id}
                            peers={snapshot.snippets.filter((s) => s.id !== item.id).map((s) => ({ id: s.id, label: s.text.length > 70 ? `${s.text.slice(0, 69)}…` : s.text }))}
                          />
                        ),
                      }
                    : {}),
                }
              : question
                ? {
                    concept: <QuestionConceptAdder question={question} concepts={concepts} />,
                    source: <QuestionTieAdder question={question} snapshot={snapshot} kind="source" />,
                    snippet: <QuestionTieAdder question={question} snapshot={snapshot} kind="snippet" />,
                  }
                : undefined
        }
        /* Only when there ARE passages: a React element is never null, so passing one
           unconditionally rendered an empty "Snippets" heading on every source. */
        addLabelByKind={snippet !== undefined ? { snippet: 'add snippet relation' } : undefined}
        bodyByKind={ownSnippets.length > 0 ? { snippet: <SourceSnippets snippets={ownSnippets} onNavigate={onNavigate} /> } : undefined}
      />

      {track && <TrackPublishing track={track} />}

      {/* An action this engine cannot do says so BEFORE it is clicked: disabled,
          with the reason as its tooltip and a marker so it reads as a property of the engine
          rather than a broken button. The client still refuses if called anyway, from the same
          rule (lib/capabilities). */}
      <div className="detail-actions detail-foot-stick">
        <button className="link-btn" onClick={() => onViewInMap(item.id)}>
          ✳ View in map
        </button>
        {source && source.url !== undefined && onPropose && (
          <button
            className={needsServer('suggest', backend) ? 'link-btn needs-server' : 'link-btn'}
            disabled={proposing !== undefined || needsServer('suggest', backend)}
            title={
              unavailable('suggest', backend) ??
              'ask the LLM to draft structure from this source — everything lands in the Inbox for your verdict'
            }
            onClick={() => onPropose(item.id)}
          >
            {proposing?.kind === 'structure' && proposing.id === item.id ? '… proposing' : <><StarFour size={14} /> Suggest structure</>}
          </button>
        )}
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
    </EditModeCtx.Provider>
  );
}
