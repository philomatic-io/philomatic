/**
 * The GAP STRIPS — the labeled drop places between two
 * sources. Rendered only while a source drag is in flight (edit mode), and COLLAPSED until
 * the drag actually hovers the gap (every gap open at once was too many
 * boxes) — a thin hint line marks the gap; crossing it unfolds the strips: "reads after ↑" /
 * "reads between ↑ ↓" / "reads before ↓", the arrows pointing at the neighbouring rows.
 * Each strip IS its meaning — the drop writes exactly what the label says (drops assert,
 * badges retract). Strips that would write nothing (they name the dragged source, the
 * relation already exists, or it would loop) keep their place but go light and inert.
 */
import { useEffect, useState } from 'react';
import type { DropTarget } from '../../lib/drag';

export interface GapDragCtx {
  /** A source drag is in flight — strips render. */
  active: boolean;
  /** What kind of thing is being dragged — targets accept accordingly: concept
   *  headings/chips take SOURCE drags (anchor it), rows take CONCEPT drags (tag it). */
  dragKind?: 'source' | 'concept';
  start: (id: string, from: 'spine' | 'group') => void;
  /** A concept CHIP picked up off a row — dropping it on another row writes ABOUT. */
  startConcept: (id: string) => void;
  end: () => void;
  drop: (target: DropTarget) => void;
  titleOf: (id: string) => string;
  /** The dragged source's title — the hovered strip PREVIEWS it slotting into place (the browser's translucent drag snapshot hid where the row would land). */
  dragTitle?: string;
  /** Would dropping the in-flight item here write anything? A strip that writes nothing —
   *  it names the dragged source itself, or its relation already exists — stays in the
   *  layout but goes LIGHT and inert. */
  wouldWrite: (target: DropTarget) => boolean;
}

export function GapStrips({ aboveId, belowId, ctx }: { aboveId?: string; belowId?: string; ctx: GapDragCtx }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState<number | undefined>();
  // A drag that ends elsewhere must fold the gap back up.
  useEffect(() => {
    if (!ctx.active) setOpen(false);
  }, [ctx.active]);
  if (!ctx.active) return null;

  const targets: DropTarget[] = [];
  if (aboveId !== undefined) targets.push({ kind: 'gap', aboveId });
  if (aboveId !== undefined && belowId !== undefined) targets.push({ kind: 'gap', aboveId, belowId });
  if (belowId !== undefined) targets.push({ kind: 'gap', belowId });
  // A gap with at least one strip that would WRITE glows brighter — the
  // hint line itself answers "is there a valid move here?" before you commit to the hover.
  const anyLive = targets.some((t) => ctx.wouldWrite(t));

  if (!open) {
    // A gap with NOTHING to say never unfolds (inert boxes filled the
    // screen) — the dim hint stays a hint, and without preventDefault the browser shows
    // no-drop over it.
    return (
      <div
        className={anyLive ? 'gap-hint live' : 'gap-hint'}
        onDragOver={anyLive ? (e) => {
          e.preventDefault();
          setOpen(true);
        } : undefined}
      />
    );
  }

  const strips: { target: DropTarget; label: string; hint: string; cls: string }[] = [];
  if (aboveId !== undefined) {
    strips.push({ target: { kind: 'gap', aboveId }, label: 'reads after ↑', hint: `reads after “${ctx.titleOf(aboveId)}”`, cls: 'after' });
  }
  if (aboveId !== undefined && belowId !== undefined) {
    strips.push({
      target: { kind: 'gap', aboveId, belowId },
      label: 'reads between ↑ ↓',
      hint: `reads after “${ctx.titleOf(aboveId)}” and before “${ctx.titleOf(belowId)}”`,
      cls: 'between',
    });
  }
  if (belowId !== undefined) {
    strips.push({ target: { kind: 'gap', belowId }, label: 'reads before ↓', hint: `reads before “${ctx.titleOf(belowId)}”`, cls: 'before' });
  }
  return (
    <div
      className="gap-strips"
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setOver(undefined);
        }
      }}
    >
      {strips.map((s, i) => {
        // Strips that would write nothing don't render at all — only
        // the sayable options unfold.
        if (!ctx.wouldWrite(s.target)) return null;
        const isOver = over === i;
        return (
          <div
            key={s.cls}
            className={`gap-strip ${s.cls}${isOver ? ' over' : ''}`}
            title={s.hint}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'link';
              setOver(i);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && over === i) setOver(undefined);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(undefined);
              ctx.drop(s.target);
            }}
          >
            {/* The hovered strip PREVIEWS the row slotting in — the dragged title, solid,
                where it would land — instead of a translucent snapshot floating over rows. */}
            {isOver && ctx.dragTitle !== undefined ? (
              <span className="gap-ghost">
                <span className="gap-ghost-title">{ctx.dragTitle}</span>
                <span className="gap-ghost-verb">{s.label}</span>
              </span>
            ) : (
              s.label
            )}
          </div>
        );
      })}
    </div>
  );
}
