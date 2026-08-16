/**
 * Concept detail — shown when a concept node is selected in the Map (concepts aren't browsable
 * items, but they are selectable from the graph). Its typed connections come from the same
 * relations projection every entity uses.
 */
import { useEffect, useState } from 'react';
import { Star } from '@phosphor-icons/react';
import { useEngine, useAction } from '../engine-context';
import { inverseRelationWord, relationWord } from '../lib/relations';
import { ABOUT_TAGS, resolveOrCreateConcept } from '../lib/concepts';
import { createSource } from '../lib/sources';
import { anchorContents, includeConceptInTracks, includeInNewTrack, questionAboutConceptByText, tieQuestionsToConcept } from '../lib/ties';
import { TagEditor } from './detail/TagEditor';
import { TitleEditor } from './detail/TitleEditor';
import { PickerBox } from './detail/PickerBox';
import { Connections } from './detail/Connections';
import { EditModeCtx, StagedBanner } from './detail/shared';
import type { QuestionView, Relation, Snapshot } from '../client/types';
import { Icon, sourceIcon } from '../components/Icon';
import { activeFrameworks } from '../lib/framework-registry';

/** Concept↔concept LINK vocabulary — declared by the ACTIVE frameworks (built-ins + the
 *  personal framework), never hardcoded; read per render so an editor save shows up live. */
const conceptLinkTags = (): string[] => [
  ...new Set(
    activeFrameworks()
      .flatMap((f) => f.edgeTags)
      .filter((t) => t.on.type === 'LINK' && t.on.srcKind === 'concept' && t.on.dstKind === 'concept')
      .map((t) => t.name),
  ),
];


export function ConceptDetail({
  concept,
  concepts,
  snapshot,
  questions,
  onNavigate,
  onViewInMap,
  editNew,
  onClose,
}: {
  concept: { id: string; name: string; tracked: boolean; tags: string[]; staged?: boolean };
  /** The whole concept list — the tie editor's picker. */
  concepts: { id: string; name: string; tracked: boolean }[];
  /** Source titles for the anchor editor's picker. */
  snapshot: Snapshot;
  /** The question list — the Questions-group adder (question ABOUT concept, from this end). */
  questions: QuestionView[];
  onNavigate: (id: string) => void;
  onViewInMap: (id: string) => void;
  /** Just-created entity id — opens with editing ON (unified create). */
  editNew?: string;
  /** Present on a PINNED rail — renders the close × beside the edit toggle. */
  onClose?: () => void;
}) {
  // Engine seam (maintainability invariant): reads via useEngine, writes via useAction — no
  // hand-rolled try/catch + pushUndo.
  const { client, epoch } = useEngine();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editNew !== undefined && editNew === concept.id) setEditing(true);
  }, [editNew, concept.id]);
  const [relations, setRelations] = useState<Relation[]>([]);
  useEffect(() => {
    let stale = false;
    client.getRelations(concept.id).then((r) => !stale && setRelations(r.relations)).catch(() => !stale && setRelations([]));
    return () => {
      stale = true;
    };
  }, [client, concept.id, epoch]);

  // Concept↔concept ties render (and are edited) in their own section; Connections keeps the rest.
  // The tie editor: the PREREQUISITE_OF primitive in either
  // direction, plus the framework-declared concept↔concept LINK tags. A cycle is rejected by
  // the engine's validator and surfaces in the toast.
  // Every directed relation offers its CONVERSE too: "topic of"
  // beside "parent topic of", "subfield of" beside "superfield of" — the converse authors the
  // SAME edge with the endpoints swapped (exactly the standing requires/prerequisite-of pair).
  // Labels come from the declaration's inverseLabel, never client literals (ARCH #2); a tag
  // with no declared inverse (or a symmetric one) simply offers no converse.
  const flavors = [
    { value: 'requires', label: 'requires' },
    { value: 'prereq-of', label: 'prerequisite of', converse: true },
    ...conceptLinkTags().flatMap((t) => {
      const forward = { value: `tag:${t}`, label: relationWord('LINK', [`#${t}`]) };
      const inv = inverseRelationWord('LINK', [`#${t}`]);
      return inv !== undefined && inv !== forward.label
        ? [forward, { value: `rtag:${t}`, label: inv, converse: true }]
        : [forward];
    }),
  ];
  const [flavor, setFlavor] = useState(flavors[0]!.value);
  const edgeForTie = (otherId: string) =>
    flavor === 'requires'
      ? { srcType: 'concept', srcId: otherId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: concept.id, tags: [] }
      : flavor === 'prereq-of'
        ? { srcType: 'concept', srcId: concept.id, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: otherId, tags: [] }
        : flavor.startsWith('rtag:')
          ? { srcType: 'concept', srcId: otherId, type: 'LINK', dstType: 'concept', dstId: concept.id, tags: [{ name: flavor.slice(5) }] }
          : { srcType: 'concept', srcId: concept.id, type: 'LINK', dstType: 'concept', dstId: otherId, tags: [{ name: flavor.slice(4) }] };
  // Tie one or more concepts at the chosen flavor, as ONE undoable batch (
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

  // Anchor SOURCES from the concept's side: the mirror of the
  // source pane's CONCEPTS editor — same ABOUT edge, framework-declared tag vocabulary,
  // now the multiselect source palette.
  const [srcFlavor, setSrcFlavor] = useState(ABOUT_TAGS[0] ?? 'Explains');
  const addSourceAnchors = async (ids: string[]) => {
    if (ids.length === 0) return;
    // ONE gesture implementation (lib/ties.anchorContents) — the same edge the source rail's
    // adder writes, from this end.
    await act(
      () => anchorContents(client, ids.map((sid) => ({ kind: 'source' as const, id: sid })), concept.id, srcFlavor),
      `${srcFlavor.toLowerCase()} ← ${ids.length === 1 ? 'a source' : ids.length + ' sources'} ✓`,
    );
  };
  // Create-and-anchor from the same picker (consistent with the
  // track view) — the shared createSource: a url makes a link, blank makes an offline source
  // titled the text. Undo unlinks and un-mints only what this gesture created.
  const createSourceAnchor = async (text: string, url?: string) => {
    const t = text.trim();
    if (!t) return;
    await act(async () => {
      const { id: sid, created } = await createSource(client, { title: t, url });
      const g = await anchorContents(client, [{ kind: 'source', id: sid }], concept.id, srcFlavor);
      return {
        label: `anchor “${t.slice(0, 40)}”`,
        invert: async () => {
          await g.invert();
          if (created) await client.remove(sid);
        },
      };
    }, `${srcFlavor.toLowerCase()} ← “${t.slice(0, 40)}” ✓`);
  };
  // Only the concept itself is excluded — NOT concepts it's already related to (24): a concept can hold several relations to the same neighbour (e.g. both
  // #DrawsOn and PREREQUISITE_OF), so filtering out any already-tied concept locked you out of
  // adding a second flavour. Re-adding an existing flavour is a harmless no-op at the engine.
  const conceptOptions = concepts
    .filter((c) => c.id !== concept.id)
    .map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));
  const anchoredSrcIds = new Set(relations.filter((r) => r.otherKind === 'source').map((r) => r.otherId));
  const sourceOptions = snapshot.sources
    .filter((s) => !anchoredSrcIds.has(s.id))
    .map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }));

  // Put THIS concept on one or more tracks — the concept side of the
  // membership invariant needs its own door: INCLUDES track→concept, one undoable batch.
  const trackOptions = snapshot.tracks.map((t) => ({ id: t.id, label: t.title, icon: 'track' as const }));
  const addToTracks = async (trackIds: string[]) => {
    if (trackIds.length === 0) return;
    // ONE gesture implementation (lib/ties) — the same INCLUDES the track rails write.
    await act(() => includeConceptInTracks(client, concept.id, trackIds), `Added to ${trackIds.length === 1 ? 'a track' : `${trackIds.length} tracks`} ✓`);
  };

  // Questions ABOUT this concept, addable from THIS end —
  // pick existing or author-if-unseen; same edge the question rail writes.
  const questionOptions = questions.filter((q) => !q.about.includes(concept.name)).map((q) => ({ id: q.id, label: q.text, icon: 'question' as const }));
  // Snippets anchored to this concept from THIS end — the polarity pair, same edge the
  // snippet rail writes (lib/ties.anchorContents).
  const [snipFlavor, setSnipFlavor] = useState<'CLARIFIES' | 'CONTRADICTS'>('CLARIFIES');
  const snippetOptions = snapshot.snippets.map((sn) => ({ id: sn.id, label: sn.text.length > 60 ? `${sn.text.slice(0, 60)}…` : sn.text, icon: 'snippet' as const }));

  return (
    <EditModeCtx.Provider value={editing}>
    <div className={editing ? 'pane detail editing' : 'pane detail'}>
      {/* FROZEN, like every other entity's: `Detail` gained this on
          early and a concept never did, so scrolling a long concept lost both the name of
          what you were reading and the way out of it. */}
      <div className="detail-head-stick">
      <div className={concept.staged === true ? 'staged-frame' : undefined}>
      <div className="detail-top">
        <span className="kind-badge" style={{ color: 'var(--k-concept)' }}>
          <Icon name="concept" size={17} filled />
        </span>
        <span className="kind-label">concept</span>
        {/* "Needs sources": a one-tap asserted tag — the
            ask page collects flagged concepts by it. Amber like everything asking attention. */}
        <button
          className={concept.tags.includes('#NeedsSources') ? 'read-toggle needs-sources on' : 'read-toggle needs-sources'}
          title={concept.tags.includes('#NeedsSources') ? 'this concept has enough sources' : 'flag: this concept needs sources'}
          onClick={() => {
            const before = concept.tags;
            const next = before.includes('#NeedsSources') ? before.filter((t) => t !== '#NeedsSources') : [...before, '#NeedsSources'];
            void act(async () => {
              await client.update(concept.id, { tags: next });
              return { label: 'toggle needs-sources', invert: () => client.update(concept.id, { tags: before }) };
            }, next.includes('#NeedsSources') ? 'Flagged — asks will offer this concept for recommendations' : 'Unflagged ✓');
          }}
        >
          {concept.tags.includes('#NeedsSources') ? '◆ needs sources' : '◇ needs sources?'}
        </button>
        <span style={{ flex: 1 }} />
        {concept.tracked && <span style={{ color: 'var(--accent-soft)' }}>following ★</span>}
        <button className={editing ? 'edit-toggle on' : 'edit-toggle'} title={editing ? 'done editing' : 'edit this concept'} onClick={() => setEditing((v) => !v)}>
          {editing ? '✓ done' : '✎ edit'}
        </button>
        {onClose && (
          <button className="pinned-x" title="close this rail" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      </div>
      <TitleEditor id={concept.id} title={concept.name} field="name" onRenamed={onNavigate} />
      {concept.staged === true && <StagedBanner id={concept.id} title={concept.name} />}
      </div>
      <TagEditor id={concept.id} tags={concept.tags} />
      {concept.tracked && (
        <p className="detail-field" style={{ marginTop: '-0.2rem' }}>
          <Star size={13} weight="fill" style={{ color: 'var(--accent-soft)' }} /> you follow this concept
        </p>
      )}

      {/* Every relation shows in the unified Connections list; each kind group ends with
          its ADD affordance. */}
      <Connections
        self={{ id: concept.id, kind: 'concept' }}
        relations={relations}
        onNavigate={onNavigate}
        /* Only while editing — an empty category is noise to a reader, an affordance to an
           author. */
        addByKind={editing ? {
          track: (
            <div className="anchor-picker">
              <PickerBox
                options={trackOptions}
                placeholder="add this concept to a track…"
                variant="track"
                onPick={(ids) => void addToTracks(ids)}
                onCreate={(title) => void act(() => includeInNewTrack(client, title, { kind: 'concept', id: concept.id }), `Created track “${title.trim().slice(0, 30)}” ✓`)}
              />
            </div>
          ),
          concept: (
            <>
      <div className="anchor-picker">
        <select className="anchor-flavor" value={flavor} onChange={(e) => setFlavor(e.target.value)} title="how these concepts relate">
          {flavors.map((f) => (
            // A converse option wears the dark backdrop: the visual says
            // "this one points the other way" right in the open list.
            <option key={f.value} value={f.value} className={'converse' in f && f.converse === true ? 'converse-opt' : undefined}>
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
            </>
          ),
          source: (
            <>
        <div className="anchor-picker">
          <select className="anchor-flavor" value={srcFlavor} onChange={(e) => setSrcFlavor(e.target.value)} title="how the source relates to this concept">
            {ABOUT_TAGS.map((t) => (
              <option key={t} value={t}>
                {t.toLowerCase()}
              </option>
            ))}
          </select>
          <PickerBox
            options={sourceOptions}
            placeholder="add a source…"
            variant="source"
            onPick={(ids) => void addSourceAnchors(ids)}
            onCreate={(text, url) => void createSourceAnchor(text, url)}
            createUrlField
          />
        </div>
            </>
          ),
          question: (
            <div className="anchor-picker">
              <span className="anchor-flavor" style={{ display: 'inline-flex', alignItems: 'center' }}>about</span>
              <PickerBox
                options={questionOptions}
                placeholder="tie a question…"
                variant="question"
                onPick={(ids) => void act(() => tieQuestionsToConcept(client, concept.id, ids), 'Tied ✓')}
                onCreate={(text) => text.trim() && void act(() => questionAboutConceptByText(client, concept.id, text, questions), `Asked “${text.trim().slice(0, 40)}” ✓`)}
              />
            </div>
          ),
          snippet: (
            <div className="anchor-picker">
              <select className="anchor-flavor" value={snipFlavor} onChange={(e) => setSnipFlavor(e.target.value as 'CLARIFIES' | 'CONTRADICTS')} title="how the snippet bears on this concept">
                <option value="CLARIFIES">clarifies</option>
                <option value="CONTRADICTS">contradicts</option>
              </select>
              <PickerBox
                options={snippetOptions}
                placeholder="tie a snippet…"
                variant="snippet"
                onPick={(ids) => void act(() => anchorContents(client, ids.map((id) => ({ kind: 'snippet' as const, id })), concept.id, snipFlavor), `${snipFlavor.toLowerCase()} ← ${ids.length === 1 ? 'a snippet' : `${ids.length} snippets`} ✓`)}
              />
            </div>
          ),
        } : undefined}
      />

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
    </EditModeCtx.Provider>
  );
}
