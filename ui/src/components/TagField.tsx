/**
 * The tag editor, CONTROLLED — chips with a remove ×, plus a "+ tag" input (maintainability
 * phase 3, 2026-07-23).
 *
 * It owns no persistence, which is the point: the detail rail wraps it to write immediately
 * (views/detail/TagEditor), and the create form binds it to local state so a not-yet-existing
 * entity can be tagged before it is saved. One widget, two lifetimes — the create form and the
 * detail literally share the control instead of growing look-alikes that drift apart.
 */
import { useState } from 'react';
import { TagChip } from './TagChip';

/** '#a, b' → ['#a', '#b'] — bare words get the # so tags read consistently. */
export const parseTags = (raw: string): string[] =>
  raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));

export function TagField({
  tags,
  onChange,
  placeholder = '+ tag',
}: {
  tags: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [adding, setAdding] = useState('');
  const commit = () => {
    if (!adding.trim()) return;
    // De-dupe: re-adding an existing tag is a no-op rather than a double chip.
    const next = [...tags, ...parseTags(adding).filter((t) => !tags.includes(t))];
    onChange(next);
    setAdding('');
  };
  return (
    <div className="detail-tags">
      {tags.map((t) => (
        <TagChip key={t} tag={t}>
          <button className="chip-x" aria-label={`remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </TagChip>
      ))}
      <input
        className="chip tag-add"
        style={{ width: 90 }}
        value={adding}
        placeholder={placeholder}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        onBlur={commit}
      />
    </div>
  );
}
