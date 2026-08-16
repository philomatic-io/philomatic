import { useState } from 'react';
import { useAction, useEngine } from '../../engine-context';
import type { QuestionView } from '../../client/types';
import { PickerBox } from './PickerBox';
import { tieQuestionByText, tieQuestions } from '../../lib/ties';

/**
 * The Questions-group add affordance for a source or snippet page:
 * tie raises/answers to existing questions, or author a new question from the typed text and
 * tie it (ask-from-here). Extracted from SnippetBody so both pages share one write path; the
 * rows themselves render in the unified Connections list.
 */
export function AddQuestionRow({
  srcType,
  srcId,
  questions,
}: {
  srcType: 'source' | 'snippet';
  srcId: string;
  questions: QuestionView[];
}) {
  const { client } = useEngine();
  const act = useAction();
  const [qWord, setQWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  const verb = qWord === 'RAISES' ? 'Raises' : 'Answers';
  const tiedQIds = new Set(
    questions.filter((q) => q.raisedBy.some((r) => r.id === srcId) || q.answeredBy.some((r) => r.id === srcId)).map((q) => q.id),
  );
  const options = questions.filter((q) => !tiedQIds.has(q.id)).map((q) => ({ id: q.id, label: q.text, icon: 'question' as const }));
  // ONE gesture implementation (lib/ties) — shared with the question rail's mirror adder.
  const tie = (ids: string[]) =>
    ids.length > 0 && act(() => tieQuestions(client, { kind: srcType, id: srcId }, qWord, ids), `${verb} ${ids.length === 1 ? 'a question' : `${ids.length} questions`} ✓`);
  const createAndTie = (text: string) =>
    text.trim() && act(() => tieQuestionByText(client, { kind: srcType, id: srcId }, qWord, text, questions), `${verb} “${text.trim().slice(0, 40)}” ✓`);
  return (
    <div className="anchor-picker">
      <select className="anchor-flavor" value={qWord} onChange={(e) => setQWord(e.target.value as 'RAISES' | 'ANSWERS')} title="how this relates to the question">
        <option value="RAISES">raises</option>
        <option value="ANSWERS">answers</option>
      </select>
      <PickerBox options={options} placeholder="add a question…" variant="question" onPick={(ids) => void tie(ids)} onCreate={(text) => void createAndTie(text)} />
    </div>
  );
}
