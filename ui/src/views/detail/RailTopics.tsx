import { Icon, sourceIcon } from '../../components/Icon';
import { shortAuthors } from '../../lib/items';
import type { TopicGroup } from '../../lib/topics';
import { TrackBody } from './TrackBody';
import { TrackPath } from './TrackPath';

/** The compact topic listing (rail scale) — TrackBody's By-concept view AND the
 *  concept-track section a non-member source shows (owner request, 2026-07-20).
 *  `highlightId` marks one source row the way TrackPath marks the current member. */
export function RailTopics({ topics, onNavigate, highlightId }: { topics: TopicGroup[]; onNavigate: (id: string) => void; highlightId?: string }) {
  return (
    <div className="rail-topics">
      {topics.map((g, i) => (
        <div key={g.conceptId} className="rail-topic">
          <button className="rail-topic-head" onClick={() => onNavigate(g.conceptId)}>
            <span className="rail-topic-n">{i + 1}</span>
            <Icon name="concept" size={14} />
            {g.conceptName}
          </button>
          {g.sources.map(({ source: src, ties }) => (
            <div key={src.id} className={src.id === highlightId ? 'rail-topic-source on' : 'rail-topic-source'}>
              {/* Title with the author STACKED beneath it; the tie chips sit to the RIGHT when
                  the row has room and wrap below it when it doesn't (owner request, 2026-07-21 —
                  right-justified authors read badly). */}
              <button className="rail-topic-title" onClick={() => onNavigate(src.id)}>
                <Icon name={sourceIcon(src.modality)} size={13} />
                <span className="rail-topic-texts">
                  <span>{src.title}</span>
                  {src.author && <span className="rail-topic-author">{shortAuthors(src.author)}</span>}
                </span>
              </button>
              {ties.length > 0 && (
                <div className="rail-topic-chips">
                  {ties.map((t) => (
                    <button key={t.id} className="outline-cchip" onClick={() => onNavigate(t.id)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
