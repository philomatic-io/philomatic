/**
 * A draggable column divider (feedback round 5) — sits between two workbench panes; dragging it
 * horizontally reports the incremental delta so the parent can widen/narrow the neighbouring
 * columns. Pointer-capture based, so the drag survives the cursor leaving the 6px handle.
 */
import { useRef } from 'react';

export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  const last = useRef(0);
  const dragging = useRef(false);

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        dragging.current = true;
        last.current = e.clientX;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const dx = e.clientX - last.current;
        last.current = e.clientX;
        if (dx !== 0) onResize(dx);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      }}
    />
  );
}
