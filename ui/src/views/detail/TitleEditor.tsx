import { useAction, useEngine } from '../../engine-context';
import { PencilSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** Inline rename. SOURCES: title is a plain attribute (id derives from the URL; URL-less
 *  sources are the exception — the engine rejects and the reason surfaces as the toast).
 *  TRACKS: the title slugs the id, so the engine renames BY SUPERSESSION — new id minted,
 *  edges carried over, old entity retracted (restorable) — and `onRenamed` re-selects the new
 *  id. Question / snippet / concept names are content-hash identity: still deferred to the
 *  Phase-2 identity work (ROADMAP §1.2). */
export function TitleEditor({
  id,
  title,
  onRenamed,
}: {
  id: string;
  title: string;
  onRenamed?: (newId: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  // Track the entity, but NEVER clobber the input while the user is typing (owner bug
  // 2026-07-22: a refresh/selection churn mid-edit reset the value to the old title, and
  // Enter then silently no-opped as "unchanged").
  useEffect(() => {
    if (!editing) setValue(title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, title]);

  const save = async () => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === title) {
      setValue(title);
      return;
    }
    try {
      const result = await client.update(id, { title: next });
      pushUndo(`rename “${next.slice(0, 30)}”`, () => client.update(result.targetId, { title }));
      await refresh();
      notify('Renamed ✓');
      if (result.targetId !== id) onRenamed?.(result.targetId); // track rename mints a new id
    } catch (e) {
      setValue(title);
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  if (editing) {
    return (
      <input
        className="title-edit"
        autoFocus
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            setValue(title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h2 className="title-row">
      {title}
      <button className="title-pencil" title="rename" onClick={() => setEditing(true)}>
        <PencilSimple size={14} />
      </button>
    </h2>
  );
}
