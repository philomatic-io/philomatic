import { relationWord } from '../../lib/relations';
import type { Relation } from '../../client/types';
import { kindIcon } from './shared';

/** One row per relation — the neighbour is repeated when several edge types connect the same two
 *  entities (reverted from the stacked form on feedback: the per-edge rows read better). */
export function Connections({ relations, onNavigate }: { relations: Relation[]; onNavigate: (id: string) => void }) {
  if (relations.length === 0) return null;
  const rows = [...relations].sort((a, b) => a.otherLabel.localeCompare(b.otherLabel) || a.type.localeCompare(b.type));
  return (
    <>
      <div className="detail-section">Connections</div>
      <div className="connections">
        {rows.map((r) => {
          const word = relationWord(r.type, r.tags);
          return (
            <button key={`${r.type}-${r.direction}-${r.otherId}`} className="connection" onClick={() => onNavigate(r.otherId)}>
              <span className="connection-type">{r.direction === 'out' ? `${word} →` : `← ${word}`}</span>
              <span style={{ color: `var(--k-${r.otherKind})` }}>{kindIcon(r.otherKind)}</span>
              <span className="connection-target">{r.otherLabel}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
