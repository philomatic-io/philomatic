/**
 * Map marks (public-polish item 4) — the SVG vocabulary every map draws with,
 * in ONE place. The rule libs (`lib/edge-families`, `lib/map-groups`) decide WHAT to draw;
 * this module owns how each mark LOOKS: the node shape language (track = square, concept =
 * diamond, everything else = circle), the per-family edge marks
 * (ordering tapers, dialogue bows, conflict interrupts, structure stays quiet), the taxonomy
 * hull, and the legend swatches that must match them. MapView (workbench) and TrackMap
 * (publication + ask pages) both render through these — the marks cannot drift.
 *
 * Deliberately NOT shared: node *presentation* (the workbench draws outlined interactive
 * nodes, the compact maps draw solid dots) — that difference is design, so only the shape
 * geometry lives here.
 */
import type { ReactNode, SVGProps } from 'react';
import { bowPath, taperPoints, type EdgeFamily } from '../lib/edge-families';
import { hullPath, paddedHull } from '../lib/map-groups';

export type MarkNodeKind = 'track' | 'concept' | 'source' | 'question' | 'snippet';

/** The shape language: one function mints the element, callers own fill/stroke/handlers. */
export function nodeShape(kind: string, x: number, y: number, r: number, props: SVGProps<SVGRectElement> & SVGProps<SVGCircleElement>, children?: ReactNode) {
  if (kind === 'track') {
    return (
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={3} {...(props as SVGProps<SVGRectElement>)}>
        {children}
      </rect>
    );
  }
  if (kind === 'concept') {
    return (
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} transform={`rotate(45 ${x} ${y})`} {...(props as SVGProps<SVGRectElement>)}>
        {children}
      </rect>
    );
  }
  return (
    <circle cx={x} cy={y} r={r} {...(props as SVGProps<SVGCircleElement>)}>
      {children}
    </circle>
  );
}

/** One mark per edge FAMILY. `hot` (hover) recolors to accent; `selected` raises emphasis —
 *  the compact maps simply never set them. */
export function EdgeMark({
  family,
  A,
  B,
  open = false,
  hot = false,
  selected = false,
}: {
  family: EdgeFamily;
  A: { x: number; y: number };
  B: { x: number; y: number };
  /** dialogue only: an open (unanswered) RAISES — dotted amber; answered = solid green. */
  open?: boolean;
  hot?: boolean;
  selected?: boolean;
}) {
  if (family === 'ordering') {
    return <polygon points={taperPoints(A, B)} fill={hot ? 'var(--accent)' : 'var(--line-strong)'} opacity={selected || hot ? 0.95 : 0.55} />;
  }
  if (family === 'dialogue') {
    return (
      <path
        d={bowPath(A, B)}
        fill="none"
        stroke={hot ? 'var(--accent)' : open ? 'var(--raised)' : 'var(--ok)'}
        strokeWidth={selected || hot ? 1.8 : 1.3}
        strokeDasharray={open ? '0.5 6' : undefined}
        strokeLinecap="round"
        opacity={selected || hot ? 1 : 0.6}
      />
    );
  }
  if (family === 'conflict') {
    return (
      <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={hot ? 'var(--accent)' : 'var(--danger)'} strokeWidth={selected || hot ? 1.8 : 1.3} strokeDasharray="7 5" opacity={selected || hot ? 1 : 0.6} />
    );
  }
  if (family === 'support') {
    // The green counterpart of conflict's red — solid where conflict dashes, bowed where
    // conflict is straight, so the epistemic pair separates on pattern as well as hue.
    return (
      <path
        d={bowPath(A, B)}
        fill="none"
        stroke={hot ? 'var(--accent)' : 'var(--ok)'}
        strokeWidth={selected || hot ? 1.8 : 1.3}
        strokeLinecap="round"
        opacity={selected || hot ? 1 : 0.6}
      />
    );
  }
  const quiet = family === 'anchoring' ? 0.28 : family === 'containment' ? 0.35 : 0.4;
  return (
    <line
      x1={A.x}
      y1={A.y}
      x2={B.x}
      y2={B.y}
      stroke={hot ? 'var(--accent)' : 'var(--line-strong)'}
      strokeWidth={selected || hot ? 1.6 : family === 'anchoring' ? 0.8 : 1}
      opacity={selected || hot ? 1 : quiet}
    />
  );
}

/** The taxonomy hull — parent + declared children share a soft field, UNDER everything. */
export function HullMark({ pts, pad, color = 'var(--rank-field)' }: { pts: { x: number; y: number }[]; pad: number; color?: string }) {
  if (pts.length === 0) return null;
  return <path d={hullPath(paddedHull(pts, pad))} fill={color} fillOpacity={0.08} stroke={color} strokeOpacity={0.3} strokeWidth={1.2} pointerEvents="none" />;
}

export type LegendItem =
  | { swatch: 'node'; kind: MarkNodeKind; color: string; label: string; title?: string; ring?: boolean; dashed?: boolean }
  | { swatch: 'edge'; family: 'ordering' | 'dialogue' | 'conflict'; color: string; label: string; title?: string; open?: boolean };

/** The RELATIONAL half of the legend, worded once: every map that draws
 *  these families explains them identically. The node half varies by surface — the workbench
 *  shows snippets, the public maps don't — so `kindLegend` takes the kinds it draws.
 *
 *  Only ORDERING is spelled out: it is the one mark whose meaning isn't in
 *  its colour. raises/answers/contradicts were dropped — the marks stay, the legend rows go. */
export const RELATION_LEGEND: readonly LegendItem[] = [
  { swatch: 'edge', family: 'ordering', color: 'var(--line-strong)', label: 'before', title: 'prerequisite / reading order — thick end first' },
];

export function kindLegend(kinds: readonly MarkNodeKind[]): LegendItem[] {
  return kinds.map((kind) => ({ swatch: 'node', kind, color: `var(--k-${kind})`, label: kind }));
}

/** The one legend — swatches are drawn BY the mark vocabulary above, so they can't lie. */
export function MapLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="map-legend">
      {items.map((it) => (
        <span key={it.label} title={it.title} style={{ color: it.color }}>
          {it.swatch === 'node' ? (
            <svg className="node-swatch" viewBox="0 0 14 14" aria-hidden="true">
              {it.ring === true
                ? <circle cx={7} cy={7} r={4.5} fill="none" stroke="currentColor" strokeWidth={1.6} />
                : it.dashed === true
                  ? nodeShape(it.kind, 7, 7, it.kind === 'concept' ? 4.2 : 4.8, { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeDasharray: '2.4 1.8' })
                  : nodeShape(it.kind, 7, 7, it.kind === 'concept' ? 4.2 : 4.8, { fill: 'currentColor' })}
            </svg>
          ) : (
            <svg className="edge-swatch" viewBox="0 0 26 10" aria-hidden="true">
              {it.family === 'ordering' && <polygon points="1,1.2 25,4.2 25,5.8 1,8.8" fill="currentColor" opacity="0.75" />}
              {it.family === 'dialogue' && (
                <path d="M 1 8 Q 13 0 25 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={it.open === true ? '0.5 4' : undefined} strokeLinecap="round" />
              )}
              {it.family === 'conflict' && <line x1="1" y1="5" x2="25" y2="5" stroke="currentColor" strokeWidth="1.6" strokeDasharray="5 3.5" />}
            </svg>
          )}
          <span className="legend-word">{it.label}</span>
        </span>
      ))}
    </div>
  );
}
