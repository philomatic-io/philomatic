/** Journey column 4 — the selected source's snippets; ones related to a focused question first. */
import { Icon } from '../../components/Icon';
import { SnippetText } from '../../lib/snippet-md';
import { SentimentTag } from '../../lib/sentiment';
import type { SnippetView, SourceView } from '../../client/types';
import { AddBox } from './AddBox';
import type { Focus, Rel } from './shared';

export function SnippetsColumn({
  activeSrc,
  insideSnippets,
  relOfSnippet,
  focus,
  setFocus,
  edit,
  addSnippet,
  onOpenInLibrary,
}: {
  activeSrc?: SourceView;
  insideSnippets: SnippetView[];
  relOfSnippet: (s: SnippetView) => Rel;
  focus?: Focus;
  setFocus: (f: Focus) => void;
  edit: boolean;
  addSnippet: (text: string) => void;
  onOpenInLibrary: (id: string) => void;
}) {
  return (
        <div className="journey-col">
          <div className="col-head">Snippets</div>
          {!activeSrc && <p className="hint">Pick a source.</p>}
          {activeSrc && insideSnippets.length === 0 && <p className="hint">No snippets yet.</p>}
          {(() => {
            const focusedQ = focus?.kind === 'question';
            // When a question is focused, put the snippets that RELATE to it first.
            const ordered = focusedQ
              ? [...insideSnippets].sort((a, b) => (relOfSnippet(b) ? 1 : 0) - (relOfSnippet(a) ? 1 : 0))
              : insideSnippets;
            return ordered.map((s) => {
              const rel = relOfSnippet(s);
              const cls = ['col-row', focus?.id === s.id ? 'on' : '', rel ? `rel-${rel}` : ''].filter(Boolean).join(' ');
              return (
                <button key={s.id} className={cls} onClick={() => setFocus({ kind: 'snippet', id: s.id })} onDoubleClick={() => onOpenInLibrary(s.id)}>
                  <span className="col-row-title snippet-cell">
                    <span style={{ color: 'var(--k-snippet)' }}><Icon name="snippet" size={13} /></span>
                    <span className="snippet-cell-body"><SnippetText text={s.text} images="inline" /></span>
                    {rel === 'raised' && <span className="rel-badge raised">raises ↑</span>}
                    {rel === 'answered' && <span className="rel-badge answered">answers ✓</span>}
                  </span>
                  <span className="col-row-meta">
                    {s.sentiment && <SentimentTag token={s.sentiment} />}
                    {s.raises.length > 0 && <span> · raises {s.raises.length}</span>}
                  </span>
                </button>
              );
            });
          })()}
          {edit && activeSrc && <AddBox label="add snippet" fields={[{ key: 'text', placeholder: 'Paste a passage…', textarea: true }]} onSubmit={(v) => addSnippet(v.text ?? '')} />}
        </div>
  );
}
