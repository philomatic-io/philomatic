/** Journey column 3 — the questions of the selected source or concept, Open above Answered. */
import { Icon } from '../../components/Icon';
import type { QuestionView, SourceView } from '../../client/types';
import { ConnectionAdd } from '../detail/Connections';
import { AddQuestionRow } from '../detail/AddQuestionRow';
import type { Focus, Rel } from './shared';

export function QuestionsColumn({
  selectedConcept,
  activeSrc,
  insideQuestions,
  questionsOfConcept,
  relOfQuestion,
  focus,
  setFocus,
  edit,
  allQuestions,
}: {
  selectedConcept?: { id: string; name: string };
  activeSrc?: SourceView;
  insideQuestions: QuestionView[];
  questionsOfConcept: (name: string) => QuestionView[];
  relOfQuestion: (q: QuestionView) => Rel;
  focus?: Focus;
  setFocus: (f: Focus) => void;
  edit: boolean;
  /** The FULL question list — the adder's options/dedup (the library's AddQuestionRow). */
  allQuestions: QuestionView[];
}) {
  return (
        <div className="journey-col">
          <div className="col-head">Questions{selectedConcept ? ` · ${selectedConcept.name}` : ''}</div>
          {(() => {
            const qs = selectedConcept ? questionsOfConcept(selectedConcept.name) : activeSrc ? insideQuestions : [];
            if (!selectedConcept && !activeSrc) return <p className="hint">Pick a source or concept.</p>;
            if (qs.length === 0) return <p className="hint">{selectedConcept ? `No questions in “${selectedConcept.name}” yet.` : 'No questions yet.'}</p>;
            const open = qs.filter((q) => !q.answered);
            const answered = qs.filter((q) => q.answered);
            const row = (q: QuestionView) => {
              const rel = relOfQuestion(q);
              const fromSource = activeSrc !== undefined && q.raisedBy.some((r) => r.kind === 'source' && r.id === activeSrc.id);
              const cls = ['col-row', focus?.id === q.id ? 'on' : '', rel ? `rel-${rel}` : ''].filter(Boolean).join(' ');
              return (
                <button key={q.id} className={cls} onClick={() => setFocus({ kind: 'question', id: q.id })}>
                  <span className="col-row-title">
                    <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={13} /></span> {q.text}
                    {rel === 'raised' && <span className="rel-badge raised">raised by ↑</span>}
                    {rel === 'answered' && <span className="rel-badge answered">answered by ✓</span>}
                  </span>
                  {activeSrc && (
                    <span className="col-row-meta">
                      <span className={fromSource ? 'src-badge source' : 'src-badge snippet'}>{fromSource ? 'from source' : 'from a snippet'}</span>
                    </span>
                  )}
                </button>
              );
            };
            return (
              <>
                {open.length > 0 && <div className="q-section open">Open · {open.length}</div>}
                {open.map(row)}
                {answered.length > 0 && <div className="q-section answered">Answered · {answered.length}</div>}
                {answered.map(row)}
              </>
            );
          })()}
          {edit && activeSrc && (
            <ConnectionAdd groupKind="question" selfKind="source">
              <AddQuestionRow srcType="source" srcId={activeSrc.id} questions={allQuestions} />
            </ConnectionAdd>
          )}
        </div>
  );
}
