/**
 * The JSON read contract this UI consumes — a deliberate MIRROR of the engine's versioned view
 * shapes (`src/engine/read.ts`, READ_VERSION 2), not a source import. The UI is a transport-level
 * client (plan): it depends on the wire shapes plus the `version` envelope, exactly like the
 * extension's fetches, so it stays host-agnostic and never reaches into engine source.
 * If the engine bumps READ_VERSION, the transport refuses loudly instead of rendering garbage.
 */
export const READ_VERSION = 2;

export type Modality = 'text' | 'video' | 'audio' | 'interactive' | 'other';

export interface AssembledQuestion {
  id: string;
  text: string;
  /** The learner has an open gap for this question (ASKS). */
  asked: boolean;
  /** The learner has answered it (ANSWERED). */
  answered: boolean;
  /** Nothing in the corpus ANSWERS it — an information gap. */
  gap: boolean;
}

export interface SourceView {
  id: string;
  title: string;
  modality: Modality;
  url?: string;
  /** The learner's own copy/workspace (obsidian:// note, file://) — links back to it. */
  personalUrl?: string;
  /** Human tag labels (`#name`, `#name:subtype`, `#name:degree`). */
  tags: string[];
  /** Concept names this source is ABOUT — the concept facet for sources. */
  about: string[];
  /** Author(s) — user-typed or adapter-resolved (arXiv). */
  author?: string;
  estimatedDurationMins?: number;
  consumed: boolean;
  staged: boolean;
}

export interface TrackView {
  id: string;
  title: string;
  goal?: string;
  framework?: string;
  tags: string[];
  sourceIds: string[];
  /** Members layered by in-context PRECEDES; same level = co-requisites (additive, RV1). */
  sourceLevels: string[][];
  /** The PRECEDES pairs that order this track, each carrying its STORED context — absent =
   *  a context-free edge (orders every track). Cuts must match the stored shape. */
  precedes: { srcId: string; dstId: string; trackContextId?: string }[];
  /** Pending validation: accepting a proposed track IS the INCLUDES gesture. */
  staged: boolean;
  /** The publish stamp when the track is published. Additive. */
  published?: { at: number; license: string };
  /** Fork lineage: where this track came from, and the base version last seen. */
  origin?: { trackId: string; contentHash: string; url?: string };
}

export interface SnippetView {
  id: string;
  text: string;
  sourceId: string;
  /** The owning source's title, joined server-side. */
  source: string;
  note?: string;
  sentiment?: string;
  clarifies: string[];
  contradicts: string[];
  tags: string[];
  /** The questions this snippet RAISES, with the learner/corpus overlay. */
  raises: AssembledQuestion[];
  /** Pending validation — an adapter/LLM proposal or a self-parked item. */
  staged: boolean;
}

export interface Snapshot {
  version: number;
  tracks: TrackView[];
  sources: SourceView[];
  snippets: SnippetView[];
}

// ── The edit primitives (DATA_MODEL.md) ─────────────────────────────────────────────────────

export interface EditResult {
  version: number;
  kind: 'track' | 'concept' | 'source' | 'snippet' | 'question';
  targetId: string;
  changed: boolean;
}

/** A dependent hidden by the ownership cascade (restored together with its owner). */
export interface RemovedDependent {
  kind: 'snippet';
  id: string;
  label: string;
}

export interface RemovedItem {
  kind: EditResult['kind'];
  id: string;
  label: string;
  removedAt: number;
  removedBy: string;
  hides: RemovedDependent[];
}

export interface RemovedEnvelope {
  version: number;
  removed: RemovedItem[];
}

// ── Timeline + question provenance (feedback round 1) ──────────────────────────────────────

export interface TimelineEntry {
  at: number;
  verb: string;
  targetKind: string;
  targetId: string;
  label: string;
}

export interface TimelineEnvelope {
  version: number;
  timeline: TimelineEntry[];
}

export interface QuestionProvenance {
  kind: 'source' | 'snippet';
  id: string;
  label: string;
  /** For snippets: the owning source's title. */
  sourceTitle?: string;
}

export interface QuestionView {
  id: string;
  text: string;
  asked: boolean;
  answered: boolean;
  gap: boolean;
  tags: string[];
  about: string[];
  raisedBy: QuestionProvenance[];
  answeredBy: QuestionProvenance[];
  /** Pending validation — an adapter/LLM proposal or a self-parked item. */
  staged: boolean;
}

export interface QuestionsEnvelope {
  version: number;
  questions: QuestionView[];
}

// ── Relations + graph (workbench redesign) ─────────────────────────────────────────────────

export type NodeKind = 'track' | 'concept' | 'source' | 'snippet' | 'question';

export interface Relation {
  direction: 'out' | 'in';
  type: string;
  /** Edge-tag labels — the meaning of generic LINK/ABOUT edges (model v2). */
  tags: string[];
  otherId: string;
  otherKind: NodeKind;
  otherLabel: string;
  /** Present on track-scoped edges (in-context PRECEDES). */
  trackContextId?: string;
}

export interface RelationsEnvelope {
  version: number;
  relations: Relation[];
}

/** A framework file as clients handle it — the structural twin of the engine's zod shape
 *  (no shared module across src/ and ui/; the server validates, this types). */
export interface FrameworkEdgeTag {
  name: string;
  on: { type: string; srcKind?: string; dstKind?: string };
  direction: 'directed' | 'symmetric';
  inverseLabel?: string;
  subtypeRole?: string;
  hierarchy?: string;
  hierarchyRole?: 'parent' | 'attachment';
  publish?: boolean;
  render?: 'line' | 'group' | 'comet' | 'hidden';
  polarity?: 'for' | 'against';
  description?: string;
}
export interface FrameworkFile {
  framework: string;
  version: number;
  /** Stamped by an accounts registry at push time — attribution, never self-asserted. */
  author?: string;
  description?: string;
  edgeTags: readonly FrameworkEdgeTag[];
  entityTags?: readonly unknown[];
  metadataFields?: readonly unknown[];
}
/** Local VIEW OVERRIDES — how THIS library looks at declarations it doesn't own: re-mark or
 *  hide a tag, hide an edge type. Store-document state, never part of a framework file, so a
 *  reading preference cannot travel with an export or a bundle. */
export interface ViewOverrides {
  tags: Record<string, 'line' | 'group' | 'comet' | 'hidden'>;
  types: Record<string, 'hidden'>;
}

/** The library's vocabulary: built-ins + the personal working framework + installed imports. */
export interface FrameworksView {
  builtin: readonly FrameworkFile[];
  mine?: FrameworkFile;
  installed: readonly FrameworkFile[];
  viewOverrides?: ViewOverrides;
  /** Which OPTIONAL built-ins are on — core is always ambient; the rest are opt-in. */
  enabledBuiltins: readonly string[];
  /** Installed frameworks switched OFF — installs default on; this records the exceptions. */
  disabledInstalled: readonly string[];
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
  /** Edge-tag labels — the meaning of generic LINK/ABOUT edges (model v2). */
  tags: string[];
}

export interface GraphEnvelope {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── The journey projection (GET /assemble; Journey view) ───────────────────────────────────

export interface AssembledSource {
  id: string;
  title: string;
  consumed: boolean;
}

export interface AssembledSnippet {
  id: string;
  text: string;
  sourceId: string;
  relation: 'clarifies' | 'contradicts';
  note?: string;
  sentiment?: string;
}

export interface AssembledConcept {
  id: string;
  name: string;
  answered: boolean;
  sources: AssembledSource[];
  snippets: AssembledSnippet[];
  questions: AssembledQuestion[];
  following: boolean;
  /** Pending validation. */
  staged: boolean;
  /** Tag labels on the concept itself (concept tag editing). */
  tags: string[];
  lastEngagedAt?: number;
}

export interface AssembleResult {
  version: number;
  levels: AssembledConcept[][];
  sourceOrder: AssembledSource[][];
  total: number;
  answeredCount: number;
  openQuestions: AssembledQuestion[];
  corpusGaps: AssembledQuestion[];
  trackId?: string;
  title?: string;
}
