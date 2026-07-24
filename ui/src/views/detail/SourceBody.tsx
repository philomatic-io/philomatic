import { useAction, useEngine } from '../../engine-context';
import { SentimentTag } from '../../lib/sentiment';
import { SnippetText } from '../../lib/snippet-md';
import { LinkSimple, PencilSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { Snapshot, SourceView } from '../../client/types';
import { TagEditor } from './TagEditor';

export function SourceBody({
  source,
  snapshot,
  onNavigate,
}: {
  source: SourceView;
  snapshot: Snapshot;
  onNavigate: (id: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const snippets = snapshot.snippets.filter((s) => s.sourceId === source.id);
  return (
    <>
      {source.personalUrl && (
        <a className="detail-url" href={source.personalUrl}>
          <LinkSimple size={13} /> {source.personalUrl.startsWith('obsidian://') ? 'Open note in Obsidian' : source.personalUrl}
        </a>
      )}
      {source.url && (
        <a className="detail-url" href={source.url} target="_blank" rel="noreferrer">
          <LinkSimple size={13} /> {source.url}
        </a>
      )}
      <SourceFacts source={source} />
      <TagEditor id={source.id} tags={source.tags} />
      {snippets.length > 0 && (
        <>
          <div className="detail-section">Snippets ({snippets.length})</div>
          {snippets.map((s) => (
            <button key={s.id} className="snippet-box" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => onNavigate(s.id)}>
              {s.sentiment && <p className="sentiment"><SentimentTag token={s.sentiment} /></p>}
              <blockquote><SnippetText text={s.text} /></blockquote>
              {s.note && <p className="snippet-note">{s.note}</p>}
            </button>
          ))}
        </>
      )}
    </>
  );
}

/** Author (visible + editable — model v2 made it a pure attribute) and modality (the source
 *  "type": capture infers it from the URL, which guesses wrong for PDFs-in-browser and
 *  podcasts-on-web — so it's correctable here). Owner requests, 2026-07-18. */
export function SourceFacts({
  source,
}: {
  source: SourceView;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  // Pencil-toggled like the title/goal editors (owner request, 2026-07-18): read-only text
  // until the pencil, so a stray click can't start an edit.
  const [editingAuthor, setEditingAuthor] = useState(false);
  const [author, setAuthor] = useState(source.author ?? '');
  useEffect(() => {
    setAuthor(source.author ?? '');
    setEditingAuthor(false);
  }, [source.id, source.author]);

  const saveAuthor = async () => {
    setEditingAuthor(false);
    const next = author.trim();
    if (next === (source.author ?? '') || next === '') {
      setAuthor(source.author ?? '');
      return;
    }
    try {
      const before = source.author;
      await client.update(source.id, { author: next });
      pushUndo('edit author', () => client.update(source.id, { author: before ?? '' }));
      await refresh();
      notify('Author saved ✓');
    } catch (e) {
      setAuthor(source.author ?? '');
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="source-facts">
      <div className="fact-row">
        <span className="fact-label">by</span>
        {editingAuthor ? (
          <input
            autoFocus
            value={author}
            placeholder="add authors…"
            onChange={(e) => setAuthor(e.target.value)}
            onBlur={() => void saveAuthor()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveAuthor();
              if (e.key === 'Escape') {
                setAuthor(source.author ?? '');
                setEditingAuthor(false);
              }
            }}
          />
        ) : (
          <span className="fact-value" title={source.author ?? ''}>
            <span className="fact-value-text">{source.author ?? <span className="fact-empty">add authors…</span>}</span>
            <button className="title-pencil" title="edit authors" onClick={() => setEditingAuthor(true)}>
              <PencilSimple size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
