/**
 * The staged inbox — every entity pending the learner's validation, with
 * the two VERDICTS as row chips: accept (ordinary entity, marker off) and reject (retracted,
 * restorable). Suggest-and-confirm made visible: proposals accumulate HERE, never as silent
 * graph truth. Rows mirror the ItemList markup (same classes, same glyphs) so the inbox
 * reads as a filtered library, not a second UI language; the row itself navigates so the
 * learner can inspect before judging.
 */
import type { Item } from '../lib/items';
import type { NodeKind } from '../client/types';
import type { ProposeResult } from '../client/transport';
import { Icon } from '../components/Icon';
import { itemIcon } from './ItemList';
import { RelationChip } from './detail/Connections';
import { kindIcon } from './detail/shared';
import { SnippetText } from '../lib/snippet-md';
import { useAction, useEngine } from '../engine-context';
import { CommunityInbox, communityMailCount } from './CommunityInbox';

/** One end of a suggested connection — the Connections row's own end markup, navigable. */
function End({ kind, label, onOpen }: { kind: NodeKind; label: string; onOpen?: () => void }) {
  return (
    <button className="connection-end" title={`open “${label}”`} onClick={onOpen} disabled={onOpen === undefined}>
      <span style={{ color: `var(--k-${kind})` }}>{kindIcon(kind)}</span>
      <span className="connection-target">{label}</span>
    </button>
  );
}

const KIND_LABEL: Record<Item['kind'], string> = {
  track: 'Track',
  concept: 'Concept',
  source: 'Source',
  question: 'Question',
  snippet: 'Snippet',
};

export function InboxView({
  items,
  selectedId,
  onSelect,
  companions = [],
  onDropCompanion,
  onOpen,
}: {
  /** Pre-filtered: only staged items reach the inbox. */
  items: Item[];
  selectedId?: string;
  onSelect: (item: Item) => void;
  /** The proposal records this session holds: accept-time companions — track and
   *  ordering suggestions that are NEVER graph state until the learner confirms one here. */
  companions?: { sourceId: string; sourceTitle: string; result: ProposeResult }[];
  onDropCompanion?: (sourceId: string, kind: 'track' | 'ordering', index: number) => void;
  /** Open an entity's detail by id — the suggested connections' ends navigate like real rows. */
  onOpen?: (id: string) => void;
}) {
  const { client } = useEngine();
  const act = useAction();

  const accept = (item: Item) =>
    act(async () => {
      await client.accept(item.id);
      return { label: `accept "${item.title.slice(0, 40)}"`, invert: () => client.stage(item.id) };
    }, 'Accepted ✓');

  const reject = (item: Item) =>
    act(async () => {
      await client.reject(item.id);
      // reject = verdict + retraction, so taking it back is restore THEN re-stage.
      return {
        label: `reject "${item.title.slice(0, 40)}"`,
        invert: async () => {
          await client.restore(item.id);
          await client.stage(item.id);
        },
      };
    }, 'Rejected — restorable from Removed');

  // Companion accepts write the edge through the ordinary link path — the accept gesture IS
  // the human INCLUDES / PREREQUISITE_OF, exactly as the invariants demand.
  const addToTrack = (sourceId: string, sourceTitle: string, t: { trackId: string; title: string }, drop: () => void) =>
    act(async () => {
      const edge = { srcType: 'track', srcId: t.trackId, type: 'INCLUDES', dstType: 'source', dstId: sourceId };
      await client.link(edge);
      drop();
      return { label: `add "${sourceTitle.slice(0, 30)}" to ${t.title}`, invert: () => client.unlink(edge) };
    }, `Added to ${t.title} ✓`);

  const tieOrder = (o: { beforeId: string; before: string; afterId: string; after: string }, drop: () => void) =>
    act(async () => {
      const edge = { srcType: 'concept', srcId: o.beforeId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: o.afterId };
      await client.link(edge); // the engine's acyclicity check guards this; a cycle toasts here
      drop();
      return { label: `${o.before} before ${o.after}`, invert: () => client.unlink(edge) };
    }, `Ordered: ${o.before} → ${o.after} ✓`);

  const suggestionCount = companions.reduce(
    (n, c) => n + (c.result.trackSuggestion?.length ?? 0) + (c.result.orderingSuggestion?.length ?? 0),
    0,
  );

  return (
    <div className="pane list inbox">
      <div className="list-head">
        <span>
          {items.length} pending validation
          {suggestionCount > 0 && ` · ${suggestionCount} suggestion${suggestionCount === 1 ? '' : 's'}`}
          {items.length > 0 && ' · accept keeps, reject retracts (restorable)'}
        </span>
      </div>
      {/* Community mail: contributions from members of tracks published here — named,
          waiting on the owner. Renders nothing when there is none (or no registry). */}
      <CommunityInbox />
      {companions.map((c) => (
        <div key={c.sourceId} className="companion-block">
          {c.result.notes.length > 0 && (
            <div className="companion-notes">
              {c.result.notes.map((n, i) => (
                <div key={i}>⚠ {n}</div>
              ))}
            </div>
          )}
          {c.result.trackSuggestion?.map((t, i) => (
            <div key={`t${i}`}>
              <div className="companion-row">
                <End kind="track" label={t.title} onOpen={onOpen && (() => onOpen(t.trackId))} />
                <RelationChip word="includes" />
                <End kind="source" label={c.sourceTitle} onOpen={onOpen && (() => onOpen(c.sourceId))} />
                <span style={{ flex: 1 }} />
                <span className="inbox-acts">
                  <button className="inbox-accept" onClick={() => void addToTrack(c.sourceId, c.sourceTitle, t, () => onDropCompanion?.(c.sourceId, 'track', i))}>
                    ✓ accept
                  </button>
                  <button className="inbox-reject" onClick={() => onDropCompanion?.(c.sourceId, 'track', i)}>
                    ✕ dismiss
                  </button>
                </span>
              </div>
              <div className="companion-reason">{t.reason}</div>
            </div>
          ))}
          {c.result.orderingSuggestion?.map((o, i) => (
            <div key={`o${i}`}>
              <div className="companion-row">
                <End kind="concept" label={o.before} onOpen={onOpen && (() => onOpen(o.beforeId))} />
                <RelationChip word="prerequisite of" />
                <End kind="concept" label={o.after} onOpen={onOpen && (() => onOpen(o.afterId))} />
                <span style={{ flex: 1 }} />
                <span className="inbox-acts">
                  <button className="inbox-accept" onClick={() => void tieOrder(o, () => onDropCompanion?.(c.sourceId, 'ordering', i))}>
                    ✓ accept
                  </button>
                  <button className="inbox-reject" onClick={() => onDropCompanion?.(c.sourceId, 'ordering', i)}>
                    ✕ dismiss
                  </button>
                </span>
              </div>
              <div className="companion-reason">{o.reason}</div>
            </div>
          ))}
        </div>
      ))}
      {items.length === 0 && communityMailCount() === 0 && (
        <p className="hint" style={{ padding: '1rem' }}>
          Nothing pending. Proposed and parked items land here for your verdict.
        </p>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          role="button"
          tabIndex={0}
          className={item.id === selectedId ? 'item inbox-row on' : 'item inbox-row'}
          onClick={() => onSelect(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSelect(item);
          }}
        >
          <span className="item-glyph" style={{ color: `var(--k-${item.kind})` }}>
            <Icon name={itemIcon(item)} filled={item.id === selectedId} />
          </span>
          <span>
            <span className="item-kind">{KIND_LABEL[item.kind]}</span>
            <div className="item-title">{item.kind === 'snippet' ? <SnippetText text={item.title} inline /> : item.title}</div>
            {item.meta !== '' && <span className="item-meta">{item.meta}</span>}
          </span>
          <span className="inbox-acts">
            <button
              className="inbox-accept"
              title="Accept — keep as an ordinary item"
              onClick={(e) => {
                e.stopPropagation();
                void accept(item);
              }}
            >
              ✓ accept
            </button>
            <button
              className="inbox-reject"
              title="Reject — retract (restorable from Removed)"
              onClick={(e) => {
                e.stopPropagation();
                void reject(item);
              }}
            >
              ✕ reject
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
