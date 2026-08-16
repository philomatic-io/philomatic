/**
 * The ONE create-form, for every kind — the owner's model: it looks like the
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
import { TreeStructure } from '@phosphor-icons/react';
import { Icon } from '../components/Icon';
import { TagField } from '../components/TagField';
import { SentimentSeg } from '../components/SentimentPicker';
import { resolveOrCreateConcept } from '../lib/concepts';
import { createSource } from '../lib/sources';
import { provenanceEdge } from '../lib/ties';
import { useEngine } from '../engine-context';
import { EditModeCtx } from './detail/shared';
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
  // The survey→track pass: a new track can be DRAFTED from a
  // survey URL instead of typed — capture the page, run the survey chain, land on the staged
  // track's rail for review.
  const [surveyUrl, setSurveyUrl] = useState('');

  const draftFromSurvey = async () => {
    const u = surveyUrl.trim();
    if (u === '' || busy) return;
    setBusy(true);
    try {
      await client.captureSource({ url: u, stage: false }); // deliberate capture — not backlog
      const r = await client.proposeTrack({ ref: u });
      await refresh();
      if (r.staged.length === 0 && r.notes.length > 0) {
        notify(`Nothing drafted — ${r.notes[0]}`);
      } else if (r.staged.length <= 1 && r.notes.length > 0) {
        // just the track, no readings — a thin draft is a report, not a success
        notify(`Drafted “${r.trackTitle}” but found no readings — ${r.notes[r.notes.length - 1]}`);
        onCreated(r.trackId);
      } else {
        notify(`Drafted “${r.trackTitle}” — ${r.staged.length} item${r.staged.length === 1 ? '' : 's'} staged; review and accept`);
        onCreated(r.trackId);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
        // Same explicit create as the track picker (lib/sources): url → a link, none → offline by
        // title. `ready` already guarantees a title or a url is present.
        id = (await createSource(client, { title: value || undefined, url: url.trim() || undefined, author: author.trim() || undefined, tags: tags.length ? tags : undefined })).id;
      } else if (kind === 'concept') {
        id = (await resolveOrCreateConcept(client, [], value)).id;
        if (tags.length) await client.update(id, { tags });
      } else if (kind === 'question') {
        await client.importPayload({ version: 2, questions: [{ text: value, ...(tags.length ? { tags } : {}) }] });
        await client.ask(value); // record the learner's ask against the just-authored question
        id = (await client.getQuestions()).questions.find((q) => q.text === value)?.id;
        // Tie provenance at birth: what raised this question.
        if (id !== undefined) {
          if (snippetId) await client.link(provenanceEdge({ kind: 'snippet', id: snippetId }, 'RAISES', id));
          else if (pickedSource) await client.link(provenanceEdge({ kind: 'source', id: pickedSource.id }, 'RAISES', id));
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
    // The create surface IS the detail with nothing in it yet:
    // same header chrome, editing state ON — after the name-first create, the rail becomes the
    // real detail with editing still on.
    <EditModeCtx.Provider value={true}>
    <div className="pane detail draft-form editing">
      <div className="detail-top">
        <span className="kind-badge" style={{ color: `var(--k-${kind})` }}>
          <Icon name={kind} size={17} filled />
        </span>
        <span className="kind-label">new {kind}</span>
        <span style={{ flex: 1 }} />
        <span className="edit-toggle on">✎ creating</span>
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

      {kind === 'track' && (
        <>
          {field(
            'or draft the whole track from a survey (URL)',
            <input
              placeholder="https://… a survey or overview article"
              value={surveyUrl}
              onChange={(e) => setSurveyUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void draftFromSurvey();
                if (e.key === 'Escape') onCancel();
              }}
            />,
          )}
          {surveyUrl.trim() !== '' && (
            <div className="detail-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
              <button className="link-btn publish-go" disabled={busy} onClick={() => void draftFromSurvey()}>
                {busy ? '… drafting from survey' : <><TreeStructure size={14} /> Draft track from survey</>}
              </button>
              <span className="hint" style={{ fontSize: 12 }}>
                captures the page, then stages a whole track — readings, order, concepts — for your review
              </span>
            </div>
          )}
        </>
      )}

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
    </EditModeCtx.Provider>
  );
}
