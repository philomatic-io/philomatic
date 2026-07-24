import { useAction, useEngine } from '../../engine-context';
import { relationEdge } from '../../lib/concepts';
import { useState } from 'react';
import type { Relation, Snapshot, SourceView } from '../../client/types';
import { Connections } from './Connections';

/** Reading order (owner request, 2026-07-19) — source→source prerequisites, independent of
 *  any track: "read A before B" as a global PRECEDES edge. The Outline/rail topic groups and
 *  member-track paths already respect these when ordering. PRECEDES is folded out of the
 *  generic Connections list, so this section is where the edges live: list, unlink, add. */
export function ReadingOrder({
  source,
  precedes,
  snapshot,
  onNavigate,
}: {
  source: SourceView;
  precedes: Relation[];
  snapshot: Snapshot;
  onNavigate: (id: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
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
