import { nextMoves } from '../../lib/topics';
import { CaretDoubleDown, CaretDoubleRight } from '@phosphor-icons/react';
import { useMemo } from 'react';
import type { AssembleResult, GraphEnvelope, Snapshot, SourceView } from '../../client/types';
import type { NextMove, NextMoves } from '../../lib/topics';

/** Next reading (owner design, 2026-07-19) — the two live moves from a source inside a
 *  concept-anchored track: go DEEPER (shared concept, then descendant concepts) or go WIDER
 *  (different concept in the topic, then a later topic). Derived per track family, skips
 *  consumed sources, and always names the concept that justifies the recommendation. */
export function NextReading({
  source,
  snapshot,
  projection,
  onNavigate,
}: {
  source: SourceView;
  snapshot: Snapshot;
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  onNavigate: (id: string) => void;
}) {
  const perTrack: { trackId: string; title: string; moves: NextMoves }[] = useMemo(() => {
    if (!projection) return [];
    return snapshot.tracks
      .map((t) => ({ trackId: t.id, title: t.title, moves: nextMoves(projection.asm, projection.graph, t.id, snapshot.sources, source.id) }))
      .filter((x): x is { trackId: string; title: string; moves: NextMoves } => x.moves !== undefined);
  }, [projection, snapshot.tracks, snapshot.sources, source.id]);

  if (perTrack.length === 0) return null;

  const moveRow = (label: string, icon: React.ReactNode, m: NextMove | undefined) =>
    m && (
      <div className="next-move">
        <div className="next-move-head">
          {icon}
          <span className="next-label">{label} in</span>
          <button className="outline-cchip" onClick={() => onNavigate(m.viaId)} title="the concept behind this recommendation">
            {m.topicIndex !== undefined ? `Topic ${m.topicIndex} · ${m.viaName}` : m.viaName}
          </button>
        </div>
        <button className="next-title" onClick={() => onNavigate(m.source.id)}>
          {m.source.title}
        </button>
      </div>
    );

  return (
    <>
      <div className="detail-section">Next reading</div>
      {perTrack.map(({ trackId, title, moves }) => (
        <div key={trackId} className="next-moves">
          {perTrack.length > 1 && <div className="next-track">{title}</div>}
          {moves.frontier ? (
            <p className="hint" style={{ padding: 0, fontSize: 12 }}>frontier reached — nothing unconsumed deeper or wider in “{title}”</p>
          ) : (
            <>
              {moveRow('Go deeper', <CaretDoubleDown size={14} />, moves.deeper)}
              {moveRow('Go wider', <CaretDoubleRight size={14} />, moves.wider)}
            </>
          )}
        </div>
      ))}
    </>
  );
}
