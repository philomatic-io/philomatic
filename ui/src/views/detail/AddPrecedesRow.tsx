import { useState } from 'react';
import { useAction, useEngine } from '../../engine-context';
import { sourceIcon } from '../../components/Icon';
import type { Snapshot } from '../../client/types';
import { PickerBox } from './PickerBox';

/**
 * The Sources-group adder on a source page: reading-order
 * ties in the language of record — "reads before" / "reads after". Global PRECEDES edges,
 * exactly as the retired ReadingOrder editor wrote them; the rows render as connections.
 */
export function AddPrecedesRow({ sourceId, snapshot }: { sourceId: string; snapshot: Snapshot }) {
  const { client } = useEngine();
  const act = useAction();
  const [word, setWord] = useState<'reads before' | 'reads after'>('reads after');
  const options = snapshot.sources.filter((s) => s.id !== sourceId).map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }));
  const tie = async (ids: string[]) => {
    if (ids.length === 0) return;
    await act(async () => {
      // "this reads after X" = X PRECEDES this; "this reads before X" = this PRECEDES X.
      const edges = ids.map((other) =>
        word === 'reads after'
          ? { srcType: 'source', srcId: other, type: 'PRECEDES', dstType: 'source', dstId: sourceId, tags: [] }
          : { srcType: 'source', srcId: sourceId, type: 'PRECEDES', dstType: 'source', dstId: other, tags: [] },
      );
      for (const e of edges) await client.link(e);
      return {
        label: `${word} ${edges.length === 1 ? 'a source' : `${edges.length} sources`}`,
        invert: async () => {
          for (const e of edges) await client.unlink({ srcId: e.srcId, type: 'PRECEDES', dstId: e.dstId });
        },
      };
    }, `${word} ${ids.length === 1 ? 'a source' : `${ids.length} sources`} ✓`);
  };
  return (
    <div className="anchor-picker">
      <select className="anchor-flavor" value={word} onChange={(e) => setWord(e.target.value as typeof word)} title="reading order relative to this source">
        <option value="reads after">reads after</option>
        <option value="reads before">reads before</option>
      </select>
      <PickerBox options={options} placeholder="order against a source…" variant="source" onPick={(ids) => void tie(ids)} />
    </div>
  );
}
