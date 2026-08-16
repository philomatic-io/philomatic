/**
 * TrackMap — THE prop-driven track map.
 *
 * One component draws "a track's knowledge graph" everywhere it appears outside the workbench
 * proper: the publication page (`/t/`, live and static-export) today, the ask page
 * next. It takes plain payload data — no EngineClient, no fetching, no browser globals at
 * module scope — runs the workbench Map's physics (continuous d3-force, draggable nodes), and
 * draws with the SAME shared rules the workbench Map uses (`lib/map-edges`, `lib/map-groups`,
 * `lib/edge-families`), so the surfaces cannot drift by construction.
 *
 * Extracted verbatim from Publication.tsx's PubMap. The
 * `flaggedIds`/`accentIds` props are additive hooks for the ask page:
 * amber breathing halos on gap concepts, `--ok` green on recommended sources.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { minimalIncludesEdges } from '../lib/map-edges';
import { EdgeMark, HullMark, nodeShape } from './map-marks';
import { declaredGroups, snippetGroups, suppressDeclaredGroupEdges, suppressGroupedSnippetEdges, suppressGroupedTaxonomyEdges, taxonomyGroups, pullGroupMembers } from '../lib/map-groups';
import { declaredRender, renderGroupTags, typeHidden } from '../lib/edge-families';
import { edgeFamily, orderingGravity } from '../lib/edge-families';

/** The structural subset of a publication bundle's payload the map reads — any host that can
 *  project its data into this shape gets the map. Edge tags are CANONICAL objects ({name}). */
export interface TrackMapPayload {
  tracks: readonly { id: string; title: string }[];
  concepts: readonly { id: string; name: string }[];
  sources: readonly { id: string; title: string }[];
  questions: readonly { id: string; text: string }[];
  /** Captured passages — they were absent from the map entirely, so a
   *  source's passages appeared in the tree and in the legend but never on the canvas. */
  snippets?: readonly { id: string; text: string }[];
  edges: readonly { srcId: string; dstId: string; srcType: string; dstType: string; type: string; tags?: readonly unknown[] }[];
}

export function TrackMap({
  payload: p,
  flaggedIds,
  accentIds,
  scopeIds,
}: {
  payload: TrackMapPayload;
  /** Present → draw only these ids: the published page narrows the map to
   *  whatever the reader last clicked in the tree, using the SAME scope rule the workbench map
   *  uses on double-click (lib/map-scope.ts). Absent → the whole track. */
  scopeIds?: ReadonlySet<string>;
  /** Concepts to ring with the amber "needs attention" halo (ask page: #NeedsSources). */
  flaggedIds?: ReadonlySet<string>;
  /** Nodes drawn in the `--ok` accent (ask page: recommended sources). */
  accentIds?: ReadonlySet<string>;
}) {
  interface N extends SimulationNodeDatum { id: string; label: string; kind: 'track' | 'concept' | 'source' | 'question' | 'snippet' }
  const svgRef = useRef<SVGSVGElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Zoom: the viewBox shrinks as zoom grows. 1 = the tighter
  // default fit; buttons step ×1.3 within [0.5, 3.5].
  const [zoom, setZoom] = useState(1);
  // Drag the empty space to pan: the background is a hand, nodes keep
  // their own drag. Offsets shift the viewBox, so panning composes with zoom.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // Fit-to-content: the viewBox is the nodes' own bounding box, padded for
  // the labels that hang under them — so at zoom 1 EVERY entity is on screen whatever shape the
  // layout settles into, instead of a fixed 440×300 window the graph could grow out of. The fit
  // tracks the simulation until the reader takes over (a pan or a node drag), then it freezes:
  // a view that re-fitted under a drag would zoom out as you pulled a node outward.
  const fitRef = useRef({ cx: 0, cy: 0, w: 440, h: 300 });
  const frozen = useRef(false);
  // Fullscreen: the wrapper element goes fullscreen via the
  // native API; state tracks the fullscreenchange event so Esc updates the button too.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = (): void => setFull(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const world = useMemo(() => {
    const inScope = (id: string): boolean => scopeIds === undefined || scopeIds.has(id);
    const nodes: N[] = [
      ...p.tracks.map((t): N => ({ id: t.id, label: t.title, kind: 'track' })),
      ...p.concepts.map((c): N => ({ id: c.id, label: c.name, kind: 'concept' })),
      ...p.sources.map((src): N => ({ id: src.id, label: src.title, kind: 'source' })),
      ...p.questions.map((q): N => ({ id: q.id, label: q.text, kind: 'question' })),
      ...(p.snippets ?? []).map((sn): N => ({ id: sn.id, label: sn.text, kind: 'snippet' })),
    ].filter((n) => inScope(n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // The SAME drawing rules as the workbench Map (lib/map-edges.ts):
    // INCLUDES draws only its minimal non-redundant subset, so a track spokes only to concept
    // HEADS and UNCLASSIFIED sources; everything else hangs off its concept. Payload edges
    // carry canonical tag objects — convert to display labels for the shared rule.
    const drawable = minimalIncludesEdges(
      p.edges
        .filter((e) => inScope(e.srcId) && inScope(e.dstId))
        .map((e) => ({ ...e, tags: (e.tags ?? []).map((t) => `#${(t as { name: string }).name}`) })),
      (id) => byId.get(id)?.kind,
    );
    // Taxonomy renders as GROUPS here exactly as in the workbench Map (lib/map-groups.ts):
    // parent + declared children share a shaded hull; the grouped ties are suppressed as
    // lines. The full drawable set still shapes the layout via groups' cluster pull.
    const groups = taxonomyGroups(drawable, (id) => byId.get(id)?.kind === 'concept');
    // A source and its passages group the same way: SNIPPET_OF ties draw
    // as a shared field in the snippet hue, never as spoke lines.
    const snipGroups = snippetGroups(drawable, (id) => byId.get(id)?.kind);
    // Declared rendering: render:'group' tags hull; render:'hidden' edges leave the
    // drawing (they still shape the layout through the cluster pull).
    const gTags = renderGroupTags();
    const declGroups = declaredGroups(drawable, gTags);
    const drawn = suppressDeclaredGroupEdges(
      suppressGroupedSnippetEdges(suppressGroupedTaxonomyEdges(drawable, groups), snipGroups),
      declGroups,
      gTags,
    ).filter((e) => declaredRender(e.tags) !== 'hidden' && !typeHidden(e.type));
    // Pub-page presentation on top of the shared rule: PRECEDES stays out (the reading order
    // has its own section — it only tangles the map), one line per pair with
    // the most meaningful type winning.
    const RANK: Record<string, number> = { PREREQUISITE_OF: 3, RAISES: 3, ANSWERS: 3, ABOUT: 2, LINK: 1, INCLUDES: 0 };
    const byPair = new Map<string, { source: string; target: string; type: string; tags: readonly string[] }>();
    for (const e of drawn) {
      if (e.type === 'PRECEDES' || !byId.has(e.srcId) || !byId.has(e.dstId) || e.srcId === e.dstId) continue;
      const key = [e.srcId, e.dstId].sort().join('|');
      const cur = byPair.get(key);
      if (!cur || (RANK[e.type] ?? 0) > (RANK[cur.type] ?? 0)) byPair.set(key, { source: e.srcId, target: e.dstId, type: e.type, tags: e.tags ?? [] });
    }
    const links = [...byPair.values()];
    const orderingEdges = drawn.filter((e) => edgeFamily(e.type, e.tags) === 'ordering');
    return { nodes, byId, links, groups, snipGroups, declGroups, orderingEdges };
  }, [p, scopeIds]);

  const simRef = useRef<ReturnType<typeof forceSimulation<N>> | null>(null);
  useEffect(() => {
    const byId = new Map(world.nodes.map((n) => [n.id, n]));
    const clusterForce = (alpha: number): void => {
      pullGroupMembers([...world.groups, ...world.snipGroups, ...world.declGroups], byId, alpha);
    };
    const sim = forceSimulation(world.nodes)
      .force('link', forceLink(world.links.map((l) => ({ ...l }))).id((n) => (n as N).id).distance(72))
      .force('charge', forceManyBody().strength(-170))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(26))
      .force('cluster', clusterForce)
      .force('ordering', orderingGravity(world.nodes, world.orderingEdges))
      .on('tick', () => {
        if (!frozen.current) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const n of world.nodes) {
            if (n.x !== undefined && n.y !== undefined) {
              xs.push(n.x);
              ys.push(n.y);
            }
          }
          if (xs.length > 0) {
            // Labels are centred UNDER their node, so the pad is wide and bottom-heavy.
            const PAD_X = 62;
            const PAD_TOP = 20;
            const PAD_BOTTOM = 32;
            const minX = Math.min(...xs) - PAD_X;
            const maxX = Math.max(...xs) + PAD_X;
            const minY = Math.min(...ys) - PAD_TOP;
            const maxY = Math.max(...ys) + PAD_BOTTOM;
            // Match the ELEMENT's aspect so nothing letterboxes; `.pub-map` sets an explicit
            // height, so measuring it here can't feed back into the viewBox.
            const box = svgRef.current?.getBoundingClientRect();
            const aspect = box !== undefined && box.height > 0 ? box.width / box.height : 440 / 300;
            // A FLOOR on the frame: narrowed to a passage and its
            // source, the bounding box is tiny and fitting it magnified two dots and a label to
            // fill the canvas. Never frame closer than roughly the default window.
            let w = Math.max(maxX - minX, 340);
            let h = Math.max(maxY - minY, 232);
            if (w / h < aspect) w = h * aspect;
            else h = w / aspect;
            fitRef.current = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
          }
        }
        bump();
      });
    simRef.current = sim;
    frozen.current = false; // a different set of nodes is a different picture: frame it afresh
    setPan({ x: 0, y: 0 });
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [world]);

  /** Client coords → the SVG's viewBox space (for drag). */
  const toLocal = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = svgRef.current!;
    const pt = new DOMPoint(e.clientX, e.clientY);
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const local = pt.matrixTransform(m.inverse());
    return { x: local.x, y: local.y };
  };

  const dragStart = (n: N) => (down: React.PointerEvent) => {
    down.preventDefault();
    down.stopPropagation(); // a node drag is not a pan
    frozen.current = true; // the reader is arranging it now — stop re-fitting under them
    (down.target as Element).setPointerCapture(down.pointerId);
    simRef.current?.alphaTarget(0.25).restart();
    const move = (e: PointerEvent): void => {
      const l = toLocal(e);
      n.fx = l.x;
      n.fy = l.y;
    };
    const up = (): void => {
      simRef.current?.alphaTarget(0);
      n.fx = null;
      n.fy = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const vw = fitRef.current.w / zoom;
  const vh = fitRef.current.h / zoom;
  return (
    <div className="pub-map-wrap" ref={wrapRef}>
      <div className="pub-map-zoom">
        <button title="zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.3))}>−</button>
        <button title="zoom in" onClick={() => setZoom((z) => Math.min(3.5, z * 1.3))}>+</button>
        <button
          title={full ? 'exit full screen (Esc)' : 'full screen'}
          onClick={() => {
            if (full) void document.exitFullscreen();
            else void wrapRef.current?.requestFullscreen();
          }}
        >
          {full ? '🗗' : '⛶'}
        </button>
      </div>
      <svg
        ref={svgRef}
        className="pub-map"
        viewBox={`${fitRef.current.cx - vw / 2 + pan.x} ${fitRef.current.cy - vh / 2 + pan.y} ${vw} ${vh}`}
        role="img"
        aria-label="concept and source map of this track — drag a node to move it, drag the background to pan, +/− to zoom"
        style={{ cursor: panFrom.current === null ? 'grab' : 'grabbing', touchAction: 'none' }}
        onPointerDown={(down) => {
          (down.target as Element).setPointerCapture?.(down.pointerId);
          frozen.current = true;
          panFrom.current = { x: down.clientX, y: down.clientY, ox: pan.x, oy: pan.y };
        }}
        onPointerMove={(move) => {
          const from = panFrom.current;
          if (from === null) return;
          const svg = svgRef.current;
          if (svg === null) return;
          // Screen pixels → viewBox units, so a drag tracks the cursor at any zoom.
          const scale = vw / svg.getBoundingClientRect().width;
          setPan({ x: from.ox - (move.clientX - from.x) * scale, y: from.oy - (move.clientY - from.y) * scale });
        }}
        onPointerUp={() => {
          panFrom.current = null;
        }}
        onPointerLeave={() => {
          panFrom.current = null;
        }}
      >
      {world.groups.map((g) => {
        const pts = g.memberIds
          .map((id) => world.byId.get(id))
          .filter((n): n is N => n !== undefined && n.x !== undefined && n.y !== undefined)
          .map((n) => ({ x: n.x!, y: n.y! }));
        if (pts.length === 0) return null;
        return <HullMark key={`hull-${g.parentId}`} pts={pts} pad={26} />;
      })}
      {world.snipGroups.map((g) => {
        const pts = g.memberIds
          .map((id) => world.byId.get(id))
          .filter((n): n is N => n !== undefined && n.x !== undefined && n.y !== undefined)
          .map((n) => ({ x: n.x!, y: n.y! }));
        if (pts.length === 0) return null;
        return <HullMark key={`shull-${g.parentId}`} pts={pts} pad={20} color="var(--k-snippet)" />;
      })}
      {world.declGroups.map((g) => {
        const pts = g.memberIds
          .map((id) => world.byId.get(id))
          .filter((n): n is N => n !== undefined && n.x !== undefined && n.y !== undefined)
          .map((n) => ({ x: n.x!, y: n.y! }));
        if (pts.length === 0) return null;
        return <HullMark key={`dhull-${g.parentId}`} pts={pts} pad={24} />;
      })}
      {world.links.map((l, i) => {
        const na = world.byId.get(l.source)!;
        const nb = world.byId.get(l.target)!;
        const A = { x: na.x ?? 0, y: na.y ?? 0 };
        const B = { x: nb.x ?? 0, y: nb.y ?? 0 };
        // The SAME marks as the workbench Map — literally (components/map-marks.tsx).
        // A declared 'comet' borrows the ordering MARK only — never its gravity.
        const family = declaredRender(l.tags) === 'comet' ? 'ordering' : edgeFamily(l.type, l.tags);
        return <EdgeMark key={i} family={family} A={A} B={B} open={l.type === 'RAISES'} />;
      })}
      {world.nodes.map((n) => {
        const marks = `${flaggedIds?.has(n.id) ? ' flagged' : ''}${accentIds?.has(n.id) ? ' accent' : ''}`;
        return (
        <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`} className="pub-map-g" onPointerDown={dragStart(n)}>
          {flaggedIds?.has(n.id) && <circle r={11} className="pub-map-halo" pointerEvents="none" />}
          {nodeShape(n.kind, 0, 0, n.kind === 'track' ? 9 : n.kind === 'source' ? 7 : n.kind === 'snippet' ? 4 : 5.5, { className: `pub-map-node ${n.kind}${marks}` }, <title>{n.label}</title>)}
          {/* Passages carry no label, as in the workbench map: the text IS the passage, and it
              runs to paragraphs (or an embedded image) — the hover title still tells you. */}
          {n.kind !== 'snippet' && (
            <text y={n.kind === 'track' ? 22 : 18} className="pub-map-label">
              {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
            </text>
          )}
        </g>
        );
      })}
      </svg>
    </div>
  );
}
