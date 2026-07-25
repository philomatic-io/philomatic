import { sourceIcon } from '../../components/Icon';
import { useAction, useEngine } from '../../engine-context';
import { relationEdge } from '../../lib/concepts';
import { useState } from 'react';
import type { Relation, Snapshot, SourceView } from '../../client/types';
import { PickerBox } from './PickerBox';

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
  const options = snapshot.sources
    .filter((s) => s.id !== source.id)
    .map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }));
  // Tie reading order to one or more other sources at the chosen direction — ONE undoable batch
  // (owner, 2026-07-24: the same palette picker as the track view).
  const addOrder = async (otherIds: string[]) => {
    await act(async () => {
      // after: the other source comes first (other PRECEDES this); before: the reverse.
      const edges = otherIds.map((oid) =>
        dir === 'after'
          ? { srcType: 'source', srcId: oid, type: 'PRECEDES', dstType: 'source', dstId: source.id, tags: [] }
          : { srcType: 'source', srcId: source.id, type: 'PRECEDES', dstType: 'source', dstId: oid, tags: [] },
      );
      for (const edge of edges) await client.link(edge);
      return {
        label: `reading order (${edges.length})`,
        invert: async () => {
          for (const edge of edges) await client.unlink({ srcId: edge.srcId, type: 'PRECEDES', dstId: edge.dstId });
        },
      };
    }, `Reads ${dir} ${otherIds.length === 1 ? 'a source' : `${otherIds.length} sources`} ✓`);
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
      <div className="anchor-picker">
        <select className="anchor-flavor" value={dir} onChange={(e) => setDir(e.target.value as 'after' | 'before')}>
          <option value="after">reads after</option>
          <option value="before">reads before</option>
        </select>
        <PickerBox options={options} placeholder="another source…" variant="order" onPick={(ids) => void addOrder(ids)} />
      </div>
    </>
  );
}
