/**
 * The read contract (ROADMAP §2.6; ARCHITECTURE.md §7) — the engine's owned read projections,
 * symmetric to the versioned write contract in `./capture`. Everything here is a PURE function of
 * a canonical payload: no storage, no clock, no I/O. The facade (`./index`) binds these to the
 * store; shells and views consume the results and never compute their own projections.
 *
 * Two projections live here:
 *   - `snapshotViews` — the flat browse views (tracks / sources / snippets) behind `GET /…`
 *     and the static viewer. Versioned via `READ_VERSION` so clients can detect shape changes.
 *   - `assemble` — the learning-path projection (topo-ordered concepts overlaid with the
 *     learner's questions, snippets, recency, and consumption state).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { trackId } from '../schema/ids';
import { topoLevels } from '../graph/assemble';
import { conceptFamily } from '../graph/family';
import { recencyByConcept } from '../graph/recency';
import {
  EVENT_ONLY_VERBS,
  type CanonicalPayload,
  type LearnerEvent,
  type Modality,
  type TypedTag,
} from '../schema/entities';
import { DEFAULT_LEARNER } from './capture';

/** The current read-contract version, carried on every snapshot envelope. */
export const READ_VERSION = 2;

// ── Liveness (DATA_MODEL.md §6) ──────────────────────────────────────────────────────────
// Nothing is ever physically deleted: `remove` appends a RETRACTED event and views fold it
// away. Everything here is the fold — pure over the payload, no store metadata.

/** targetId → its winning RETRACTED event. An entity is retracted iff its most recent
 *  RETRACTED/RESTORED event (by occurredAt; same-ms ties → RESTORED wins) is RETRACTED. */
function retractedIds(p: CanonicalPayload): Map<string, LearnerEvent> {
  const latest = new Map<string, LearnerEvent>();
  for (const ev of p.events) {
    if (!EVENT_ONLY_VERBS.has(ev.verb)) continue;
    const prev = latest.get(ev.targetId);
    if (
      !prev ||
      ev.occurredAt > prev.occurredAt ||
      (ev.occurredAt === prev.occurredAt && ev.verb === 'RESTORED')
    ) {
      latest.set(ev.targetId, ev);
    }
  }
  const retracted = new Map<string, LearnerEvent>();
  for (const [id, ev] of latest) if (ev.verb === 'RETRACTED') retracted.set(id, ev);
  return retracted;
}

/** True iff `id`'s most recent RETRACTED/RESTORED event is RETRACTED — the command layer's
 *  liveness check (idempotent no-ops, revive-on-recapture, minimal-ancestor restore). */
export function isRetracted(p: CanonicalPayload, id: string): boolean {
  return retractedIds(p).has(id);
}

/** Retracted ids plus the ownership cascade: a retracted source hides its snippets (they cannot
 *  float without their source). Single level by construction — only sources own dependents. */
function hiddenIds(p: CanonicalPayload, retracted: ReadonlySet<string>): Set<string> {
  const hidden = new Set(retracted);
  for (const s of p.snippets) if (hidden.has(s.sourceId)) hidden.add(s.id);
  return hidden;
}

/**
 * The live world: the payload minus retracted entities, their ownership-cascade dependents,
 * every edge touching a hidden entity, and the events about them. Retracting a *shared anchor*
 * (a concept) therefore hides only its edges — annotations survive and fall to unanchored/global
 * space in the views (the reference cascade, DATA_MODEL.md §6). `exportAll()` never applies this:
 * the canonical payload is the full value, retractions included.
 */
export function liveView(p: CanonicalPayload): CanonicalPayload {
  const retracted = retractedIds(p);
  if (retracted.size === 0) return p;
  const hidden = hiddenIds(p, new Set(retracted.keys()));
  const live = (id: string): boolean => !hidden.has(id);
  return {
    ...p,
    tracks: p.tracks.filter((s) => live(s.id)),
    concepts: p.concepts.filter((c) => live(c.id)),
    sources: p.sources.filter((s) => live(s.id)),
    snippets: p.snippets.filter((s) => live(s.id)),
    questions: p.questions.filter((q) => live(q.id)),
    edges: p.edges.filter((e) => live(e.srcId) && live(e.dstId)),
    events: p.events.filter((ev) => live(ev.targetId) && !EVENT_ONLY_VERBS.has(ev.verb)),
  };
}

/** A dependent hidden by the ownership cascade (restored together with its owner). */
export interface RemovedDependent {
  kind: 'snippet';
  id: string;
  label: string;
}
export interface RemovedItem {
  kind: 'track' | 'concept' | 'source' | 'snippet' | 'question';
  id: string;
  /** Human handle: title / name / text, per kind. */
  label: string;
  removedAt: number;
  removedBy: string;
  /** Ownership-cascade dependents this retraction hides (not independently retracted). */
  hides: RemovedDependent[];
}

/**
 * The complement of `liveView` — the slim trash bin (DATA_MODEL.md §6): retracted entities with
 * their cascade-hidden dependents, newest first. Read-only; restore is a command-layer verb.
 */
export function removedView(p: CanonicalPayload): RemovedItem[] {
  const retracted = retractedIds(p);
  if (retracted.size === 0) return [];
  const meta = new Map<string, { kind: RemovedItem['kind']; label: string }>();
  for (const s of p.tracks) meta.set(s.id, { kind: 'track', label: s.title });
  for (const c of p.concepts) meta.set(c.id, { kind: 'concept', label: c.name });
  for (const s of p.sources) meta.set(s.id, { kind: 'source', label: s.title });
  for (const s of p.snippets) meta.set(s.id, { kind: 'snippet', label: s.text });
  for (const q of p.questions) meta.set(q.id, { kind: 'question', label: q.text });

  const items: RemovedItem[] = [];
  for (const [id, ev] of retracted) {
    const m = meta.get(id);
    if (!m) continue; // retraction of an id this payload no longer carries — nothing to show
    const hides: RemovedDependent[] =
      m.kind === 'source'
        ? p.snippets
            .filter((s) => s.sourceId === id && !retracted.has(s.id))
            .map((s) => ({ kind: 'snippet', id: s.id, label: s.text }))
        : [];
    items.push({ kind: m.kind, id, label: m.label, removedAt: ev.occurredAt, removedBy: ev.learnerId, hides });
  }
  return items.sort((a, b) => b.removedAt - a.removedAt || a.id.localeCompare(b.id));
}

export interface SourceView {
  id: string;
  title: string;
  modality: Modality;
  url?: string;
  /** The learner's own copy/workspace for this source (`file:///…`, `obsidian://…` — a source
   *  note in the note-taker links back through here). Additive under READ_VERSION 1. */
  personalUrl?: string;
  /** Human tag labels (`#name`, `#name:degree`, `#name:subtype`). */
  tags: string[];
  /** Concept names this source is ABOUT — the concept facet for sources (alpha UI S1).
   *  Renamed from v1's `explains` in the READ_VERSION 2 cleanup (the verb has been ABOUT
   *  since model v2). */
  about: string[];
  /** Author(s), if known — user-typed or adapter-resolved (arXiv, 2026-07-18). Additive. */
  author?: string;
  /** Estimated time-to-consume in minutes, if known (metadata line, workbench redesign). */
  estimatedDurationMins?: number;
  /** The learner has a CONSUMED edge for this source. */
  consumed: boolean;
  /** The learner has a STAGED edge (saved for later). */
  staged: boolean;
  /** Reserved: read-time, view-only enrichment namespaced by adapter (adapters `enrich`). */
  enrichments?: Record<string, unknown>;
}
export interface TrackView {
  id: string;
  title: string;
  goal?: string;
  /** An opted-in framework name (Phase-2 rigidity), if set. */
  framework?: string;
  /** Human tag labels on the track (workbench redesign — the rail's tag facet spans kinds). */
  tags: string[];
  /** Ids of the sources this track INCLUDES (join to `sources` for display). */
  sourceIds: string[];
  /**
   * The member sources layered by in-context PRECEDES edges (topoLevels — the same layering
   * `assemble` uses for its reading order). Sources sharing a level are co-requisites; with no
   * PRECEDES edges in this track's context everything sits in one level and `sourceIds`
   * (INCLUDES order) remains the display order. Additive under READ_VERSION 1.
   */
  sourceLevels: string[][];
  /** The in-context PRECEDES pairs themselves (drag-ordering writes anchor to these). */
  precedes: { srcId: string; dstId: string }[];
  /** The publish stamp (publish plan P2), when the track is published. Additive. */
  published?: { at: number; license: string };
}
export interface SnippetView {
  id: string;
  text: string;
  sourceId: string;
  source: string;
  note?: string;
  sentiment?: string;
  clarifies: string[];
  contradicts: string[];
  /** Human tag labels on the snippet itself. */
  tags: string[];
  /** The questions this snippet RAISES, with the learner/corpus overlay — expandable in the
   *  card footer (alpha UI S3). Additive (non-breaking; READ_VERSION unchanged). */
  raises: AssembledQuestion[];
}
export interface Snapshot {
  version: typeof READ_VERSION;
  tracks: TrackView[];
  sources: SourceView[];
  snippets: SnippetView[];
}

/** Render a canonical tag back to its sugar string (inverse of `lexTag`), for display. */
const tagLabel = (t: TypedTag): string =>
  `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}${t.degree !== undefined ? `:${t.degree}` : ''}`;

/**
 * The flat read views — tracks with their member sources, sources (with tags), and snippets
 * joined to their source title, concept anchors, and the learner's note/sentiment.
 * Live-filtered: retracted entities (and their cascade) never appear (DATA_MODEL.md §6).
 *
 * `learnerId` scopes the behavioral overlay (annotations, asked/answered, consumed/staged) to
 * one learner — the multi-tenant read seam (self-serve plan T4). Omitted, the overlay folds
 * ALL learners together: the degenerate single-tenant view every pre-T4 caller gets.
 */
export function snapshotViews(raw: CanonicalPayload, learnerId?: string): Snapshot {
  const p = liveView(raw);
  const mine = (e: { srcId: string }): boolean => learnerId === undefined || e.srcId === learnerId;
  const titleById = new Map(p.sources.map((s) => [s.id, s.title]));
  const conceptName = new Map(p.concepts.map((c) => [c.id, c.name]));
  const annotation = new Map<string, { note?: string; sentiment?: string }>();
  for (const e of p.edges) {
    if (e.type === 'ANNOTATES' && mine(e)) annotation.set(e.dstId, (e.metadata ?? {}) as { note?: string; sentiment?: string });
  }
  const anchors = (snpId: string, type: 'CLARIFIES' | 'CONTRADICTS'): string[] =>
    p.edges.filter((e) => e.type === type && e.srcId === snpId).map((e) => conceptName.get(e.dstId) ?? e.dstId);

  // The question overlay for `raises` (S3); `gap` = nothing in the corpus ANSWERS it (corpus
  // fact — never learner-scoped, unlike asked/answered).
  const questionText = new Map(p.questions.map((q) => [q.id, q.text]));
  const askedQ = new Set(p.edges.filter((e) => e.type === 'ASKS' && mine(e)).map((e) => e.dstId));
  const answeredQ = new Set(p.edges.filter((e) => e.type === 'ANSWERED' && mine(e)).map((e) => e.dstId));
  const answersQ = new Set(p.edges.filter((e) => e.type === 'ANSWERS').map((e) => e.dstId));
  const raisesOf = (snpId: string): AssembledQuestion[] =>
    p.edges
      .filter((e) => e.type === 'RAISES' && e.srcId === snpId)
      .map((e) => ({
        id: e.dstId,
        text: questionText.get(e.dstId) ?? e.dstId,
        asked: askedQ.has(e.dstId),
        answered: answeredQ.has(e.dstId),
        gap: !answersQ.has(e.dstId),
      }))
      .sort((a, b) => a.text.localeCompare(b.text));

  // Concept names a source is ABOUT (S1's concept facet for sources; v2 — however tagged:
  // #Explains/#Demonstrates/#Exercises all file it under the concept).
  const explainsOf = (srcId: string): string[] =>
    p.edges
      .filter((e) => e.type === 'ABOUT' && e.srcType === 'source' && e.srcId === srcId)
      .map((e) => conceptName.get(e.dstId) ?? e.dstId)
      .sort((a, b) => a.localeCompare(b));

  // Consumption state for the source metadata line (workbench redesign) — scoped with the
  // annotation/question overlays above.
  const consumedSrc = new Set(p.edges.filter((e) => e.type === 'CONSUMED' && mine(e)).map((e) => e.dstId));
  const stagedSrc = new Set(p.edges.filter((e) => e.type === 'STAGED' && mine(e)).map((e) => e.dstId));

  // track id -> the source ids it INCLUDES (source members only; concept members are elsewhere).
  const membersByTrack = new Map<string, string[]>();
  for (const e of p.edges) {
    if (e.type === 'INCLUDES' && e.srcType === 'track' && e.dstType === 'source' && titleById.has(e.dstId)) {
      const list = membersByTrack.get(e.srcId) ?? [];
      if (!list.includes(e.dstId)) list.push(e.dstId);
      membersByTrack.set(e.srcId, list);
    }
  }

  const tracks: TrackView[] = p.tracks.map((sy) => {
    const memberIds = membersByTrack.get(sy.id) ?? [];
    // Layer the members by this track's own PRECEDES edges (edges scoped to other contexts,
    // or touching non-members, are ignored by topoLevels).
    const ctxPrecedes = p.edges
      .filter((e) => e.type === 'PRECEDES' && e.trackContextId === sy.id)
      .map((e) => ({ src: e.srcId, dst: e.dstId }));
    return {
      id: sy.id,
      title: sy.title,
      ...(sy.goal !== undefined ? { goal: sy.goal } : {}),
      ...(sy.framework !== undefined ? { framework: sy.framework } : {}),
      tags: sy.tags.map(tagLabel),
      sourceIds: memberIds,
      sourceLevels: topoLevels(memberIds, ctxPrecedes),
      precedes: ctxPrecedes.map((e) => ({ srcId: e.src, dstId: e.dst })),
      ...(sy.published ? { published: sy.published } : {}),
    };
  });
  const sources: SourceView[] = p.sources.map((s) => ({
    id: s.id,
    title: s.title,
    modality: s.modality,
    ...(s.directUrl ? { url: s.directUrl } : {}),
    ...(s.personalUrl ? { personalUrl: s.personalUrl } : {}),
    tags: s.tags.map(tagLabel),
    about: explainsOf(s.id),
    ...(s.author !== undefined ? { author: s.author } : {}),
    ...(s.estimatedDurationMins !== undefined ? { estimatedDurationMins: s.estimatedDurationMins } : {}),
    consumed: consumedSrc.has(s.id),
    staged: stagedSrc.has(s.id),
  }));
  const snippets: SnippetView[] = p.snippets.map((s) => {
    const ann = annotation.get(s.id) ?? {};
    return {
      id: s.id,
      text: s.text,
      sourceId: s.sourceId,
      source: titleById.get(s.sourceId) ?? s.sourceId,
      ...(ann.note !== undefined ? { note: ann.note } : {}),
      ...(ann.sentiment !== undefined ? { sentiment: ann.sentiment } : {}),
      clarifies: anchors(s.id, 'CLARIFIES'),
      contradicts: anchors(s.id, 'CONTRADICTS'),
      tags: s.tags.map(tagLabel),
      raises: raisesOf(s.id),
    };
  });
  return { version: READ_VERSION, tracks, sources, snippets };
}

// ── Timeline + question provenance (alpha feedback round 1) ────────────────────────────────
// Additive projections under READ_VERSION 1, same discipline as the M1 additions: deliberate,
// versioned view-model changes with tests — not presentation work.

export interface TimelineEntry {
  /** Event time (epoch-ms) — the log's stored time, displayed as-is (no decay semantics). */
  at: number;
  verb: LearnerEvent['verb'];
  targetKind: LearnerEvent['targetType'];
  targetId: string;
  /** Human handle of the target: title / name / text, joined here so clients never derive it. */
  label: string;
}

/**
 * The learner's engagement feed, newest first — every logged event with its target labeled.
 * Includes RETRACTED/RESTORED entries (they are things that happened); events whose target is
 * currently hidden are folded away like everything else, EXCEPT the retraction entry itself —
 * the timeline says "you removed X" without resurrecting X's history around it.
 */
export function timelineView(raw: CanonicalPayload, learnerId?: string): TimelineEntry[] {
  const label = new Map<string, string>();
  for (const s of raw.tracks) label.set(s.id, s.title);
  for (const c of raw.concepts) label.set(c.id, c.name);
  for (const s of raw.sources) label.set(s.id, s.title);
  for (const s of raw.snippets) label.set(s.id, s.text);
  for (const q of raw.questions) label.set(q.id, q.text);

  const retracted = retractedIds(raw);
  const hidden = hiddenIds(raw, new Set(retracted.keys()));
  return raw.events
    .filter((ev) => learnerId === undefined || ev.learnerId === learnerId) // T4 scope; omitted = all
    .filter((ev) => EVENT_ONLY_VERBS.has(ev.verb) || !hidden.has(ev.targetId))
    .map((ev) => ({
      at: ev.occurredAt,
      verb: ev.verb,
      targetKind: ev.targetType,
      targetId: ev.targetId,
      label: label.get(ev.targetId) ?? ev.targetId,
    }))
    .sort((a, b) => b.at - a.at || a.label.localeCompare(b.label));
}

/** A source/snippet on the other end of a RAISES or ANSWERS edge, labeled for display. */
export interface QuestionProvenance {
  kind: 'source' | 'snippet';
  id: string;
  /** Source title, or the snippet's text. */
  label: string;
  /** For snippets: the owning source's title (the "which source" answer, one hop up). */
  sourceTitle?: string;
}

export interface QuestionView {
  id: string;
  text: string;
  asked: boolean;
  answered: boolean;
  gap: boolean;
  /** Human tag labels on the question (workbench rail's cross-kind tag facet). */
  tags: string[];
  /** Concept names this question is ABOUT. */
  about: string[];
  /** What RAISED it (sources/snippets). */
  raisedBy: QuestionProvenance[];
  /** What ANSWERS it in the corpus (sources/snippets). */
  answeredBy: QuestionProvenance[];
}

/**
 * Every live question with its full provenance — where it came from (RAISES) and what answers
 * it (ANSWERS) — plus the learner/corpus overlay. The Journey's question sections read this.
 * `learnerId` scopes asked/answered to one learner (T4); omitted = the all-learners fold.
 */
export function questionsView(raw: CanonicalPayload, learnerId?: string): QuestionView[] {
  const p = liveView(raw);
  const mine = (e: { srcId: string }): boolean => learnerId === undefined || e.srcId === learnerId;
  const titleById = new Map(p.sources.map((s) => [s.id, s.title]));
  const snippetById = new Map(p.snippets.map((s) => [s.id, s]));
  const conceptName = new Map(p.concepts.map((c) => [c.id, c.name]));
  const asked = new Set(p.edges.filter((e) => e.type === 'ASKS' && mine(e)).map((e) => e.dstId));
  const answered = new Set(p.edges.filter((e) => e.type === 'ANSWERED' && mine(e)).map((e) => e.dstId));

  const provenance = (e: { srcType: string; srcId: string }): QuestionProvenance | undefined => {
    if (e.srcType === 'source') {
      const title = titleById.get(e.srcId);
      return title === undefined ? undefined : { kind: 'source', id: e.srcId, label: title };
    }
    const snip = snippetById.get(e.srcId);
    if (!snip) return undefined;
    const sourceTitle = titleById.get(snip.sourceId);
    return { kind: 'snippet', id: snip.id, label: snip.text, ...(sourceTitle !== undefined ? { sourceTitle } : {}) };
  };
  const of = (qid: string, type: 'RAISES' | 'ANSWERS'): QuestionProvenance[] =>
    p.edges
      .filter((e) => e.type === type && e.dstId === qid)
      .map(provenance)
      .filter((x): x is QuestionProvenance => x !== undefined)
      .sort((a, b) => a.label.localeCompare(b.label));

  return p.questions
    .map((q) => ({
      id: q.id,
      text: q.text,
      asked: asked.has(q.id),
      answered: answered.has(q.id),
      gap: !p.edges.some((e) => e.type === 'ANSWERS' && e.dstId === q.id),
      tags: q.tags.map(tagLabel),
      about: p.edges
        .filter((e) => e.type === 'ABOUT' && e.srcId === q.id)
        .map((e) => conceptName.get(e.dstId) ?? e.dstId)
        .sort((a, b) => a.localeCompare(b)),
      raisedBy: of(q.id, 'RAISES'),
      answeredBy: of(q.id, 'ANSWERS'),
    }))
    .sort((a, b) => a.text.localeCompare(b.text));
}

// ── Relations + graph (workbench redesign) ─────────────────────────────────────────────────
// Two projections the workbench's detail "Connections" and the Map tab need — both require
// edge traversal and kind resolution the graph owns, so no client can derive them from
// snapshot alone. Additive under READ_VERSION 1; live-filtered (retracted entities and edges
// touching them never appear).

/** The six node kinds the workbench renders (concepts included — they anchor snippets/sources). */
export type NodeKind = 'track' | 'concept' | 'source' | 'snippet' | 'question';

/** One typed edge touching a focused entity, from that entity's point of view. */
export interface Relation {
  /** 'out' = the focused entity is the edge source; 'in' = it is the target. */
  direction: 'out' | 'in';
  type: string;
  /** The edge's tags (rendered labels) — on generic LINK/ABOUT edges these carry the meaning
   *  (#Refines, #Explains, …; model v2). Additive under READ_VERSION 1. */
  tags: string[];
  /** The entity on the other end. */
  otherId: string;
  otherKind: NodeKind;
  /** Its title / name / text. */
  otherLabel: string;
  /** Present on TRACK-SCOPED edges (in-context PRECEDES): the owning track's id. Additive. */
  trackContextId?: string;
}

/** Build id → {kind,label} over the live entities (learner endpoints are dropped — the
 *  workbench graph is the knowledge graph, not the behavioral overlay). */
function labelIndex(p: CanonicalPayload): Map<string, { kind: NodeKind; label: string }> {
  const idx = new Map<string, { kind: NodeKind; label: string }>();
  for (const s of p.tracks) idx.set(s.id, { kind: 'track', label: s.title });
  for (const c of p.concepts) idx.set(c.id, { kind: 'concept', label: c.name });
  for (const s of p.sources) idx.set(s.id, { kind: 'source', label: s.title });
  for (const s of p.snippets) idx.set(s.id, { kind: 'snippet', label: s.text });
  for (const q of p.questions) idx.set(q.id, { kind: 'question', label: q.text });
  return idx;
}

/** Structural edge types only — the learner-overlay verbs (STAGED/CONSUMED/ASKS/…) are state,
 *  surfaced on the entity views, not drawn as graph relations. */
const STRUCTURAL = new Set([
  'PREREQUISITE_OF', 'CLARIFIES', 'CONTRADICTS', 'RAISES', 'ANSWERS', 'ABOUT',
  'INCLUDES', 'PREREQUISITE_OF_SYL', 'PRECEDES', 'LINK',
]);

/**
 * Snippet→source containment SYNTHESIZED as a relation. Containment is a field
 * (`snippet.sourceId` — it participates in snippet identity), not an edge row, so a snippet
 * captured with no clarifies/raises/annotation has zero edges and rendered as a floating
 * "orphan" in the Map / an empty Connections list (alpha report, 2026-07-15). The projections
 * add the implicit edge so containment is always visible; `SNIPPET_OF` is a view-level type,
 * never stored.
 */
function containmentEdges(p: CanonicalPayload): { srcId: string; dstId: string; type: string }[] {
  return p.snippets.map((s) => ({ srcId: s.id, dstId: s.sourceId, type: 'SNIPPET_OF' }));
}

/** The typed edges touching `id`, each labeled from that entity's side (workbench "Connections"). */
export function relationsView(raw: CanonicalPayload, id: string): Relation[] {
  const p = liveView(raw);
  const idx = labelIndex(p);
  const rels: Relation[] = [];
  for (const e of [...p.edges.filter((x) => STRUCTURAL.has(x.type)), ...containmentEdges(p)]) {
    const tags = ((e as { tags?: readonly TypedTag[] }).tags ?? []).map(tagLabel);
    const ctx = (e as { trackContextId?: string }).trackContextId;
    const scoped = ctx !== undefined && ctx !== '' ? { trackContextId: ctx } : {};
    if (e.srcId === id) {
      const other = idx.get(e.dstId);
      if (other) rels.push({ direction: 'out', type: e.type, tags, otherId: e.dstId, otherKind: other.kind, otherLabel: other.label, ...scoped });
    } else if (e.dstId === id) {
      const other = idx.get(e.srcId);
      if (other) rels.push({ direction: 'in', type: e.type, tags, otherId: e.srcId, otherKind: other.kind, otherLabel: other.label, ...scoped });
    }
  }
  return rels.sort((a, b) => a.type.localeCompare(b.type) || a.otherLabel.localeCompare(b.otherLabel));
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  tags: string[];
}
export interface GraphEdge {
  srcId: string;
  dstId: string;
  type: string;
  /** Rendered tag labels — the meaning of generic LINK/ABOUT edges (model v2). Additive. */
  tags: string[];
}
export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The whole knowledge graph as nodes + structural edges (the Map tab). Live-filtered; learner
 *  overlay verbs and learner nodes are excluded — this is the graph of what is known, not done. */
export function graphView(raw: CanonicalPayload): GraphView {
  const p = liveView(raw);
  const tagsOf = (t: readonly TypedTag[]): string[] => t.map(tagLabel);
  const nodes: GraphNode[] = [
    ...p.tracks.map((s) => ({ id: s.id, kind: 'track' as const, label: s.title, tags: tagsOf(s.tags) })),
    ...p.concepts.map((c) => ({ id: c.id, kind: 'concept' as const, label: c.name, tags: tagsOf(c.tags) })),
    ...p.sources.map((s) => ({ id: s.id, kind: 'source' as const, label: s.title, tags: tagsOf(s.tags) })),
    ...p.snippets.map((s) => ({ id: s.id, kind: 'snippet' as const, label: s.text, tags: tagsOf(s.tags) })),
    ...p.questions.map((q) => ({ id: q.id, kind: 'question' as const, label: q.text, tags: tagsOf(q.tags) })),
  ];
  const present = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [
    ...p.edges.filter((e) => STRUCTURAL.has(e.type)).map((e) => ({ srcId: e.srcId, dstId: e.dstId, type: e.type, tags: tagsOf(e.tags) })),
    // implicit snippet→source containment, so a bare snippet never floats
    ...containmentEdges(p).map((e) => ({ ...e, tags: [] as string[] })),
  ].filter((e) => present.has(e.srcId) && present.has(e.dstId));
  return { nodes, edges };
}

export interface AssembledSource {
  id: string;
  title: string;
  consumed: boolean;
}
export interface AssembledSnippet {
  id: string;
  text: string;
  sourceId: string;
  /** How the passage anchors to the concept. */
  relation: 'clarifies' | 'contradicts';
  /** The learner's annotation, if any (from their `ANNOTATES` edge). */
  note?: string;
  sentiment?: string;
}
export interface AssembledQuestion {
  id: string;
  text: string;
  /** The learner has an open gap for this question (`ASKS`). */
  asked: boolean;
  /** The learner has answered it (`ANSWERED`). */
  answered: boolean;
  /** No source/snippet `ANSWERS` it — a corpus gap (questions §2.3). */
  gap: boolean;
}
export interface AssembledConcept {
  id: string;
  name: string;
  /** The learner has answered at least one question `ABOUT` this concept (behavioral progress). */
  answered: boolean;
  /**
   * In-scope sources filed under this concept via `EXPLAINS`. Only explicit members ever
   * appear here — `EXPLAINS` is a candidate pool, never an auto-pull (the membership
   * invariant; see slice5 §2.3).
   */
  sources: AssembledSource[];
  /** Passages anchored to this concept via `CLARIFIES`/`CONTRADICTS`, with the learner's note. */
  snippets: AssembledSnippet[];
  /** Questions anchored to this concept via `ABOUT`, with learner + corpus-gap flags. */
  questions: AssembledQuestion[];
  /** The learner `TRACKS` this concept (the freshness gate). */
  following: boolean;
  /** Human tag labels on the concept itself (concept tag editing, 2026-07-18). Additive. */
  tags: string[];
  /** Most-recent engagement time (epoch-ms) rolled up from events; undefined if never engaged. */
  lastEngagedAt?: number;
}
export interface AssembleResult {
  /** Prerequisite levels: level 0 has no unmet prereqs; each concept precedes its dependents. */
  levels: AssembledConcept[][];
  /** PRECEDES-ordered source levels for in-scope sources NOT filed under any concept. */
  sourceOrder: AssembledSource[][];
  /** Total concepts in scope. */
  total: number;
  /** Concepts with at least one learner-answered question (behavioral progress count). */
  answeredCount: number;
  /** Concept-anchored questions the learner asked but has not answered (asked && !answered). */
  openQuestions: AssembledQuestion[];
  /** Concept-anchored questions no source/snippet answers — the corpus's information gaps. */
  corpusGaps: AssembledQuestion[];
  /** Present when the assembly was scoped to a track. */
  trackId?: string;
  title?: string;
}

/**
 * Assemble a learning path, overlaid with a learner's mastery — the "tracks the learner,
 * not the document" payoff. `trackRef` may be a `syl_` id or a natural reference (the
 * title), resolved here like the behavioral verbs' refs — clients never derive ids. With a
 * ref, the path is scoped to that track's explicit `INCLUDES` members; with none, the
 * whole store is in scope.
 *
 * Membership is always explicit: only in-scope sources are ever filed under a concept, and
 * `EXPLAINS` is a candidate pool, never an auto-pull (slice5 §2.3).
 * Two payoffs fall out of that pool:
 *  - **concepts for free** (source-first): the concept set = explicit concept members ∪ the
 *    concepts the in-scope sources `EXPLAINS`, ordered by the global PREREQUISITE_OF graph.
 *  - **sources under concepts**: each in-scope source is filed under the concept(s) it
 *    `EXPLAINS`; sources that explain nothing fall to the PRECEDES-ordered reading list.
 */
export function assemble(
  raw: CanonicalPayload,
  trackRef?: string,
  learnerId = DEFAULT_LEARNER,
): AssembleResult {
  const p = liveView(raw); // retracted entities and their cascade never assemble (DATA_MODEL.md §6)
  const sid = trackRef
    ? trackRef.startsWith('syl_') ? trackRef : trackId(trackRef)
    : undefined;
  const nameById = new Map(p.concepts.map((c) => [c.id, c.name]));
  const conceptTagsById = new Map(p.concepts.map((c) => [c.id, c.tags.map(tagLabel)]));
  const titleById = new Map(p.sources.map((s) => [s.id, s.title]));

  // In-scope sources: a track's explicit source members, or every source for the global view.
  let explicitConceptIds: string[];
  let inScopeSourceIds: string[];
  let title: string | undefined;
  if (sid) {
    title = p.tracks.find((s) => s.id === sid)?.title;
    const included = p.edges.filter((e) => e.type === 'INCLUDES' && e.srcId === sid);
    explicitConceptIds = included.filter((e) => e.dstType === 'concept').map((e) => e.dstId);
    inScopeSourceIds = included.filter((e) => e.dstType === 'source').map((e) => e.dstId);
  } else {
    explicitConceptIds = p.concepts.map((c) => c.id);
    inScopeSourceIds = p.sources.map((s) => s.id);
  }
  const inScopeSources = new Set(inScopeSourceIds);

  // Source-ABOUT-concept (v2; formerly EXPLAINS) restricted to in-scope sources: the only path
  // from a source into a concept view. Any tag counts — the pool is "about", the tags say how.
  const explainsByConcept = new Map<string, string[]>();
  for (const e of p.edges) {
    if (e.type !== 'ABOUT' || e.srcType !== 'source' || !inScopeSources.has(e.srcId)) continue;
    const arr = explainsByConcept.get(e.dstId);
    if (arr) arr.push(e.srcId);
    else explainsByConcept.set(e.dstId, [e.srcId]);
  }
  // Concepts for free: explicit members plus whatever the in-scope sources explain.
  const conceptIds = [...new Set([...explicitConceptIds, ...explainsByConcept.keys()])];

  const prereq = p.edges
    .filter((e) => e.type === 'PREREQUISITE_OF')
    .map((e) => ({ src: e.srcId, dst: e.dstId }));
  const consumed = new Set(
    p.edges.filter((e) => e.type === 'CONSUMED' && e.srcId === learnerId).map((e) => e.dstId),
  );
  const source = (id: string): AssembledSource => ({
    id,
    title: titleById.get(id) ?? id,
    consumed: consumed.has(id),
  });

  // Snippets anchored to concepts via CLARIFIES/CONTRADICTS, overlaid with the learner's
  // annotation (note/sentiment from their ANNOTATES edge). Parallel to sources under concepts.
  const snippetById = new Map(p.snippets.map((s) => [s.id, s]));
  const annotationBySnippet = new Map<string, { note?: string; sentiment?: string }>();
  for (const e of p.edges) {
    if (e.type === 'ANNOTATES' && e.srcId === learnerId) {
      annotationBySnippet.set(e.dstId, (e.metadata ?? {}) as { note?: string; sentiment?: string });
    }
  }
  const snippetsByConcept = new Map<string, AssembledSnippet[]>();
  for (const e of p.edges) {
    if (e.type !== 'CLARIFIES' && e.type !== 'CONTRADICTS') continue;
    const snip = snippetById.get(e.srcId);
    if (!snip) continue;
    const ann = annotationBySnippet.get(e.srcId) ?? {};
    const entry: AssembledSnippet = {
      id: e.srcId,
      text: snip.text,
      sourceId: snip.sourceId,
      relation: e.type === 'CLARIFIES' ? 'clarifies' : 'contradicts',
      ...(ann.note !== undefined ? { note: ann.note } : {}),
      ...(ann.sentiment !== undefined ? { sentiment: ann.sentiment } : {}),
    };
    const arr = snippetsByConcept.get(e.dstId);
    if (arr) arr.push(entry);
    else snippetsByConcept.set(e.dstId, [entry]);
  }

  // Questions anchored to concepts via ABOUT, flagged with the learner's overlay (ASKS/ANSWERED)
  // and the corpus-gap test (no source/snippet ANSWERS it). Rolls up to the concept (questions §2.5).
  const questionById = new Map(p.questions.map((q) => [q.id, q]));
  const asked = new Set(p.edges.filter((e) => e.type === 'ASKS' && e.srcId === learnerId).map((e) => e.dstId));
  const answeredByLearner = new Set(p.edges.filter((e) => e.type === 'ANSWERED' && e.srcId === learnerId).map((e) => e.dstId));
  const answeredBySource = new Set(p.edges.filter((e) => e.type === 'ANSWERS').map((e) => e.dstId));
  const questionsByConcept = new Map<string, AssembledQuestion[]>();
  for (const e of p.edges) {
    if (e.type !== 'ABOUT') continue;
    const q = questionById.get(e.srcId);
    if (!q) continue;
    const entry: AssembledQuestion = {
      id: q.id,
      text: q.text,
      asked: asked.has(q.id),
      answered: answeredByLearner.has(q.id),
      gap: !answeredBySource.has(q.id),
    };
    const arr = questionsByConcept.get(e.dstId);
    if (arr) arr.push(entry);
    else questionsByConcept.set(e.dstId, [entry]);
  }

  // Time overlays (freshness 8a): the pure recency projection over the event log, plus the
  // learner's tracked (following) set. No clock — last-engaged is a stored time.
  const recency = recencyByConcept(p, learnerId);
  const following = new Set(
    p.edges.filter((e) => e.type === 'TRACKS' && e.srcId === learnerId).map((e) => e.dstId),
  );

  const filed = new Set<string>();
  const levels = topoLevels(conceptIds, prereq).map((level) =>
    level.map((id) => {
      const srcIds = (explainsByConcept.get(id) ?? [])
        .slice()
        .sort((a, b) => (titleById.get(a) ?? a).localeCompare(titleById.get(b) ?? b));
      for (const s of srcIds) filed.add(s);
      const snippets = (snippetsByConcept.get(id) ?? [])
        .slice()
        .sort((a, b) => a.text.localeCompare(b.text));
      const questions = (questionsByConcept.get(id) ?? [])
        .slice()
        .sort((a, b) => a.text.localeCompare(b.text));
      return {
        id,
        name: nameById.get(id) ?? id,
        tags: conceptTagsById.get(id) ?? [],
        answered: questions.some((q) => q.answered),
        sources: srcIds.map(source),
        snippets,
        questions,
        following: following.has(id),
        ...(recency.get(id) !== undefined ? { lastEngagedAt: recency.get(id) } : {}),
      };
    }),
  );

  // Loose reading list: in-scope sources not filed under any concept, in PRECEDES order.
  const looseSourceIds = inScopeSourceIds.filter((id) => !filed.has(id));
  const precedes = p.edges
    .filter((e) => e.type === 'PRECEDES' && (e.trackContextId ?? '') === (sid ?? ''))
    .map((e) => ({ src: e.srcId, dst: e.dstId }));
  const sourceOrder = topoLevels(looseSourceIds, precedes).map((level) => level.map(source));

  const answeredCount = levels.flat().filter((n) => n.answered).length;

  // Deduplicate concept-anchored questions (one may be ABOUT several in-scope concepts) and
  // derive the two headline views: the learner's open gaps and the corpus's information gaps.
  const uniqueQuestions = new Map(levels.flat().flatMap((n) => n.questions).map((q) => [q.id, q]));
  const openQuestions = [...uniqueQuestions.values()].filter((q) => q.asked && !q.answered);
  const corpusGaps = [...uniqueQuestions.values()].filter((q) => q.gap);

  return { levels, sourceOrder, total: conceptIds.length, answeredCount, openQuestions, corpusGaps, trackId: sid, title };
}

// ── The publication contract (publish plan P1/P4; DATA_GOVERNANCE §2) ──────────────────────────
// A published track's PUBLIC face: its own versioned view, never a filtered snapshot — what is
// public must be enumerable and testable. The closure: the track + its INCLUDES members
// (concepts, sources) + those sources' snippets + questions RAISED/ANSWERED by included content,
// plus edges among included entities (PRECEDES only in this track's context). Stripped, by
// construction rather than by filter: learners, events, the whole learner overlay (no learner-
// src edge can survive — learners aren't included), ANNOTATES notes/sentiments, `personalUrl`
// (a private pointer into someone's vault), the creator's learner id, and the publish stamp
// itself (a fork must arrive unpublished). The bundle round-trips: `payload` is importable as-is
// (import = fork, PB-S4), and `contentHash` fingerprints it for later descent-vs-change diffing.

/** The current publication-contract version, carried on every bundle. */
export const PUB_VERSION = 1;

export interface PublicationManifest {
  trackId: string;
  title: string;
  /** The creator's display name — attribution (governance §7), never the learner id. */
  author?: string;
  license: string;
  publishedAt: number;
  /** sha256 over the canonical JSON of `payload` — the fork-diff anchor. */
  contentHash: string;
  /** D3: the author's Ed25519 public key (hex) — signed in by the FACADE (this view stays
   *  pure); possession of the matching secret is ownership continuity. */
  authorKey?: string;
  /** D3: Ed25519 signature (hex) over the manifest-minus-signature JSON — tamper/impersonation
   *  evidence for copies in circulation. */
  signature?: string;
}

export interface PublicationBundle {
  pubVersion: typeof PUB_VERSION;
  publication: PublicationManifest;
  /** Canonical-payload-shaped, importable as-is; importing it IS forking (PB-S4). */
  payload: {
    version: 2;
    tracks: unknown[];
    concepts: unknown[];
    sources: unknown[];
    snippets: unknown[];
    questions: unknown[];
    edges: unknown[];
  };
}

/** The publication bundle for a track, or null when unpublished/unknown — the routes' 404. */
export function publicationView(raw: CanonicalPayload, trackId: string): PublicationBundle | null {
  const p = liveView(raw);
  const sy = p.tracks.find((s) => s.id === trackId);
  if (!sy?.published) return null;

  const memberIds = new Set(p.edges.filter((e) => e.type === 'INCLUDES' && e.srcId === trackId).map((e) => e.dstId));
  let sources = p.sources.filter((s) => memberIds.has(s.id));
  // Concept-anchored expansion (experiment, 2026-07-19): a CONCEPTS-ONLY track (concept
  // members, zero source members) publishes its concept-anchored reading list — the members'
  // prerequisite family (PREREQUISITE_OF walked both ways) plus every source ABOUT a family
  // concept. Member-source tracks keep the classic closure untouched: the ABOUT pool is
  // still never auto-pulled where explicit membership exists.
  const memberConceptIds = new Set(p.concepts.filter((c) => memberIds.has(c.id)).map((c) => c.id));
  const conceptAnchored = sources.length === 0 && memberConceptIds.size > 0;
  let familyIds = new Set(memberConceptIds);
  if (conceptAnchored) {
    // ONE closure implementation for the concepts-anchored model (src/graph/family.ts) —
    // shared with the workbench projection so the two can never drift.
    familyIds = conceptFamily({
      conceptIds: p.concepts.map((c) => c.id),
      prereqs: p.edges.filter((e) => e.type === 'PREREQUISITE_OF'),
      mains: memberConceptIds,
      baseRank: (a, b) => a.localeCompare(b),
    }).familyIds;
    const anchoredIds = new Set(
      p.edges.filter((e) => e.type === 'ABOUT' && e.srcType === 'source' && familyIds.has(e.dstId)).map((e) => e.srcId),
    );
    sources = p.sources.filter((s) => anchoredIds.has(s.id));
  }
  const memberSourceIds = new Set(sources.map((s) => s.id));
  const snippets = p.snippets.filter((s) => memberSourceIds.has(s.sourceId));
  // Concepts enter the closure BOTH ways (owner gap, 2026-07-18): tracked directly by the
  // track (INCLUDES) and tied to member content (source ABOUT / snippet CLARIFIES-CONTRADICTS)
  // — without the second set, a published page showed sources with their concept ties severed.
  const contentSrcIds = new Set([...memberSourceIds, ...snippets.map((s) => s.id)]);
  const tiedConceptIds = new Set(
    p.edges
      .filter((e) => e.dstType === 'concept' && contentSrcIds.has(e.srcId) && (e.type === 'ABOUT' || e.type === 'CLARIFIES' || e.type === 'CONTRADICTS'))
      .map((e) => e.dstId),
  );
  const concepts = p.concepts.filter((c) => memberIds.has(c.id) || tiedConceptIds.has(c.id) || (conceptAnchored && familyIds.has(c.id)));
  const contentIds = new Set([...concepts.map((c) => c.id), ...memberSourceIds, ...snippets.map((s) => s.id)]);
  const questionIds = new Set(
    p.edges
      .filter((e) => (e.type === 'RAISES' || e.type === 'ANSWERS') && e.dstType === 'question' && contentIds.has(e.srcId))
      .map((e) => e.dstId),
  );
  const questions = p.questions.filter((q) => questionIds.has(q.id));
  const included = new Set([trackId, ...contentIds, ...questionIds]);

  const edges = p.edges.filter((e) => {
    if (e.srcType === 'learner') return false; // the overlay never publishes
    // Reading order: this track's scoped pairs, plus GLOBAL pairs (readsAfter sugar /
    // Reading order UI) between included sources — the concept-anchored page sorts by them.
    if (e.type === 'PRECEDES') return ((e.trackContextId ?? '') === '' || e.trackContextId === trackId) && included.has(e.srcId) && included.has(e.dstId);
    return included.has(e.srcId) && included.has(e.dstId);
  });

  const payload: PublicationBundle['payload'] = {
    version: 2,
    // creatorId (a learner id) and the publish stamp stay home; the importer's sugar layer
    // re-defaults the creator, so the bundle imports as an UNPUBLISHED fork.
    tracks: [
      {
        id: sy.id,
        title: sy.title,
        ...(sy.goal !== undefined ? { goal: sy.goal } : {}),
        ...(sy.framework !== undefined ? { framework: sy.framework } : {}),
        locked: sy.locked,
        validationState: sy.validationState,
        tags: sy.tags,
      },
    ],
    concepts,
    sources: sources.map(({ personalUrl: _personal, ...pub }) => pub),
    snippets,
    questions,
    edges: edges.map(({ metadata: _metadata, ...pub }) => pub),
  };

  const creator = raw.learners.find((l) => l.id === sy.creatorId);
  const author = creator && creator.displayName !== 'default' ? creator.displayName : undefined;
  return {
    pubVersion: PUB_VERSION,
    publication: {
      trackId: sy.id,
      title: sy.title,
      ...(author !== undefined ? { author } : {}),
      license: sy.published.license,
      publishedAt: sy.published.at,
      contentHash: bytesToHex(sha256(utf8ToBytes(JSON.stringify(payload)))),
    },
    payload,
  };
}
