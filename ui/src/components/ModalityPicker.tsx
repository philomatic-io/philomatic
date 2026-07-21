/**
 * The source-type dropdown (owner request, 2026-07-18) — the SentimentPicker pattern applied
 * to modality: a custom menu showing each choice as "icon — label" (native <select> can't
 * render icons). Closes on outside-click / Escape.
 */
import { useEffect, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { Icon, sourceIcon } from './Icon';
import type { Modality } from '../client/types';

const MODALITIES: Modality[] = ['text', 'video', 'audio', 'interactive', 'other'];

export function ModalityPicker({
  value,
  onChange,
  badge = false,
}: {
  value: Modality;
  onChange: (m: Modality) => void;
  /** Render the trigger as the detail-top kind tile (owner request, 2026-07-18): clicking the
   *  source icon IS how you change the type. */
  badge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (m: Modality) => {
    setOpen(false);
    if (m !== value) onChange(m);
  };

  return (
    <div className="dropdown" ref={ref}>
      {badge ? (
        <button
          className="kind-badge kind-badge-btn"
          style={{ color: 'var(--k-source)' }}
          title="change the source type"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Icon name={sourceIcon(value)} size={17} />
        </button>
      ) : (
        <button className="dropdown-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          <span className="modality-tag">
            <Icon name={sourceIcon(value)} size={14} /> {value}
          </span>
          <CaretDown size={13} />
        </button>
      )}
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {MODALITIES.map((m) => (
            <li key={m}>
              <button className={m === value ? 'dropdown-opt on' : 'dropdown-opt'} role="option" aria-selected={m === value} onClick={() => pick(m)}>
                <Icon name={sourceIcon(m)} size={14} /> <span>{m}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
