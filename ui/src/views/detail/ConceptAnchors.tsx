import { useAction, useEngine } from '../../engine-context';
import { ABOUT_TAGS } from '../../lib/concepts';
import { anchorConcepts } from '../../lib/ties';
import { relationWord } from '../../lib/relations';
import { useState } from 'react';
import type { Relation } from '../../client/types';
import { Connections } from './Connections';
import { PickerBox } from './PickerBox';

/**
 * Apply concepts to a source or snippet: the workbench's write
 * path for the anchoring edges — source ABOUT #Explains/#Demonstrates/#Exercises, snippet
 * CLARIFIES/CONTRADICTS (the polarity pair). Existing anchors render here (and leave the
 * generic Connections list); adding resolves the concept by name — creating it first when
 * new, with the id looked up from /graph (the server owns id derivation). No un-anchor:
 * edges have no ids yet.
 */
export function ConceptAnchors({
  kind,
  id,
  concepts,
}: {
  kind: 'source' | 'snippet';
  id: string;
  concepts: { id: string; name: string; tracked: boolean }[];
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const flavors =
    kind === 'source'
      ? ABOUT_TAGS.map((t) => ({ value: t, label: t.toLowerCase() }))
      : [
          { value: 'CLARIFIES', label: 'clarifies' },
          { value: 'CONTRADICTS', label: 'contradicts' },
        ];
  const [flavor, setFlavor] = useState(flavors[0]!.value);


  // Link one or more concepts at the chosen flavor, as ONE undoable batch (
  // the same multiselect+create palette as the track pickers).
  const addConcepts = async (names: string[]) => {
    // ONE gesture implementation (lib/ties.anchorConcepts) — shared with the concept rail's
    // mirror adder, so the two ends of this edge cannot drift.
    await act(() => anchorConcepts(client, { kind, id }, names, flavor, concepts), `Linked ${names.length === 1 ? 'a concept' : `${names.length} concepts`} ✓`);
  };
  // No already-anchored filter: several flavors may tie the
  // same pair, and re-adding an existing flavor is a harmless engine no-op.
  const conceptOptions = concepts.map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));

  return (
    <>
      <div className="anchor-picker">
        <select className="anchor-flavor" value={flavor} onChange={(e) => setFlavor(e.target.value)} title="how this anchors to the concept">
          {flavors.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <PickerBox
          options={conceptOptions}
          placeholder="add a concept…"
          variant="concept"
          onPick={(names) => void addConcepts(names)}
          onCreate={(name) => void addConcepts([name])}
        />
      </div>
    </>
  );
}
