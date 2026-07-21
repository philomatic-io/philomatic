/**
 * Create-form for identity-named entities (concept / question / snippet) — owner request
 * 2026-07-20. Their name/text IS their id (can't be renamed after creation), so unlike
 * track/source (create-then-name in the detail) these are typed here and persisted on Create.
 * Rendered in the detail rail's slot; on success the new entity is selected and shows normally.
 */
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { resolveOrCreateConcept } from '../lib/concepts';
import type { EngineClient } from '../client/transport';
import type { Snapshot } from '../client/types';

export function DraftForm({
  kind,
  client,
  snapshot,
  refresh,
  notify,
  onCreated,
  onCancel,
}: {
  kind: 'concept' | 'question' | 'snippet';
  client: EngineClient;
  snapshot: Snapshot | undefined;
  refresh: () => Promise<void>;
  notify: (m: string) => void;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [srcTitle, setSrcTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = text.trim().length > 0 && (kind !== 'snippet' || srcTitle.trim().length > 0);
  const create = async () => {
    const value = text.trim();
    if (!ready || busy) return;
    setBusy(true);
    try {
      let id: string | undefined;
      if (kind === 'concept') {
        id = (await resolveOrCreateConcept(client, [], value)).id;
      } else if (kind === 'question') {
        await client.importPayload({ version: 2, questions: [{ text: value }] });
        await client.ask(value); // record the learner's ask against the just-authored question
        id = (await client.getQuestions()).questions.find((q) => q.text === value)?.id;
      } else {
        const src = snapshot?.sources.find((s) => s.title.toLowerCase() === srcTitle.trim().toLowerCase());
        if (!src) {
          notify(`No source titled “${srcTitle.trim()}” — a snippet needs an existing source`);
          setBusy(false);
          return;
        }
        id = ((await client.captureSnippet({ sourceId: src.id, text: value })) as { snippetId?: string }).snippetId;
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

  const label = kind === 'concept' ? 'concept name' : kind === 'question' ? 'question text' : 'passage text';
  return (
    <div className="pane detail draft-form">
      <div className="draft-head">
        <span className="draft-icon" style={{ color: `var(--k-${kind})` }}>
          <Icon name={kind} size={18} />
        </span>
        New {kind}
      </div>
      {kind === 'snippet' && (
        <label className="detail-field">
          which source?
          <input
            list="pm-draft-sources"
            placeholder="source title…"
            value={srcTitle}
            onChange={(e) => setSrcTitle(e.target.value)}
          />
          <datalist id="pm-draft-sources">
            {(snapshot?.sources ?? []).map((s) => (
              <option key={s.id} value={s.title} />
            ))}
          </datalist>
        </label>
      )}
      <label className="detail-field">
        {label}
        {kind === 'snippet' ? (
          <textarea autoFocus rows={5} placeholder={`${label}…`} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input
            autoFocus
            placeholder={`${label}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') onCancel();
            }}
          />
        )}
      </label>
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
