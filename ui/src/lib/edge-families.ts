/**
 * Edge FAMILIES for the maps: the edge vocabulary groups into
 * semantic families, and each family spends ONE perceptual channel — so ten types don't
 * become ten look-alike lines with a legend nobody internalizes.
 *
 *   containment — INCLUDES / SNIPPET_OF / track-nesting  → enclosure + quiet spokes (hulls)
 *   ordering    — PREREQUISITE_OF / PRECEDES             → tapered "comet" (thick at the
 *                 prerequisite, thinning toward the dependent — direction without arrowhead
 *                 confetti) + a weak vertical gravity: learning flows DOWNWARD
 *   anchoring   — ABOUT / CLARIFIES                      → the quietest tether; proximity works
 *   dialogue    — RAISES / ANSWERS                       → CURVED; open = dotted amber,
 *                 answered = solid green (pattern is the discriminator — the amber/green pair
 *                 alone fails the normal-vision ΔE floor)
 *   conflict    — CONTRADICTS / declared polarity:against → dashed, danger-hued, straight
 *   support     — declared polarity:for (#IsEvidenceFor, #Supports) → solid, ok-hued, bowed —
 *                 the green counterpart of conflict's red; the epistemic pair
 *   plain       — generic LINK + framework tags          → one neutral thin style; meaning
 *                 surfaces on hover (deliberately zero visual budget)
 *
 * Hue is reserved for STATE (open/settled/for/against) — node kinds own the identity-hue
 * budget. Families derive from edge types and DECLARED tag fields (`polarity`, `render` —
 * declarations), never tag-name literals (the old `'#Opposes'` literal retired
 * here); shared by both maps per the one-rule doctrine (lib/map-edges.ts).
 */
import type { DrawableEdge } from './map-edges';
import { activeFrameworks, activeViewOverrides, frameworksVersion } from './framework-registry';

export type EdgeFamily = 'containment' | 'ordering' | 'anchoring' | 'dialogue' | 'conflict' | 'support' | 'plain';
export type EdgeRender = 'line' | 'group' | 'comet' | 'hidden';

// Declared per-tag fields, keyed by bare tag name (a display tag '#Supports:a' matches its
// declaration by the name before the subtype). Rebuilt whenever the active framework list
// moves (a personal-framework save), cached against its version otherwise.
let builtFor = 0;
let TAG_POLARITY = new Map<string, 'for' | 'against'>();
let TAG_RENDER = new Map<string, EdgeRender>();
let TYPE_HIDDEN = new Set<string>();
function ensureMaps(): void {
  if (builtFor === frameworksVersion()) return;
  TAG_POLARITY = new Map();
  TAG_RENDER = new Map();
  for (const f of activeFrameworks()) {
    for (const t of f.edgeTags as readonly { name: string; polarity?: 'for' | 'against'; render?: EdgeRender }[]) {
      // FIRST declaration wins: active order is core → mine → enabled
      // built-ins → installed, so a colliding install cannot re-mean an earlier word.
      if (t.polarity !== undefined && !TAG_POLARITY.has(t.name)) TAG_POLARITY.set(t.name, t.polarity);
      if (t.render !== undefined && !TAG_RENDER.has(t.name)) TAG_RENDER.set(t.name, t.render);
    }
  }
  // Local view overrides sit ON TOP of declarations: the reader's re-marks and hides
  // win in THIS library and travel nowhere.
  const view = activeViewOverrides();
  for (const [tag, mark] of Object.entries(view.tags)) TAG_RENDER.set(tag, mark);
  TYPE_HIDDEN = new Set(Object.keys(view.types));
  builtFor = frameworksVersion();
}

/** Is this edge TYPE locally hidden? Types hide but never re-mark. */
export function typeHidden(type: string): boolean {
  ensureMaps();
  return TYPE_HIDDEN.has(type);
}

/** '#Supports:a' → 'Supports' — a display tag's declaration key. */
const bareName = (tag: string): string => tag.replace(/^#/, '').split(':')[0]!;

/** The pure classifier — maps injected, so tests (and future user frameworks) need no bake. */
export function familyOf(
  type: string,
  tags: readonly string[],
  polarity: ReadonlyMap<string, 'for' | 'against'>,
): EdgeFamily {
  const declared = tags.map((t) => polarity.get(bareName(t)));
  if (type === 'CONTRADICTS' || declared.includes('against')) return 'conflict';
  if (declared.includes('for')) return 'support';
  if (type === 'INCLUDES' || type === 'SNIPPET_OF' || type === 'PREREQUISITE_OF_SYL') return 'containment';
  if (type === 'PREREQUISITE_OF' || type === 'PRECEDES') return 'ordering';
  if (type === 'ABOUT' || type === 'CLARIFIES') return 'anchoring';
  if (type === 'RAISES' || type === 'ANSWERS') return 'dialogue';
  return 'plain';
}

export function edgeFamily(type: string, tags?: readonly string[]): EdgeFamily {
  ensureMaps();
  return familyOf(type, tags ?? [], TAG_POLARITY);
}

/** The pure render reader — the FIRST declared render among an edge's tags wins ('hidden'
 *  outranks all: any tag hiding an edge hides it). */
export function renderOf(tags: readonly string[], render: ReadonlyMap<string, EdgeRender>): EdgeRender | undefined {
  const declared = tags.map((t) => render.get(bareName(t))).filter((r): r is EdgeRender => r !== undefined);
  if (declared.includes('hidden')) return 'hidden';
  return declared[0];
}

/** A drawable edge's declared mark, if any tag declares one. */
export function declaredRender(tags?: readonly string[]): EdgeRender | undefined {
  ensureMaps();
  return renderOf(tags ?? [], TAG_RENDER);
}

/** Tag names declared `render: 'group'` — the maps hull these like the taxonomy. */
export function renderGroupTags(): ReadonlySet<string> {
  ensureMaps();
  return new Set([...TAG_RENDER.entries()].filter(([, r]) => r === 'group').map(([n]) => n));
}

interface Pt {
  x: number;
  y: number;
}

/** The ordering family's mark: a tapered polygon, thick at the prerequisite end (a) thinning
 *  toward the dependent (b). Returns SVG polygon `points`. */
export function taperPoints(a: Pt, b: Pt, wA = 4.4, wB = 0.9): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const p = (x: number, y: number): string => `${x},${y}`;
  return [
    p(a.x + nx * wA, a.y + ny * wA),
    p(b.x + nx * wB, b.y + ny * wB),
    p(b.x - nx * wB, b.y - ny * wB),
    p(a.x - nx * wA, a.y - ny * wA),
  ].join(' ');
}

/** The dialogue family's mark: a gently bowed quadratic — curvature is the family's shape
 *  channel (structural families stay straight). */
export function bowPath(a: Pt, b: Pt, bow = 0.16): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return `M ${a.x} ${a.y} Q ${mx - dy * bow} ${my + dx * bow} ${b.x} ${b.y}`;
}

/**
 * The weak vertical bias for ordering: a prerequisite drifts ABOVE what depends on it, so
 * "learning flows downward" becomes literal geography (matching assemble's levels).
 * Deliberately a grain, not a layout — strength stays small and the push is capped. It
 * applies to PREREQUISITE_OF ONLY: PRECEDES chains are whole reading orders (dozens of
 * sources long), and gravity on those stacks a track into a tower (seen in pixels,
 * deliberately) — their tapered marks carry the direction alone.
 */
export function orderingGravity(
  nodes: readonly { id: string; y?: number; vy?: number | null }[],
  edges: readonly DrawableEdge[],
  gap = 50,
  strength = 0.03,
): (alpha: number) => void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pairs = edges
    .filter((e) => e.type === 'PREREQUISITE_OF')
    .map((e) => [e.srcId, e.dstId] as const);
  return (alpha: number): void => {
    for (const [pre, dep] of pairs) {
      const a = byId.get(pre);
      const b = byId.get(dep);
      if (!a || !b || a.y === undefined || b.y === undefined) continue;
      const short = gap - (b.y - a.y);
      if (short <= 0) continue; // already ordered with room to spare
      const push = Math.min(short, 40) * strength * alpha;
      a.vy = (a.vy ?? 0) - push;
      b.vy = (b.vy ?? 0) + push;
    }
  };
}
