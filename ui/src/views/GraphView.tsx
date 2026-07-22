/**
 * Graph — the hierarchical journey tree (claude.ai/design "Learning Library" Graph view).
 *
 * A deterministic left-to-right layout, not a force simulation: track boxes hang on a left
 * spine (each with a port dot), their ordered sources branch right along rounded-elbow trunks,
 * each source's snippets branch further right, and questions jut to a far-right rail with the
 * relation (raises / answers) written at the stub. Dashed connectors carry track↔track
 * (prerequisite) and question↔question (refines) edges. Sources in no track gather under a
 * "not in a track yet" section. Clicking any node selects it in the shared Detail pane;
 * selection re-inks the touched trunk in accent; active tag/concept filters and the search box
 * dim non-matches.
 *
 * Pure client of the read contract (snapshot + questions + graphView for the typed edges).
 */
import { useEffect, useState } from 'react';
import type { EngineClient } from '../client/transport';
import type { GraphEdge, QuestionView, Snapshot, SnippetView, SourceView, TrackView } from '../client/types';
import { Icon, sourceIcon, type IconName } from '../components/Icon';
import { relationWord } from '../lib/relations';
import { orderedSources } from '../lib/order';
import { SnippetText } from '../lib/snippet-md';
import { conceptTier, isConceptAnchored } from '../lib/topics';
import type { AssembleResult, GraphEnvelope } from '../client/types';

// Geometry (from the design): a fixed-width canvas, vertical flow, rounded elbows.
const R = 8;
const SPINE_X = 110;
const BOX_W = 384;
const BOX_H = 72;
const SRC_TRUNK = 158;
const SRC_CX = 182;
const SNIP_CX = 256;
const Q_CX = 640;
const Q_STUB = 626;
const W = 960;
// Concept tier (concept-anchored tracks): concepts hang under the box, indented by their
// prerequisite depth; sources nest a step further right under their owning concept.
const CPT_TRUNK = 150; // the box→concepts vertical
const CPT_X0 = 176; // depth-0 concept column
const CPT_DEPTH_STEP = 15; // indent per prerequisite level
const CPT_SRC_INDENT = 30; // source column = concept column + this

type PlacedKind = 'sylbox' | 'port' | 'source' | 'snippet' | 'question' | 'section' | 'conceptrow';
interface Placed {
  key: string;
  id: string;
  kind: PlacedKind;
  x: number;
  y: number;
  label: string;
  meta?: string;
  icon?: IconName;
  selected: boolean;
  dimmed: boolean;
  /** conceptrow only: an INCLUDED concept (bolder) vs a family sub-concept. */
  main?: boolean;
  /** source only: the concepts this source is ABOUT, shown as chips (source-anchored tracks). */
  concepts?: string[];
}
interface Seg {
  d: string;
  touched: boolean;
  dash?: string;
}
interface RelLabel {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'end';
}

interface Layout {
  nodes: Placed[];
  segs: Seg[];
  labels: RelLabel[];
  height: number;
}

function buildLayout(
  snapshot: Snapshot,
  questions: QuestionView[],
  graphEdges: GraphEdge[],
  selectedId: string | undefined,
  dim: (id: string) => boolean,
  projection: { asm: AssembleResult; graph: GraphEnvelope } | undefined,
): Layout {
  const nodes: Placed[] = [];
  const segs: Seg[] = [];
  const labels: RelLabel[] = [];
  const qPlaced: Record<string, number> = {};
  let y = 26;

  const isSel = (id: string) => id === selectedId;
  const seg = (d: string, touched: boolean, dash?: string) => segs.push({ d, touched, dash });

  /** Vertical trunk from (x, y0) with horizontal stubs to each row; the last row takes the elbow. */
  const trunk = (x: number, y0: number, rowYs: number[], stubEnd: number, touched: boolean) => {
    if (rowYs.length === 0) return;
    const last = rowYs[rowYs.length - 1]!;
    seg(`M ${x} ${y0} L ${x} ${last - R} Q ${x} ${last} ${x + R} ${last} L ${stubEnd} ${last}`, touched);
    for (const ry of rowYs.slice(0, -1)) seg(`M ${x} ${ry} L ${stubEnd} ${ry}`, touched);
  };

  /** Like trunk, but each row has its OWN stub end — the concept tier, whose rows sit at
   *  different x by prerequisite depth. The vertical drops to the deepest row's y (the elbow). */
  const trunkTo = (x: number, y0: number, rows: { ry: number; stubEnd: number }[], touched: boolean) => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1]!;
    seg(`M ${x} ${y0} L ${x} ${last.ry - R} Q ${x} ${last.ry} ${x + R} ${last.ry} L ${last.stubEnd} ${last.ry}`, touched);
    for (const r of rows.slice(0, -1)) seg(`M ${x} ${r.ry} L ${r.stubEnd} ${r.ry}`, touched);
  };

  /** Questions this anchor raised or answered (provenance direction → relation word). */
  const questionsOf = (anchorId: string): { q: QuestionView; rel: string }[] => {
    const out: { q: QuestionView; rel: string }[] = [];
    for (const q of questions) {
      if (q.raisedBy.some((r) => r.id === anchorId)) out.push({ q, rel: 'raises' });
      else if (q.answeredBy.some((r) => r.id === anchorId)) out.push({ q, rel: 'answers' });
    }
    return out;
  };

  /** Hang any not-yet-placed questions of `anchor` on the right-hand question rail. */
  const placeQuestions = (anchorId: string, anchorX: number, anchorBottomY: number) => {
    const fresh = questionsOf(anchorId).filter(({ q }) => qPlaced[q.id] === undefined);
    if (fresh.length === 0) return;
    const rowYs: number[] = [];
    for (const { q, rel } of fresh) {
      const ry = y + 22;
      // A question title clamps to two lines (~31px); 48px per row keeps them from overlapping.
      y += 48;
      rowYs.push(ry);
      qPlaced[q.id] = ry;
      labels.push({ x: Q_STUB - 6, y: ry - 7, text: rel, anchor: 'end' });
      nodes.push({ key: `q-${q.id}`, id: q.id, kind: 'question', x: Q_CX - 11, y: ry, label: q.text, selected: isSel(q.id), dimmed: dim(q.id) });
    }
    trunk(anchorX, anchorBottomY, rowYs, Q_STUB, isSel(anchorId) || fresh.some(({ q }) => isSel(q.id)));
  };

  /** One source row + its snippet branch + its questions; returns the row's y. `xCol` is the
   *  source column x (default the spine's source column; concept-anchored tracks nest sources
   *  under their concept by passing a larger x). Snippets/questions follow xCol. */
  const sourceRow = (src: SourceView, status: string, xCol: number = SRC_CX, chips?: string[]): number => {
    const snipX = xCol + (SNIP_CX - SRC_CX);
    const hasChips = chips !== undefined && chips.length > 0;
    const ry = y + 22;
    y += 44 + (hasChips ? 18 : 0); // a chip row needs a little more vertical room
    const meta = [src.modality, src.estimatedDurationMins ? `${src.estimatedDurationMins} min` : '', status].filter(Boolean).join(' · ');
    nodes.push({
      key: `s-${src.id}`,
      id: src.id,
      kind: 'source',
      x: xCol - 10,
      y: ry,
      label: src.title,
      meta,
      icon: sourceIcon(src.modality),
      selected: isSel(src.id),
      dimmed: dim(src.id),
      ...(hasChips ? { concepts: chips } : {}),
    });
    const snips: SnippetView[] = snapshot.snippets.filter((sn) => sn.sourceId === src.id);
    const snipYs: number[] = [];
    for (const sn of snips) {
      const sy = y + 18;
      y += 36;
      snipYs.push(sy);
      nodes.push({ key: `n-${sn.id}`, id: sn.id, kind: 'snippet', x: snipX - 5, y: sy, label: `“${sn.text}”`, selected: isSel(sn.id), dimmed: dim(sn.id) });
      placeQuestions(sn.id, snipX, sy + 5);
    }
    if (snipYs.length > 0) trunk(xCol, ry + 10, snipYs, snipX - 7, isSel(src.id) || snips.some((sn) => isSel(sn.id)));
    placeQuestions(src.id, xCol, ry + 10);
    return ry;
  };

  // Tracks on the spine — ordered so a prerequisite track sits above its dependent.
  const sylEdges = graphEdges.filter((e) => snapshot.tracks.some((s) => s.id === e.srcId) && snapshot.tracks.some((s) => s.id === e.dstId));
  const syls: TrackView[] = [...snapshot.tracks].sort((a, b) =>
    sylEdges.some((e) => e.srcId === a.id && e.dstId === b.id) ? -1 : sylEdges.some((e) => e.srcId === b.id && e.dstId === a.id) ? 1 : 0,
  );
  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));
  const ports: Record<string, number> = {};
  // Sources placed under a concept-anchored track's concept tier — they ARE in a track (via
  // their concept ties) even though the track has no member sourceIds, so they must not fall
  // into the "not in a track yet" bucket below.
  const inConceptTrack = new Set<string>();

  for (const syl of syls) {
    const boxTop = y;
    const portY = boxTop + BOX_H / 2;
    ports[syl.id] = portY;
    const order = orderedSources(syl).map((o) => sourceById.get(o.id)).filter((s): s is SourceView => !!s);

    // Concept-anchored track: show its concept family as an indented tier under the box, each
    // source hung at its ANCHOR concept — lib/topics.conceptTier, the same assignment
    // buildTopics rolls up into owner groups, so this view and Journey/Detail always agree
    // (debt fix 2026-07-21: this view briefly had its own "deepest tie" rule; they diverged).
    const tier = isConceptAnchored(syl) && projection ? conceptTier(projection.asm, projection.graph, syl.id, snapshot.sources) : undefined;
    const concepts = tier?.concepts ?? [];
    const conceptMode = concepts.length > 0;

    let meta: string;
    if (conceptMode) {
      const srcByConcept = tier!.sourcesOf;
      const total = [...srcByConcept.values()].reduce((n, xs) => n + xs.length, 0);
      meta = [`${concepts.length} concept${concepts.length === 1 ? '' : 's'} · ${total} source${total === 1 ? '' : 's'}`, syl.goal ?? ''].filter(Boolean).join(' · ');
      nodes.push({ key: `y-${syl.id}`, id: syl.id, kind: 'sylbox', x: SPINE_X, y: boxTop, label: syl.title, meta, icon: 'track', selected: isSel(syl.id), dimmed: dim(syl.id) });
      nodes.push({ key: `p-${syl.id}`, id: syl.id, kind: 'port', x: SPINE_X - 7, y: portY - 7, label: '', selected: isSel(syl.id), dimmed: dim(syl.id) });
      y = boxTop + BOX_H + 24;

      const cptRows: { ry: number; stubEnd: number }[] = [];
      const upNextId = snapshot.sources.find((s) => srcByConcept.size > 0 && !s.consumed && [...srcByConcept.values()].some((xs) => xs.includes(s)))?.id;
      for (const c of concepts) {
        const cx = CPT_X0 + c.level * CPT_DEPTH_STEP;
        const cy = y + 16;
        y += 30;
        nodes.push({ key: `c-${syl.id}-${c.id}`, id: c.id, kind: 'conceptrow', x: cx, y: cy, label: c.name, icon: 'concept', main: c.main, selected: isSel(c.id), dimmed: dim(c.id) });
        cptRows.push({ ry: cy, stubEnd: cx - 12 });
        const cSources = srcByConcept.get(c.id) ?? [];
        for (const s of cSources) inConceptTrack.add(s.id);
        const srcRys = cSources.map((src) => sourceRow(src, src.consumed ? 'consumed' : src.id === upNextId ? 'up next' : src.staged ? 'staged' : '', cx + CPT_SRC_INDENT));
        if (srcRys.length > 0) trunk(cx + 3, cy + 10, srcRys, cx + CPT_SRC_INDENT - 11, isSel(c.id) || cSources.some((s) => isSel(s.id)));
      }
      // Box → concept tier: down from the port, across to the concept trunk, then a stub to each
      // concept (each at its own depth-indented x); the deepest row takes the elbow.
      if (cptRows.length > 0) {
        const yEl = boxTop + BOX_H + 10;
        const last = cptRows[cptRows.length - 1]!;
        const touched = isSel(syl.id) || concepts.some((c) => isSel(c.id));
        seg(
          `M ${SPINE_X} ${portY} L ${SPINE_X} ${yEl - R} Q ${SPINE_X} ${yEl} ${SPINE_X + R} ${yEl} L ${CPT_TRUNK - R} ${yEl} ` +
            `Q ${CPT_TRUNK} ${yEl} ${CPT_TRUNK} ${yEl + R} L ${CPT_TRUNK} ${last.ry - R} Q ${CPT_TRUNK} ${last.ry} ${CPT_TRUNK + R} ${last.ry} L ${last.stubEnd} ${last.ry}`,
          touched,
        );
        for (const r of cptRows.slice(0, -1)) seg(`M ${CPT_TRUNK} ${r.ry} L ${r.stubEnd} ${r.ry}`, touched);
      }
      y += 22;
      continue;
    }

    // Source-anchored track: flat source list under the box (unchanged).
    meta = [`${order.length} ${order.length === 1 ? 'source' : 'sources'}`, syl.goal ?? ''].filter(Boolean).join(' · ');
    nodes.push({ key: `y-${syl.id}`, id: syl.id, kind: 'sylbox', x: SPINE_X, y: boxTop, label: syl.title, meta, icon: 'track', selected: isSel(syl.id), dimmed: dim(syl.id) });
    nodes.push({ key: `p-${syl.id}`, id: syl.id, kind: 'port', x: SPINE_X - 7, y: portY - 7, label: '', selected: isSel(syl.id), dimmed: dim(syl.id) });
    y = boxTop + BOX_H + 24;

    const upNextId = order.find((s) => !s.consumed)?.id;
    const rows = order.map((src) => ({
      id: src.id,
      // Source-anchored tracks have no concept tier, so each source wears its concepts as chips.
      ry: sourceRow(src, src.consumed ? 'consumed' : src.id === upNextId ? 'up next' : src.staged ? 'staged' : '', SRC_CX, src.about),
    }));
    if (rows.length > 0) {
      const yEl = boxTop + BOX_H + 10;
      const lastRy = rows[rows.length - 1]!.ry;
      seg(
        `M ${SPINE_X} ${portY} L ${SPINE_X} ${yEl - R} Q ${SPINE_X} ${yEl} ${SPINE_X + R} ${yEl} L ${SRC_TRUNK - R} ${yEl} ` +
          `Q ${SRC_TRUNK} ${yEl} ${SRC_TRUNK} ${yEl + R} L ${SRC_TRUNK} ${lastRy - R} Q ${SRC_TRUNK} ${lastRy} ${SRC_TRUNK + R} ${lastRy} L ${SRC_CX - 11} ${lastRy}`,
        isSel(syl.id) || isSel(rows[rows.length - 1]!.id),
      );
      for (const r of rows.slice(0, -1)) seg(`M ${SRC_TRUNK} ${r.ry} L ${SRC_CX - 11} ${r.ry}`, isSel(syl.id) || isSel(r.id));
    }
    y += 22;
  }

  // Dashed spine connectors for track↔track edges. Several edge types can link the same
  // pair (e.g. PREREQUISITE_OF_SYL one way, COMPLEMENTS back) — draw ONE connector per pair and
  // stack the labels beside it instead of painting them all at the midpoint.
  const byPair = new Map<string, GraphEdge[]>();
  for (const e of sylEdges) {
    if (ports[e.srcId] === undefined || ports[e.dstId] === undefined) continue;
    const key = [e.srcId, e.dstId].sort().join('|');
    byPair.set(key, [...(byPair.get(key) ?? []), e]);
  }
  for (const pair of byPair.values()) {
    const a = ports[pair[0]!.srcId]!;
    const b = ports[pair[0]!.dstId]!;
    const touched = pair.some((e) => isSel(e.srcId) || isSel(e.dstId));
    seg(`M ${SPINE_X} ${Math.min(a, b) + 7} L ${SPINE_X} ${Math.max(a, b) - 7}`, touched, '5 4');
    const mid = (a + b) / 2 + 3;
    pair.forEach((e, i) => {
      const word = relationWord(e.type, e.tags);
      labels.push({ x: SPINE_X - 10, y: mid + (i - (pair.length - 1) / 2) * 13, text: word, anchor: 'end' });
    });
  }

  // Sources in no track.
  const inSyl = new Set(syls.flatMap((s) => s.sourceIds));
  const loose = snapshot.sources.filter((s) => !inSyl.has(s.id) && !inConceptTrack.has(s.id));
  if (loose.length > 0) {
    nodes.push({ key: 'loose', id: '', kind: 'section', x: SRC_TRUNK, y, label: 'NOT IN A TRACK YET', selected: false, dimmed: false });
    y += 28;
    for (const src of loose) sourceRow(src, src.consumed ? 'consumed' : src.staged ? 'staged' : '');
    y += 10;
  }

  // Dashed rail connectors for question↔question edges (refines, …) — both ends placed.
  for (const e of graphEdges) {
    const a = qPlaced[e.srcId];
    const b = qPlaced[e.dstId];
    if (a === undefined || b === undefined) continue;
    seg(`M ${Q_CX} ${Math.min(a, b) + 11} L ${Q_CX} ${Math.max(a, b) - 11}`, isSel(e.srcId) || isSel(e.dstId), '4 4');
    labels.push({ x: Q_CX + 9, y: (a + b) / 2 + 3, text: relationWord(e.type, e.tags), anchor: 'start' });
  }

  return { nodes, segs, labels, height: y + 40 };
}

export function GraphView({
  snapshot,
  questions,
  projection,
  client,
  selectedTags,
  selectedConcepts,
  query,
  selectedId,
  onSelect,
}: {
  snapshot: Snapshot;
  questions: QuestionView[];
  projection?: { asm: AssembleResult; graph: GraphEnvelope };
  client: EngineClient;
  selectedTags: ReadonlySet<string>;
  selectedConcepts: ReadonlySet<string>;
  query: string;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  useEffect(() => {
    let alive = true;
    client
      .getGraph()
      .then((g) => alive && setGraphEdges(g.edges))
      .catch(() => alive && setGraphEdges([]));
    return () => {
      alive = false;
    };
  }, [client, snapshot]);

  // Dim non-matches under the active filters + search (the design's dim(), over our facets).
  const q = query.trim().toLowerCase();
  const dim = (id: string): boolean => {
    const src = snapshot.sources.find((s) => s.id === id);
    const syl = snapshot.tracks.find((s) => s.id === id);
    const snp = snapshot.snippets.find((s) => s.id === id);
    const qst = questions.find((x) => x.id === id);
    const tags = src?.tags ?? syl?.tags ?? snp?.tags ?? qst?.tags ?? [];
    const label = src?.title ?? syl?.title ?? snp?.text ?? qst?.text ?? '';
    const concepts = src?.about ?? qst?.about ?? [];
    if (selectedTags.size > 0 && !tags.some((t) => selectedTags.has(t))) return true;
    if (selectedConcepts.size > 0 && concepts.length > 0 && !concepts.some((c) => selectedConcepts.has(c))) return true;
    if (q && !label.toLowerCase().includes(q)) return true;
    return false;
  };

  const { nodes, segs, labels, height } = buildLayout(snapshot, questions, graphEdges, selectedId, dim, projection);

  return (
    <div className="pane graph-view">
      <span className="gv-experimental" title="this view is a work in progress">experimental</span>
      <div className="graph-canvas" style={{ width: W, height }}>
        <svg width={W} height={height} className="graph-svg">
          {segs.map((s, i) => (
            <path key={i} d={s.d} fill="none" stroke={s.touched ? 'var(--accent)' : 'var(--line)'} strokeWidth={s.touched ? 1.5 : 1.2} strokeDasharray={s.dash} />
          ))}
          {labels.map((l, i) => (
            <text key={i} x={l.x} y={l.y} fontSize={9.5} fill="var(--faint)" textAnchor={l.anchor}>
              {l.text}
            </text>
          ))}
        </svg>
        {nodes.map((n) => {
          const cls = ['gv', `gv-${n.kind}`, n.selected ? 'sel' : '', n.dimmed ? 'dim' : ''].filter(Boolean).join(' ');
          if (n.kind === 'section') {
            return (
              <div key={n.key} className={cls} style={{ left: n.x, top: n.y }}>
                {n.label}
              </div>
            );
          }
          if (n.kind === 'port') {
            return <button key={n.key} className={cls} style={{ left: n.x, top: n.y }} title={n.label} onClick={() => onSelect(n.id)} />;
          }
          if (n.kind === 'conceptrow') {
            return (
              <button key={n.key} className={`${cls}${n.main ? ' main' : ''}`} style={{ left: n.x, top: n.y }} title={n.label} onClick={() => onSelect(n.id)}>
                <span className="gv-shape" style={{ color: n.selected ? 'var(--accent)' : 'var(--k-concept)' }}>
                  <Icon name="concept" size={n.main ? 15 : 12} />
                </span>
                <span className="gv-title">{n.label}</span>
              </button>
            );
          }
          if (n.kind === 'sylbox') {
            return (
              <button key={n.key} className={cls} style={{ left: n.x, top: n.y, width: BOX_W, height: BOX_H }} title={n.label} onClick={() => onSelect(n.id)}>
                <span className="gv-icon" style={{ color: n.selected ? 'var(--accent)' : 'var(--k-track)' }}>
                  <Icon name="track" size={17} />
                </span>
                <span className="gv-texts">
                  <span className="gv-title">{n.label}</span>
                  {n.meta && <span className="gv-meta">{n.meta}</span>}
                </span>
              </button>
            );
          }
          return (
            <button key={n.key} className={cls} style={{ left: n.x, top: n.y }} title={n.label} onClick={() => onSelect(n.id)}>
              {n.kind === 'source' && (
                <span className="gv-shape">
                  <Icon name={n.icon ?? 'source'} size={11} />
                </span>
              )}
              {n.kind === 'snippet' && <span className="gv-shape" />}
              {n.kind === 'question' && <span className="gv-shape" />}
              <span className="gv-texts">
                {/* Snippets render their markdown/math/images (mini thumbnails) inline; others are plain. */}
                <span className="gv-title">{n.kind === 'snippet' ? <SnippetText text={n.label} inline /> : n.label}</span>
                {n.meta && <span className="gv-meta">{n.meta}</span>}
                {n.concepts && n.concepts.length > 0 && (
                  <span className="gv-chips">
                    {n.concepts.map((c) => (
                      <span key={c} className="gv-chip">
                        ◇ {c}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        <div className="gv-legend">track ▸ sources ▸ snippets · questions jut right · dashed = prerequisite / refines · click any node to inspect</div>
      </div>
    </div>
  );
}
