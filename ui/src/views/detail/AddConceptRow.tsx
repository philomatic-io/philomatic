import { PickerBox } from './PickerBox';

/** Include a concept in the track — the concept counterpart of the
 *  source palette: the same purple box, opening into concept boxes with the
 *  ◇ glyph. Typing filters, and CREATES the concept if it's new (INCLUDES track→concept). */
export function AddConceptRow({
  concepts,
  includedIds,
  onAdd,
}: {
  concepts: { id: string; name: string }[];
  includedIds: Set<string>;
  /** Include these concepts by NAME (resolve-or-create) — one or many at a time. */
  onAdd: (names: string[]) => void;
}) {
  // onAdd takes NAMES (resolve-or-create), so the option id is the concept name.
  const options = concepts
    .filter((c) => !includedIds.has(c.id))
    .map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));
  return <PickerBox options={options} placeholder="add a concept…" variant="concept" onPick={onAdd} onCreate={(name) => onAdd([name])} />;
}
