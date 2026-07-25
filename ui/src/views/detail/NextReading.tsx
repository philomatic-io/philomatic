import { nextMoves } from '../../lib/topics';
import { CaretDoubleDown, CaretDoubleRight, CaretDoubleUp } from '@phosphor-icons/react';
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

  // One row per move. `label` carries its own connector ("Go back to", "Go deeper in") — a
  // backward move reads differently. The via concept is just a standard concept chip: no
  // "Topic N" numbering, since we never define "topic" to the user (owner, 2026-07-24).
  const moveRows = (label: string, icon: React.ReactNode, ms: NextMove[]) =>
    ms.map((m) => (
      <div key={`${label}-${m.source.id}`} className="next-move">
        <div className="next-move-head">
          {icon}
          <span className="next-label">{label}</span>
          {m.viaId !== undefined && (
            <button className="outline-cchip" onClick={() => onNavigate(m.viaId!)} title="the concept behind this recommendation">
              {m.viaName}
            </button>
          )}
        </div>
        <button className="next-title" onClick={() => onNavigate(m.source.id)}>
          {m.source.title}
        </button>
      </div>
    ));

  return (
    <>
      <div className="detail-section">Next reading</div>
      {perTrack.map(({ trackId, title, moves }) => (
        <div key={trackId} className="next-moves">
          {perTrack.length > 1 && <div className="next-track">{title}</div>}
          {moves.frontier && moves.back.length === 0 ? (
            <p className="hint" style={{ padding: 0, fontSize: 12 }}>frontier reached — nothing further in “{title}”</p>
          ) : (
            <>
              {/* Go back first — the foundation to review before moving on (owner, 2026-07-24) —
                  then deeper down the branch, then wider into a new topic. Multiple each. */}
              {moveRows('Go back to', <CaretDoubleUp size={14} />, moves.back)}
              {moveRows('Go deeper in', <CaretDoubleDown size={14} />, moves.deeper)}
              {moveRows('Go wider in', <CaretDoubleRight size={14} />, moves.wider)}
            </>
          )}
        </div>
      ))}
    </>
  );
}
