/**
 * The publication page (publish plan P5): the PUBLIC face of a published track, served at
 * `/t/<id>` and fed ONLY by `/t/<id>.json` — never `/snapshot` — so the page can't show more
 * than the bundle contains. A clean document layout, not the workbench: header (title, goal,
 * author, license), the reading order (PRECEDES levels computed from the bundle's own edges;
 * co-requisites share a row), each source with its passages and the questions they open.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { GitBranch, GraphIcon } from '@phosphor-icons/react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force';
import { SnippetText } from '../lib/snippet-md';
import { Icon, sourceIcon } from '../components/Icon';
import type { Modality, SourceView } from '../client/types';
import { buildTopicsFromBundle, type TopicGroup } from '../lib/topics';

// The bundle's own shapes (canonical payload subset + manifest) — local on purpose: this page
// is a client of the publication contract, not of the workbench's snapshot types.
interface Tag {
  name: string;
  subtype?: string;
  degree?: number;
}
interface PubEdge {
  srcType: string;
  srcId: string;
  type: string;
  dstType: string;
  dstId: string;
  tags: Tag[];
  trackContextId?: string;
}
interface Bundle {
  pubVersion: number;
  publication: { trackId: string; title: string; author?: string; license: string; publishedAt: number; authorKey?: string };
  payload: {
    tracks: { id: string; title: string; goal?: string; framework?: string; tags: Tag[] }[];
    concepts: { id: string; name: string; description?: string; tags: Tag[] }[];
    sources: {
      id: string;
      title: string;
      author?: string;
      directUrl?: string;
      modality: string;
      estimatedDurationMins?: number;
      tags: Tag[];
    }[];
    snippets: { id: string; sourceId: string; text: string; tags: Tag[] }[];
    questions: { id: string; text: string; tags: Tag[] }[];
    edges: PubEdge[];
  };
}

const tagLabel = (t: Tag): string =>
  `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}${t.degree !== undefined ? `:${t.degree}` : ''}`;

/** Kahn layering over the track's own PRECEDES edges — sources sharing a level read together. */
function levels(memberIds: string[], precedes: { src: string; dst: string }[]): string[][] {
  const members = new Set(memberIds);
  const indeg = new Map(memberIds.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of precedes) {
    if (!members.has(e.src) || !members.has(e.dst)) continue;
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
    out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
  }
  const result: string[][] = [];
  let frontier = memberIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const seen = new Set<string>();
  while (frontier.length > 0) {
    result.push(frontier);
    for (const id of frontier) seen.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dst of out.get(id) ?? []) {
        indeg.set(dst, (indeg.get(dst) ?? 0) - 1);
        if ((indeg.get(dst) ?? 0) === 0 && !seen.has(dst)) next.push(dst);
      }
    }
    frontier = next;
  }
  return result;
}

export function PublicationPage({ trackId, inline }: { trackId?: string; inline?: unknown }) {
  const [bundle, setBundle] = useState<Bundle | undefined>(inline as Bundle | undefined);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (inline !== undefined || trackId === undefined) return; // static export: the bundle came baked in
    fetch(`/t/${encodeURIComponent(trackId)}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Bundle>) : Promise.reject(new Error(r.status === 404 ? 'This track is not published.' : `server error (${r.status})`))))
      .then(setBundle)
      .catch((e: Error) => setError(e.message));
  }, [trackId, inline]);

  const view = useMemo(() => {
    if (!bundle) return undefined;
    const p = bundle.payload;
    const memberSources = new Set(p.sources.map((s) => s.id));
    const readingOrder = levels(
      p.edges
        .filter((e) => e.type === 'INCLUDES' && e.dstType === 'source')
        .map((e) => e.dstId)
        .filter((id) => memberSources.has(id)),
      p.edges.filter((e) => e.type === 'PRECEDES').map((e) => ({ src: e.srcId, dst: e.dstId })),
    );
    const sourceById = new Map(p.sources.map((s) => [s.id, s]));
    const questionById = new Map(p.questions.map((q) => [q.id, q]));
    const snippetsBySource = new Map<string, Bundle['payload']['snippets']>();
    for (const s of p.snippets) snippetsBySource.set(s.sourceId, [...(snippetsBySource.get(s.sourceId) ?? []), s]);
    const questionTies = new Map<string, { word: 'raises' | 'answers'; text: string }[]>();
    for (const e of p.edges) {
      if ((e.type === 'RAISES' || e.type === 'ANSWERS') && e.dstType === 'question') {
        const q = questionById.get(e.dstId);
        if (!q) continue;
        questionTies.set(e.srcId, [
          ...(questionTies.get(e.srcId) ?? []),
          { word: e.type === 'RAISES' ? 'raises' : 'answers', text: q.text },
        ]);
      }
    }
    const conceptName = new Map(p.concepts.map((c) => [c.id, c.name]));
    const conceptsBySource = new Map<string, string[]>();
    for (const e of p.edges) {
      if (e.type === 'ABOUT' && e.dstType === 'concept') {
        const name = conceptName.get(e.dstId);
        if (name !== undefined) conceptsBySource.set(e.srcId, [...(conceptsBySource.get(e.srcId) ?? []), name]);
      }
    }
    // Concept-anchored bundle (concepts-only membership): topics replace the flat reading
    // order. Detected from the bundle's own edges: the track INCLUDES concepts, no sources.
    const trackId2 = p.tracks[0]?.id ?? '';
    const includesSources = p.edges.some((e) => e.type === 'INCLUDES' && e.srcId === trackId2 && e.dstType === 'source');
    const includesConcepts = p.edges.some((e) => e.type === 'INCLUDES' && e.srcId === trackId2 && e.dstType === 'concept');
    let topics: TopicGroup[] = [];
    if (!includesSources && includesConcepts) {
      topics = buildTopicsFromBundle(p);
    }
    return { p, readingOrder, sourceById, snippetsBySource, questionTies, conceptsBySource, topics };
  }, [bundle]);


  if (error !== undefined) {
    return (
      <div className="pub">
        <div className="pub-doc">
          <p className="pub-missing">{error}</p>
        </div>
      </div>
    );
  }
  if (!bundle || !view) {
    return (
      <div className="pub">
        <div className="pub-doc">
          <p className="pub-missing">Loading…</p>
        </div>
      </div>
    );
  }

  const { publication } = bundle;
  const track = view.p.tracks[0];
  const date = new Date(publication.publishedAt).toISOString().slice(0, 10);

  const sourceCard = (id: string) => {
    const src = view.sourceById.get(id);
    if (!src) return null;
    const snippets = view.snippetsBySource.get(id) ?? [];
    return (
      <article key={id} className="pub-source">
        <h3>
          <span className="pub-src-icon"><Icon name={sourceIcon(src.modality as Modality)} size={15} /></span>
          {src.directUrl !== undefined ? (
            <a href={src.directUrl} rel="noreferrer">
              {src.title}
            </a>
          ) : (
            src.title
          )}
        </h3>
        {(src.author !== undefined || src.estimatedDurationMins !== undefined || src.tags.length > 0) && (
          <div className="pub-src-meta">
            {[
              ...(src.author !== undefined ? [src.author] : []),
              ...(src.estimatedDurationMins !== undefined ? [`~${src.estimatedDurationMins} min`] : []),
              ...src.tags.map(tagLabel),
            ].join(' · ')}
          </div>
        )}
        {(view.questionTies.get(id) ?? []).map((tie, j) => (
          <div key={`src-${j}`} className={`pub-tie pub-tie-${tie.word}`}>
            <span className="pub-tie-badge">{tie.word === 'raises' ? '? raises' : '✓ answers'}</span>
            <span>{tie.text}</span>
          </div>
        ))}
        {snippets.map((snip) => (
          <blockquote key={snip.id} className="pub-snippet">
            <div className="md-p"><SnippetText text={snip.text} images="link" /></div>
            {(view.questionTies.get(snip.id) ?? []).map((tie, j) => (
              <div key={j} className={`pub-tie pub-tie-${tie.word}`}>
                <span className="pub-tie-badge">{tie.word === 'raises' ? '? raises' : '✓ answers'}</span>
                <span>{tie.text}</span>
              </div>
            ))}
          </blockquote>
        ))}
        {(view.conceptsBySource.get(id) ?? []).length > 0 && (
          <div className="pub-chips pub-src-concepts foot">
            {view.conceptsBySource.get(id)!.map((n) => (
              <span key={n} className="pub-chip">{n}</span>
            ))}
          </div>
        )}
      </article>
    );
  };
  const conceptAnchored = view.topics.length > 0;

  return (
    <div className="pub">
      <div className="pub-doc">
        <header className="pub-head">
          <div className="pub-kicker">
            <span className="pub-track-badge"><Icon name="track" size={16} /></span>
            A Philomatic learning track
          </div>
          <h1>{publication.title}</h1>
          {track?.goal !== undefined && <p className="pub-goal">{track.goal}</p>}
          <div className="pub-meta">
            {publication.author !== undefined && <span>by {publication.author}</span>}
            <span>published {date}</span>
            <span className="pub-license">{publication.license}</span>
            <span>framework: {track?.framework ?? 'philomatic-core'}</span>
            {publication.authorKey !== undefined && (
              <span className="pub-signed" title={publication.authorKey}>
                ✓ signed · {publication.authorKey.slice(0, 8)}
              </span>
            )}
          </div>
        </header>

        {!conceptAnchored && view.p.concepts.length > 0 && (
          <section>
            <h2>Concepts</h2>
            <div className="pub-chips">
              {view.p.concepts.map((c) => (
                <span key={c.id} className="pub-chip" title={c.description}>
                  {c.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {conceptAnchored ? (
          <section>
            <h2>Topics</h2>
            {view.topics.map((g, i) => (
              <div key={g.conceptId} className="pub-topic">
                <div className="pub-topic-head">
                  <span className="pub-topic-n">{i + 1}</span>
                  <span className="pub-topic-icon"><Icon name="concept" size={16} /></span>
                  <span className="pub-topic-name">{g.conceptName}</span>
                  {g.tags.map((t) => (
                    <span key={t} className="pub-chip">{t}</span>
                  ))}
                </div>
                <div className="pub-level-sources">
                  {g.sources.length === 0 ? (
                    <p className="pub-topic-empty">no sources tied yet</p>
                  ) : (
                    g.sources.map(({ source: src }) => sourceCard(src.id))
                  )}
                </div>
              </div>
            ))}
          </section>
        ) : (
        <section>
          <h2>Reading order</h2>
          {view.readingOrder.map((level, i) => (
            <div key={i} className="pub-level">
              <div className="pub-level-n">{i + 1}</div>
              <div className="pub-level-sources">{level.map(sourceCard)}</div>
            </div>
          ))}
        </section>
        )}

        {view.p.concepts.length + view.p.sources.length >= 2 && (
          <section>
            <h2><GraphIcon size={16} className="pub-h2-icon" /> Map</h2>
            <PubMap p={view.p} />
          </section>
        )}

        <footer className="pub-foot">
          <button
            className="pub-fork"
            title="download this track's bundle — import it into your own Philomatic to make it yours (lineage travels with it)"
            onClick={() => {
              // Serialized from the PAGE'S OWN loaded bundle (not a URL), so forking works
              // identically on server pages, the registry, and the static single-file export.
              // parse→stringify preserves key order, so the payload hash still verifies.
              const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${publication.trackId}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            <GitBranch size={15} /> Fork this track
          </button>
          <span>
            Published with <a href="https://github.com/philomatic-io/philomatic" rel="noreferrer">Philomatic</a> · licensed{' '}
            {publication.license} · fork = download the bundle, then Import it into your own Philomatic
          </span>
        </footer>
      </div>
    </div>
  );
}

/** The track's LIVE map (owner request, 2026-07-18): the workbench Map's physics on the
 *  bundle's own nodes/edges — continuous d3-force simulation, draggable nodes, no server.
 *  Self-contained so it works on the static single-file export too. */
function PubMap({ p }: { p: Bundle['payload'] }) {
  interface N extends SimulationNodeDatum { id: string; label: string; kind: 'track' | 'concept' | 'source' | 'question' }
  const svgRef = useRef<SVGSVGElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Zoom (owner request, 2026-07-18): the viewBox shrinks as zoom grows. 1 = the tighter
  // default fit; buttons step ×1.3 within [0.5, 3.5].
  const [zoom, setZoom] = useState(1);
  // Fullscreen (owner request, 2026-07-18): the wrapper element goes fullscreen via the
  // native API; state tracks the fullscreenchange event so Esc updates the button too.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = (): void => setFull(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const world = useMemo(() => {
    const nodes: N[] = [
      ...p.tracks.map((t): N => ({ id: t.id, label: t.title, kind: 'track' })),
      ...p.concepts.map((c): N => ({ id: c.id, label: c.name, kind: 'concept' })),
      ...p.sources.map((src): N => ({ id: src.id, label: src.title, kind: 'source' })),
      ...p.questions.map((q): N => ({ id: q.id, label: q.text, kind: 'question' })),
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // The reading order has its own section — its PRECEDES chain only tangles the map
    // (owner feedback: too many edges). One line per pair, most meaningful type wins.
    const RANK: Record<string, number> = { PREREQUISITE_OF: 3, RAISES: 3, ANSWERS: 3, ABOUT: 2, LINK: 1, INCLUDES: 0 };
    const byPair = new Map<string, { source: string; target: string; type: string }>();
    for (const e of p.edges) {
      if (e.type === 'PRECEDES' || !byId.has(e.srcId) || !byId.has(e.dstId) || e.srcId === e.dstId) continue;
      const key = [e.srcId, e.dstId].sort().join('|');
      const cur = byPair.get(key);
      if (!cur || (RANK[e.type] ?? 0) > (RANK[cur.type] ?? 0)) byPair.set(key, { source: e.srcId, target: e.dstId, type: e.type });
    }
    const links = [...byPair.values()];
    return { nodes, byId, links };
  }, [p]);

  const simRef = useRef<ReturnType<typeof forceSimulation<N>> | null>(null);
  useEffect(() => {
    const sim = forceSimulation(world.nodes)
      .force('link', forceLink(world.links.map((l) => ({ ...l }))).id((n) => (n as N).id).distance(72))
      .force('charge', forceManyBody().strength(-170))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(26))
      .on('tick', bump);
    simRef.current = sim;
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

  const vw = 440 / zoom;
  const vh = 300 / zoom;
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
      <svg ref={svgRef} className="pub-map" viewBox={`${-vw / 2} ${-vh / 2} ${vw} ${vh}`} role="img" aria-label="concept and source map of this track — drag nodes to explore, +/− to zoom">
      {world.links.map((l, i) => {
        const a = world.byId.get(l.source)!;
        const b = world.byId.get(l.target)!;
        return <line key={i} x1={a.x ?? 0} y1={a.y ?? 0} x2={b.x ?? 0} y2={b.y ?? 0} className={`pub-map-edge ${l.type === 'PREREQUISITE_OF' ? 'prereq' : ''}`} />;
      })}
      {world.nodes.map((n) => (
        <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`} className="pub-map-g" onPointerDown={dragStart(n)}>
          {n.kind === 'track' ? (
            <rect x={-9} y={-9} width={18} height={18} rx={4} className="pub-map-node track">
              <title>{n.label}</title>
            </rect>
          ) : n.kind === 'concept' ? (
            <rect x={-5.5} y={-5.5} width={11} height={11} rx={2} transform="rotate(45)" className="pub-map-node concept">
              <title>{n.label}</title>
            </rect>
          ) : (
            <circle r={n.kind === 'source' ? 7 : 5.5} className={`pub-map-node ${n.kind}`}>
              <title>{n.label}</title>
            </circle>
          )}
          <text y={n.kind === 'track' ? 22 : 18} className="pub-map-label">
            {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
          </text>
        </g>
      ))}
      </svg>
    </div>
  );
}
