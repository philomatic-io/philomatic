/**
 * Canonical entity schemas (DATA_MODEL.md §3) — the "after desugar" shape:
 * ids present, tags as objects. Zod is the Tier-1 structural validator and the single
 * source of truth for types (via z.infer).
 */
import { z } from 'zod';

/** A typed tag in canonical (object) form: `#difficulty:2` -> { name, degree }. */
export const TypedTagSchema = z.object({
  name: z.string().min(1),
  subtype: z.string().min(1).optional(),
  degree: z.number().int().optional(),
});
export type TypedTag = z.infer<typeof TypedTagSchema>;

export const EntityKindSchema = z.enum([
  'learner',
  'track',
  'concept',
  'source',
  'snippet',
  'question',
]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const ModalitySchema = z.enum(['text', 'video', 'audio', 'interactive', 'other']);
export type Modality = z.infer<typeof ModalitySchema>;

export const SourceStatusSchema = z.enum(['active', 'archived', 'dead_link']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/** Canonical Concept. */
export const ConceptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  tags: z.array(TypedTagSchema).default([]),
});
export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Canonical Track (DATA_MODEL.md §3, slice5 §2).
 * A scoped, ordered view over members — the unit that turns the one global graph into a
 * goal-shaped path. Membership is via INCLUDES edges (track→concept and/or
 * track→source), so a track can be concept-driven, source-only, or mixed.
 */
/** The publish act's stamp (publish plan P2; DATA_GOVERNANCE §2): when, and under what
 *  license. Set/cleared ONLY by the explicit publish/unpublish commands; its presence gates
 *  the publication contract and the public /t routes. */
export const PublishedSchema = z.object({
  at: z.number().int(),
  license: z.string().min(1),
});
export type Published = z.infer<typeof PublishedSchema>;

/** Fork lineage (publish plan P4; meta-graph doctrine): where this track was imported FROM —
 *  recorded at fork time, because descent vs convergence is unreconstructible later. */
export const OriginSchema = z.object({
  trackId: z.string().min(1),
  publishedAt: z.number().int(),
  /** The parent bundle's payload hash — the diff anchor (the bundle itself is archived). */
  contentHash: z.string().min(1),
  url: z.string().optional(),
  /** D3: the author key the bundle was signed with at fork time — the TOFU pin (a later
   *  re-fork under a DIFFERENT key is refused loudly). */
  authorKey: z.string().optional(),
});
export type Origin = z.infer<typeof OriginSchema>;

export const TrackSchema = z.object({
  id: z.string().min(1),
  creatorId: z.string().min(1), // FK to a learner; the sugar layer defaults this so authors omit it.
  title: z.string().min(1),
  goal: z.string().optional(),
  framework: z.string().optional(), // opted-in rigid framework (Phase 2)
  locked: z.boolean().default(false), // locked vs. dynamic upkeep (spec §5.B)
  validationState: z.enum(['PENDING', 'VALID', 'INVALID']).default('PENDING'),
  tags: z.array(TypedTagSchema).default([]),
  // `null` = EXPLICIT clear (unpublish); absent = preserve whatever the store has (the
  // upsert carries the stamp forward so filing a source into a published track can't
  // silently unpublish it — registry test, 2026-07-18).
  published: PublishedSchema.nullable().optional(),
  origin: OriginSchema.optional(),
});
export type Track = z.infer<typeof TrackSchema>;

/** Canonical Source. */
export const SourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.string().optional(),
  directUrl: z.string().url().optional(),
  bibliographicUrl: z.string().url().optional(),
  personalUrl: z.string().optional(),
  modality: ModalitySchema,
  estimatedDurationMins: z.number().int().optional(),
  status: SourceStatusSchema.default('active'),
  tags: z.array(TypedTagSchema).default([]),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * Canonical Snippet (snippets §2.1). A highlighted passage of a Source —
 * the *shared* part of an annotation. The learner's note/sentiment is a separate `ANNOTATES`
 * overlay edge, not a field here. `anchor` is an opaque, extension-populated locator the engine
 * only stores and round-trips (§2.5).
 */
export const SnippetSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1), // FK to the Source this passage is drawn from
  text: z.string().min(1),
  anchor: z.string().optional(),
  tags: z.array(TypedTagSchema).default([]),
});
export type Snippet = z.infer<typeof SnippetSchema>;

/**
 * Canonical Question (questions §2.1). A first-class node parallel to
 * Concept — the inquiry/gap dimension. Its meaning is its set of answers (the things linked by
 * `ANSWERS`); an `ASKS`-ed question with no `ANSWERS` is a computable information gap (§2.3).
 */
export const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(TypedTagSchema).default([]),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * The verbs logged as timestamped events. The behavioral verbs are write-both (fact edge +
 * event); the editorial verbs RETRACTED/RESTORED are **event-only** — retraction is inherently
 * temporal (latest wins), so no timeless fact edge is derived for them (DATA_MODEL.md §6). This
 * is the one deliberate asymmetry in the event model.
 */
export const EventVerbSchema = z.enum([
  'STAGED', 'CONSUMED', 'ANNOTATES', 'ASKS', 'ANSWERED', 'TRACKS',
  'RETRACTED', 'RESTORED',
  // The first un-verb (owner ruling, 2026-07-18): read state must toggle. Event-only — it
  // REMOVES the CONSUMED fact edge rather than deriving one; the log keeps both directions.
  'UNCONSUMED',
]);
export type EventVerb = z.infer<typeof EventVerbSchema>;

/** Verbs that write only a log event — desugar derives no fact edge for these; liveness is a
 *  pure latest-wins fold over them (engine/read.ts `liveView`). */
export const EVENT_ONLY_VERBS: ReadonlySet<EventVerb> = new Set(['RETRACTED', 'RESTORED', 'UNCONSUMED']);

/** Entity kinds a retraction may target: content, not tenants (learners are never retracted). */
export const RETRACTABLE_KINDS: ReadonlySet<EntityKind> = new Set([
  'track', 'concept', 'source', 'snippet', 'question',
]);

/**
 * A timestamped behavioral event (freshness 8a §2). The append-only,
 * immutable half of the event-sourcing split: the core graph holds the timeless *fact*, this
 * log holds *when* it happened. Identity is `(learnerId, verb, targetId, occurredAt)`, so the
 * canonical payload stays deterministic and re-import is idempotent. `occurredAt` is epoch-ms.
 */
export const EventSchema = z.object({
  learnerId: z.string().min(1),
  verb: EventVerbSchema,
  targetType: EntityKindSchema,
  targetId: z.string().min(1),
  occurredAt: z.number().int(),
});
export type LearnerEvent = z.infer<typeof EventSchema>;

/** The typed relationship edges (DATA_MODEL.md §4) — model v2's razor-kept set. */
export const EdgeTypeSchema = z.enum([
  // Learner -> Entity (state overlay)
  'STAGED',
  'CONSUMED',
  'ANNOTATES', // learner -> snippet; note/sentiment ride the edge metadata (snippets §2.3)
  'ASKS', // learner -> question; an open information gap / curiosity (questions §2.2)
  'ANSWERED', // learner -> question; the learner demonstrated an answer (competence)
  'TRACKS', // learner -> concept; opted to follow it — the freshness gate (freshness 8a §2.2)
  // NB: self-claimed MASTERED / DECAYING / NEEDS_REFRESHER / REFRESHED were removed in Slice 7
  // M5 — progress is the question overlay above; recency returns as derived "freshness" (TRACKS).
  // Concept -> Concept (rigid dependency; global + acyclic)
  'PREREQUISITE_OF',
  // Snippet -> Concept — the polarity pair (negation is an engine primitive, model v2 D9)
  'CLARIFIES',
  'CONTRADICTS',
  // Source / Snippet -> Question (gap computation)
  'RAISES',
  'ANSWERS',
  // Question|Source -> Concept: "content is about a concept; tags say how" (the former
  // EXPLAINS/DEMONSTRATES/EXERCISES ride as #Explains/#Demonstrates/#Exercises tags)
  'ABOUT',
  // Track -> Source / Concept — THE membership relation; roles ride tags (#Seminal, #Foundational)
  'INCLUDES',
  // Track -> Track (macro-sequencing)
  'PREREQUISITE_OF_SYL',
  // Source -> Source (track-scoped soft sequencing; slice5 §2.1)
  'PRECEDES',
  // The generic descriptive link (same-kind pairs) — meaning rides framework-declared tags.
  // Collapsed here in v2: REFINES, COMPLEMENTS, ANALOGOUS_TO, IS_EVIDENCE_FOR, REFERENCE_FOR,
  // EXPANDS, DERIVATIVE_OF (and SEMINAL onto INCLUDES) — implementation_plan_model_v2.md §1.
  'LINK',
  // NB: Domain is not an entity (ARCHITECTURE.md §6) — membership is a #domain:* tag
  // observation, hierarchy (if a consumer ever needs it) is a BROADER concept edge.
]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/**
 * A canonical edge. Identity is the (srcId, dstId, type, trackContextId) tuple.
 * `trackContextId` scopes track-relative edges (PRECEDES, co-requisites) so the same
 * pair can be ordered differently across tracks (slice5 §2.4); it is absent/'' for global
 * edges. Kept optional here and normalized to '' at the storage boundary.
 */
export const EdgeSchema = z.object({
  srcType: EntityKindSchema,
  srcId: z.string().min(1),
  type: EdgeTypeSchema,
  dstType: EntityKindSchema,
  dstId: z.string().min(1),
  trackContextId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  tags: z.array(TypedTagSchema).default([]),
});
export type Edge = z.infer<typeof EdgeSchema>;

/** Minimal Learner — the tenant whose state overlays the shared graph (spec §4). */
export const LearnerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  profile: z.record(z.any()).optional(),
});
export type Learner = z.infer<typeof LearnerSchema>;

/** The canonical import/export envelope (DATA_MODEL.md §1). Version 2 = the model-v2 taxonomy
 *  (edge collapse + author-free source ids); v1 payloads are migrated at import by
 *  `src/io/migrate.ts`, never rejected. */
export const CanonicalPayloadSchema = z.object({
  version: z.literal(2),
  learners: z.array(LearnerSchema).default([]),
  tracks: z.array(TrackSchema).default([]),
  concepts: z.array(ConceptSchema).default([]),
  sources: z.array(SourceSchema).default([]),
  snippets: z.array(SnippetSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  events: z.array(EventSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
});
export type CanonicalPayload = z.infer<typeof CanonicalPayloadSchema>;
