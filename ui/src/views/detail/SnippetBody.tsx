import { SentimentSeg } from '../../components/SentimentPicker';
import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, SnippetView } from '../../client/types';
import { TagEditor } from './TagEditor';
import { PickerBox } from './PickerBox';
import { kindIcon } from './shared';
import { RelationChip } from './Connections';

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
    </>
  );
}
