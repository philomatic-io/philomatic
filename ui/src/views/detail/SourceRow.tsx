import { CaretRight } from '@phosphor-icons/react';
import { Icon, sourceIcon } from '../../components/Icon';
import { shortAuthors } from '../../lib/items';
import type { SourceView } from '../../client/types';

/** ONE source row for the whole track view (owner, 2026-07-23: "should both look like the
 *  logic track"). The reading spine and the concept groups render THIS — same type, same
 *  icon, same stacked author, same chips riding the right edge — so the two halves of a
 *  track can't drift into looking like two different screens.
 *
 *  `marker` is the only difference between them: the spine numbers its steps — an EMPTY
 *  marker for a member no ordering edge touches, which still holds the gutter so titles line
 *  up (owner, 2026-07-23: a `·` was still a mark where there is nothing to say). A concept
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
}: {
  source: SourceView;
  ties: { id: string; name: string }[];
  marker?: string;
  markerTitle?: string;
  highlight?: boolean;
  /** Present → a read/unread toggle chip on the row (the Journey reading view's one addition
   *  over the Library track list; owner, 2026-07-24). */
  readState?: { consumed: boolean; onToggle: () => void };
  /** The reader's current position — a ▸ marker on the title (owner, 2026-07-24). */
  current?: boolean;
  /** Open-question / snippet counts, shown with their own glyph on the concept row (owner,
   *  2026-07-24) — a source's unanswered questions and how many passages were captured. */
  openQuestions?: number;
  snippets?: number;
  /** Present → every tie chip carries a × that cuts THAT tie (owner, 2026-07-23). Only direct
   *  ties get one, which is exactly what a chip is: you can untie a source from the concept it
   *  names, never from the top-level group it merely sits under. */
  onUntie?: (concept: { id: string; name: string }) => void;
  /** Present → a trailing × that removes the SOURCE from the track (owner, 2026-07-23). Distinct
   *  from the chip ×: the chip × means "not about this concept", the row × means "not in this
   *  track". Sits at the row's end, revealed on hover. */
  onRemove?: () => void;
  onNavigate: (id: string) => void;
}) {
  return (
    // The WHOLE row navigates to the source (owner, 2026-07-24) — the interactive bits inside
    // (read dot, concept chips, remove ×) stopPropagation so they do their own thing.
    <div
      className={highlight ? 'rail-topic-source on' : 'rail-topic-source'}
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(source.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigate(source.id);
        }
      }}
    >
      {/* Read state is a green dot on the LEFT (owner, 2026-07-24) — filled when read, an
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
      {/* Name, author, and concept chips each stack as their OWN row (owner, 2026-07-24) — so a
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
        {(ties.length > 0 || openQuestions > 0 || snippets > 0) && (
          <div className="rail-topic-chips">
            {ties.map((t) =>
              onUntie ? (
                <span key={t.id} className="outline-cchip tie">
                  <button className="cchip-label" onClick={(e) => { e.stopPropagation(); onNavigate(t.id); }}>
                    {t.name}
                  </button>
                  <button className="cchip-x" title={`no longer about “${t.name}”`} onClick={(e) => { e.stopPropagation(); onUntie(t); }}>
                    ×
                  </button>
                </span>
              ) : (
                <button key={t.id} className="outline-cchip" onClick={(e) => { e.stopPropagation(); onNavigate(t.id); }}>
                  {t.name}
                </button>
              ),
            )}
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
