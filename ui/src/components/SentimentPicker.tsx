/**
 * The sentiment dropdown (feedback round 3) — a custom menu (native <select> can't render icons)
 * showing each choice as "icon — label", plus a clear option. Closes on outside-click / Escape.
 */
import { useEffect, useRef, useState } from 'react';
import { CaretDown, X } from '@phosphor-icons/react';
import { SENTIMENTS, sentimentOf } from '../lib/sentiment';

export function SentimentPicker({ value, onChange }: { value: string; onChange: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sentimentOf(value);

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

  const pick = (token: string) => {
    onChange(token);
    setOpen(false);
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="dropdown-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {current ? (
          <span className="sentiment-tag">
            <current.Icon size={15} /> {current.label}
          </span>
        ) : (
          <span className="dropdown-placeholder">Set sentiment…</span>
        )}
        <CaretDown size={13} />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {SENTIMENTS.map((s) => (
            <li key={s.token}>
              <button className={s.token === value ? 'dropdown-opt on' : 'dropdown-opt'} role="option" aria-selected={s.token === value} onClick={() => pick(s.token)}>
                <s.Icon size={15} /> <span>{s.label}</span>
              </button>
            </li>
          ))}
          {value && (
            <li>
              <button className="dropdown-opt clear" onClick={() => pick('')}>
                <X size={14} /> <span>clear</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The mutually-exclusive button row (owner request, 2026-07-18) — every sentiment visible
 *  as an icon+word pill; clicking the active one clears. Replaces the dropdown on details. */
export function SentimentSeg({ value, onChange }: { value: string; onChange: (token: string) => void }) {
  return (
    <div className="sent-seg" role="radiogroup">
      {SENTIMENTS.map((s) => (
        <button
          key={s.token}
          className={s.token === value ? 'on' : ''}
          role="radio"
          aria-checked={s.token === value}
          title={s.token === value ? 'click to clear' : s.label}
          onClick={() => onChange(s.token === value ? '' : s.token)}
        >
          <s.Icon size={14} /> {s.label}
        </button>
      ))}
    </div>
  );
}
