/**
 * The grey add-box at the end of an editing column: collapsed to a "+ label" button until
 * clicked, then a small form. Enter submits; the box closes and clears on success.
 */
import { useState } from 'react';

export function AddBox({
  label,
  fields,
  onSubmit,
}: {
  label: string;
  fields: { key: string; placeholder: string; textarea?: boolean }[];
  onSubmit: (values: Record<string, string>) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (fields.every((f) => !(values[f.key] ?? '').trim())) return;
    setBusy(true);
    try {
      await onSubmit(values);
      setValues({});
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <button className="add-box" onClick={() => setOpen(true)}>+ {label}</button>;
  return (
    <div className="add-box open">
      {fields.map((f) =>
        f.textarea ? (
          <textarea key={f.key} value={values[f.key] ?? ''} placeholder={f.placeholder} rows={3} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
        ) : (
          <input
            key={f.key}
            value={values[f.key] ?? ''}
            placeholder={f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        ),
      )}
      <div className="add-actions">
        <button className="action" disabled={busy} onClick={() => void submit()}>Add</button>
        <button className="link" disabled={busy} onClick={() => setOpen(false)}>cancel</button>
      </div>
    </div>
  );
}
