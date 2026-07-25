import { SentimentSeg } from '../../components/SentimentPicker';
import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, SnippetView } from '../../client/types';
import { TagEditor } from './TagEditor';
import { PickerBox } from './PickerBox';
import { kindIcon } from './shared';

export function SnippetBody({
  snippet,
  questions,
  onNavigate,
}: {
  snippet: SnippetView;
  questions: QuestionView[];
  onNavigate: (id: string) => void;
}) {
  const { client, refresh, notify } = useEngine();
  const act = useAction();
  const [note, setNote] = useState(snippet.note ?? '');
  const [sentiment, setSentiment] = useState(snippet.sentiment ?? '');
  const [busy, setBusy] = useState(false);
  // Tie a question from the snippet's side (owner request, 2026-07-19): raises / answers,
  // authoring the question first when it's new (text identity — capture's 'created if
  // unseen' semantic, so this row doubles as ask-from-a-passage).
  const [qWord, setQWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  const verb = qWord === 'RAISES' ? 'Raises' : 'Answers';
  const edgeForQ = (qId: string) => ({ srcType: 'snippet', srcId: snippet.id, type: qWord, dstType: 'question', dstId: qId, tags: [] as { name: string }[] });
  // Tie one or more EXISTING questions at the chosen verb, as one undoable batch (owner,
  // 2026-07-24: the same multiselect palette as the concept/source pickers, question glyph).
  const tieQuestions = async (ids: string[]) => {
    if (ids.length === 0) return;
    await act(async () => {
      const edges = ids.map(edgeForQ);
      for (const e of edges) await client.link(e);
      return {
        label: `tie ${qWord.toLowerCase()} → ${edges.length === 1 ? 'a question' : `${edges.length} questions`}`,
        invert: async () => {
          for (const e of edges) await client.unlink({ srcId: e.srcId, type: e.type, dstId: e.dstId });
        },
      };
    }, `${verb} ${ids.length === 1 ? 'a question' : `${ids.length} questions`} ✓`);
  };
  // Author a NEW question from the typed text and tie it (this row doubles as ask-from-a-passage).
  const createAndTie = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    await act(async () => {
      let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
      let created = false;
      if (q === undefined) {
        await client.importPayload({ version: 2, questions: [{ text: value }] });
        q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
        created = true;
      }
      if (q === undefined) throw new Error('could not resolve the question');
      const qId = q.id;
      const edge = edgeForQ(qId);
      await client.link(edge);
      return {
        label: `tie ${qWord.toLowerCase()} → question`,
        invert: async () => {
          await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
          if (created) await client.remove(qId);
        },
      };
    }, `${verb} “${value.slice(0, 40)}” ✓`);
  };
  const tiedQIds = new Set(
    questions.filter((q) => q.raisedBy.some((r) => r.id === snippet.id) || q.answeredBy.some((r) => r.id === snippet.id)).map((q) => q.id),
  );
  const questionOptions = questions.filter((q) => !tiedQIds.has(q.id)).map((q) => ({ id: q.id, label: q.text, icon: 'question' as const }));

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (note.trim() !== (snippet.note ?? '')) patch.note = note.trim();
    if (sentiment !== (snippet.sentiment ?? '')) patch.sentiment = sentiment;
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    const before = { note: snippet.note ?? '', sentiment: snippet.sentiment ?? '' };
    try {
      await act(async () => {
        await client.update(snippet.id, patch);
        return { label: 'edit note', invert: () => client.update(snippet.id, before) };
      }, 'Saved ✓');
    } finally {
      setBusy(false);
    }
  };

  // The passage is the pane's heading (item.title) and its source is in the detail-top meta —
  // so no blockquote/"from" repeat here (feedback round 3).
  return (
    <>
      <TagEditor id={snippet.id} tags={snippet.tags} />
      <label className="detail-field">
        Note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => void save()} placeholder="your note" rows={3} />
      </label>
      <div className="detail-field">
        Sentiment
        <SentimentSeg
          value={sentiment}
          onChange={(next) => {
            setSentiment(next);
            const prev = snippet.sentiment ?? '';
            void act(async () => {
              await client.update(snippet.id, { sentiment: next });
              return { label: 'set sentiment', invert: () => client.update(snippet.id, { sentiment: prev }) };
            }, '');
          }}
        />
      </div>
      <div className="detail-section">Questions</div>
      {(() => {
        const mine = questions
          .flatMap((q) => [
            ...q.raisedBy.filter((r) => r.id === snippet.id).map(() => ({ q, word: 'raises' as const })),
            ...q.answeredBy.filter((r) => r.id === snippet.id).map(() => ({ q, word: 'answers' as const })),
          ]);
        return mine.length === 0 ? (
          <p className="hint" style={{ padding: 0 }}>none tied yet</p>
        ) : (
          <div className="connections">
            {mine.map(({ q, word }) => (
              <button key={`${word}-${q.id}`} className="connection" onClick={() => onNavigate(q.id)}>
                <span className="connection-type">{word}</span>
                <span style={{ color: 'var(--k-question)' }}>{kindIcon('question')}</span>
                <span className="connection-target">{q.text}</span>
              </button>
            ))}
          </div>
        );
      })()}
      <div className="anchor-picker">
        <select className="anchor-flavor" value={qWord} onChange={(e) => setQWord(e.target.value as 'RAISES' | 'ANSWERS')} title="how this passage relates to the question">
          <option value="RAISES">raises</option>
          <option value="ANSWERS">answers</option>
        </select>
        <PickerBox
          options={questionOptions}
          placeholder="add a question…"
          variant="question"
          onPick={(ids) => void tieQuestions(ids)}
          onCreate={(text) => void createAndTie(text)}
        />
      </div>
    </>
  );
}
