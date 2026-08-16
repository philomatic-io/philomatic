import { nextMoves } from '../../lib/topics';
import { CaretDoubleDown, CaretDoubleRight, CaretDoubleUp } from '@phosphor-icons/react';
import { useMemo } from 'react';
import { Icon, sourceIcon } from '../../components/Icon';
import type { AssembleResult, GraphEnvelope, Snapshot, SourceView } from '../../client/types';
import type { NextMove, NextMoves } from '../../lib/topics';

/** Next reading — the two live moves from a source inside a
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
    const withMoves = snapshot.tracks
      .map((t) => ({ trackId: t.id, title: t.title, moves: nextMoves(projection.asm, projection.graph, t.id, snapshot.sources, source.id) }))
      .filter((x): x is { trackId: string; title: string; moves: NextMoves } => x.moves !== undefined)
      ;
    // ONE row per recommended source, across the whole section.
    // Tracks that share a concept reach the same reading, so a source sitting in two of them was
    // recommended twice — the identical pair of "go deeper" cards under two different track
    // names, which reads as a bug because it is one. The first track to offer a source keeps it.
    const seen = new Set<string>();
    const fresh = (ms: NextMove[]): NextMove[] =>
      ms.filter((m) => {
        if (seen.has(m.source.id)) return false;
        seen.add(m.source.id);
        return true;
      });
    return withMoves
      .map((x) => ({ ...x, moves: { ...x.moves, back: fresh(x.moves.back), deeper: fresh(x.moves.deeper), wider: fresh(x.moves.wider) } }))
      // A track with no move LEFT to offer contributes NOTHING — not a row, and not a sentence
      // saying so. "frontier reached — nothing further in X" is a section
      // reporting its own emptiness, once per track, and on a source at the end of every track
      // that was the entire section. Silence says it better.
      .filter((x) => x.moves.back.length + x.moves.deeper.length + x.moves.wider.length > 0);
  }, [projection, snapshot.tracks, snapshot.sources, source.id]);

  if (perTrack.length === 0) return null;

  // One row per move. `label` carries its own connector ("Go back to", "Go deeper in") — a
  // backward move reads differently. The via concept is just a standard concept chip: no
  // "Topic N" numbering, since we never define "topic" to the user.
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
          <span style={{ color: 'var(--k-source)', marginRight: '0.35rem', verticalAlign: '-2px' }}>
            <Icon name={sourceIcon(m.source.modality)} size={13} />
          </span>
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
          {/* Go back first — the foundation to review before moving on —
              then deeper down the branch, then wider into a new topic. Multiple each. At least
              one of these is non-empty, or the track would not be here. */}
          {moveRows('Go back to', <CaretDoubleUp size={14} />, moves.back)}
          {moveRows('Go deeper in', <CaretDoubleDown size={14} />, moves.deeper)}
          {moveRows('Go wider in', <CaretDoubleRight size={14} />, moves.wider)}
        </div>
      ))}
    </>
  );
}
