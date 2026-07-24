/**
 * The ONE create-form, for every kind — the owner's model (2026-07-22): it looks like the
 * detail view with nothing in it yet; you fill out the properties and save. Name-first — you
 * type and Enter/Create persists exactly what you typed (the old create-then-rename flow
 * raced by construction). Per kind that means:
 *   track    — name + goal
 *   source   — title AND url (either alone suffices; url is source identity, so creation is
 *              the ONE chance to set it until the Phase-2 identity work) + author
 *   concept  — name
 *   question — text + what raised it (a source and/or one of its snippets), tied at birth
 *   snippet  — owning source + passage + note + sentiment + a question it raises
 * Tags (every kind) and sentiment (snippets) use the SAME controlled widgets the detail rail
 * uses — components/TagField and SentimentPicker — so the two surfaces cannot drift apart
 * (maintainability phase 3): the create form is the detail with nothing in it yet.
 */
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { TagField } from '../components/TagField';
import { SentimentSeg } from '../components/SentimentPicker';
import { resolveOrCreateConcept } from '../lib/concepts';
import { useEngine } from '../engine-context';
import type { Snapshot } from '../client/types';

const trunc = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function DraftForm({
  kind,
  snapshot,
  onCreated,
  onCancel,
}: {
  kind: 'track' | 'source' | 'concept' | 'question' | 'snippet';
  snapshot: Snapshot | undefined;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const { client, refresh, notify } = useEngine();
  const [text, setText] = useState(''); // the primary field: name / title / text / passage
  const [url, setUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [goal, setGoal] = useState('');
  const [srcTitle, setSrcTitle] = useState(''); // snippet's owner · question's raised-by
  const [snippetId, setSnippetId] = useState(''); // question's raised-by snippet
  const [note, setNote] = useState('');
  const [raisesText, setRaisesText] = useState(''); // snippet: a question it raises
  const [tags, setTags] = useState<string[]>([]);
  const [sentiment, setSentiment] = useState('');
  const [busy, setBusy] = useState(false);

  const findSource = (title: string) =>
    snapshot?.sources.find((s) => s.title.toLowerCase() === title.trim().toLowerCase());
  const pickedSource = findSource(srcTitle);
  // The raised-by snippet picker scopes to the picked source when there is one.
  const snippetPool = (snapshot?.snippets ?? []).filter((n) => (pickedSource ? n.sourceId === pickedSource.id : true));

  const ready =
    kind === 'source'
      ? text.trim().length > 0 || url.trim().length > 0
      : text.trim().length > 0 && (kind !== 'snippet' || srcTitle.trim().length > 0);

  const create = async () => {
    const value = text.trim();
    if (!ready || busy) return;
    setBusy(true);
    try {
      let id: string | undefined;
      if (kind === 'track') {
        await client.importPayload({ version: 2, tracks: [{ title: value, ...(goal.trim() ? { goal: goal.trim() } : {}), ...(tags.length ? { tags } : {}) }] });
        id = (await client.getSnapshot()).tracks.find((t) => t.title === value)?.id;
      } else if (kind === 'source') {
        if (url.trim()) {
          // The capture contract: url is identity; title/author enrich it.
          id = (
            (await client.captureSource({
              url: url.trim(),
              ...(value ? { title: value } : {}),
              ...(author.trim() ? { author: author.trim() } : {}),
              ...(tags.length ? { tags } : {}),
            })) as { sourceId?: string }
          ).sourceId;
        } else {
          // No URL: an offline source (a book, a lecture) — title is all there is.
          await client.importPayload({ version: 2, sources: [{ title: value, modality: 'text', ...(author.trim() ? { author: author.trim() } : {}), ...(tags.length ? { tags } : {}) }] });
          id = (await client.getSnapshot()).sources.find((x) => x.title === value)?.id;
        }
      } else if (kind === 'concept') {
        id = (await resolveOrCreateConcept(client, [], value)).id;
        if (tags.length) await client.update(id, { tags });
      } else if (kind === 'question') {
        await client.importPayload({ version: 2, questions: [{ text: value, ...(tags.length ? { tags } : {}) }] });
        await client.ask(value); // record the learner's ask against the just-authored question
        id = (await client.getQuestions()).questions.find((q) => q.text === value)?.id;
        // Tie provenance at birth (owner request 2026-07-22): what raised this question.
        if (id !== undefined) {
          if (snippetId) await client.link({ srcType: 'snippet', srcId: snippetId, type: 'RAISES', dstType: 'question', dstId: id });
          else if (pickedSource) await client.link({ srcType: 'source', srcId: pickedSource.id, type: 'RAISES', dstType: 'question', dstId: id });
        }
      } else {
        if (!pickedSource) {
          notify(`No source titled “${srcTitle.trim()}” — a snippet needs an existing source`);
          setBusy(false);
          return;
        }
        id = (
          (await client.captureSnippet({
            sourceId: pickedSource.id,
            text: value,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(sentiment ? { sentiment } : {}),
            ...(raisesText.trim() ? { raises: [raisesText.trim()] } : {}),
            ...(tags.length ? { tags } : {}),
          })) as { snippetId?: string }
        ).snippetId;
      }
      await refresh();
      if (id !== undefined) {
        onCreated(id);
        notify(`Created ${kind} ✓`);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void create();
    if (e.key === 'Escape') onCancel();
  };
  const field = (labelText: string, node: React.ReactNode) => (
    <label className="detail-field">
      {labelText}
      {node}
    </label>
  );
  const sourcePicker = (labelText: string, placeholder: string) =>
    field(
      labelText,
      <>
        <input list="pm-draft-sources" placeholder={placeholder} value={srcTitle} onChange={(e) => { setSrcTitle(e.target.value); setSnippetId(''); }} />
        <datalist id="pm-draft-sources">
          {(snapshot?.sources ?? []).map((s) => (
            <option key={s.id} value={s.title} />
          ))}
        </datalist>
      </>,
    );

  const primaryLabel =
    kind === 'track' ? 'track name' : kind === 'source' ? 'title' : kind === 'concept' ? 'concept name' : kind === 'question' ? 'question text' : 'passage text';
  return (
    <div className="pane detail draft-form">
      <div className="draft-head">
        <span className="draft-icon" style={{ color: `var(--k-${kind})` }}>
          <Icon name={kind} size={18} />
        </span>
        New {kind}
      </div>

      {kind === 'snippet' && sourcePicker('which source?', 'source title…')}

      {field(
        primaryLabel,
        kind === 'snippet' ? (
          <textarea autoFocus rows={4} placeholder={`${primaryLabel}…`} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input autoFocus placeholder={`${primaryLabel}…`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
        ),
      )}

      {kind === 'track' &&
        field('goal (optional)', <textarea rows={2} placeholder="what is this path for?…" value={goal} onChange={(e) => setGoal(e.target.value)} />)}

      {kind === 'source' && (
        <>
          {field('url', <input placeholder="https://… (identity — can’t be added later)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={keys} />)}
          {field('author (optional)', <input placeholder="author…" value={author} onChange={(e) => setAuthor(e.target.value)} onKeyDown={keys} />)}
        </>
      )}

      {kind === 'question' && (
        <>
          {sourcePicker('raised while reading (optional)', 'source title…')}
          {field(
            'raised by a specific snippet (optional)',
            <select value={snippetId} onChange={(e) => setSnippetId(e.target.value)}>
              <option value="">—</option>
              {snippetPool.map((n) => (
                <option key={n.id} value={n.id}>
                  {trunc(n.text.replace(/\s+/g, ' '), 70)}
                </option>
              ))}
            </select>,
          )}
        </>
      )}

      {kind === 'snippet' && (
        <>
          {field('your note (optional)', <input placeholder="what struck you…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={keys} />)}
          {field('how it struck you (optional)', <SentimentSeg value={sentiment} onChange={setSentiment} />)}
          {field('raises a question (optional)', <input placeholder="what did it make you wonder?…" value={raisesText} onChange={(e) => setRaisesText(e.target.value)} onKeyDown={keys} />)}
        </>
      )}

      {field('tags (optional)', <TagField tags={tags} onChange={setTags} />)}

      <div className="detail-actions">
        <button className="action" disabled={!ready || busy} onClick={() => void create()}>
          Create
        </button>
        <button className="link-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
