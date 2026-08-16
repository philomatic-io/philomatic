import { useAction, useEngine } from '../../engine-context';
import { useEditMode } from './shared';
import { PencilSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** Inline rename. SOURCES: title is a plain attribute (id derives from the URL; URL-less
 *  sources are the exception — the engine rejects and the reason surfaces as the toast).
 *  TRACKS (title) and CONCEPTS (name, via `field`): the value slugs the id, so the engine
 *  renames BY SUPERSESSION — new id minted, edges carried over, old entity retracted
 *  (restorable) — and `onRenamed` re-selects the new id. Question / snippet text is still
 *  deferred to the Phase-2 identity work. */
export function TitleEditor({
  id,
  title,
  field = 'title',
  onRenamed,
}: {
  id: string;
  title: string;
  /** The entity field this edits — 'title' for track/source, 'name' for concept. */
  field?: 'title' | 'name';
  onRenamed?: (newId: string) => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  const editMode = useEditMode();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  // Track the entity, but NEVER clobber the input while the user is typing (a refresh/selection churn mid-edit reset the value to the old title, and
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
      const result = await client.update(id, { [field]: next });
      pushUndo(`rename “${next.slice(0, 30)}”`, () => client.update(result.targetId, { [field]: title }));
      await refresh();
      notify('Renamed ✓');
      if (result.targetId !== id) onRenamed?.(result.targetId); // supersession mints a new id
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
      <span
        className={editMode ? 'editable-text' : undefined}
        title={editMode ? 'click to rename' : undefined}
        onClick={() => editMode && setEditing(true)}
      >
        {title}
      </span>
      <button className="title-pencil" title="rename" onClick={() => setEditing(true)}>
        <PencilSimple size={14} />
      </button>
    </h2>
  );
}
