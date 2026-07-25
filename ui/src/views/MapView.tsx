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
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { EngineClient } from '../client/transport';
import type { GraphEdge, GraphNode, NodeKind } from '../client/types';
import { conceptRanks, type ConceptRank } from '../lib/ranks';
import { relationWord } from '../lib/relations';

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
  field: '#17a67f',
  subfield: '#4fbca6',
  topic: '#8fd0c4',
  plain: 'var(--k-concept)',
};
const RANK_RADIUS: Record<ConceptRank, number> = { field: 15, subfield: 12, topic: 9, plain: 11 };

const W = 900;
const H = 640;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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

function Shape({ n, selected, rank, onDown }: { n: SimNode; selected: boolean; rank?: ConceptRank; onDown: (e: React.PointerEvent) => void }) {
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
  };
  let shape;
  // Shape language (owner consistency ruling, 2026-07-19, matching the Icon set): track =
  // square, concept = diamond, everything else (questions included) = circle.
  if (n.kind === 'track') shape = <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={3} {...common} />;
  else if (n.kind === 'concept') shape = <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} transform={`rotate(45 ${x} ${y})`} {...common} />;
  else shape = <circle cx={x} cy={y} r={r} {...common} />;
  return (
    <g>
      {shape}
      {n.kind !== 'snippet' && (
        <text className={selected ? 'node-label selected' : 'node-label'} x={x} y={y + r + 11} textAnchor="middle">
          {n.label.length > 22 ? `${n.label.slice(0, 22)}…` : n.label}
        </text>
      )}
    </g>
  );
}

type Interaction =
  | { mode: 'none' }
  | { mode: 'node'; id: string; moved: boolean }
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
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | undefined>(undefined);
  const nodesRef = useRef<SimNode[]>([]);
  const interaction = useRef<Interaction>({ mode: 'none' });

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
    if (idFilter !== undefined) {
      // The note-embed scope, expanded the way the Map's filters already think: containment
      // joins the seed (a referenced source's snippets are PART of it; a referenced snippet
      // brings its source), then the seed shows one hop of relations — its questions, its
      // track, the snippets' concept anchors.
      const seed = new Set(idFilter);
      for (const e of full.edges) if (e.type === 'SNIPPET_OF' && seed.has(e.dstId)) seed.add(e.srcId); // children
      for (const e of full.edges) if (e.type === 'SNIPPET_OF' && seed.has(e.srcId)) seed.add(e.dstId); // parents
      const visible = new Set(seed);
      for (const e of full.edges) {
        if (seed.has(e.srcId)) visible.add(e.dstId);
        if (seed.has(e.dstId)) visible.add(e.srcId);
      }
      scoped = {
        nodes: full.nodes.filter((n) => visible.has(n.id)),
        edges: full.edges.filter((e) => visible.has(e.srcId) && visible.has(e.dstId)),
      };
    }
    // The rail's facets apply to the map exactly as to the list (owner report, 2026-07-18):
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
    return subgraph(scoped, selectedTags, selectedConcepts);
  }, [full, idFilter, kind, selectedTags, excludedTags, selectedConcepts]);
  const visKey = useMemo(() => vis.nodes.map((n) => n.id).sort().join('|'), [vis]);
  // Ranks derive from the FULL graph, not the filtered view — hiding a parent must not
  // demote its subfields.
  const ranks = useMemo(() => conceptRanks(full.nodes, full.edges), [full]);

  // (Re)build the live simulation whenever the visible node set changes; carry over positions of
  // nodes that survive so the view doesn't jump, seed newcomers near the centre.
  useEffect(() => {
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const sim: SimNode[] = vis.nodes.map((n) => {
      const p = prev.get(n.id);
      return { ...n, x: p?.x ?? W / 2 + (Math.random() - 0.5) * 120, y: p?.y ?? H / 2 + (Math.random() - 0.5) * 120 };
    });
    nodesRef.current = sim;
    const links: SimLink[] = vis.edges.map((e) => ({ source: e.srcId, target: e.dstId }));
    simRef.current?.stop();
    simRef.current = forceSimulation<SimNode>(sim)
      .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(110).strength(0.35))
      .force('charge', forceManyBody<SimNode>().strength(-560))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide<SimNode>((d) => RADIUS[d.kind] + 20))
      .alpha(0.9)
      .on('tick', tick);
    return () => {
      simRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visKey]);

  // "View in map": pan+zoom so the focused node sits centred. The sim may still be settling when
  // we arrive from another tab, so we re-centre a few times as positions converge.
  useEffect(() => {
    if (!focus) return;
    const K = 1.8;
    let tries = 0;
    const centre = () => {
      const node = nodesRef.current.find((n) => n.id === focus.id);
      if (node && node.x !== undefined && node.y !== undefined) {
        setTransform({ k: K, x: W / 2 - node.x * K, y: H / 2 - node.y * K });
      }
    };
    centre();
    const iv = setInterval(() => {
      centre();
      if (++tries >= 6) clearInterval(iv);
    }, 180);
    return () => clearInterval(iv);
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
    interaction.current = { mode: 'node', id, moved: false };
    const node = nodesRef.current.find((n) => n.id === id);
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
    }
    simRef.current?.alphaTarget(0.3).restart();
  };

  const onBgDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    interaction.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
  };

  const onMove = (e: React.PointerEvent) => {
    const it = interaction.current;
    if (it.mode === 'node') {
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
      const scale = W / svg.getBoundingClientRect().width; // screen px → viewBox units
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
      if (!it.moved) onSelect(it.id); // a click, not a drag → select
    }
    interaction.current = { mode: 'none' };
  };

  const onWheel = (e: React.WheelEvent) => {
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
      return { k, x: W / 2 - ((W / 2 - t.x) / t.k) * k, y: H / 2 - ((H / 2 - t.y) / t.k) * k };
    });

  if (error) return <div className="pane map"><p className="error">{error}</p></div>;

  const nodes = nodesRef.current;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const legend: [NodeKind, string][] = [
    ['track', 'track'],
    ['source', 'source'],
    ['concept', 'concept'],
    ['question', 'question'],
    ['snippet', 'snippet'],
  ];
  const filtered = selectedTags.size > 0 || selectedConcepts.size > 0;

  return (
    <div className="pane map">
      <div className="map-legend">
        {legend.map(([k, label]) => (
          <span key={k}>
            <span className="swatch" style={{ color: KIND_COLOR[k] }}>
              ●
            </span>
            {label}
          </span>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onDragStart={(e) => e.preventDefault()}
        style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {vis.edges.map((e, i) => {
            const a = pos.get(e.srcId);
            const b = pos.get(e.dstId);
            if (!a) return null;
            if (!b) return null;
            const sel = selectedId === e.srcId || selectedId === e.dstId;
            const hot = i === hoveredEdge;
            // Labels used to render for every edge of the selected node → a pile of overlapping
            // text on well-connected nodes. Now a label shows only for the edge under the cursor
            // (the full list of a node's connections lives, uncluttered, in the detail pane).
            return (
              <g key={i} onPointerEnter={() => setHoveredEdge(i)} onPointerLeave={() => setHoveredEdge((h) => (h === i ? undefined : h))}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12} style={{ cursor: 'help' }} />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={hot ? 'var(--accent)' : 'var(--line-strong)'}
                  strokeWidth={sel || hot ? 1.6 : 1}
                  opacity={sel || hot ? 1 : 0.4}
                />
                {hot && (
                  <text className="edge-label" x={((a.x ?? 0) + (b.x ?? 0)) / 2} y={((a.y ?? 0) + (b.y ?? 0)) / 2 - 3} textAnchor="middle">
                    {relationWord(e.type, e.tags)}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => (
            <Shape key={n.id} n={n} selected={n.id === selectedId} rank={ranks.get(n.id)} onDown={onNodeDown(n.id)} />
          ))}
        </g>
      </svg>
      <span className="map-hint">
        {filtered ? 'showing matches + their neighbours · ' : ''}drag a node to move it · scroll to zoom · drag the background to pan
      </span>
      <div className="map-zoom">
        <button onClick={() => zoomBy(0.8)} aria-label="zoom out">
          −
        </button>
        <button onClick={() => setTransform({ x: 0, y: 0, k: 1 })} aria-label="reset view">
          ⊡
        </button>
        <button onClick={() => zoomBy(1.25)} aria-label="zoom in">
          +
        </button>
      </div>
    </div>
  );
}
