/**
 * The persistent detail pane (workbench redesign) — full detail on the selected item plus the
 * field-level patch form and the typed "Connections" list. Shown on both Library and Map tabs.
 * Editing follows the engine's supersession rules (identity fields read-only with the reason).
 */
import { useEffect, useMemo, useState } from 'react';
import { CaretDoubleDown, CaretDoubleRight, Code, CopySimple, GitBranch, LinkSimple, PencilSimple } from '@phosphor-icons/react';
import type { EngineClient } from '../client/transport';
import type { AssembleResult, GraphEnvelope, NodeKind, QuestionView, Relation, SnippetView, Snapshot, SourceView } from '../client/types';
import { buildTopics, derivedReading, isConceptAnchored, nextMoves, topicsForTrack, type NextMove, type NextMoves, type TopicGroup } from '../lib/topics';
import { shortAuthors, type Item } from '../lib/items';
import { orderedSources } from '../lib/order';
import { relationWord } from '../lib/relations';
import { SentimentTag } from '../lib/sentiment';
import { Icon, sourceIcon } from '../components/Icon';
import { ABOUT_TAGS, relationEdge, resolveOrCreateConcept } from '../lib/concepts';
import { SnippetText } from '../lib/snippet-md';
import { TagChip } from '../components/TagChip';
import { SentimentSeg } from '../components/SentimentPicker';
import { ModalityPicker } from '../components/ModalityPicker';

// A source's track membership + reading order is shown as a track block (feedback round 3),
// so these edge types are folded out of the generic Connections list for sources.
const PATH_EDGES = new Set(['INCLUDES', 'PRECEDES', 'SEMINAL']);

// Next reading deprecated 2026-07-21 (owner: revisit later) — flip to re-enable the section.
const SHOW_NEXT_READING: boolean = false;

const parseTags = (raw: string): string[] =>
  raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));

/** The kind icon used inside Connections/paths (sources use a generic book — modality unknown here). */
const kindIcon = (kind: NodeKind) => <Icon name={kind === 'source' ? sourceIcon('text') : kind} />;

export function Detail({
  projection,
  item,
  snapshot,
  questions,
  concepts,
  pushUndo,
  client,
  epoch,
  refresh,
  onNavigate,
  onViewInMap,
  notify,
}: {
  item: Item;
  snapshot: Snapshot;
  questions: QuestionView[];
  /** The shared assemble+graph, fetched once per change by App. */
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  /** The selected item was just created — open its title editor for naming. */
  /** The concept list (assemble projection) — the anchor editor's picker. */
  concepts: { id: string; name: string; tracked: boolean }[];
  /** Push an action's INVERSE onto the Ctrl+Z stack. */
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  client: EngineClient;
  /** Bumped by App on every refresh — the "refetch your projection" signal. */
  epoch: number;
  refresh: () => Promise<void>;
  onNavigate: (id: string) => void;
  onViewInMap: (id: string) => void;
  notify: (msg: string, undoRef?: string) => void;
}) {
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
  const removeFromTrack = async (
    tr: { id: string; title: string; precedes: { srcId: string; dstId: string }[] },
    sid: string,
  ) => {
    try {
      const touching = tr.precedes.filter((p) => p.srcId === sid || p.dstId === sid);
      await client.unlink({ srcId: tr.id, type: 'INCLUDES', dstId: sid });
      for (const p of touching) await client.unlink({ srcId: p.srcId, type: 'PRECEDES', dstId: p.dstId, trackContextId: tr.id });
      await refresh();
      pushUndo(`remove from “${tr.title}”`, () =>
        client.importPayload({
          version: 2,
          edges: [
            { srcType: 'track', srcId: tr.id, type: 'INCLUDES', dstType: 'source', dstId: sid },
            ...touching.map((p) => ({
              srcType: 'source', srcId: p.srcId, type: 'PRECEDES', dstType: 'source', dstId: p.dstId, trackContextId: tr.id,
            })),
          ],
        }),
      );
      notify(`Removed from “${tr.title}” — the source itself stays in your library`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // Precise reordering for the Library track editor (owner ruling, 2026-07-18: Journey's drag
  // stays experimental; Library is the clean path). A move REWRITES the whole in-context
  // PRECEDES chain over the new total order — deterministic, no additive contradictions, and
  // the undo restores the exact previous pairs.
  const precEdge = (trId: string) => (p: { srcId: string; dstId: string }) => ({
    srcType: 'source', srcId: p.srcId, type: 'PRECEDES', dstType: 'source', dstId: p.dstId, trackContextId: trId,
  });
  const reorderInTrack = async (
    tr: { id: string; title: string; sourceLevels: string[][]; sourceIds: string[]; precedes: { srcId: string; dstId: string }[] },
    sid: string,
    dir: -1 | 1,
  ) => {
    const order = tr.sourceLevels.flat();
    const i = order.indexOf(sid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const oldPairs = tr.precedes;
    const newPairs = order.slice(0, -1).map((a, k) => ({ srcId: a, dstId: order[k + 1]! }));
    try {
      for (const p of oldPairs) await client.unlink({ srcId: p.srcId, type: 'PRECEDES', dstId: p.dstId, trackContextId: tr.id });
      // Bulk path on purpose: a chain rewrite is one batch (one validation), not N intents.
      await client.importPayload({ version: 2, edges: newPairs.map(precEdge(tr.id)) });
      await refresh();
      pushUndo(`reorder “${tr.title}”`, async () => {
        for (const p of newPairs) await client.unlink({ srcId: p.srcId, type: 'PRECEDES', dstId: p.dstId, trackContextId: tr.id });
        if (oldPairs.length > 0) await client.importPayload({ version: 2, edges: oldPairs.map(precEdge(tr.id)) });
      });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const addToTrack = async (
    tr: { id: string; title: string; sourceLevels: string[][]; precedes: { srcId: string; dstId: string }[] },
    sid: string,
  ) => {
    const order = tr.sourceLevels.flat();
    const last = order[order.length - 1];
    // Join at the END of the reading order; the PRECEDES link only when an order already exists.
    const pair = tr.precedes.length > 0 && last !== undefined ? { srcId: last, dstId: sid } : undefined;
    try {
      await client.link({ srcType: 'track', srcId: tr.id, type: 'INCLUDES', dstType: 'source', dstId: sid });
      if (pair) await client.link(precEdge(tr.id)(pair));
      await refresh();
      pushUndo(`add to “${tr.title}”`, async () => {
        await client.unlink({ srcId: tr.id, type: 'INCLUDES', dstId: sid });
        if (pair) await client.unlink({ srcId: pair.srcId, type: 'PRECEDES', dstId: pair.dstId, trackContextId: tr.id });
      });
      notify(`Added to “${tr.title}”`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
              void (async () => {
                try {
                  await client.update(source.id, { modality: m });
                  await refresh();
                  notify(`Type set to ${m} ✓`);
                } catch (e) {
                  notify(e instanceof Error ? e.message : String(e));
                }
              })();
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
        <TitleEditor id={item.id} title={item.title} client={client} refresh={refresh} notify={notify} onRenamed={onNavigate} pushUndo={pushUndo} />
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

      {source && <SourceBody source={source} snapshot={snapshot} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} onNavigate={onNavigate} />}
      {snippet && <SnippetBody snippet={snippet} questions={questions} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} onNavigate={onNavigate} />}
      {(source || snippet) && (
        <ConceptAnchors
          kind={source ? 'source' : 'snippet'}
          id={item.id}
          anchored={relations.filter(isAnchor)}
          concepts={concepts}
          client={client}
          refresh={refresh}
          notify={notify}
          pushUndo={pushUndo}
          onNavigate={onNavigate}
        />
      )}
      {source && (
        <ReadingOrder
          source={source}
          precedes={relations.filter((r) => r.type === 'PRECEDES')}
          snapshot={snapshot}
          client={client}
          refresh={refresh}
          notify={notify}
          pushUndo={pushUndo}
          onNavigate={onNavigate}
        />
      )}
      {/* Next reading — DEPRECATED 2026-07-21 (owner: revisit later). The NextReading component
          and its nextMoves plumbing are kept below, just not rendered; flip SHOW_NEXT_READING
          to bring it back. */}
      {SHOW_NEXT_READING && source && <NextReading source={source} snapshot={snapshot} projection={projection} onNavigate={onNavigate} />}
      {question && <QuestionBody question={question} snapshot={snapshot} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} onNavigate={onNavigate} />}
      {track && (
        <TrackBody
          track={track}
          snapshot={snapshot}
          conceptMembers={conceptMembers}
          projection={projection}
          client={client}
          refresh={refresh}
          notify={notify}
          onNavigate={onNavigate}
          onRemoveMember={(sid) => void removeFromTrack(track, sid)}
          onMoveMember={(sid, dir) => void reorderInTrack(track, sid, dir)}
          onAddMember={(sid) => void addToTrack(track, sid)}
          pushUndo={pushUndo}
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

      {track && <TrackPublishing track={track} conceptAnchored={conceptMembers.length > 0 && isConceptAnchored(track)} client={client} refresh={refresh} notify={notify} />}

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

/** Inline rename. SOURCES: title is a plain attribute (id derives from the URL; URL-less
 *  sources are the exception — the engine rejects and the reason surfaces as the toast).
 *  TRACKS: the title slugs the id, so the engine renames BY SUPERSESSION — new id minted,
 *  edges carried over, old entity retracted (restorable) — and `onRenamed` re-selects the new
 *  id. Question / snippet / concept names are content-hash identity: still deferred to the
 *  Phase-2 identity work (ROADMAP §1.2). */
function TitleEditor({
  id,
  title,
  client,
  refresh,
  notify,
  onRenamed,
  pushUndo,
}: {
  id: string;
  title: string;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  onRenamed?: (newId: string) => void;
  pushUndo?: (label: string, invert: () => Promise<unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  // Track the entity, but NEVER clobber the input while the user is typing (owner bug
  // 2026-07-22: a refresh/selection churn mid-edit reset the value to the old title, and
  // Enter then silently no-opped as "unchanged").
  useEffect(() => {
    if (!editing) setValue(title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, title]);

  const save = async () => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === title) {
      setValue(title);
      return;
    }
    try {
      const result = await client.update(id, { title: next });
      pushUndo?.(`rename “${next.slice(0, 30)}”`, () => client.update(result.targetId, { title }));
      await refresh();
      notify('Renamed ✓');
      if (result.targetId !== id) onRenamed?.(result.targetId); // track rename mints a new id
    } catch (e) {
      setValue(title);
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  if (editing) {
    return (
      <input
        className="title-edit"
        autoFocus
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            setValue(title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h2 className="title-row">
      {title}
      <button className="title-pencil" title="rename" onClick={() => setEditing(true)}>
        <PencilSimple size={14} />
      </button>
    </h2>
  );
}

export function TagEditor({
  id,
  tags,
  client,
  refresh,
  notify,
  pushUndo,
}: {
  id: string;
  tags: string[];
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo?: (label: string, invert: () => Promise<unknown>) => void;
}) {
  const [adding, setAdding] = useState('');
  const patchTags = async (next: string[]) => {
    const before = tags.slice();
    try {
      await client.update(id, { tags: next });
      pushUndo?.('edit tags', () => client.update(id, { tags: before }));
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="detail-tags">
      {tags.map((t) => (
        <TagChip key={t} tag={t}>
          <button className="chip-x" aria-label={`remove ${t}`} onClick={() => void patchTags(tags.filter((x) => x !== t))}>
            ×
          </button>
        </TagChip>
      ))}
      <input
        className="chip tag-add"
        style={{ width: 90 }}
        value={adding}
        placeholder="+ tag"
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && adding.trim()) {
            void patchTags([...tags, ...parseTags(adding)]);
            setAdding('');
          }
        }}
      />
    </div>
  );
}

function SourceBody({
  source,
  snapshot,
  client,
  refresh,
  notify,
  pushUndo,
  onNavigate,
}: {
  source: SourceView;
  snapshot: Snapshot;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo?: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
}) {
  const snippets = snapshot.snippets.filter((s) => s.sourceId === source.id);
  return (
    <>
      {source.personalUrl && (
        <a className="detail-url" href={source.personalUrl}>
          <LinkSimple size={13} /> {source.personalUrl.startsWith('obsidian://') ? 'Open note in Obsidian' : source.personalUrl}
        </a>
      )}
      {source.url && (
        <a className="detail-url" href={source.url} target="_blank" rel="noreferrer">
          <LinkSimple size={13} /> {source.url}
        </a>
      )}
      <SourceFacts source={source} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} />
      <TagEditor id={source.id} tags={source.tags} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} />
      {snippets.length > 0 && (
        <>
          <div className="detail-section">Snippets ({snippets.length})</div>
          {snippets.map((s) => (
            <button key={s.id} className="snippet-box" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => onNavigate(s.id)}>
              {s.sentiment && <p className="sentiment"><SentimentTag token={s.sentiment} /></p>}
              <blockquote><SnippetText text={s.text} /></blockquote>
              {s.note && <p className="snippet-note">{s.note}</p>}
            </button>
          ))}
        </>
      )}
    </>
  );
}

/** Author (visible + editable — model v2 made it a pure attribute) and modality (the source
 *  "type": capture infers it from the URL, which guesses wrong for PDFs-in-browser and
 *  podcasts-on-web — so it's correctable here). Owner requests, 2026-07-18. */
function SourceFacts({
  source,
  client,
  refresh,
  notify,
  pushUndo,
}: {
  source: SourceView;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo?: (label: string, invert: () => Promise<unknown>) => void;
}) {
  // Pencil-toggled like the title/goal editors (owner request, 2026-07-18): read-only text
  // until the pencil, so a stray click can't start an edit.
  const [editingAuthor, setEditingAuthor] = useState(false);
  const [author, setAuthor] = useState(source.author ?? '');
  useEffect(() => {
    setAuthor(source.author ?? '');
    setEditingAuthor(false);
  }, [source.id, source.author]);

  const saveAuthor = async () => {
    setEditingAuthor(false);
    const next = author.trim();
    if (next === (source.author ?? '') || next === '') {
      setAuthor(source.author ?? '');
      return;
    }
    try {
      const before = source.author;
      await client.update(source.id, { author: next });
      pushUndo?.('edit author', () => client.update(source.id, { author: before ?? '' }));
      await refresh();
      notify('Author saved ✓');
    } catch (e) {
      setAuthor(source.author ?? '');
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="source-facts">
      <div className="fact-row">
        <span className="fact-label">by</span>
        {editingAuthor ? (
          <input
            autoFocus
            value={author}
            placeholder="add authors…"
            onChange={(e) => setAuthor(e.target.value)}
            onBlur={() => void saveAuthor()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveAuthor();
              if (e.key === 'Escape') {
                setAuthor(source.author ?? '');
                setEditingAuthor(false);
              }
            }}
          />
        ) : (
          <span className="fact-value" title={source.author ?? ''}>
            <span className="fact-value-text">{source.author ?? <span className="fact-empty">add authors…</span>}</span>
            <button className="title-pencil" title="edit authors" onClick={() => setEditingAuthor(true)}>
              <PencilSimple size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function SnippetBody({
  snippet,
  questions,
  client,
  refresh,
  notify,
  pushUndo,
  onNavigate,
}: {
  snippet: SnippetView;
  questions: QuestionView[];
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
}) {
  const [note, setNote] = useState(snippet.note ?? '');
  const [sentiment, setSentiment] = useState(snippet.sentiment ?? '');
  const [busy, setBusy] = useState(false);
  // Tie a question from the snippet's side (owner request, 2026-07-19): raises / answers,
  // authoring the question first when it's new (text identity — capture's 'created if
  // unseen' semantic, so this row doubles as ask-from-a-passage).
  const [qWord, setQWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  const [qText, setQText] = useState('');
  const tieQuestion = async () => {
    const value = qText.trim();
    if (!value) return;
    try {
      let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
      let created = false;
      if (q === undefined) {
        await client.importPayload({ version: 2, questions: [{ text: value }] });
        q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
        created = true;
      }
      if (q === undefined) throw new Error('could not resolve the question');
      const qId = q.id;
      const edge = { srcType: 'snippet', srcId: snippet.id, type: qWord, dstType: 'question', dstId: qId, tags: [] };
      await client.link(edge);
      await refresh();
      setQText('');
      pushUndo(`tie ${qWord.toLowerCase()} → question`, async () => {
        await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
        if (created) await client.remove(qId);
      });
      notify(`${qWord === 'RAISES' ? 'Raises' : 'Answers'} “${value.slice(0, 40)}” ✓${created ? ' (new question)' : ''}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (note.trim() !== (snippet.note ?? '')) patch.note = note.trim();
    if (sentiment !== (snippet.sentiment ?? '')) patch.sentiment = sentiment;
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    try {
      await client.update(snippet.id, patch);
      await refresh();
      notify('Saved ✓');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The passage is the pane's heading (item.title) and its source is in the detail-top meta —
  // so no blockquote/"from" repeat here (feedback round 3).
  return (
    <>
      <TagEditor id={snippet.id} tags={snippet.tags} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} />
      <label className="detail-field">
        Note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => void save()} placeholder="your note" rows={3} />
      </label>
      <div className="detail-field">
        Sentiment
        <SentimentSeg
          value={sentiment}
          onChange={(next) => {
            setSentiment(next);
            void (async () => {
              try {
                await client.update(snippet.id, { sentiment: next });
                await refresh();
              } catch (e) {
                notify(e instanceof Error ? e.message : String(e));
              }
            })();
          }}
        />
      </div>
      <div className="detail-section">Questions</div>
      {(() => {
        const mine = questions
          .flatMap((q) => [
            ...q.raisedBy.filter((r) => r.id === snippet.id).map(() => ({ q, word: 'raises' as const })),
            ...q.answeredBy.filter((r) => r.id === snippet.id).map(() => ({ q, word: 'answers' as const })),
          ]);
        return mine.length === 0 ? (
          <p className="hint" style={{ padding: 0 }}>none tied yet</p>
        ) : (
          <div className="connections">
            {mine.map(({ q, word }) => (
              <button key={`${word}-${q.id}`} className="connection" onClick={() => onNavigate(q.id)}>
                <span className="connection-type">{word}</span>
                <span style={{ color: 'var(--k-question)' }}>{kindIcon('question')}</span>
                <span className="connection-target">{q.text}</span>
              </button>
            ))}
          </div>
        );
      })()}
      <div className="order-addrow">
        <select className="order-pick" value={qWord} onChange={(e) => setQWord(e.target.value as 'RAISES' | 'ANSWERS')}>
          <option value="RAISES">raises</option>
          <option value="ANSWERS">answers</option>
        </select>
        <input
          className="order-input"
          list="snippet-tie-questions"
          placeholder="a question (new or existing)…"
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void tieQuestion();
          }}
        />
        <button className="link-btn" disabled={!qText.trim()} onClick={() => void tieQuestion()}>
          + Link
        </button>
        <datalist id="snippet-tie-questions">
          {questions.map((x) => (
            <option key={x.id} value={x.text} />
          ))}
        </datalist>
      </div>
    </>
  );
}

function QuestionBody({
  question,
  snapshot,
  client,
  refresh,
  notify,
  pushUndo,
  onNavigate,
}: {
  question: QuestionView;
  snapshot: Snapshot;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
}) {
  // Tie the question to a source (owner request, 2026-07-19): raised-by / answered-by from
  // the question's own pane — the RAISES/ANSWERS provenance edges, source → question.
  const [tieWord, setTieWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  const [tieTitle, setTieTitle] = useState('');
  const addTie = async () => {
    const value = tieTitle.trim();
    if (!value) return;
    // Resolve a source by title first, then a snippet by its text — one row ties either kind.
    const src = snapshot.sources.find((x) => x.title.toLowerCase() === value.toLowerCase());
    const snp = src === undefined ? snapshot.snippets.find((x) => x.text.toLowerCase() === value.toLowerCase()) : undefined;
    const other = src !== undefined ? { kind: 'source', id: src.id, label: src.title } : snp !== undefined ? { kind: 'snippet', id: snp.id, label: snp.text } : undefined;
    if (other === undefined) {
      notify(`No source or snippet matching “${value.slice(0, 40)}”`);
      return;
    }
    const edge = { srcType: other.kind, srcId: other.id, type: tieWord, dstType: 'question', dstId: question.id, tags: [] };
    try {
      await client.link(edge);
      await refresh();
      setTieTitle('');
      pushUndo(`tie ${tieWord.toLowerCase()} → question`, () => client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId }));
      notify(`${tieWord === 'RAISES' ? 'Raised by' : 'Answered by'} “${other.label.slice(0, 40)}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="detail-tags">
        {question.about.map((c) => (
          <span key={c} className="chip">
            {c}
          </span>
        ))}
        {question.gap && (
          <span className="chip" style={{ color: 'var(--k-snippet)' }} title="no source or snippet in your library answers this question yet">
            no answer in your library
          </span>
        )}
        {question.answered && <span className="chip" style={{ color: 'var(--ok)' }}>answered ✓</span>}
      </div>
      {question.raisedBy.length > 0 && (
        <>
          <div className="detail-section">Raised by</div>
          <div className="connections">
            {question.raisedBy.map((a) => (
              <button key={a.id} className="connection" onClick={() => onNavigate(a.id)}>
                <span className="connection-type">raised by</span>
                <span style={{ color: `var(--k-${a.kind})` }}>{kindIcon(a.kind)}</span>
                <span className="connection-target">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="detail-section">Answered by</div>
      {question.answeredBy.length === 0 ? (
        <p className="hint" style={{ padding: 0 }}>no answers yet — link a snippet or source</p>
      ) : (
        <div className="connections">
          {question.answeredBy.map((a) => (
            <button key={a.id} className="connection" onClick={() => onNavigate(a.id)}>
              <span className="connection-type">answered by</span>
              <span style={{ color: `var(--k-${a.kind})` }}>{kindIcon(a.kind)}</span>
              <span className="connection-target">{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="order-addrow">
        <select className="order-pick" value={tieWord} onChange={(e) => setTieWord(e.target.value as 'RAISES' | 'ANSWERS')}>
          <option value="RAISES">raised by</option>
          <option value="ANSWERS">answered by</option>
        </select>
        <input
          className="order-input"
          list="question-tie-sources"
          placeholder="a source’s title or a snippet’s text…"
          value={tieTitle}
          onChange={(e) => setTieTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTie();
          }}
        />
        <button className="link-btn" disabled={!tieTitle.trim()} onClick={() => void addTie()}>
          + Link
        </button>
        <datalist id="question-tie-sources">
          {snapshot.sources.map((x) => (
            <option key={x.id} value={x.title} />
          ))}
          {snapshot.snippets.map((x) => (
            <option key={x.id} value={x.text} />
          ))}
        </datalist>
      </div>
    </>
  );
}

/** A track and its ordered member sources (feedback round 3) — on a SOURCE detail the header
 *  links to the track and the current source is highlighted; on the TRACK detail itself
 *  the header is dropped (the page title already names it) and the section reads "Sources". */
function TrackPath({
  track,
  snapshot,
  currentId,
  showHeader = true,
  sectionLabel = 'Track',
  onNavigate,
  onRemoveMember,
  onMoveMember,
}: {
  track: { id: string; title: string; sourceIds: string[]; sourceLevels?: string[][]; precedes?: { srcId: string; dstId: string }[] };
  snapshot: Snapshot;
  currentId?: string;
  showHeader?: boolean;
  sectionLabel?: string;
  onNavigate: (id: string) => void;
  /** Present → each member row gets a remove-×: un-assert the INCLUDES (the source itself
   *  stays in the library). Owner request, 2026-07-18. */
  onRemoveMember?: (sourceId: string) => void;
  /** Present → ↑/↓ per row (the Library track editor's precise reordering). */
  onMoveMember?: (sourceId: string, dir: -1 | 1) => void;
}) {
  const titleById = new Map(snapshot.sources.map((s) => [s.id, s.title]));
  const authorById = new Map(snapshot.sources.filter((s) => s.author !== undefined).map((s) => [s.id, s.author!]));
  // Display in the TOPO order the engine derives (levels flattened); without PRECEDES edges
  // that's exactly the INCLUDES order.
  const orderedRows = orderedSources({ sourceIds: track.sourceIds, sourceLevels: track.sourceLevels ?? [], precedes: track.precedes });
  const ordered = orderedRows.map((o) => o.id);
  const unorderedIds = new Set(orderedRows.filter((o) => o.unordered).map((o) => o.id));
  // On a source detail (showHeader), the ordered list only earns its place when the track
  // has more than the current source — otherwise it's a one-item list highlighting the source
  // you're already looking at ("its own track"). On the track detail (no header) always
  // list, since that's the track's own contents.
  const listSources = !showHeader || track.sourceIds.length > 1;
  return (
    <>
      <div className="detail-section">{sectionLabel}</div>
      {showHeader && (
        <button className="track-path-head" onClick={() => onNavigate(track.id)}>
          <span style={{ color: 'var(--k-track)' }}>
            <Icon name="track" />
          </span>
          {track.title}
        </button>
      )}
      {isConceptAnchored(track) ? (
        <p className="hint" style={{ padding: 0 }}>no member sources — a concept-anchored track derives its reading</p>
      ) : listSources ? (
        <ol className="track-path">
          {ordered.map((sid, i) => (
            <li key={sid} className="path-row">
              <button className={sid === currentId ? 'path-source current' : 'path-source'} onClick={() => onNavigate(sid)}>
                <span className="path-num" title={unorderedIds.has(sid) ? 'unordered — reorder to give it a place' : undefined}>{unorderedIds.has(sid) ? '·' : i + 1}</span>
                <span className="path-texts">
                  <span className="connection-target">{titleById.get(sid) ?? sid}</span>
                  {authorById.has(sid) && <span className="path-author">{shortAuthors(authorById.get(sid)!)}</span>}
                </span>
              </button>
              {onMoveMember && (
                <span className="path-move">
                  <button className="path-x" title="move up" disabled={i === 0} onClick={() => onMoveMember(sid, -1)}>↑</button>
                  <button className="path-x" title="move down" disabled={i === ordered.length - 1} onClick={() => onMoveMember(sid, 1)}>↓</button>
                </span>
              )}
              {onRemoveMember && (
                <button className="path-x" title="remove from this track (the source itself stays)" onClick={() => onRemoveMember(sid)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

/** The Library track editor's add row (owner ruling, 2026-07-18: Journey's drag stays
 *  experimental — membership is managed HERE). Pick any non-member source by title; it joins
 *  at the end of the reading order. */
function AddMemberRow({
  track,
  snapshot,
  onAdd,
}: {
  track: { id: string; title: string; sourceIds: string[] };
  snapshot: Snapshot;
  onAdd: (sourceId: string) => void;
}) {
  const [name, setName] = useState('');
  const candidates = snapshot.sources.filter((s) => !track.sourceIds.includes(s.id));
  const match = candidates.find((s) => s.title.toLowerCase() === name.trim().toLowerCase());
  const submit = () => {
    if (!match) return;
    onAdd(match.id);
    setName('');
  };
  return (
    <div className="anchor-add">
      <input
        list="pm-track-add-sources"
        value={name}
        placeholder="add a source by title…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setName('');
        }}
      />
      <datalist id="pm-track-add-sources">
        {candidates.map((s) => (
          <option key={s.id} value={s.title} />
        ))}
      </datalist>
      <button className="link-btn" disabled={!match} onClick={submit}>
        + Add
      </button>
    </div>
  );
}

/** Include a concept in the track (owner request, 2026-07-20) — the By-concept view's
 *  counterpart of AddMemberRow. INCLUDES track→concept; creates the concept if unseen. */
function AddConceptRow({
  concepts,
  includedIds,
  onAdd,
}: {
  concepts: { id: string; name: string }[];
  includedIds: Set<string>;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const candidates = concepts.filter((c) => !includedIds.has(c.id));
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name.trim());
    setName('');
  };
  return (
    <div className="anchor-add">
      <input
        list="pm-track-add-concepts"
        value={name}
        placeholder="include a concept by name…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setName('');
        }}
      />
      <datalist id="pm-track-add-concepts">
        {candidates.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <button className="link-btn" disabled={!name.trim()} onClick={submit}>
        + Add
      </button>
    </div>
  );
}

/** The compact topic listing (rail scale) — TrackBody's By-concept view AND the
 *  concept-track section a non-member source shows (owner request, 2026-07-20).
 *  `highlightId` marks one source row the way TrackPath marks the current member. */
function RailTopics({ topics, onNavigate, highlightId }: { topics: TopicGroup[]; onNavigate: (id: string) => void; highlightId?: string }) {
  return (
    <div className="rail-topics">
      {topics.map((g, i) => (
        <div key={g.conceptId} className="rail-topic">
          <button className="rail-topic-head" onClick={() => onNavigate(g.conceptId)}>
            <span className="rail-topic-n">{i + 1}</span>
            <Icon name="concept" size={14} />
            {g.conceptName}
          </button>
          {g.sources.map(({ source: src, ties }) => (
            <div key={src.id} className={src.id === highlightId ? 'rail-topic-source on' : 'rail-topic-source'}>
              {/* Title with the author STACKED beneath it; the tie chips sit to the RIGHT when
                  the row has room and wrap below it when it doesn't (owner request, 2026-07-21 —
                  right-justified authors read badly). */}
              <button className="rail-topic-title" onClick={() => onNavigate(src.id)}>
                <Icon name={sourceIcon(src.modality)} size={13} />
                <span className="rail-topic-texts">
                  <span>{src.title}</span>
                  {src.author && <span className="rail-topic-author">{shortAuthors(src.author)}</span>}
                </span>
              </button>
              {ties.length > 0 && (
                <div className="rail-topic-chips">
                  {ties.map((t) => (
                    <button key={t.id} className="outline-cchip" onClick={() => onNavigate(t.id)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The track detail body (feedback round 3): its goal, editable tags, concept members as
 *  chips, and its ordered source list — the same reading-path view a source shows, now for the
 *  track itself (replacing the wall of "includes →" connection rows). */
function TrackBody({
  track,
  snapshot,
  conceptMembers,
  projection,
  client,
  refresh,
  notify,
  onNavigate,
  onRemoveMember,
  onMoveMember,
  onAddMember,
  pushUndo,
}: {
  track: { id: string; title: string; goal?: string; tags: string[]; sourceIds: string[]; sourceLevels?: string[][]; published?: { at: number; license: string } };
  snapshot: Snapshot;
  conceptMembers: Relation[];
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  onNavigate: (id: string) => void;
  onRemoveMember: (sid: string) => void;
  onMoveMember: (sid: string, dir: -1 | 1) => void;
  onAddMember: (sid: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
}) {
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
    try {
      await client.unlink({ srcId: track.id, type: 'INCLUDES', dstId: conceptId });
      await refresh();
      pushUndo(`un-include “${name.slice(0, 30)}”`, () => client.link({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'concept', dstId: conceptId }));
      notify(`Removed “${name}” from the track — the concept stays`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
      <TagEditor id={track.id} tags={track.tags} client={client} refresh={refresh} notify={notify} pushUndo={pushUndo} />

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

/** Reading order (owner request, 2026-07-19) — source→source prerequisites, independent of
 *  any track: "read A before B" as a global PRECEDES edge. The Outline/rail topic groups and
 *  member-track paths already respect these when ordering. PRECEDES is folded out of the
 *  generic Connections list, so this section is where the edges live: list, unlink, add. */
function ReadingOrder({
  source,
  precedes,
  snapshot,
  client,
  refresh,
  notify,
  pushUndo,
  onNavigate,
}: {
  source: SourceView;
  precedes: Relation[];
  snapshot: Snapshot;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
}) {
  const [dir, setDir] = useState<'after' | 'before'>('after');
  const [title, setTitle] = useState('');
  const add = async () => {
    const value = title.trim();
    if (!value) return;
    const other = snapshot.sources.find((s) => s.id !== source.id && s.title.toLowerCase() === value.toLowerCase());
    if (!other) {
      notify(`No other source titled “${value}” — reading order ties existing sources`);
      return;
    }
    // after: the other source comes first (other PRECEDES this); before: the reverse.
    const edge =
      dir === 'after'
        ? { srcType: 'source', srcId: other.id, type: 'PRECEDES', dstType: 'source', dstId: source.id, tags: [] }
        : { srcType: 'source', srcId: source.id, type: 'PRECEDES', dstType: 'source', dstId: other.id, tags: [] };
    try {
      await client.link(edge);
      await refresh();
      setTitle('');
      pushUndo(`reading order → “${other.title.slice(0, 30)}”`, () => client.unlink({ srcId: edge.srcId, type: 'PRECEDES', dstId: edge.dstId }));
      notify(`Reads ${dir} “${other.title.slice(0, 40)}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const drop = async (r: Relation) => {
    const edge = { ...relationEdge({ id: source.id, kind: 'source' }, r), ...(r.trackContextId !== undefined ? { trackContextId: r.trackContextId } : {}) };
    try {
      // Scoped pairs need their context or the unlink silently misses (owner bug report).
      await client.unlink({ srcId: edge.srcId, type: 'PRECEDES', dstId: edge.dstId, ...(r.trackContextId !== undefined ? { trackContextId: r.trackContextId } : {}) });
      await refresh();
      pushUndo(`unlink reading order`, () => client.link(edge));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="detail-section">Reading order</div>
      {[...precedes].sort((a, b) => (a.direction === b.direction ? a.otherLabel.localeCompare(b.otherLabel) : a.direction === 'in' ? -1 : 1)).map((r) => (
        <div key={`${r.direction}-${r.otherId}-${r.trackContextId ?? ''}`} className="order-row">
          <span className="order-dir">{r.direction === 'out' ? 'reads before' : 'reads after'}</span>
          <button className="next-title" onClick={() => onNavigate(r.otherId)}>
            {r.otherLabel}
          </button>
          {r.trackContextId !== undefined && (
            <span className="order-scope" title="a track's path ordering, not a global reading-order edge">
              in {snapshot.tracks.find((t) => t.id === r.trackContextId)?.title ?? 'a track'}
            </span>
          )}
          <button className="chip-x" title="unlink" onClick={() => void drop(r)}>
            ×
          </button>
        </div>
      ))}
      <div className="order-addrow">
        <select className="order-pick" value={dir} onChange={(e) => setDir(e.target.value as 'after' | 'before')}>
          <option value="after">reads after</option>
          <option value="before">reads before</option>
        </select>
        <input
          className="order-input"
          list="order-sources"
          placeholder="another source’s title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button className="link-btn" disabled={!title.trim()} onClick={() => void add()}>
          + Link
        </button>
        <datalist id="order-sources">
          {snapshot.sources.filter((s) => s.id !== source.id).map((s) => (
            <option key={s.id} value={s.title} />
          ))}
        </datalist>
      </div>
    </>
  );
}

/** Next reading (owner design, 2026-07-19) — the two live moves from a source inside a
 *  concept-anchored track: go DEEPER (shared concept, then descendant concepts) or go WIDER
 *  (different concept in the topic, then a later topic). Derived per track family, skips
 *  consumed sources, and always names the concept that justifies the recommendation. */
function NextReading({
  source,
  snapshot,
  projection,
  onNavigate,
}: {
  source: SourceView;
  snapshot: Snapshot;
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  onNavigate: (id: string) => void;
}) {
  const perTrack: { trackId: string; title: string; moves: NextMoves }[] = useMemo(() => {
    if (!projection) return [];
    return snapshot.tracks
      .map((t) => ({ trackId: t.id, title: t.title, moves: nextMoves(projection.asm, projection.graph, t.id, snapshot.sources, source.id) }))
      .filter((x): x is { trackId: string; title: string; moves: NextMoves } => x.moves !== undefined);
  }, [projection, snapshot.tracks, snapshot.sources, source.id]);

  if (perTrack.length === 0) return null;

  const moveRow = (label: string, icon: React.ReactNode, m: NextMove | undefined) =>
    m && (
      <div className="next-move">
        <div className="next-move-head">
          {icon}
          <span className="next-label">{label} in</span>
          <button className="outline-cchip" onClick={() => onNavigate(m.viaId)} title="the concept behind this recommendation">
            {m.topicIndex !== undefined ? `Topic ${m.topicIndex} · ${m.viaName}` : m.viaName}
          </button>
        </div>
        <button className="next-title" onClick={() => onNavigate(m.source.id)}>
          {m.source.title}
        </button>
      </div>
    );

  return (
    <>
      <div className="detail-section">Next reading</div>
      {perTrack.map(({ trackId, title, moves }) => (
        <div key={trackId} className="next-moves">
          {perTrack.length > 1 && <div className="next-track">{title}</div>}
          {moves.frontier ? (
            <p className="hint" style={{ padding: 0, fontSize: 12 }}>frontier reached — nothing unconsumed deeper or wider in “{title}”</p>
          ) : (
            <>
              {moveRow('Go deeper', <CaretDoubleDown size={14} />, moves.deeper)}
              {moveRow('Go wider', <CaretDoubleRight size={14} />, moves.wider)}
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** Publishing controls (owner placements, 2026-07-18: the LAST block of the pane, just above
 *  View-in-map/Remove). Publish/unpublish, the public link, and the registry push. */
function TrackPublishing({
  track,
  conceptAnchored,
  client,
  refresh,
  notify,
}: {
  track: { id: string; title: string; published?: { at: number; license: string } };
  /** Concepts-only membership: the publication carries the concept-anchored reading list. */
  conceptAnchored?: boolean;
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
}) {
  // Publishing (publish plan P2, workbench affordance from the PB-S5 ledger). The act stays
  // explicit and informed (DATA_GOVERNANCE 2): the confirm panel names the license and states
  // what is and is not included before anything happens.
  const [publishOpen, setPublishOpen] = useState(false);
  const [license, setLicense] = useState('CC-BY-SA-4.0');
  const publicUrl = `${window.location.origin}/t/${track.id}`;
  const doPublish = async () => {
    try {
      await client.publish(track.id, license.trim());
      setPublishOpen(false);
      await refresh();
      notify('Published ✓ — the public page is live');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  // Push to a registry (track registry, 2026-07-18): the server does the outbound POST; the
  // registry URL is a workbench setting, remembered once entered.
  const [registry, setRegistry] = useState(() => localStorage.getItem('pm.registry') ?? '');
  const [pushing, setPushing] = useState(false);
  const doPush = async () => {
    const url = registry.trim().replace(/\/$/, '');
    if (!url) return;
    localStorage.setItem('pm.registry', url);
    setPushing(true);
    try {
      const r = await client.pushToRegistry(track.id, url);
      notify(`${r.updated ? 'Updated on' : 'Published to'} the registry ✓ — ${r.url}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
    }
  };

  const doUnpublish = async () => {
    try {
      await client.unpublish(track.id);
      await refresh();
      notify('Unpublished — distribution stopped; copies made while public persist');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="detail-section">Publishing</div>
      {track.published ? (
        <div className="publish-box">
          <div className="publish-state">
            <span className="publish-live">● public</span>
            <span>{track.published.license}</span>
            <span>since {new Date(track.published.at).toISOString().slice(0, 10)}</span>
          </div>
          <div className="publish-actions">
            <a className="link-btn" href={publicUrl} target="_blank" rel="noreferrer">
              Open public page ↗
            </a>
            <button className="link-btn" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => notify('Link copied ✓'))}>
              Copy link
            </button>
            <button className="link-btn publish-stop" title="stops distribution; copies made while public persist" onClick={() => void doUnpublish()}>
              Unpublish
            </button>
          </div>
          <div className="publish-actions registry-row">
            <input
              className="detail-field registry-url"
              value={registry}
              placeholder="registry URL (https://…)"
              title="a track registry to push this publication to — the public commons"
              onChange={(e) => setRegistry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doPush();
              }}
            />
            <button className="link-btn publish-go" disabled={registry.trim() === '' || pushing} onClick={() => void doPush()}>
              {pushing ? 'Pushing…' : 'Push to registry'}
            </button>
          </div>
        </div>
      ) : publishOpen ? (
        <div className="publish-box">
          <p className="publish-terms">
            Publishing puts this track's <strong>content</strong> — its concepts, sources, snippets, and questions — on a
            public page under the license below. Your private world stays home: notes, sentiments, progress, and personal
            links are never included. Unpublishing later stops distribution, but copies made while public persist.
          </p>
          {conceptAnchored === true && (
            <p className="publish-terms">
              This is a <strong>concepts-only</strong> track: the publication carries its concept topics <em>and every
              source tied to those concepts</em> (the reading list you see in the By-concept view), including their
              reading order.
            </p>
          )}
          <div className="publish-actions">
            <input
              className="detail-field publish-license"
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              title="the license stamped on this publication"
            />
            <button className="link-btn publish-go" onClick={() => void doPublish()}>
              <GitBranch size={14} /> Publish
            </button>
            <button className="link-btn" onClick={() => setPublishOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="publish-actions">
          <button className="link-btn" onClick={() => setPublishOpen(true)}>
            <GitBranch size={14} /> Publish…
          </button>
        </div>
      )}
    </>
  );
}

/** One row per relation — the neighbour is repeated when several edge types connect the same two
 *  entities (reverted from the stacked form on feedback: the per-edge rows read better). */
function Connections({ relations, onNavigate }: { relations: Relation[]; onNavigate: (id: string) => void }) {
  if (relations.length === 0) return null;
  const rows = [...relations].sort((a, b) => a.otherLabel.localeCompare(b.otherLabel) || a.type.localeCompare(b.type));
  return (
    <>
      <div className="detail-section">Connections</div>
      <div className="connections">
        {rows.map((r) => {
          const word = relationWord(r.type, r.tags);
          return (
            <button key={`${r.type}-${r.direction}-${r.otherId}`} className="connection" onClick={() => onNavigate(r.otherId)}>
              <span className="connection-type">{r.direction === 'out' ? `${word} →` : `← ${word}`}</span>
              <span style={{ color: `var(--k-${r.otherKind})` }}>{kindIcon(r.otherKind)}</span>
              <span className="connection-target">{r.otherLabel}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}


/**
 * Apply concepts to a source or snippet (owner request, 2026-07-17): the workbench's write
 * path for the anchoring edges — source ABOUT #Explains/#Demonstrates/#Exercises, snippet
 * CLARIFIES/CONTRADICTS (the polarity pair). Existing anchors render here (and leave the
 * generic Connections list); adding resolves the concept by name — creating it first when
 * new, with the id looked up from /graph (the server owns id derivation). No un-anchor:
 * edges have no ids yet (ROADMAP — edge retraction rides the assertion layer).
 */
function ConceptAnchors({
  kind,
  id,
  anchored,
  concepts,
  client,
  refresh,
  notify,
  pushUndo,
  onNavigate,
}: {
  kind: 'source' | 'snippet';
  id: string;
  anchored: Relation[];
  concepts: { id: string; name: string; tracked: boolean }[];
  client: EngineClient;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
}) {
  const flavors =
    kind === 'source'
      ? ABOUT_TAGS.map((t) => ({ value: t, label: t.toLowerCase() }))
      : [
          { value: 'CLARIFIES', label: 'clarifies' },
          { value: 'CONTRADICTS', label: 'contradicts' },
        ];
  const [flavor, setFlavor] = useState(flavors[0]!.value);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const concept = await resolveOrCreateConcept(client, concepts, trimmed);
      const edge =
        kind === 'source'
          ? { srcType: 'source', srcId: id, type: 'ABOUT', dstType: 'concept', dstId: concept.id, tags: [{ name: flavor }] }
          : { srcType: 'snippet', srcId: id, type: flavor, dstType: 'concept', dstId: concept.id, tags: [] };
      await client.link(edge);
      await refresh();
      setName('');
      pushUndo(`link → “${concept.name}”`, async () => {
        await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
        if (concept.created) await client.remove(concept.id); // undo the whole gesture
      });
      notify(`${flavors.find((f) => f.value === flavor)?.label} → “${concept.name}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="detail-section">Concepts</div>
      <div className="detail-tags">
        {anchored.map((r) => (
          <button
            key={`${r.type}-${r.otherId}`}
            className="chip concept"
            title={`${relationWord(r.type, r.tags)} — open concept`}
            onClick={() => onNavigate(r.otherId)}
          >
            {relationWord(r.type, r.tags)} → {r.otherLabel}
            <span
              className="chip-x"
              title="remove this relation"
              onClick={(e) => {
                e.stopPropagation();
                const edge = relationEdge({ id, kind }, r);
                void (async () => {
                  try {
                    await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
                    await refresh();
                    pushUndo(`unlink “${r.otherLabel}”`, () => client.link(edge));
                    notify(`Removed relation to “${r.otherLabel}”`);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : String(err));
                  }
                })();
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <div className="anchor-add">
        <select value={flavor} onChange={(e) => setFlavor(e.target.value)} title="how this anchors to the concept">
          {flavors.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          list="pm-concept-names"
          value={name}
          placeholder="concept name…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
            if (e.key === 'Escape') setName('');
          }}
        />
        <datalist id="pm-concept-names">
          {concepts.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        <button className="link-btn" disabled={!name.trim() || busy} onClick={() => void add()}>
          + Link
        </button>
      </div>
    </>
  );
}
