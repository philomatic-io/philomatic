import { SentimentSeg } from '../../components/SentimentPicker';
import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, SnippetView } from '../../client/types';
import { TagEditor } from './TagEditor';
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
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const [note, setNote] = useState(snippet.note ?? '');
  const [sentiment, setSentiment] = useState(snippet.sentiment ?? '');
  const [busy, setBusy] = useState(false);
  // Tie a question from the snippet's side (owner request, 2026-07-19): raises / answers,
  // authoring the question first when it's new (text identity — capture's 'created if
  // unseen' semantic, so this row doubles as ask-from-a-passage).
  const [qWord, setQWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  const [qText, setQText] = useState('');
  const tieQuestion = async () => {
    const value = qText.trim();
    if (!value) return;
    try {
      let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
      let created = false;
      if (q === undefined) {
        await client.importPayload({ version: 2, questions: [{ text: value }] });
        q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
        created = true;
      }
      if (q === undefined) throw new Error('could not resolve the question');
      const qId = q.id;
      const edge = { srcType: 'snippet', srcId: snippet.id, type: qWord, dstType: 'question', dstId: qId, tags: [] };
      await client.link(edge);
      await refresh();
      setQText('');
      pushUndo(`tie ${qWord.toLowerCase()} → question`, async () => {
        await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
        if (created) await client.remove(qId);
      });
      notify(`${qWord === 'RAISES' ? 'Raises' : 'Answers'} “${value.slice(0, 40)}” ✓${created ? ' (new question)' : ''}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

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
      <div className="order-addrow">
        <select className="order-pick" value={qWord} onChange={(e) => setQWord(e.target.value as 'RAISES' | 'ANSWERS')}>
          <option value="RAISES">raises</option>
          <option value="ANSWERS">answers</option>
        </select>
        <input
          className="order-input"
          list="snippet-tie-questions"
          placeholder="a question (new or existing)…"
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void tieQuestion();
          }}
        />
        <button className="link-btn" disabled={!qText.trim()} onClick={() => void tieQuestion()}>
          + Link
        </button>
        <datalist id="snippet-tie-questions">
          {questions.map((x) => (
            <option key={x.id} value={x.text} />
          ))}
        </datalist>
      </div>
    </>
  );
}
