import { CaretRight } from '@phosphor-icons/react';
import { useRef } from 'react';
import { Icon, sourceIcon } from '../../components/Icon';
import { shortAuthors } from '../../lib/items';
import type { SourceView } from '../../client/types';

/** ONE source row for the whole track view ("should both look like the
 *  logic track"). The reading spine and the concept groups render THIS — same type, same
 *  icon, same stacked author, same chips riding the right edge — so the two halves of a
 *  track can't drift into looking like two different screens.
 *
 *  `marker` is the only difference between them: the spine numbers its steps — an EMPTY
 *  marker for a member no ordering edge touches, which still holds the gutter so titles line
 *  up (a `·` was still a mark where there is nothing to say). A concept
 *  group numbers nothing at all. */
export function SourceRow({
  source,
  ties,
  marker,
  markerTitle,
  highlight = false,
  readState,
  current = false,
  openQuestions = 0,
  snippets = 0,
  onUntie,
  onRemove,
  onNavigate,
  drag,
  chipDragStart,
  dropTargets,
  orderBadges,
}: {
  source: SourceView;
  ties: { id: string; name: string }[];
  marker?: string;
  markerTitle?: string;
  highlight?: boolean;
  /** Present → a read/unread toggle chip on the row (the Journey reading view's one addition
   *  over the Library track list; owner). */
  readState?: { consumed: boolean; onToggle: () => void };
  /** The reader's current position — a ▸ marker on the title. */
  current?: boolean;
  /** Open-question / snippet counts, shown with their own glyph on the concept row (24) — a source's unanswered questions and how many passages were captured. */
  openQuestions?: number;
  snippets?: number;
  /** Present → every tie chip carries a × that cuts THAT tie. Only direct
   *  ties get one, which is exactly what a chip is: you can untie a source from the concept it
   *  names, never from the top-level group it merely sits under. */
  onUntie?: (concept: { id: string; name: string }) => void;
  /** Present → a trailing × that removes the SOURCE from the track. Distinct
   *  from the chip ×: the chip × means "not about this concept", the row × means "not in this
   *  track". Sits at the row's end, revealed on hover. */
  onRemove?: () => void;
  onNavigate: (id: string) => void;
  /** Present → EDIT MODE: the row is draggable and NAVIGATION IS
   *  OFF — clicking a row or a chip must not take you away while you're arranging. The edit
   *  affordances (dot, ×s) keep working. */
  drag?: { onStart: () => void; onEnd: () => void };
  /** Pick a concept CHIP up off this row — dropping it on another row writes ABOUT. */
  chipDragStart?: (conceptId: string) => void;
  /** Drop wiring: `kind` = what's in flight; chips take SOURCE drags (anchor the
   *  dragged source to that concept), the row takes CONCEPT drags (tag this source). */
  dropTargets?: { kind?: 'source' | 'concept'; onConcept: (conceptId: string) => void; onRow: () => void };
  /** The relation marks: each of this row's READS-BEFORE
   *  relations as `↓②` in the gutter under the row's own number — one mark per edge, on the
   *  predecessor only, aligned with the circles it references. × (hover) cuts that relation.
   *  Edit mode only (passed only there). */
  orderBadges?: { key: string; n?: number; title: string; onCut: () => void }[];
}) {
  const editing = drag !== undefined;
  // The cursor carries the source's FILLED modality icon at document-ghost size (14) — an offscreen proxy the browser snapshots on dragstart; the translucent
  // whole-row snapshot hid the very strips the drop aims for.
  const dragImgRef = useRef<HTMLSpanElement>(null);
  return (
    // The WHOLE row navigates to the source — the interactive bits inside
    // (read dot, concept chips, remove ×) stopPropagation so they do their own thing. In edit
    // mode the row is a drag handle instead and navigation is off.
    <div
      className={`rail-topic-source${highlight ? ' on' : ''}${editing ? ' editing' : ''}`}
      data-source-id={source.id}
      role="button"
      tabIndex={0}
      draggable={editing}
      onDragStart={editing ? (e) => {
        e.dataTransfer.effectAllowed = 'link';
        e.dataTransfer.setData('text/plain', source.id);
        if (dragImgRef.current !== null) e.dataTransfer.setDragImage(dragImgRef.current, 16, 16);
        e.currentTarget.classList.add('drag-origin');
        drag.onStart();
      } : undefined}
      onDragEnd={editing ? (e) => { e.currentTarget.classList.remove('drag-origin'); drag.onEnd(); } : undefined}
      onDragOver={dropTargets?.kind === 'concept' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; e.currentTarget.classList.add('drop'); } : undefined}
      onDragLeave={dropTargets?.kind === 'concept' ? (e) => e.currentTarget.classList.remove('drop') : undefined}
      onDrop={dropTargets?.kind === 'concept' ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); dropTargets.onRow(); } : undefined}
      onClick={editing ? undefined : () => onNavigate(source.id)}
      onKeyDown={(e) => {
        if (!editing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onNavigate(source.id);
        }
      }}
    >
      {editing && (
        <span ref={dragImgRef} className="drag-img-proxy" aria-hidden="true">
          <Icon name={sourceIcon(source.modality)} size={32} filled />
        </span>
      )}
      {/* Read state is a green dot on the LEFT — filled when read, an
          outline ring when not; click toggles. Narrow rails have no room for a text chip. */}
      {readState && (
        <button
          className={readState.consumed ? 'read-dot on' : 'read-dot'}
          title={readState.consumed ? 'read — click to mark unread' : 'unread — click to mark read'}
          onClick={(e) => {
            e.stopPropagation();
            readState.onToggle();
          }}
        />
      )}
      {marker !== undefined && (
        <span className="rail-topic-n step" title={markerTitle}>
          {marker}
        </span>
      )}
      {/* Name, author, and concept chips each stack as their OWN row — so a
          narrow rail (Journey) and a wide one (Library detail) lay out identically, instead of
          the chips floating right where there's room and wrapping where there isn't. */}
      <div className="rail-topic-body">
        <span className="rail-topic-title">
          <Icon name={sourceIcon(source.modality)} size={13} />
          <span className="rail-topic-name">{source.title}</span>
          {current && (
            <span className="rail-here" title="you are here">
              <CaretRight size={11} weight="fill" />
            </span>
          )}
        </span>
        {source.author !== undefined && <span className="rail-topic-author">{shortAuthors(source.author)}</span>}
        {(ties.length > 0 || openQuestions > 0 || snippets > 0 || (orderBadges?.length ?? 0) > 0) && (
          <div className="rail-topic-chips">
            {ties.map((t) => {
              // Edit mode: a chip DRAGS as its concept (drop on another row → ABOUT)
              // and CATCHES a dragged source (anchor it to this — possibly intermediate —
              // concept). stopPropagation on dragstart keeps the row's own drag out of it.
              const chipDrag = editing && chipDragStart !== undefined
                ? {
                    draggable: true,
                    onDragStart: (e: React.DragEvent) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'link'; e.dataTransfer.setData('text/plain', t.id); chipDragStart(t.id); },
                    onDragEnd: (e: React.DragEvent) => { e.stopPropagation(); drag?.onEnd(); },
                  }
                : {};
              const chipCatch = dropTargets?.kind === 'source'
                ? {
                    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'link'; e.currentTarget.classList.add('drop'); },
                    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
                    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drop'); dropTargets.onConcept(t.id); },
                  }
                : {};
              return onUntie ? (
                <span key={t.id} className="outline-cchip tie" {...chipDrag} {...chipCatch}>
                  {/* Editing: the chip label goes INERT — arranging must not navigate away
. The × keeps cutting; it's an edit gesture. */}
                  <button className="cchip-label" onClick={editing ? (e) => e.stopPropagation() : (e) => { e.stopPropagation(); onNavigate(t.id); }}>
                    {t.name}
                  </button>
                  <button className="cchip-x" title={`no longer about “${t.name}”`} onClick={(e) => { e.stopPropagation(); onUntie(t); }}>
                    ×
                  </button>
                </span>
              ) : (
                <button key={t.id} className="outline-cchip" {...chipDrag} {...chipCatch} onClick={editing ? (e) => e.stopPropagation() : (e) => { e.stopPropagation(); onNavigate(t.id); }}>
                  {t.name}
                </button>
              );
            })}
            {openQuestions > 0 && (
              <span className="rail-count q" title={`${openQuestions} open question${openQuestions === 1 ? '' : 's'}`}>
                <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={13} /></span> {openQuestions}
              </span>
            )}
            {snippets > 0 && (
              <span className="rail-count s" title={`${snippets} snippet${snippets === 1 ? '' : 's'}`}>
                <span style={{ color: 'var(--k-snippet)' }}><Icon name="snippet" size={13} /></span> {snippets}
              </span>
            )}
            {/* The ORDER chips ride the same line, pushed to the far right:
                ↓2 = this reads before step 2; × (hover) cuts that relation. */}
            {orderBadges !== undefined && orderBadges.length > 0 && (
              <span className="order-chips">
                {orderBadges.map((b) => (
                  <span
                    key={b.key}
                    className="gut-rel"
                    title={`reads before “${b.title}”${b.n === undefined ? ' (not on this track any more)' : ''} — × removes this relation`}
                  >
                    <span className="gut-arrow">↓</span>
                    <span className="gut-n">{b.n ?? '·'}</span>
                    <button
                      className="gut-x"
                      onClick={(e) => {
                        e.stopPropagation();
                        b.onCut();
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
      {onRemove && (
        <button className="path-x row-remove-x" title="remove this source from the track (it stays in your library)" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          ×
        </button>
      )}
    </div>
  );
}
