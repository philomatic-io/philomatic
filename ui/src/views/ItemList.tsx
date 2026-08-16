/**
 * The unified center list (workbench redesign) — every kind in one column with a glyph, kind
 * label, title, tags, and a metadata line. Selection drives the detail pane; the selected row
 * scrolls into view when selection arrives from outside the list (a deep link, the Map).
 */
import { useEffect, useRef } from 'react';
import type { Item, ItemKind } from '../lib/items';
import { Icon, sourceIcon, type IconName } from '../components/Icon';
import { SnippetText } from '../lib/snippet-md';
import { PubStateChip } from '../components/PubStateChip';
import { TagChip } from '../components/TagChip';

const KIND_LABEL: Record<Item['kind'], string> = {
  track: 'Track',
  concept: 'Concept',
  source: 'Source',
  question: 'Question',
  snippet: 'Snippet',
};

export const itemIcon = (item: Item): IconName =>
  item.kind === 'source' ? sourceIcon(item.modality ?? 'text') : item.kind;

export function ItemList({
  items,
  total,
  filterNote,
  selectedId,
  onSelect,
  newActions,
  header,
}: {
  items: Item[];
  total: number;
  filterNote?: string;
  selectedId?: string;
  onSelect: (item: Item) => void;
  /** Rendered above the rows — the sparse-library start strip. */
  header?: React.ReactNode;
  /** Create-in-detail: one '+ New <kind>' button per action, each with the kind's icon
   *. On the 'all' view this is every creatable kind; on a
   *  single-kind view just that one. Every kind creates the same way — track/source open a
   *  blank entity in the detail, concept/question/snippet open a name/text form there. */
  newActions?: { kind: ItemKind; onClick: () => void }[];
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="pane list">
      <div className="list-head">
        <span>
          {items.length} of {total} items{filterNote ? ` · ${filterNote}` : ''}
        </span>
        {newActions && newActions.length > 0 && (
          <span className="list-new">
            {newActions.map((a) => (
              <button key={a.kind} className="new-draft" onClick={a.onClick} title={`New ${a.kind}`}>
                <span className="new-draft-plus">+</span>
                <Icon name={a.kind} size={14} />
                <span className="new-draft-label">{a.kind}</span>
              </button>
            ))}
          </span>
        )}
      </div>
      {header}
      {items.length === 0 && <p className="hint" style={{ padding: '1rem' }}>Nothing matches.</p>}
      {items.map((item) => (
        <button
          key={item.id}
          ref={item.id === selectedId ? selectedRef : undefined}
          className={item.id === selectedId ? 'item on' : 'item'}
          onClick={() => onSelect(item)}
          onDoubleClick={() => onSelect(item)}
        >
          <span className="item-glyph" style={{ color: `var(--k-${item.kind})` }}>
            <Icon name={itemIcon(item)} filled={item.id === selectedId} />
          </span>
          <span>
            <span className="item-kind">
              {KIND_LABEL[item.kind]}
              {item.staged === true && <span className="staged-badge">staged</span>}
            </span>
            <div className="item-title">{item.kind === 'snippet' ? <SnippetText text={item.title} inline /> : item.title}</div>
            <span className="item-meta">
              {item.kind === 'track' && <PubStateChip trackId={item.id} />}
              {item.tags.map((t) => (
                <TagChip key={t} tag={t} />
              ))}
              {item.meta && <span>{item.meta}</span>}
              {/* What hangs off this — the SAME chip the detail rail's rows
                  wear, so a count means one thing wherever it appears. A track shows its
                  members' totals. */}
              {item.openQuestions !== undefined && (
                <span className="rail-count q" title={`${item.openQuestions} open question${item.openQuestions === 1 ? '' : 's'}`}>
                  <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={12} /></span> {item.openQuestions}
                </span>
              )}
              {item.snippets !== undefined && (
                <span className="rail-count s" title={`${item.snippets} passage${item.snippets === 1 ? '' : 's'}`}>
                  <span style={{ color: 'var(--k-snippet)' }}><Icon name="snippet" size={12} /></span> {item.snippets}
                </span>
              )}
            </span>
            {/* Topic concepts the item covers, as chips — for tracks and
                sources, where "what is this about" is the useful cue on the selection card. A
                concept row would just chip itself; questions/snippets have their own line. */}
            {(item.kind === 'track' || item.kind === 'source') && item.concepts.length > 0 && (
              <span className="item-concepts">
                {item.concepts.slice(0, 5).map((c) => (
                  <span key={c} className="outline-cchip mini">
                    {c}
                  </span>
                ))}
                {item.concepts.length > 5 && <span className="item-concepts-more">+{item.concepts.length - 5}</span>}
              </span>
            )}
          </span>
          <span className="item-chev">›</span>
        </button>
      ))}
    </div>
  );
}
