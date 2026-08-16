import { useDismiss } from '../../lib/use-dismiss';
import { Icon, type IconName } from '../../components/Icon';
import { useEffect, useRef, useState } from 'react';
import { revealAboveFrozenBar } from '../../lib/reveal';

export interface PickerOption {
  id: string;
  label: string;
  /** The glyph shown in the option box — modality icon for a source, 'track', 'concept'. */
  icon: IconName;
}

const ICON_COLOR: Partial<Record<IconName, string>> = {
  concept: 'var(--k-concept)',
  track: 'var(--k-track)',
  question: 'var(--k-question)',
  snippet: 'var(--k-snippet)',
};

/**
 * The one "add" affordance across the track view: a purple bar that opens
 * into a list of icon boxes — the same palette look as Journey's "drag in existing sources".
 *
 * MULTISELECT: click options to check them, then "Add N" commits the whole
 * batch at once (the parent writes them as one undoable action). With `onCreate` (the concept
 * adder) the list gets a filter input and a "＋ create …" row for making a new one. Collapsed
 * until opened and the list scrolls, so a concept 500 sources explain stays one control.
 */
export function PickerBox({
  options,
  placeholder,
  variant,
  onPick,
  onCreate,
  createUrlField,
  single = false,
  value,
}: {
  options: PickerOption[];
  placeholder: string;
  /** A stable hook for tests / styling, e.g. "source" → .picker-trigger.source. */
  variant?: string;
  /** Called once with every checked id when "Add" is clicked — the parent batches the writes. */
  onPick: (ids: string[]) => void;
  /** Present → the list can filter and CREATE a new item from the typed text (a concept by name,
   *  a source by name). The second arg is the optional url from `createUrlField` (undefined when
   *  the field is off or left blank) — the parent decides what a url means. */
  onCreate?: (text: string, url?: string) => void;
  /** Source picker: the create row also shows an OPTIONAL url input, so a new
   *  source can be a url OR just a name — explicitly, no guessing which the typed text is. */
  createUrlField?: boolean;
  /** SINGLE-choice mode (the published Questions tab's anchor pickers):
   *  clicking an option commits it immediately (onPick([id])) and closes — no checkboxes, no
   *  Add footer. Pair with `value` so the trigger names the current choice. */
  single?: boolean;
  /** The current choice's label, shown on the trigger instead of the placeholder. */
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [newUrl, setNewUrl] = useState(''); // the create row's optional url (createUrlField)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setSelected(new Set());
    setQuery('');
    setNewUrl('');
  };
  // An open picker's commit button must be VISIBLE: the rail pins its
  // action row to the foot, and a picker opened near the bottom put "+ Add" behind it. One frame
  // to let the list render, then scroll the least amount that clears the bar.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (footRef.current !== null) revealAboveFrozenBar(footRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, query]);
  useDismiss(boxRef, open, close);

  if (options.length === 0 && onCreate === undefined) return null;

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const exact = options.some((o) => o.label.toLowerCase() === q);
  const wantsCreate = onCreate !== undefined && q.length > 0 && !exact;

  const toggle = (id: string) => {
    if (single) {
      onPick([id]);
      close();
      return;
    }
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const commit = () => {
    if (selected.size === 0) return;
    onPick([...selected]);
    close();
  };
  const create = () => {
    if (!wantsCreate) return;
    onCreate!(query.trim(), createUrlField ? newUrl.trim() || undefined : undefined);
    close();
  };

  return (
    <div className="picker-box" ref={boxRef}>
      <button className={variant ? `picker-trigger ${variant}` : 'picker-trigger'} onClick={() => (open ? close() : setOpen(true))}>
        <span className={value !== undefined ? 'picker-placeholder chosen' : 'picker-placeholder'}>{value ?? placeholder}</span>
        <span className="picker-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="picker-list">
          {/* Search and the Add button are PINNED (the Add button was
              buried at the bottom of the scrolling list, so a multiselect could never be
              committed). Only the options scroll between them. */}
          <input
            className="picker-search"
            autoFocus
            value={query}
            placeholder={onCreate !== undefined ? 'type to filter or create…' : 'type to filter…'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') close();
            }}
          />
          <div className="picker-options">
            {filtered.map((o) => (
              <button
                key={o.id}
                className={selected.has(o.id) ? 'palette-item selected' : 'palette-item'}
                onClick={() => toggle(o.id)}
              >
                <span className="palette-check">{selected.has(o.id) ? '✓' : ''}</span>
                <span style={{ color: ICON_COLOR[o.icon] ?? 'var(--k-source)' }}>
                  <Icon name={o.icon} size={13} />
                </span>{' '}
                {o.label}
              </button>
            ))}
            {wantsCreate && (
              <button className="palette-item create" onClick={create}>
                ＋ create “{query.trim()}”
              </button>
            )}
            {wantsCreate && createUrlField && (
              <input
                className="picker-create-url"
                value={newUrl}
                placeholder="url (optional) — paste to make it a link"
                onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') close();
                }}
              />
            )}
          </div>
          {!single && (
            <div className="picker-footer" ref={footRef}>
              <button className="picker-add-btn" disabled={selected.size === 0} onClick={commit}>
                + Add{selected.size > 0 ? ` ${selected.size}` : ''}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
