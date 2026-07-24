import { useAction, useEngine } from '../../engine-context';
import { ABOUT_TAGS, relationEdge, resolveOrCreateConcept } from '../../lib/concepts';
import { relationWord } from '../../lib/relations';
import { useState } from 'react';
import type { Relation } from '../../client/types';
import { Connections } from './Connections';

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
