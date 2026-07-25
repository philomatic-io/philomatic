import { useAction, useEngine } from '../../engine-context';
import { ABOUT_TAGS, relationEdge, resolveOrCreateConcept } from '../../lib/concepts';
import { relationWord } from '../../lib/relations';
import { useState } from 'react';
import type { Relation } from '../../client/types';
import { Connections } from './Connections';
import { PickerBox } from './PickerBox';

/**
 * Apply concepts to a source or snippet (owner request, 2026-07-17): the workbench's write
 * path for the anchoring edges — source ABOUT #Explains/#Demonstrates/#Exercises, snippet
 * CLARIFIES/CONTRADICTS (the polarity pair). Existing anchors render here (and leave the
 * generic Connections list); adding resolves the concept by name — creating it first when
 * new, with the id looked up from /graph (the server owns id derivation). No un-anchor:
 * edges have no ids yet (ROADMAP — edge retraction rides the assertion layer).
 */
export function ConceptAnchors({
  kind,
  id,
  anchored,
  concepts,
  onNavigate,
}: {
  kind: 'source' | 'snippet';
  id: string;
  anchored: Relation[];
  concepts: { id: string; name: string; tracked: boolean }[];
  onNavigate: (id: string) => void;
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

  const edgeFor = (conceptId: string) =>
    kind === 'source'
      ? { srcType: 'source', srcId: id, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: flavor }] }
      : { srcType: 'snippet', srcId: id, type: flavor, dstType: 'concept', dstId: conceptId, tags: [] };

  // Link one or more concepts at the chosen flavor, as ONE undoable batch (owner, 2026-07-24:
  // the same multiselect+create palette as the track pickers).
  const addConcepts = async (names: string[]) => {
    await act(async () => {
      const made: { conceptId: string; created: boolean; edge: ReturnType<typeof edgeFor> }[] = [];
      for (const nm of names) {
        const concept = await resolveOrCreateConcept(client, concepts, nm);
        const edge = edgeFor(concept.id);
        await client.link(edge);
        made.push({ conceptId: concept.id, created: concept.created, edge });
      }
      return {
        label: `link ${made.length === 1 ? 'a concept' : `${made.length} concepts`}`,
        invert: async () => {
          for (const m of made) {
            await client.unlink({ srcId: m.edge.srcId, type: m.edge.type, dstId: m.edge.dstId });
            if (m.created) await client.remove(m.conceptId);
          }
        },
      };
    }, `Linked ${names.length === 1 ? 'a concept' : `${names.length} concepts`} ✓`);
  };
  const anchoredIds = new Set(anchored.map((r) => r.otherId));
  const conceptOptions = concepts
    .filter((c) => !anchoredIds.has(c.id))
    .map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));

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
