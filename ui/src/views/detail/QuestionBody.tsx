import { sourceIcon } from '../../components/Icon';
import { useAction, useEngine } from '../../engine-context';
import { useState } from 'react';
import type { QuestionView, Snapshot } from '../../client/types';
import { PickerBox } from './PickerBox';
import { questionAboutConcepts, tieQuestions } from '../../lib/ties';

const trunc = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The question page body: status only — every connection (about-concepts, raised-by,
 *  answered-by) lives in the unified Connections list, with the adders below as that group's
 *  end-of-section affordance. */
export function QuestionBody({ question }: { question: QuestionView }) {
  return (
    <div className="detail-tags">
      {question.gap && (
        <span className="chip" style={{ color: 'var(--k-snippet)' }} title="no source or snippet in your library answers this question yet">
          no answer in your library
        </span>
      )}
      {question.answered && <span className="chip" style={{ color: 'var(--ok)' }}>answered ✓</span>}
    </div>
  );
}

/** Sources- or Snippets-group adder: tie raised-by/answered-by provenance to this question. */
export function QuestionTieAdder({
  question,
  snapshot,
  kind,
}: {
  question: QuestionView;
  snapshot: Snapshot;
  kind: 'source' | 'snippet';
}) {
  const { client } = useEngine();
  const act = useAction();
  const [tieWord, setTieWord] = useState<'RAISES' | 'ANSWERS'>('RAISES');
  // A NEW snippet needs an owning source (identity); the adder carries a source select so the
  // "＋ create" can captureSnippet there and tie it in one undoable gesture.
  const [srcForNew, setSrcForNew] = useState('');
  const createSnippetAndTie = async (text: string) => {
    const value = text.trim();
    const sourceId = srcForNew || snapshot.sources[0]?.id;
    if (!value || sourceId === undefined) return;
    await act(async () => {
      const r = (await client.captureSnippet({ sourceId, text: value })) as { snippetId?: string; created?: boolean };
      if (r.snippetId === undefined) throw new Error('captured the snippet but could not resolve its id');
      const sid = r.snippetId;
      const g = await tieQuestions(client, { kind: 'snippet', id: sid }, tieWord, [question.id]);
      return {
        label: `capture + tie snippet`,
        invert: async () => {
          await g.invert();
          if (r.created !== false) await client.remove(sid);
        },
      };
    }, `Snippet captured and tied ✓`);
  };
  const options =
    kind === 'source'
      ? snapshot.sources.map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }))
      : snapshot.snippets.map((s) => ({ id: s.id, label: trunc(s.text), icon: 'snippet' as const }));
  const addTies = async (ids: string[]) => {
    if (ids.length === 0) return;
    // ONE gesture implementation per content item (lib/ties) — shared with the content rails.
    await act(async () => {
      const gestures: { invert: () => Promise<void> }[] = [];
      for (const id of ids) gestures.push(await tieQuestions(client, { kind, id }, tieWord, [question.id]));
      return {
        label: `tie ${ids.length === 1 ? 'one' : ids.length} to the question`,
        invert: async () => {
          for (const g of gestures) await g.invert();
        },
      };
    }, `${tieWord === 'RAISES' ? 'Raised by' : 'Answered by'} ${ids.length === 1 ? `a ${kind}` : `${ids.length} ${kind}s`} ✓`);
  };
  return (
    <div className="anchor-picker">
      <select className="anchor-flavor" value={tieWord} onChange={(e) => setTieWord(e.target.value as 'RAISES' | 'ANSWERS')}>
        <option value="RAISES">raised by</option>
        <option value="ANSWERS">answered by</option>
      </select>
      {kind === 'snippet' && (
        <select className="anchor-flavor" value={srcForNew} onChange={(e) => setSrcForNew(e.target.value)} title="which source a NEW snippet belongs to">
          {snapshot.sources.map((src) => (
            <option key={src.id} value={src.id}>
              {src.title.length > 28 ? `${src.title.slice(0, 28)}…` : src.title}
            </option>
          ))}
        </select>
      )}
      <PickerBox
        options={options}
        placeholder={`tie a ${kind}…`}
        variant={kind}
        onPick={(ids) => void addTies(ids)}
        onCreate={kind === 'snippet' ? (text) => void createSnippetAndTie(text) : undefined}
      />
    </div>
  );
}

/** Concepts-group adder: question ABOUT concept — the anchor edge the schema always had.
 *  Create-if-unseen via the shared resolver; one undoable batch. */
export function QuestionConceptAdder({
  question,
  concepts,
}: {
  question: QuestionView;
  concepts: { id: string; name: string; tracked: boolean }[];
}) {
  const { client } = useEngine();
  const act = useAction();
  const options = concepts.map((c) => ({ id: c.name, label: c.name, icon: 'concept' as const }));
  const addConcepts = async (names: string[]) => {
    const clean = names.filter((n) => n.trim());
    if (clean.length === 0) return;
    await act(() => questionAboutConcepts(client, question.id, clean, concepts), `About ${clean.length === 1 ? '“' + clean[0]!.trim() + '”' : clean.length + ' concepts'} ✓`);
  };
  return (
    <div className="anchor-picker">
      <span className="anchor-flavor" style={{ display: 'inline-flex', alignItems: 'center' }}>about</span>
      <PickerBox options={options} placeholder="tie a concept…" variant="concept" onPick={(names) => void addConcepts(names)} onCreate={(name) => void addConcepts([name])} />
    </div>
  );
}
