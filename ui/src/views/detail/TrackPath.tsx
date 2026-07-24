import { Icon } from '../../components/Icon';
import { shortAuthors } from '../../lib/items';
import { orderedSources } from '../../lib/order';
import { isConceptAnchored } from '../../lib/topics';
import { useState } from 'react';
import type { Snapshot } from '../../client/types';

/** A track and its ordered member sources (feedback round 3) — on a SOURCE detail the header
 *  links to the track and the current source is highlighted; on the TRACK detail itself
 *  the header is dropped (the page title already names it) and the section reads "Sources". */
export function TrackPath({
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
export function AddMemberRow({
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
