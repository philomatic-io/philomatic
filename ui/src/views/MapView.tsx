/**
 * The Map tab (workbench redesign) — the knowledge graph as a LIVE force-directed diagram.
 *
 * Interaction (feedback round 3): the d3-force simulation runs continuously, so spacing is
 * dynamic and the layout breathes; drag a node to reposition it, wheel to zoom around the
 * cursor, drag the background to pan. When a tag/concept filter is active, non-matching nodes
 * DISAPPEAR (not dim) — only the matched nodes and their immediate neighbours remain, and the
 * simulation re-lays-out and re-centres the surviving subgraph.
 *
 * Nodes are shape-coded by kind (□ track, ◇ question, ● snippet, ◆ concept, ○ source);
 * edge types label on the selected node. d3-force is a bundled dependency — pure computation,
 * zero network — so it stays inside the self-contained extension's CSP.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceX,
  forceY,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { EngineClient } from '../client/transport';
import type { GraphEdge, GraphNode, NodeKind } from '../client/types';
import { conceptRanks, type ConceptRank } from '../lib/ranks';
import { minimalIncludesEdges } from '../lib/map-edges';
import { declaredGroups, snippetGroups, suppressDeclaredGroupEdges, suppressGroupedSnippetEdges, suppressGroupedTaxonomyEdges, taxonomyGroups, pullGroupMembers } from '../lib/map-groups';
import { collapseTwins } from '../lib/map-twins';
import { declaredRender, renderGroupTags, typeHidden } from '../lib/edge-families';
import { edgeFamily, orderingGravity } from '../lib/edge-families';
import { EdgeMark, HullMark, MapLegend, kindLegend, nodeShape, RELATION_LEGEND, type LegendItem } from '../components/map-marks';
import { relationWord } from '../lib/relations';
import { scopeOf } from '../lib/map-scope';

interface SimNode extends GraphNode, SimulationNodeDatum {}
type SimLink = SimulationLinkDatum<SimNode>;

const KIND_COLOR: Record<NodeKind, string> = {
  track: 'var(--k-track)',
  concept: 'var(--k-concept)',
  source: 'var(--k-source)',
  snippet: 'var(--k-snippet)',
  question: 'var(--k-question)',
};
const RADIUS: Record<NodeKind, number> = { track: 13, source: 13, concept: 11, question: 11, snippet: 6 };

// Concept ranks (framework-declared hierarchy → derived here): redundant encoding — deeper
// green AND bigger radius the higher the rank — so the taxonomy reads at a glance and survives
// color-vision differences. Plain concepts keep the familiar kind color at the base size.
const RANK_COLOR: Record<ConceptRank, string> = {
  field: 'var(--rank-field)',
  subfield: 'var(--rank-subfield)',
  topic: 'var(--rank-topic)',
  plain: 'var(--k-concept)',
};
const RANK_RADIUS: Record<ConceptRank, number> = { field: 15, subfield: 12, topic: 9, plain: 11 };

// Fallback canvas, used until the pane has been measured. The live viewBox tracks the pane's
// ACTUAL pixel size: a fixed 900×640 viewBox inside a differently-shaped
// pane letterboxes — the drawing shrank to fit the tighter dimension and left ~40% of a tall
// pane as empty bands, so the fit was optimal only inside an imaginary rectangle.
const W = 900;
const H = 640;
/** Containment pull at maximum compactness — see the compactness dial. */
const MAX_PULL = 0.16;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── The words dial (ONE dial does both: words AND spacing) ───────
// How much of a title a label shows is a DIAL, middle = the old fixed truncation (22 chars),
// max = every word of every title. Labels longer than one line WRAP under their node — and the
// SAME dial lengthens the layout's distances (link length, charge, collision radius), so
// fuller labels buy themselves the room they need instead of piling up.
const LABEL_LINE = 24; // chars per wrapped line — one line holds the middle setting exactly

/** Shown-character budget for a label: 8 at min, 22 (the old rule) at middle, ∞ at max. */
function labelLimit(t: number): number {
  return t >= 0.995 ? Infinity : Math.round(8 + 28 * t);
}

/** A label as wrapped lines under its dial setting. At and below the middle the budget fits
 *  one line, so the old single-line look is unchanged; above it, titles stack. */
function labelLines(label: string, t: number, maxLines = Infinity): string[] {
  const limit = labelLimit(t);
  const text = label.length > limit ? `${label.slice(0, limit)}…` : label;
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur !== '' && cur.length + 1 + w.length > LABEL_LINE) {
      lines.push(cur);
      cur = w;
    } else cur = cur === '' ? w : `${cur} ${w}`;
  }
  if (cur !== '') lines.push(cur);
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!}…`];
  return lines;
}

/** Extra collision room the words dial buys: nothing at or below the middle (today's look),
 *  growing toward max so full titles get the space they need. */
function labelPad(t: number): number {
  return t <= 0.5 ? 0 : Math.round((t - 0.5) * 2 * 46);
}

/** The distance side of the SAME dial: middle = 1 (today's distances); brief labels pack a
 *  little tighter, full titles stretch every distance by 1.4×. */
const spreadFactor = (t: number): number => 0.6 + 0.8 * t;

/** The visible subgraph under the active filters: matched nodes ∪ their immediate neighbours.
 *  With no filter, everything is visible. */
function subgraph(
  full: { nodes: GraphNode[]; edges: GraphEdge[] },
  tags: ReadonlySet<string>,
  concepts: ReadonlySet<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (tags.size === 0 && concepts.size === 0) return full;
  const seed = new Set<string>();
  for (const n of full.nodes) {
    const tagHit = tags.size > 0 && n.tags.some((t) => tags.has(t));
    const conceptHit = concepts.size > 0 && n.kind === 'concept' && concepts.has(n.label);
    if (tagHit || conceptHit) seed.add(n.id);
  }
  const visible = new Set(seed);
  for (const e of full.edges) {
    if (seed.has(e.srcId)) visible.add(e.dstId);
    if (seed.has(e.dstId)) visible.add(e.srcId);
  }
  return {
    nodes: full.nodes.filter((n) => visible.has(n.id)),
    edges: full.edges.filter((e) => visible.has(e.srcId) && visible.has(e.dstId)),
  };
}

function Shape({ n, selected, hovered, rank, lines, twinCount, onDown, onDouble, onHover }: { n: SimNode; selected: boolean; hovered: boolean; rank?: ConceptRank; lines: string[]; twinCount?: number; onDown: (e: React.PointerEvent) => void; onDouble: () => void; onHover: (on: boolean) => void }) {
  const color = n.kind === 'concept' && rank !== undefined ? RANK_COLOR[rank] : KIND_COLOR[n.kind];
  const r = n.kind === 'concept' && rank !== undefined ? RANK_RADIUS[rank] : RADIUS[n.kind];
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const common = {
    fill: selected ? color : 'var(--surface)',
    stroke: color,
    strokeWidth: selected ? 2.5 : 1.5,
    style: { cursor: 'grab', filter: selected ? `drop-shadow(0 0 7px ${color})` : 'none' } as const,
    onPointerDown: onDown,
    onDoubleClick: onDouble,
  };
  // Shape language: minted by the shared marks module.
  const shape = nodeShape(n.kind, x, y, r, common);
  return (
    // Hover is per-ENTITY: shape and label together — the full title shows
    // and every connection heats up with its word (the edge loop reads the hovered id).
    <g onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      {shape}
      {twinCount !== undefined && twinCount > 1 && (
        // A collapsed twin group: the count rides the representative; clicking expands.
        <text className="twin-badge" x={x + r + 3} y={y - r - 1}>
          ×{twinCount}
        </text>
      )}
      {lines.length > 0 && (
        // The label is part of the entity: clicking it selects, exactly as
        // clicking the shape does — same pointer gesture, so drag works from the text too.
        <text
          className={`node-label${selected ? ' selected' : ''}${hovered ? ' hover' : ''}`}
          x={x}
          y={y + r + 11}
          textAnchor="middle"
          onPointerDown={onDown}
          onDoubleClick={onDouble}
          style={{ cursor: 'pointer' }}
        >
          {lines.map((ln, i) => (
            <tspan key={i} x={x} dy={i === 0 ? 0 : 12}>
              {ln}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
}

type Interaction =
  | { mode: 'none' }
  | { mode: 'node'; id: string; moved: boolean; startX: number; startY: number }
  | { mode: 'pan'; startX: number; startY: number; origX: number; origY: number };

export function MapView({
  client,
  epoch,
  idFilter,
  kind = 'all',
  selectedTags,
  excludedTags,
  selectedConcepts,
  selectedId,
  focus,
  onSelect,
}: {
  client: EngineClient;
  /** Bumped by App on every refresh — the "refetch your projection" signal. */
  epoch: number;
  /** The note-embed scope (#map=…): these ids, their containment family (a source's snippets),
   *  and one hop of relations — mirroring the tag/concept filters' matched∪neighbours rule. */
  idFilter?: readonly string[];
  /** The rail's kind facet — 'concept' scopes the map to the concept graph, etc. Optional so
   *  the note-embed mode (idFilter) stays unscoped. */
  kind?: NodeKind | 'all';
  selectedTags: ReadonlySet<string>;
  /** The rail's standing exclusions (⊘ tags): hard-hidden — never seeded, never a neighbour. */
  excludedTags?: ReadonlySet<string>;
  selectedConcepts: ReadonlySet<string>;
  selectedId?: string;
  /** A "centre on this node" signal (id + nonce) from "View in map". */
  focus?: { id: string; nonce: number };
  onSelect: (id: string) => void;
}) {
  const [full, setFull] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [error, setError] = useState<string | undefined>();
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hoveredEdge, setHoveredEdge] = useState<number | undefined>();
  // Hovering an ENTITY: its full title shows and every edge touching it
  // heats up, each carrying its relation word — the transient version of the detail pane's
  // Connections list, in place.
  const [hoverId, setHoverId] = useState<string | undefined>();
  // Twin collapse: OFF by default; toggling clears any groups the
  // reader had opened, so the switch always returns to the fully-folded view.
  const [twinsOn, setTwinsOn] = useState(false);
  const [expandedTwins, setExpandedTwins] = useState<ReadonlySet<string>>(new Set());
  // Scope: double-click a node — or arrive from "view in map" — and the
  // canvas narrows to that node and everything under it (lib/map-scope.ts owns what "under"
  // means, so the two entry points cannot diverge).
  const [scopeId, setScopeId] = useState<string | undefined>();
  // Compactness: the containment pull is a DIAL, not a fixed value. 1 is the
  // tight layout that makes a fit-to-content view readable; 0 removes the pull entirely and
  // gives back the sprawling layout the map had before fitting existed. It opens HALFWAY (04) — the extremes are both worth reaching, so neither is the place to start.
  const [compact, setCompact] = useState(0.5);
  // The words dial (ONE dial does both): middle = the default look.
  // It governs how much of every title shows (max = all of it, wrapped) AND scales the
  // layout's distances in step, so growing labels never pile into each other.
  const [labelAmt, setLabelAmt] = useState(0.5);
  // Read inside the sim builder, which is keyed on the visible set — refs keep the dials'
  // current values available there without rebuilding the whole simulation when they move.
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const labelRef = useRef(labelAmt);
  labelRef.current = labelAmt;
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | undefined>(undefined);
  const nodesRef = useRef<SimNode[]>([]);
  const interaction = useRef<Interaction>({ mode: 'none' });
  // Fit-to-content: the layout is centred on the canvas but nothing bounds
  // it, so a big graph settles with nodes and labels off every edge. While the reader hasn't
  // touched the view, the transform tracks the simulation and frames ALL of it; the first pan,
  // zoom, node drag or "view in map" hands control over and the fit stops.
  const autoFit = useRef(true);
  // The pane's measured size in CSS pixels = the viewBox, so one unit is one pixel and nothing
  // letterboxes. A ref mirrors it for the simulation callbacks, which outlive a render.
  const [canvas, setCanvas] = useState({ w: W, h: H });
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r === undefined || r.width < 1 || r.height < 1) return;
      setCanvas((prev) => (Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1 ? prev : { w: r.width, h: r.height }));
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);
  // A resized pane is a new frame to fill: recentre the forces and re-fit into it.
  useEffect(() => {
    const sim = simRef.current;
    if (sim === undefined || sim === null) return;
    (sim.force('center') as ReturnType<typeof forceCenter<SimNode>> | undefined)?.x(canvas.w / 2).y(canvas.h / 2);
    (sim.force('x') as ReturnType<typeof forceX<SimNode>> | undefined)?.x(canvas.w / 2);
    (sim.force('y') as ReturnType<typeof forceY<SimNode>> | undefined)?.y(canvas.h / 2);
    autoFit.current = true;
    sim.alpha(0.35).restart();
  }, [canvas]);

  useEffect(() => {
    let stale = false;
    client
      .getGraph()
      .then((g) => !stale && (setFull({ nodes: g.nodes, edges: g.edges }), setError(undefined)))
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [client, epoch]);

  const vis = useMemo(() => {
    let scoped = full;
    // Scope FIRST: it answers "which graph am I looking at", and the rail's facets then apply
    // within it exactly as they do to the whole library.
    if (scopeId !== undefined && full.nodes.some((n) => n.id === scopeId)) {
      const ids = scopeOf(scopeId, full.edges);
      scoped = {
        nodes: full.nodes.filter((n) => ids.has(n.id)),
        edges: full.edges.filter((e) => ids.has(e.srcId) && ids.has(e.dstId)),
      };
    }
    if (idFilter !== undefined) {
      const base = scoped;
      // The note-embed scope, expanded the way the Map's filters already think: containment
      // joins the seed (a referenced source's snippets are PART of it; a referenced snippet
      // brings its source), then the seed shows one hop of relations — its questions, its
      // track, the snippets' concept anchors.
      const seed = new Set(idFilter);
      for (const e of base.edges) if (e.type === 'SNIPPET_OF' && seed.has(e.dstId)) seed.add(e.srcId); // children
      for (const e of base.edges) if (e.type === 'SNIPPET_OF' && seed.has(e.srcId)) seed.add(e.dstId); // parents
      const visible = new Set(seed);
      for (const e of base.edges) {
        if (seed.has(e.srcId)) visible.add(e.dstId);
        if (seed.has(e.dstId)) visible.add(e.srcId);
      }
      scoped = {
        nodes: base.nodes.filter((n) => visible.has(n.id)),
        edges: base.edges.filter((e) => visible.has(e.srcId) && visible.has(e.dstId)),
      };
    }
    // The rail's facets apply to the map exactly as to the list:
    // excluded tags hard-hide their nodes, and a selected kind scopes to that kind's graph —
    // both BEFORE tag/concept seeding, so hidden nodes can't sneak back in as neighbours.
    const excluded = excludedTags ?? new Set<string>();
    if (excluded.size > 0 || kind !== 'all') {
      const keep = new Set(
        scoped.nodes
          .filter((n) => !n.tags.some((t) => excluded.has(t)) && (kind === 'all' || n.kind === kind))
          .map((n) => n.id),
      );
      scoped = {
        nodes: scoped.nodes.filter((n) => keep.has(n.id)),
        edges: scoped.edges.filter((e) => keep.has(e.srcId) && keep.has(e.dstId)),
      };
    }
    const sub0 = subgraph(scoped, selectedTags, selectedConcepts);
    // Twin collapse first, so every downstream rule (minimal INCLUDES, hulls, families) sees
    // the folded graph — a hull around one counted node instead of a hundred dots.
    const folded = twinsOn ? collapseTwins(sub0.nodes, sub0.edges, expandedTwins) : undefined;
    const sub = folded ?? sub0;
    const twins = folded?.twins ?? new Map<string, string[]>();
    // Drawing rules SHARED with the published track's map (lib/map-edges.ts + map-groups.ts),
    // so the two can't drift again: INCLUDES draws its minimal non-redundant subset, and the
    // taxonomy renders as GROUPS — parent + its #TopicOf/#SubfieldOf children in a shaded
    // hull — with the grouped ties suppressed as lines (the
    // hull expresses them). All edges still feed the sim, so groups stay physically together.
    const kindOf = new Map(sub.nodes.map((n) => [n.id, n.kind]));
    const minimal = minimalIncludesEdges(sub.edges, (id) => kindOf.get(id));
    const groups = taxonomyGroups(minimal, (id) => kindOf.get(id) === 'concept');
    // A source and its passages group the same way: the SNIPPET_OF ties
    // become a shared field in the snippet hue instead of spoke lines.
    const snipGroups = snippetGroups(minimal, (id) => kindOf.get(id));
    // Declared rendering: tags declared render:'group' hull like the taxonomy, and
    // render:'hidden' edges leave the drawing (they still feed the sim, so layout holds).
    const gTags = renderGroupTags();
    const declGroups = declaredGroups(minimal, gTags);
    const edges = suppressDeclaredGroupEdges(
      suppressGroupedSnippetEdges(suppressGroupedTaxonomyEdges(minimal, groups), snipGroups),
      declGroups,
      gTags,
    ).filter((e) => declaredRender(e.tags) !== 'hidden' && !typeHidden(e.type));
    return { nodes: sub.nodes, edges, simEdges: minimal, groups, snipGroups, declGroups, twins };
  }, [full, scopeId, idFilter, kind, selectedTags, excludedTags, selectedConcepts, twinsOn, expandedTwins]);
  const visKey = useMemo(() => vis.nodes.map((n) => n.id).sort().join('|'), [vis]);
  // Ranks derive from the FULL graph, not the filtered view — hiding a parent must not
  // demote its subfields.
  const ranks = useMemo(() => conceptRanks(full.nodes, full.edges), [full]);

  // Moving a dial retunes the live simulation in place and re-frames as it re-settles.
  useEffect(() => {
    const sim = simRef.current;
    if (sim === undefined || sim === null) return;
    (sim.force('x') as ReturnType<typeof forceX<SimNode>> | undefined)?.strength(MAX_PULL * compact);
    (sim.force('y') as ReturnType<typeof forceY<SimNode>> | undefined)?.strength(MAX_PULL * compact);
    const F = spreadFactor(labelAmt);
    (sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined)?.distance(110 * F);
    (sim.force('charge') as ReturnType<typeof forceManyBody<SimNode>> | undefined)?.strength(-560 * F);
    (sim.force('collide') as ReturnType<typeof forceCollide<SimNode>> | undefined)?.radius(
      (d) => RADIUS[(d as SimNode).kind] + 20 * F + labelPad(labelAmt),
    );
    autoFit.current = true;
    sim.alpha(0.55).restart();
  }, [compact, labelAmt]);

  /** Frame every node — and the label under it — inside the canvas. */
  const fitAll = (): void => {
    const ns = nodesRef.current.filter((n) => n.x !== undefined && n.y !== undefined);
    if (ns.length === 0) return;
    // Labels sit under their node and run wider than it; pad generously rather than measure.
    const PAD_X = 78;
    const PAD_TOP = 26;
    const PAD_BOTTOM = 34;
    const minX = Math.min(...ns.map((n) => n.x!)) - PAD_X;
    const maxX = Math.max(...ns.map((n) => n.x!)) + PAD_X;
    const minY = Math.min(...ns.map((n) => n.y!)) - PAD_TOP;
    const maxY = Math.max(...ns.map((n) => n.y!)) + PAD_BOTTOM;
    // Fit into the clear rectangle, not the whole canvas: the legend floats over the top, the
    // compactness dial over the right, the zoom buttons over the bottom. Now that the drawing
    // reaches the pane's edges, ignoring them would park nodes underneath the chrome.
    const { w: cw, h: ch } = canvasRef.current;
    const CHROME = { top: 46, right: 62, bottom: 46, left: 10 };
    const availW = Math.max(cw - CHROME.left - CHROME.right, 40);
    const availH = Math.max(ch - CHROME.top - CHROME.bottom, 40);
    const k = Math.min(availW / Math.max(maxX - minX, 1), availH / Math.max(maxY - minY, 1), 1.6);
    // Centre of the CLEAR area, which is offset from the canvas centre by the uneven chrome.
    const cx = CHROME.left + availW / 2;
    const cy = CHROME.top + availH / 2;
    setTransform({ k, x: cx - ((minX + maxX) / 2) * k, y: cy - ((minY + maxY) / 2) * k });
  };

  // (Re)build the live simulation whenever the visible node set changes; carry over positions of
  // nodes that survive so the view doesn't jump, seed newcomers near the centre.
  useEffect(() => {
    autoFit.current = true; // a different visible set is a different graph: frame it afresh
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const sim: SimNode[] = vis.nodes.map((n) => {
      const p = prev.get(n.id);
      const { w: cw, h: ch } = canvasRef.current;
      return { ...n, x: p?.x ?? cw / 2 + (Math.random() - 0.5) * 120, y: p?.y ?? ch / 2 + (Math.random() - 0.5) * 120 };
    });
    nodesRef.current = sim;
    // The sim binds over ALL structural edges (incl. grouped taxonomy ties) so hull members
    // attract; a gentle cluster force pulls each group's children toward its parent so the
    // shaded hulls come out compact instead of stringy.
    const links: SimLink[] = vis.simEdges.map((e) => ({ source: e.srcId, target: e.dstId }));
    const byId = new Map(sim.map((n) => [n.id, n]));
    const clusterForce = (alpha: number): void => {
      pullGroupMembers([...vis.groups, ...vis.snipGroups, ...vis.declGroups], byId, alpha);
    };
    simRef.current?.stop();
    simRef.current = forceSimulation<SimNode>(sim)
      .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(110 * spreadFactor(labelRef.current)).strength(0.35))
      .force('charge', forceManyBody<SimNode>().strength(-560 * spreadFactor(labelRef.current)))
      .force('center', forceCenter(canvasRef.current.w / 2, canvasRef.current.h / 2))
      // Containment: the library is SEVERAL disconnected components (one
      // per track, plus loose entities), and charge repulsion between components has nothing
      // to push back — they drift apart forever, so a fit-to-content view zoomed out to a dust
      // cloud. A weak pull toward the canvas keeps the whole graph a readable size; it is far
      // softer than the link force, so it doesn't distort structure inside a component.
      .force('x', forceX<SimNode>(canvasRef.current.w / 2).strength(MAX_PULL * compactRef.current))
      .force('y', forceY<SimNode>(canvasRef.current.h / 2).strength(MAX_PULL * compactRef.current))
      .force('collide', forceCollide<SimNode>((d) => RADIUS[d.kind] + 20 * spreadFactor(labelRef.current) + labelPad(labelRef.current)))
      .force('cluster', clusterForce)
      // learning flows downward: prerequisites drift above their dependents (weakly)
      .force('ordering', orderingGravity(sim, vis.simEdges))
      .alpha(0.9)
      .on('tick', () => {
        if (autoFit.current) fitAll();
        tick();
      });
    return () => {
      simRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visKey]);

  // "View in map" SCOPES: arriving from the Library shows that entity and
  // everything under it, not the whole library centred on a dot. The fit then frames it, so
  // the old re-centre-a-few-times dance is gone — scoping restarts the sim, and autoFit
  // follows it to rest.
  useEffect(() => {
    if (!focus) return;
    setScopeId(focus.id);
  }, [focus]);

  /** Pointer → graph-space coordinates, robust to preserveAspectRatio via the screen CTM. */
  const toGraph = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const u = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: (u.x - transform.x) / transform.k, y: (u.y - transform.y) / transform.k };
  };

  const onNodeDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    autoFit.current = false;
    interaction.current = { mode: 'node', id, moved: false, startX: e.clientX, startY: e.clientY };
    const node = nodesRef.current.find((n) => n.id === id);
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
    }
    simRef.current?.alphaTarget(0.3).restart();
  };

  const onBgDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    autoFit.current = false;
    interaction.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
  };

  const onMove = (e: React.PointerEvent) => {
    const it = interaction.current;
    if (it.mode === 'node') {
      // A real hand jitters a pixel or two between press and release — without a threshold
      // EVERY click registered as a drag and selection never fired (
      // "clicking the text does not seem to be selecting"; shapes had the same flaw). The node
      // holds still until the pointer has clearly left the click zone.
      if (!it.moved && Math.hypot(e.clientX - it.startX, e.clientY - it.startY) < 4) return;
      const p = toGraph(e);
      const node = nodesRef.current.find((n) => n.id === it.id);
      if (node) {
        node.fx = p.x;
        node.fy = p.y;
      }
      interaction.current = { ...it, moved: true };
      simRef.current?.alphaTarget(0.3).restart();
    } else if (it.mode === 'pan') {
      const svg = svgRef.current!;
      const scale = canvasRef.current.w / svg.getBoundingClientRect().width; // screen px → viewBox units
      setTransform((t) => ({ ...t, x: it.origX + (e.clientX - it.startX) * scale, y: it.origY + (e.clientY - it.startY) * scale }));
    }
  };

  const onUp = () => {
    const it = interaction.current;
    if (it.mode === 'node') {
      const node = nodesRef.current.find((n) => n.id === it.id);
      if (node) {
        node.fx = null;
        node.fy = null;
      }
      simRef.current?.alphaTarget(0);
      if (!it.moved) {
        // A COLLAPSED twin's click expands its group — selection is what
        // the click means everywhere else, and what it means here once the group is open.
        if (vis.twins.has(it.id)) setExpandedTwins((prev) => new Set(prev).add(it.id));
        else onSelect(it.id);
      }
    }
    interaction.current = { mode: 'none' };
  };

  const onWheel = (e: React.WheelEvent) => {
    autoFit.current = false;
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const u = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    setTransform((t) => {
      const k = clamp(t.k * (e.deltaY < 0 ? 1.12 : 0.89), 0.4, 4);
      return { k, x: u.x - ((u.x - t.x) / t.k) * k, y: u.y - ((u.y - t.y) / t.k) * k };
    });
  };

  const zoomBy = (f: number) =>
    setTransform((t) => {
      const k = clamp(t.k * f, 0.4, 4);
      const { w: cw, h: ch } = canvasRef.current;
      return { k, x: cw / 2 - ((cw / 2 - t.x) / t.k) * k, y: ch / 2 - ((ch / 2 - t.y) / t.k) * k };
    });

  if (error) return <div className="pane map"><p className="error">{error}</p></div>;

  const nodes = nodesRef.current;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const legend: LegendItem[] = [...kindLegend(['track', 'source', 'concept', 'question', 'snippet']), ...RELATION_LEGEND];
  const filtered = selectedTags.size > 0 || selectedConcepts.size > 0;

  return (
    <div className="pane map">
      <MapLegend items={legend} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${canvas.w} ${canvas.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onBgDown}
        onDoubleClick={(e) => {
          if (e.target === svgRef.current) setScopeId(undefined); // empty space = back to all
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onDragStart={(e) => e.preventDefault()}
        style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {/* Taxonomy groups as shaded hulls, UNDER everything: the parent and its declared
              children share a soft field; the suppressed tie lines live in this shape. */}
          {vis.groups.map((g) => {
            const pts = g.memberIds
              .map((id) => nodesRef.current.find((n) => n.id === id))
              .filter((n): n is SimNode => n !== undefined && n.x !== undefined && n.y !== undefined)
              .map((n) => ({ x: n.x!, y: n.y! }));
            if (pts.length === 0) return null;
            return <HullMark key={`hull-${g.parentId}`} pts={pts} pad={30} color={RANK_COLOR[ranks.get(g.parentId) ?? 'plain']} />;
          })}
          {/* A source's passages share its field too — containment, not spokes; the snippet
              hue (yellow) says whose family this is. */}
          {vis.snipGroups.map((g) => {
            const pts = g.memberIds
              .map((id) => nodesRef.current.find((n) => n.id === id))
              .filter((n): n is SimNode => n !== undefined && n.x !== undefined && n.y !== undefined)
              .map((n) => ({ x: n.x!, y: n.y! }));
            if (pts.length === 0) return null;
            return <HullMark key={`shull-${g.parentId}`} pts={pts} pad={24} color="var(--k-snippet)" />;
          })}
          {/* Declared groups: a framework tag marked render:'group' hulls its members. */}
          {vis.declGroups.map((g) => {
            const pts = g.memberIds
              .map((id) => nodesRef.current.find((n) => n.id === id))
              .filter((n): n is SimNode => n !== undefined && n.x !== undefined && n.y !== undefined)
              .map((n) => ({ x: n.x!, y: n.y! }));
            if (pts.length === 0) return null;
            return <HullMark key={`dhull-${g.parentId}`} pts={pts} pad={26} />;
          })}
          {vis.edges.map((e, i) => {
            const a = pos.get(e.srcId);
            const b = pos.get(e.dstId);
            if (!a) return null;
            if (!b) return null;
            const sel = selectedId === e.srcId || selectedId === e.dstId;
            const hot = i === hoveredEdge || (hoverId !== undefined && (e.srcId === hoverId || e.dstId === hoverId));
            const A = { x: a.x ?? 0, y: a.y ?? 0 };
            const B = { x: b.x ?? 0, y: b.y ?? 0 };
            // A declared 'comet' borrows the ordering MARK only — never its gravity.
            const family = declaredRender(e.tags) === 'comet' ? 'ordering' : edgeFamily(e.type, e.tags);
            // One mark per FAMILY (lib/edge-families.ts): ordering tapers, dialogue curves
            // (dotted while open), conflict interrupts, structure stays quiet. Hue carries
            // STATE only; hover carries the exact word, as before.
            const mark = <EdgeMark family={family} A={A} B={B} open={e.type === 'RAISES'} hot={hot} selected={sel} />;
            // Labels used to render for every edge of the selected node → a pile of overlapping
            // text on well-connected nodes. Now a label shows only for the edge under the cursor
            // (the full list of a node's connections lives, uncluttered, in the detail pane).
            return (
              <g key={i} onPointerEnter={() => setHoveredEdge(i)} onPointerLeave={() => setHoveredEdge((h) => (h === i ? undefined : h))}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12} style={{ cursor: 'help' }} />
                {mark}
                {hot && (
                  <text className="edge-label" x={(A.x + B.x) / 2} y={(A.y + B.y) / 2 - 3} textAnchor="middle">
                    {relationWord(e.type, e.tags)}
                  </text>
                )}
              </g>
            );
          })}
          {/* The hovered node renders LAST so its full label sits above its neighbours. */}
          {[...nodes.filter((n) => n.id !== hoverId), ...nodes.filter((n) => n.id === hoverId)].map((n) => (
            <Shape
              key={n.id}
              n={n}
              selected={n.id === selectedId}
              hovered={n.id === hoverId}
              rank={ranks.get(n.id)}
              // Passages stay unlabeled at and below the middle (the text IS the passage); the
              // upper half of the dial brings them in too, capped so a paragraph can't unroll.
              // HOVER shows the full text regardless of the dial (snippets capped at ten lines).
              lines={
                n.id === hoverId
                  ? labelLines(n.label, 1, n.kind === 'snippet' ? 10 : Infinity)
                  : n.kind === 'snippet'
                    ? labelAmt > 0.5
                      ? labelLines(n.label, labelAmt, 5)
                      : []
                    : labelLines(n.label, labelAmt)
              }
              twinCount={vis.twins.get(n.id)?.length}
              onDown={onNodeDown(n.id)}
              onDouble={() => setScopeId(n.id)}
              onHover={(on) => setHoverId((h) => (on ? n.id : h === n.id ? undefined : h))}
            />
          ))}
        </g>
      </svg>
      {scopeId !== undefined && (
        <button className="map-scope-clear" onClick={() => setScopeId(undefined)}>
          show everything
        </button>
      )}
      {/* The dial rail: compactness (top = loose, bottom = tight) beside the words dial
          (top = brief, bottom = full titles — distances stretch with it). */}
      <div className="map-spread">
        {/* Twin collapse: fold nodes with identical inputs AND outputs into
            one counted node — hundreds of interchangeable passages/questions read as a handful.
            Clicking a counted node opens ITS group; the toggle refolds everything. */}
        <button
          className={twinsOn ? 'map-toggle on' : 'map-toggle'}
          onClick={() => {
            setExpandedTwins(new Set());
            setTwinsOn((v) => !v);
          }}
          title="collapse nodes with identical connections into one counted node"
        >
          twins
        </button>
        <div className="map-dial">
          <span>loose</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={compact}
            onChange={(e) => setCompact(Number(e.target.value))}
            aria-label="layout compactness"
            title="how tightly the layout is pulled together"
          />
          <span>tight</span>
        </div>
        <div className="map-dial">
          <span>brief</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={labelAmt}
            onChange={(e) => setLabelAmt(Number(e.target.value))}
            aria-label="label detail"
            title="how much of every title shows — the layout spreads to fit"
          />
          <span>full</span>
        </div>
      </div>
      {/* Only STATE is worth a line here — the drag/scroll instructions are
          gone; the gestures are discoverable and the text was permanent clutter. */}
      {filtered && <span className="map-hint">showing matches + their neighbours</span>}
      <div className="map-zoom">
        <button onClick={() => zoomBy(0.8)} aria-label="zoom out">
          −
        </button>
        <button onClick={() => zoomBy(1.25)} aria-label="zoom in">
          +
        </button>
      </div>
    </div>
  );
}
