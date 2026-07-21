/**
 * Concept detail — shown when a concept node is selected in the Map (concepts aren't browsable
 * items, but they are selectable from the graph). Its typed connections come from the same
 * relations projection every entity uses.
 */
import { useEffect, useState } from 'react';
import { Star } from '@phosphor-icons/react';
import type { EngineClient } from '../client/transport';
import { relationWord } from '../lib/relations';
import { ABOUT_TAGS, relationEdge, resolveOrCreateConcept } from '../lib/concepts';
import { TagEditor } from './Detail';
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
  client,
  epoch,
  refresh,
  notify,
  pushUndo,
  onNavigate,
  onViewInMap,
}: {
  concept: { id: string; name: string; tracked: boolean; tags: string[] };
  /** The whole concept list — the tie editor's picker. */
  concepts: { id: string; name: string; tracked: boolean }[];
  /** Source titles for the anchor editor's picker. */
  snapshot: Snapshot;
  client: EngineClient;
  /** Bumped by App on every refresh — the "refetch your projection" signal. */
  epoch: number;
  refresh: () => Promise<void>;
  notify: (message: string, undoRef?: string) => void;
  /** Push an action's INVERSE onto the Ctrl+Z stack. */
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  onNavigate: (id: string) => void;
  onViewInMap: (id: string) => void;
}) {
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
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const addTie = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    if (trimmed.toLowerCase() === concept.name.toLowerCase()) {
      notify('a concept cannot relate to itself');
      return;
    }
    setBusy(true);
    try {
      const other = await resolveOrCreateConcept(client, concepts, trimmed);
      const edge =
        flavor === 'requires'
          ? { srcType: 'concept', srcId: other.id, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: concept.id, tags: [] }
          : flavor === 'prereq-of'
            ? { srcType: 'concept', srcId: concept.id, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: other.id, tags: [] }
            : { srcType: 'concept', srcId: concept.id, type: 'LINK', dstType: 'concept', dstId: other.id, tags: [{ name: flavor.slice(4) }] };
      await client.link(edge);
      await refresh();
      setName('');
      pushUndo(`tie to “${other.name}”`, async () => {
        await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
        if (other.created) await client.remove(other.id); // undo the whole gesture
      });
      notify(`${flavors.find((f) => f.value === flavor)?.label} “${other.name}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Anchor a SOURCE from the concept's side (owner request, 2026-07-20): the mirror of the
  // source pane's CONCEPTS editor — same ABOUT edge, framework-declared tag vocabulary.
  const [srcFlavor, setSrcFlavor] = useState(ABOUT_TAGS[0] ?? 'Explains');
  const [srcTitle, setSrcTitle] = useState('');
  const addSourceAnchor = async () => {
    const value = srcTitle.trim();
    if (!value) return;
    const src = snapshot.sources.find((x) => x.title.toLowerCase() === value.toLowerCase());
    if (!src) {
      notify(`No source titled “${value.slice(0, 40)}” — anchors tie existing sources`);
      return;
    }
    const edge = { srcType: 'source', srcId: src.id, type: 'ABOUT', dstType: 'concept', dstId: concept.id, tags: [{ name: srcFlavor }] };
    try {
      await client.link(edge);
      await refresh();
      setSrcTitle('');
      pushUndo(`anchor “${src.title.slice(0, 30)}”`, () => client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId }));
      notify(`${srcFlavor.toLowerCase()} ← “${src.title.slice(0, 40)}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

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
      <h2>{concept.name}</h2>
      <TagEditor id={concept.id} tags={concept.tags} client={client} refresh={refresh} notify={notify} />
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
        <select value={flavor} onChange={(e) => setFlavor(e.target.value)} title="how these concepts relate">
          {flavors.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          list="pm-concept-names-cd"
          value={name}
          placeholder="concept name…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTie();
            if (e.key === 'Escape') setName('');
          }}
        />
        <datalist id="pm-concept-names-cd">
          {concepts
            .filter((c) => c.id !== concept.id)
            .map((c) => (
              <option key={c.id} value={c.name} />
            ))}
        </datalist>
        <button className="link-btn" disabled={!name.trim() || busy} onClick={() => void addTie()}>
          + Link
        </button>
      </div>

        <div className="detail-section">Sources</div>
        <div className="order-addrow">
          <select className="order-pick" value={srcFlavor} onChange={(e) => setSrcFlavor(e.target.value)} title="how the source relates to this concept">
            {ABOUT_TAGS.map((t) => (
              <option key={t} value={t}>
                {t.toLowerCase()}
              </option>
            ))}
          </select>
          <input
            className="order-input"
            list="concept-anchor-sources"
            placeholder="a source’s title…"
            value={srcTitle}
            onChange={(e) => setSrcTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addSourceAnchor();
            }}
          />
          <button className="link-btn" disabled={!srcTitle.trim()} onClick={() => void addSourceAnchor()}>
            + Link
          </button>
          <datalist id="concept-anchor-sources">
            {snapshot.sources.map((x) => (
              <option key={x.id} value={x.title} />
            ))}
          </datalist>
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
            void (async () => {
              try {
                await client.remove(concept.id);
                await refresh();
                pushUndo(`remove “${concept.name.slice(0, 30)}”`, () => client.restore(concept.id));
                notify(`Removed “${concept.name.length > 40 ? `${concept.name.slice(0, 40)}…` : concept.name}”`, concept.id);
              } catch (e) {
                notify(e instanceof Error ? e.message : String(e));
              }
            })()
          }
        >
          Remove
        </button>
      </div>
    </div>
  );
}
