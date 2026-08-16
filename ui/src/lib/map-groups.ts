/**
 * Taxonomy-as-GROUPING for the maps: instead of drawing a
 * #TopicOf/#SubfieldOf tie as one more line, the parent concept and everything declared under
 * it render as a SHADED HULL — the group reads at a glance, and the grouped taxonomy edges
 * are suppressed (the hull expresses them). Shared by the workbench Map and the published
 * track's map like every drawing rule (lib/map-edges.ts doctrine); derived from the
 * framework DECLARATIONS via hierarchyLinks, never tag-name literals.
 */
import { hierarchyLinks, isHierarchyTag } from './ranks';
import type { DrawableEdge } from './map-edges';

export interface TaxonomyGroup {
  parentId: string;
  /** The parent plus every concept declared under it — the hull's members. */
  memberIds: string[];
}

/** parent concept → its declared children (#TopicOf and #SubfieldOf alike, both roles). */
export function taxonomyGroups(
  edges: readonly DrawableEdge[],
  isConcept: (id: string) => boolean,
): TaxonomyGroup[] {
  const children = new Map<string, Set<string>>();
  for (const [childId, links] of hierarchyLinks(edges)) {
    if (!isConcept(childId)) continue;
    for (const l of links) {
      if (!isConcept(l.dstId)) continue;
      if (!children.has(l.dstId)) children.set(l.dstId, new Set());
      children.get(l.dstId)!.add(childId);
    }
  }
  return [...children.entries()].map(([parentId, kids]) => ({ parentId, memberIds: [parentId, ...kids] }));
}

/** Drop the taxonomy edges a hull already expresses (child → its grouped parent). Every
 *  other edge — including taxonomy ties whose parent isn't visible as a group — passes. */
export function suppressGroupedTaxonomyEdges<E extends DrawableEdge>(
  edges: readonly E[],
  groups: readonly TaxonomyGroup[],
): E[] {
  const grouped = new Set<string>();
  for (const g of groups) for (const m of g.memberIds) if (m !== g.parentId) grouped.add(`${m}|${g.parentId}`);
  return edges.filter((e) => !((e.tags ?? []).some(isHierarchyTag) && grouped.has(`${e.srcId}|${e.dstId}`)));
}

/**
 * Source-passage containment as the SAME grouping: a snippet is
 * PART of its source — the containment family — so the tie renders as a shared field around
 * the source and its passages (drawn in the snippet hue by the callers), and the grouped
 * SNIPPET_OF spokes disappear as lines, exactly the taxonomy treatment. Shared by both maps
 * per the one-rule doctrine.
 */
export function snippetGroups(
  edges: readonly DrawableEdge[],
  kindOf: (id: string) => string | undefined,
): TaxonomyGroup[] {
  const kids = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== 'SNIPPET_OF') continue;
    if (kindOf(e.srcId) !== 'snippet' || kindOf(e.dstId) !== 'source') continue;
    if (!kids.has(e.dstId)) kids.set(e.dstId, new Set());
    kids.get(e.dstId)!.add(e.srcId);
  }
  return [...kids.entries()].map(([parentId, members]) => ({ parentId, memberIds: [parentId, ...members] }));
}

/** Drop the SNIPPET_OF edges a hull already expresses (snippet → its grouped source); any
 *  other edge — including a SNIPPET_OF whose source isn't visible as a group — passes. */
export function suppressGroupedSnippetEdges<E extends DrawableEdge>(
  edges: readonly E[],
  groups: readonly TaxonomyGroup[],
): E[] {
  const grouped = new Set<string>();
  for (const g of groups) for (const m of g.memberIds) if (m !== g.parentId) grouped.add(`${m}|${g.parentId}`);
  return edges.filter((e) => !(e.type === 'SNIPPET_OF' && grouped.has(`${e.srcId}|${e.dstId}`)));
}

/**
 * DECLARED grouping: any tag declared `render: 'group'` hulls exactly the
 * way the taxonomy does — the DST end is the group head (matching taxonomy's child→parent
 * direction), the src members gather around it, and the grouped ties are suppressed as lines.
 * The tag set is a parameter (built from declarations by the caller), so this stays pure and
 * a user framework's tags group the day they exist.
 */
export function declaredGroups(
  edges: readonly DrawableEdge[],
  groupTags: ReadonlySet<string>,
): TaxonomyGroup[] {
  if (groupTags.size === 0) return [];
  const tagOf = (t: string): string => t.replace(/^#/, '').split(':')[0]!;
  const kids = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!(e.tags ?? []).some((t) => groupTags.has(tagOf(t)))) continue;
    if (!kids.has(e.dstId)) kids.set(e.dstId, new Set());
    kids.get(e.dstId)!.add(e.srcId);
  }
  return [...kids.entries()].map(([parentId, members]) => ({ parentId, memberIds: [parentId, ...members] }));
}

/** Drop the declared-group ties a hull already expresses (src → its grouped dst head). */
export function suppressDeclaredGroupEdges<E extends DrawableEdge>(
  edges: readonly E[],
  groups: readonly TaxonomyGroup[],
  groupTags: ReadonlySet<string>,
): E[] {
  if (groupTags.size === 0) return [...edges];
  const tagOf = (t: string): string => t.replace(/^#/, '').split(':')[0]!;
  const grouped = new Set<string>();
  for (const g of groups) for (const m of g.memberIds) if (m !== g.parentId) grouped.add(`${m}|${g.parentId}`);
  return edges.filter((e) => !((e.tags ?? []).some((t) => groupTags.has(tagOf(t))) && grouped.has(`${e.srcId}|${e.dstId}`)));
}

/**
 * A padded convex hull around member positions — the shaded polygon itself. Each position is
 * inflated into a ring of points at radius `pad`, then Andrew's monotone chain runs over the
 * cloud, so 1- and 2-member groups come out as circles/capsules instead of degenerate lines.
 */
export function paddedHull(
  points: readonly { x: number; y: number }[],
  pad: number,
): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const cloud: { x: number; y: number }[] = [];
  for (const p of points) {
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      cloud.push({ x: p.x + Math.cos(a) * pad, y: p.y + Math.sin(a) * pad });
    }
  }
  cloud.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of cloud) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = cloud.length - 1; i >= 0; i -= 1) {
    const p = cloud[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The hull as a smooth closed SVG path (quadratic midpoint rounding — soft blob, not a
 *  hard-cornered polygon). */
export function hullPath(hull: readonly { x: number; y: number }[]): string {
  if (hull.length === 0) return '';
  if (hull.length < 3) {
    const p = hull[0]!;
    return `M ${p.x} ${p.y}`;
  }
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  let d = '';
  for (let i = 0; i < hull.length; i += 1) {
    const cur = hull[i]!;
    const next = hull[(i + 1) % hull.length]!;
    const m = mid(cur, next);
    d += i === 0 ? `M ${mid(hull[hull.length - 1]!, cur).x} ${mid(hull[hull.length - 1]!, cur).y} ` : '';
    d += `Q ${cur.x} ${cur.y} ${m.x} ${m.y} `;
  }
  return `${d}Z`;
}

/** The simulation force both maps apply: every group member is pulled toward its parent —
 *  the gravity that makes hulls cohere. One body, two simulations. */
export function pullGroupMembers(
  groups: readonly { parentId: string; memberIds: readonly string[] }[],
  byId: ReadonlyMap<string, { x?: number; y?: number; vx?: number; vy?: number }>,
  alpha: number,
  k = 0.12,
): void {
  for (const g of groups) {
    const parent = byId.get(g.parentId);
    if (!parent || parent.x === undefined || parent.y === undefined) continue;
    for (const mid of g.memberIds) {
      if (mid === g.parentId) continue;
      const child = byId.get(mid);
      if (!child || child.x === undefined || child.y === undefined) continue;
      child.vx = (child.vx ?? 0) + (parent.x - child.x) * k * alpha;
      child.vy = (child.vy ?? 0) + (parent.y - child.y) * k * alpha;
    }
  }
}
