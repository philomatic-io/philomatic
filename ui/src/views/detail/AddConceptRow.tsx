import { useState } from 'react';
import { AddMemberRow } from './TrackPath';

/** Include a concept in the track (owner request, 2026-07-20) — the By-concept view's
 *  counterpart of AddMemberRow. INCLUDES track→concept; creates the concept if unseen. */
export function AddConceptRow({
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
