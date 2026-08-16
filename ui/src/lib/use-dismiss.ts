/**
 * Dismiss-on-outside-click + Escape for any popover-ish element — the effect five components
 * hand-rolled with small drifts. One
 * hook, uniform behavior: clicking outside `ref` or pressing Escape while `open` calls
 * `close`.
 */
import { useEffect, type RefObject } from 'react';

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    // close/ref are stable enough per open cycle; re-binding on open is the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
