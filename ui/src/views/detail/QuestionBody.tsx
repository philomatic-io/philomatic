import { sourceIcon } from '../../components/Icon';
import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, Snapshot } from '../../client/types';
import { PickerBox } from './PickerBox';
import { kindIcon } from './shared';

const trunc = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function QuestionBody({
  question,
  snapshot,
  onNavigate,
}: {
  question: QuestionView;
  snapshot: Snapshot;
  onNavigate: (id: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  // Tie the question to a source (owner request, 2026-07-19): raised-by / answered-by from
  // the question's own pane — the RAISES/ANSWERS provenance edges, source → question.
  const [tieWord, setTieWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  // The picker options: sources and snippets, encoded as "<kind>:<id>" so the pick knows which.
  const tieOptions = [
    ...snapshot.sources.map((s) => ({ id: `source:${s.id}`, label: s.title, icon: sourceIcon(s.modality) })),
    ...snapshot.snippets.map((s) => ({ id: `snippet:${s.id}`, label: trunc(s.text), icon: 'snippet' as const })),
  ];
  // Tie one or more sources/snippets to the question at the chosen flavor — ONE undoable batch
  // (owner, 2026-07-24: the same palette picker as the track view).
  const addTies = async (encoded: string[]) => {
    await act(async () => {
      const edges = encoded.map((e) => {
        const at = e.indexOf(':');
        return { srcType: e.slice(0, at), srcId: e.slice(at + 1), type: tieWord, dstType: 'question', dstId: question.id, tags: [] };
      });
      for (const edge of edges) await client.link(edge);
      return {
        label: `tie ${edges.length === 1 ? 'one' : edges.length} to the question`,
        invert: async () => {
          for (const edge of edges) await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
        },
      };
    }, `${tieWord === 'RAISES' ? 'Raised by' : 'Answered by'} ${encoded.length === 1 ? 'a source' : `${encoded.length} sources`} ✓`);
  };
  return (
    <>
      <div className="detail-tags">
        {question.about.map((c) => (
          <span key={c} className="chip">
            {c}
          </span>
        ))}
        {question.gap && (
          <span className="chip" style={{ color: 'var(--k-snippet)' }} title="no source or snippet in your library answers this question yet">
            no answer in your library
          </span>
        )}
        {question.answered && <span className="chip" style={{ color: 'var(--ok)' }}>answered ✓</span>}
      </div>
      {question.raisedBy.length > 0 && (
        <>
          <div className="detail-section">Raised by</div>
          <div className="connections">
            {question.raisedBy.map((a) => (
              <button key={a.id} className="connection" onClick={() => onNavigate(a.id)}>
                <span className="connection-type">raised by</span>
                <span style={{ color: `var(--k-${a.kind})` }}>{kindIcon(a.kind)}</span>
                <span className="connection-target">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="detail-section">Answered by</div>
      {question.answeredBy.length === 0 ? (
        <p className="hint" style={{ padding: 0 }}>no answers yet — link a snippet or source</p>
      ) : (
        <div className="connections">
          {question.answeredBy.map((a) => (
            <button key={a.id} className="connection" onClick={() => onNavigate(a.id)}>
              <span className="connection-type">answered by</span>
              <span style={{ color: `var(--k-${a.kind})` }}>{kindIcon(a.kind)}</span>
              <span className="connection-target">{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="anchor-picker">
        <select className="anchor-flavor" value={tieWord} onChange={(e) => setTieWord(e.target.value as 'RAISES' | 'ANSWERS')}>
          <option value="RAISES">raised by</option>
          <option value="ANSWERS">answered by</option>
        </select>
        <PickerBox options={tieOptions} placeholder="tie a source or snippet…" variant="tie" onPick={(ids) => void addTies(ids)} />
      </div>
    </>
  );
}
