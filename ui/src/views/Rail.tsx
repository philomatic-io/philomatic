/**
 * The Browse rail (workbench redesign) — kind filters with live counts + the cross-kind tag
 * facet. Pure presentation over the item model; selection state lives in App.
 */
import { SquaresFour, Tray } from '@phosphor-icons/react';
import type { ItemKind } from '../lib/items';
import type { RailCounts } from '../lib/items';
import { Icon } from '../components/Icon';

const KINDS: { key: ItemKind | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'track', label: 'Tracks' },
  { key: 'concept', label: 'Concepts' },
  { key: 'source', label: 'Sources' },
  { key: 'question', label: 'Questions' },
  { key: 'snippet', label: 'Snippets' },
];

export function Rail({
  counts,
  readState,
  tags,
  concepts,
  kind,
  selectedTags,
  selectedConcepts,
  onKind,
  onReadState,
  modality,
  modalityCounts,
  onModality,
  qstate,
  questionCounts,
  onQstate,
  onToggleTag,
  onToggleConcept,
  excludedTags,
}: {
  counts: RailCounts;
  /** Read-state filter: sources narrow to unread/read; everything else passes. */
  readState: 'all' | 'unread' | 'read';
  tags: string[];
  concepts: string[];
  kind: ItemKind | 'all';
  selectedTags: ReadonlySet<string>;
  /** Standing exclusions — chips cycle off → include → exclude (persisted) → off. */
  excludedTags: ReadonlySet<string>;
  selectedConcepts: ReadonlySet<string>;
  onKind: (k: ItemKind | 'all') => void;
  onReadState: (r: 'all' | 'unread' | 'read') => void;
  /** Source sub-facet (only rendered while Sources is selected). */
  modality: string;
  modalityCounts: Record<string, number>;
  onModality: (m: string) => void;
  /** Question sub-facet (only rendered while Questions is selected). */
  qstate: '' | 'open' | 'answered';
  questionCounts: { open: number; answered: number };
  onQstate: (q: '' | 'open' | 'answered') => void;
  onToggleTag: (t: string) => void;
  onToggleConcept: (c: string) => void;
}) {
  const countFor = (k: ItemKind | 'all'): number => (k === 'all' ? counts.all : counts[k]);
  return (
    <div className="pane rail">
      <div className="rail-label">Browse</div>
      {KINDS.map((k) => (
        <div key={k.key}>
          <button className={k.key === kind ? 'browse-row on' : 'browse-row'} onClick={() => onKind(k.key)}>
            <span className="browse-glyph" style={k.key === 'all' ? undefined : { color: `var(--k-${k.key})` }}>
              {k.key === 'all' ? <SquaresFour size={15} /> : <Icon name={k.key} size={15} />}
            </span>
            <span>{k.label}</span>
            <span className="browse-count">{countFor(k.key)}</span>
          </button>
          {k.key === 'source' && kind === 'source' && (
            <div className="browse-sub">
              {(['text', 'video', 'audio', 'interactive', 'other'] as const)
                .filter((m) => (modalityCounts[m] ?? 0) > 0)
                .map((m) => (
                  <button key={m} className={modality === m ? 'browse-row sub on' : 'browse-row sub'} onClick={() => onModality(modality === m ? '' : m)}>
                    <span className="browse-glyph"><Icon name={`source:${m}`} size={13} /></span>
                    <span>{m}</span>
                    <span className="browse-count">{modalityCounts[m]}</span>
                  </button>
                ))}
            </div>
          )}
          {k.key === 'question' && kind === 'question' && (
            <div className="browse-sub">
              {(['open', 'answered'] as const).map((q) => (
                <button key={q} className={qstate === q ? 'browse-row sub on' : 'browse-row sub'} onClick={() => onQstate(qstate === q ? '' : q)}>
                  <span className="browse-glyph">{q === 'open' ? '?' : '✓'}</span>
                  <span>{q}</span>
                  <span className="browse-count">{questionCounts[q]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="read-filter" title="filter sources by read state — derived, nothing is stored">
        <Tray size={14} />
        {(['all', 'unread', 'read'] as const).map((r) => (
          <button key={r} className={readState === r ? 'read-pill on' : 'read-pill'} onClick={() => onReadState(r)}>
            {r}
            {r === 'unread' && counts.backlog > 0 && <span className="browse-count"> {counts.backlog}</span>}
          </button>
        ))}
      </div>
      {concepts.length > 0 && (
        <>
          <div className="rail-label">Concepts</div>
          <div className="tag-list">
            {concepts.map((c) => (
              <button key={c} className={selectedConcepts.has(c) ? 'chip concept on' : 'chip concept'} onClick={() => onToggleConcept(c)}>
                {c}
              </button>
            ))}
          </div>
        </>
      )}
      {tags.length > 0 && (
        <>
          <div className="rail-label">Tags</div>
          <div className="tag-list">
            {tags.map((t) => (
              <button
                key={t}
                className={selectedTags.has(t) ? 'chip on' : excludedTags.has(t) ? 'chip excluded' : 'chip'}
                title={excludedTags.has(t) ? 'hidden from the library — click to show again' : 'click: filter · click again: hide (sticky)'}
                onClick={() => onToggleTag(t)}
              >
                {excludedTags.has(t) ? `⊘ ${t}` : t}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
