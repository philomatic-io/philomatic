import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, Snapshot } from '../../client/types';
import { kindIcon } from './shared';

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
  const [tieTitle, setTieTitle] = useState('');
  const addTie = async () => {
    const value = tieTitle.trim();
    if (!value) return;
    // Resolve a source by title first, then a snippet by its text — one row ties either kind.
    const src = snapshot.sources.find((x) => x.title.toLowerCase() === value.toLowerCase());
    const snp = src === undefined ? snapshot.snippets.find((x) => x.text.toLowerCase() === value.toLowerCase()) : undefined;
    const other = src !== undefined ? { kind: 'source', id: src.id, label: src.title } : snp !== undefined ? { kind: 'snippet', id: snp.id, label: snp.text } : undefined;
    if (other === undefined) {
      notify(`No source or snippet matching “${value.slice(0, 40)}”`);
      return;
    }
    const edge = { srcType: other.kind, srcId: other.id, type: tieWord, dstType: 'question', dstId: question.id, tags: [] };
    try {
      await client.link(edge);
      await refresh();
      setTieTitle('');
      pushUndo(`tie ${tieWord.toLowerCase()} → question`, () => client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId }));
      notify(`${tieWord === 'RAISES' ? 'Raised by' : 'Answered by'} “${other.label.slice(0, 40)}” ✓`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
      <div className="order-addrow">
        <select className="order-pick" value={tieWord} onChange={(e) => setTieWord(e.target.value as 'RAISES' | 'ANSWERS')}>
          <option value="RAISES">raised by</option>
          <option value="ANSWERS">answered by</option>
        </select>
        <input
          className="order-input"
          list="question-tie-sources"
          placeholder="a source’s title or a snippet’s text…"
          value={tieTitle}
          onChange={(e) => setTieTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTie();
          }}
        />
        <button className="link-btn" disabled={!tieTitle.trim()} onClick={() => void addTie()}>
          + Link
        </button>
        <datalist id="question-tie-sources">
          {snapshot.sources.map((x) => (
            <option key={x.id} value={x.title} />
          ))}
          {snapshot.snippets.map((x) => (
            <option key={x.id} value={x.text} />
          ))}
        </datalist>
      </div>
    </>
  );
}
