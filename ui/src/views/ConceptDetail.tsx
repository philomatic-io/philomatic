/**
 * Concept detail — shown when a concept node is selected in the Map (concepts aren't browsable
 * items, but they are selectable from the graph). Its typed connections come from the same
 * relations projection every entity uses.
 */
import { useEffect, useState } from 'react';
import { Star } from '@phosphor-icons/react';
import { useEngine, useAction } from '../engine-context';
import { relationWord } from '../lib/relations';
import { ABOUT_TAGS, relationEdge, resolveOrCreateConcept } from '../lib/concepts';
import { TagEditor } from './detail/TagEditor';
import { TitleEditor } from './detail/TitleEditor';
import { PickerBox } from './detail/PickerBox';
import type { NodeKind, Relation, Snapshot } from '../client/types';
import { Icon, sourceIcon } from '../components/Icon';
import { FRAMEWORKS } from '../generated/framework';

/** Concept↔concept LINK vocabulary — declared by the frameworks, never hardcoded. */
interface EdgeTagView {
  name: string;
  on: { type: string; srcKind?: string; dstKind?: string };
}
const CONCEPT_LINK_TAGS: string[] = FRAMEWORKS.flatMap((f): readonly EdgeTagView[] => f.edgeTags)
  .filter((t) => t.on.type === 'LINK' && t.on.srcKind === 'concept' && t.on.dstKind === 'concept')
  .map((t) => t.name);

const kindIcon = (kind: NodeKind) => <Icon name={kind === 'source' ? sourceIcon('text') : kind} />;

export function ConceptDetail({
  concept,
  concepts,
  snapshot,
  onNavigate,
  onViewInMap,
}: {
  concept: { id: string; name: string; tracked: boolean; tags: string[] };
  /** The whole concept list — the tie editor's picker. */
  concepts: { id: string; name: string; tracked: boolean }[];
  /** Source titles for the anchor editor's picker. */
  snapshot: Snapshot;
  onNavigate: (id: string) => void;
  onViewInMap: (id: string) => void;
}) {
  // Engine seam (maintainability invariant): reads via useEngine, writes via useAction — no
  // hand-rolled try/catch + pushUndo (owner consistency pass, 2026-07-24).
  const { client, epoch } = useEngine();
  const act = useAction();
  const [relations, setRelations] = useState<Relation[]>([]);
  useEffect(() => {
    let stale = false;
    client.getRelations(concept.id).then((r) => !stale && setRelations(r.relations)).catch(() => !stale && setRelations([]));
    return () => {
      stale = true;
    };
  }, [client, concept.id, epoch]);

  // Concept↔concept ties render (and are edited) in their own section; Connections keeps the rest.
  const isTie = (r: Relation): boolean => r.otherKind === 'concept' && (r.type === 'PREREQUISITE_OF' || r.type === 'LINK');
  const ties = relations.filter(isTie);
  const rows = relations
    .filter((r) => !isTie(r))
    .sort((a, b) => a.otherLabel.localeCompare(b.otherLabel) || a.type.localeCompare(b.type));

  // The tie editor (owner request, 2026-07-17): the PREREQUISITE_OF primitive in either
  // direction, plus the framework-declared concept↔concept LINK tags. A cycle is rejected by
  // the engine's validator and surfaces in the toast.
  const flavors = [
    { value: 'requires', label: 'requires' },
    { value: 'prereq-of', label: 'prerequisite of' },
    ...CONCEPT_LINK_TAGS.map((t) => ({ value: `tag:${t}`, label: relationWord('LINK', [`#${t}`]) })),
  ];
  const [flavor, setFlavor] = useState(flavors[0]!.value);
  const edgeForTie = (otherId: string) =>
    flavor === 'requires'
      ? { srcType: 'concept', srcId: otherId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: concept.id, tags: [] }
      : flavor === 'prereq-of'
        ? { srcType: 'concept', srcId: concept.id, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: otherId, tags: [] }
        : { srcType: 'concept', srcId: concept.id, type: 'LINK', dstType: 'concept', dstId: otherId, tags: [{ name: flavor.slice(4) }] };
  // Tie one or more concepts at the chosen flavor, as ONE undoable batch (owner, 2026-07-24:
  // the same multiselect+create palette as the track/source pickers).
  const addTies = async (names: string[]) => {
    const clean = names.filter((n) => n.trim() && n.trim().toLowerCase() !== concept.name.toLowerCase());
    if (clean.length === 0) return;
    const label = flavors.find((f) => f.value === flavor)?.label ?? 'tie';
    await act(async () => {
      const made: { id: string; created: boolean; edge: ReturnType<typeof edgeForTie> }[] = [];
      for (const nm of clean) {
        const other = await resolveOrCreateConcept(client, concepts, nm.trim());
        const edge = edgeForTie(other.id);
        await client.link(edge);
        made.push({ id: other.id, created: other.created, edge });
      }
      return {
        label: `${label} ${made.length === 1 ? 'a concept' : `${made.length} concepts`}`,
        invert: async () => {
          for (const m of made) {
            await client.unlink({ srcId: m.edge.srcId, type: m.edge.type, dstId: m.edge.dstId });
            if (m.created) await client.remove(m.id);
          }
        },
      };
    }, `${label} ${clean.length === 1 ? '“' + clean[0]!.trim() + '”' : clean.length + ' concepts'} ✓`);
  };

  // Anchor SOURCES from the concept's side (owner request, 2026-07-20): the mirror of the
  // source pane's CONCEPTS editor — same ABOUT edge, framework-declared tag vocabulary,
  // now the multiselect source palette.
  const [srcFlavor, setSrcFlavor] = useState(ABOUT_TAGS[0] ?? 'Explains');
  const addSourceAnchors = async (ids: string[]) => {
    if (ids.length === 0) return;
    await act(async () => {
      const made: { edge: { srcType: string; srcId: string; type: string; dstType: string; dstId: string; tags: { name: string }[] } }[] = [];
      for (const sid of ids) {
        const edge = { srcType: 'source', srcId: sid, type: 'ABOUT', dstType: 'concept', dstId: concept.id, tags: [{ name: srcFlavor }] };
        await client.link(edge);
        made.push({ edge });
      }
      return {
        label: `anchor ${made.length === 1 ? 'a source' : `${made.length} sources`}`,
        invert: async () => {
          for (const m of made) await client.unlink({ srcId: m.edge.srcId, type: m.edge.type, dstId: m.edge.dstId });
        },
      };
    }, `${srcFlavor.toLowerCase()} ← ${ids.length === 1 ? 'a source' : ids.length + ' sources'} ✓`);
  };
  // Only the concept itself is excluded — NOT concepts it's already related to (owner bug,
  // 2026-07-24): a concept can hold several relations to the same neighbour (e.g. both
  // #DrawsOn and PREREQUISITE_OF), so filtering out any already-tied concept locked you out of
  // adding a second flavour. Re-adding an existing flavour is a harmless no-op at the engine.
  const conceptOptions = concepts
    .filter((c) => c.id !== concept.id)
    .map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));
  const anchoredSrcIds = new Set(relations.filter((r) => r.otherKind === 'source').map((r) => r.otherId));
  const sourceOptions = snapshot.sources
    .filter((s) => !anchoredSrcIds.has(s.id))
    .map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }));

  return (
    <div className="pane detail">
      <div className="detail-top">
        <span className="kind-badge" style={{ color: 'var(--k-concept)' }}>
          <Icon name="concept" size={17} />
        </span>
        <span className="kind-label">concept</span>
        <span style={{ flex: 1 }} />
        {concept.tracked && <span style={{ color: 'var(--accent-soft)' }}>following ★</span>}
      </div>
      <TitleEditor id={concept.id} title={concept.name} field="name" onRenamed={onNavigate} />
      <TagEditor id={concept.id} tags={concept.tags} />
      {concept.tracked && (
        <p className="detail-field" style={{ marginTop: '-0.2rem' }}>
          <Star size={13} weight="fill" style={{ color: 'var(--accent-soft)' }} /> you follow this concept
        </p>
      )}

      <div className="detail-section">Related concepts</div>
      <div className="detail-tags">
        {ties.map((r) => (
          <button
            key={`${r.type}-${r.direction}-${r.otherId}`}
            className="chip concept"
            title="open concept"
            onClick={() => onNavigate(r.otherId)}
          >
            {r.direction === 'out' ? `${relationWord(r.type, r.tags)} → ` : `← ${relationWord(r.type, r.tags)} `}
            {r.otherLabel}
            <span
              className="chip-x"
              title="remove this relation"
              onClick={(e) => {
                e.stopPropagation();
                const edge = relationEdge({ id: concept.id, kind: 'concept' }, r);
                void act(async () => {
                  await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
                  return { label: `unlink “${r.otherLabel}”`, invert: () => client.link(edge) };
                }, `Removed relation to “${r.otherLabel}”`);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <div className="anchor-picker">
        <select className="anchor-flavor" value={flavor} onChange={(e) => setFlavor(e.target.value)} title="how these concepts relate">
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
          onPick={(names) => void addTies(names)}
          onCreate={(name) => void addTies([name])}
        />
      </div>

        <div className="detail-section">Sources</div>
        <div className="anchor-picker">
          <select className="anchor-flavor" value={srcFlavor} onChange={(e) => setSrcFlavor(e.target.value)} title="how the source relates to this concept">
            {ABOUT_TAGS.map((t) => (
              <option key={t} value={t}>
                {t.toLowerCase()}
              </option>
            ))}
          </select>
          <PickerBox options={sourceOptions} placeholder="add a source…" variant="source" onPick={(ids) => void addSourceAnchors(ids)} />
        </div>
      {rows.length > 0 && (
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
      )}

      <div className="detail-actions">
        <button className="link-btn" onClick={() => onViewInMap(concept.id)}>
          ✳ View in map
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="remove"
          title="remove (retraction — restorable from the Removed tab)"
          onClick={() =>
            void act(async () => {
              await client.remove(concept.id);
              return { label: `remove “${concept.name.slice(0, 30)}”`, invert: () => client.restore(concept.id) };
            }, `Removed “${concept.name.length > 40 ? `${concept.name.slice(0, 40)}…` : concept.name}”`)
          }
        >
          Remove
        </button>
      </div>
    </div>
  );
}
