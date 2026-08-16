/**
 * Canonical entity schemas (DATA_MODEL.md) — the "after desugar" shape:
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
 * Canonical Track.
 * A scoped, ordered view over members — the unit that turns the one global graph into a
 * goal-shaped path. Membership is via INCLUDES edges (track→concept and/or
 * track→source), so a track can be concept-driven, source-only, or mixed.
 */
/** The publish act's stamp: when, and under what
 *  license. Set/cleared ONLY by the explicit publish/unpublish commands; its presence gates
 *  the publication contract and the public /t routes. */
export const PublishedSchema = z.object({
  at: z.number().int(),
  license: z.string().min(1),
  /** Published AS a different identity: the
   *  projection to a bundle carries THIS trackId+title instead of the local ones. How a fork of
   *  someone else's track publishes as YOUR OWN version — the registry name belongs to its
   *  first publisher, so your version needs a name of its own. Local history never re-ids. */
  as: z.object({ trackId: z.string().min(1), title: z.string().min(1) }).optional(),
});
export type Published = z.infer<typeof PublishedSchema>;

/** Fork lineage (meta-graph doctrine): where this track was imported FROM —
 *  recorded at fork time, because descent vs convergence is unreconstructible later. */
export const OriginSchema = z.object({
  trackId: z.string().min(1),
  publishedAt: z.number().int(),
  /** The parent bundle's payload hash — the diff anchor (the bundle itself is archived). */
  contentHash: z.string().min(1),
  url: z.string().optional(),
  /** The author key the bundle was signed with at fork time — the TOFU pin (a later
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
  locked: z.boolean().default(false), // locked vs. dynamic upkeep
  validationState: z.enum(['PENDING', 'VALID', 'INVALID']).default('PENDING'),
  tags: z.array(TypedTagSchema).default([]),
  // `null` = EXPLICIT clear (unpublish); absent = preserve whatever the store has (the
  // upsert carries the stamp forward so filing a source into a published track can't
  // silently unpublish it).
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
 * Canonical Snippet. A highlighted passage of a Source —
 * the *shared* part of an annotation. The learner's note/sentiment is a separate `ANNOTATES`
 * overlay edge, not a field here. `anchor` is an opaque, extension-populated locator the engine
 * only stores and round-trips.
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
 * Canonical Question. A first-class node parallel to
 * Concept — the inquiry/gap dimension. Its meaning is its set of answers (the things linked by
 * `ANSWERS`); an `ASKS`-ed question with no `ANSWERS` is a computable information gap.
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
 * temporal (latest wins), so no timeless fact edge is derived for them. This
 * is the one deliberate asymmetry in the event model.
 */
export const EventVerbSchema = z.enum([
  'STAGED', 'CONSUMED', 'ANNOTATES', 'ASKS', 'ANSWERED', 'TRACKS',
  'RETRACTED', 'RESTORED',
  // The first un-verb: read state must toggle. Event-only — it
  // REMOVES the CONSUMED fact edge rather than deriving one; the log keeps both directions.
  'UNCONSUMED',
  // The staged lifecycle. An un- verb may only ever REVERSE
  // its verb, so the two EXITS from staged get their own verdict verbs:
  //   UNSTAGED — mechanical reversal, NO verdict ("oops"/un-park); symmetric with UNCONSUMED.
  //   ACCEPTED — verdict: the proposal becomes an ordinary entity (marker folds away).
  //   REJECTED — verdict: the proposal is retracted (a RETRACTED event rides along).
  // All three are event-only and together form the candidate-disposition log.
  'UNSTAGED', 'ACCEPTED', 'REJECTED',
]);
export type EventVerb = z.infer<typeof EventVerbSchema>;

/** Verbs that write only a log event — desugar derives no fact edge for these. */
export const EVENT_ONLY_VERBS: ReadonlySet<EventVerb> = new Set([
  'RETRACTED', 'RESTORED', 'UNCONSUMED', 'UNSTAGED', 'ACCEPTED', 'REJECTED',
]);

/** The verbs the LIVENESS fold reads — retraction is latest-wins over exactly this pair
 *  (engine/read.ts `retractedIds`). Split from EVENT_ONLY_VERBS when the staged lifecycle
 *  landed: folding every event-only verb meant a later UNCONSUMED/ACCEPTED
 *  silently un-retracted an entity, since "latest and not RETRACTED" read as live. */
export const RETRACTION_VERBS: ReadonlySet<EventVerb> = new Set(['RETRACTED', 'RESTORED']);

/** Entity kinds a retraction may target: content, not tenants (learners are never retracted). */
export const RETRACTABLE_KINDS: ReadonlySet<EntityKind> = new Set([
  'track', 'concept', 'source', 'snippet', 'question',
]);

/**
 * A timestamped behavioral event. The append-only,
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

/** The typed relationship edges (DATA_MODEL.md) — the razor-kept set. */
export const EdgeTypeSchema = z.enum([
  // Learner -> Entity (state overlay)
  'STAGED',
  'CONSUMED',
  'ANNOTATES', // learner -> snippet; note/sentiment ride the edge metadata
  'ASKS', // learner -> question; an open information gap / curiosity
  'ANSWERED', // learner -> question; the learner demonstrated an answer (competence)
  'TRACKS', // learner -> concept; opted to follow it — the freshness gate
  // NB: no self-claimed MASTERED / DECAYING / NEEDS_REFRESHER / REFRESHED verbs — progress is
  // the question overlay above; recency is derived "freshness" (TRACKS).
  // Concept -> Concept (rigid dependency; global + acyclic)
  'PREREQUISITE_OF',
  // Snippet -> Concept — the polarity pair (negation is an engine primitive)
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
  // Source -> Source (track-scoped soft sequencing)
  'PRECEDES',
  // The generic descriptive link (same-kind pairs) — meaning rides framework-declared tags.
  // Collapsed here in v2: REFINES, COMPLEMENTS, ANALOGOUS_TO, IS_EVIDENCE_FOR, REFERENCE_FOR,
  // EXPANDS, DERIVATIVE_OF (and SEMINAL onto INCLUDES) — collapsed by io/migrate.
  'LINK',
  // NB: Domain is not an entity — membership is a #domain:* tag
  // observation, hierarchy (if a consumer ever needs it) is a BROADER concept edge.
]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/**
 * A canonical edge. Identity is the (srcId, dstId, type, trackContextId) tuple.
 * `trackContextId` scopes track-relative edges (PRECEDES, co-requisites) so the same
 * pair can be ordered differently across tracks; it is absent/'' for global
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

/** Minimal Learner — the tenant whose state overlays the shared graph. */
export const LearnerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  profile: z.record(z.any()).optional(),
});
export type Learner = z.infer<typeof LearnerSchema>;

/**
 * The FRAMEWORK MANIFEST: an export names
 * the frameworks it assumes — `{name, version}` per installed framework — so a cross-INSTANCE
 * share can one day flag a missing lens instead of silently degrading its tags to unstyled.
 * ADDITIVE and DORMANT: exports stamp it (the stamp reflects the exporting engine's installed
 * set, so it is regenerated per export, never stored); imports tolerate and ignore it; nothing
 * interprets it yet. Publication bundles deliberately do NOT carry it — their payload is built
 * field-by-field in publicationView, so landing this changed no contentHash. An absent
 * manifest means "assumes core only", which is true of every pre-manifest payload — that
 * reading is what makes the reservation safe to land late for old files and early for new.
 */
export const FrameworkManifestSchema = z.array(
  z.object({ name: z.string().min(1), version: z.number().int() }),
);
export type FrameworkManifest = z.infer<typeof FrameworkManifestSchema>;

/** The canonical import/export envelope (DATA_MODEL.md). Version 2 = the model-v2 taxonomy
 *  (edge collapse + author-free source ids); v1 payloads are migrated at import by
 *  `src/io/migrate.ts`, never rejected. */
export const CanonicalPayloadSchema = z.object({
  version: z.literal(2),
  frameworks: FrameworkManifestSchema.optional(),
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

/**
 * The IMPORT-side entity shapes — merge-patch semantics. Per field, on an entity whose id
 * already has a row:
 *   absent        → keep what the store has (a create-default applies only to a brand-new row)
 *   explicit null → clear (optional scalars only; enums/booleans/arrays have no null)
 *   value present → replace (a present `[]` clears tags/aliases — empty is expressible)
 * The FULL schemas above stay the internal value shape: reads, exports and projections always
 * see every field, because `exportAll()` builds from rows. A full payload is a valid patch, so
 * backup/fork/publish round-trips behave exactly as before — what changes is that a PARTIAL
 * payload can no longer wipe metadata it never mentioned. The merge itself runs in
 * `storage/upsert.ts` against the prior row, inside the write transaction.
 * Identity fields (id, name, text, title-as-identity, directUrl, snippet.sourceId) are never
 * clearable — same rule as the `update` primitive.
 * DRIFT GUARD: any field later added to a base schema with a `.default(...)` MUST be overridden
 * here too, or the default silently re-erases absence — test/merge-patch.test.ts pins this.
 */
const clearable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
export const ConceptPatchSchema = ConceptSchema.extend({
  description: clearable(z.string()),
  aliases: z.array(z.string()).optional(),
  tags: z.array(TypedTagSchema).optional(),
});
export type ConceptPatch = z.infer<typeof ConceptPatchSchema>;

export const TrackPatchSchema = TrackSchema.extend({
  goal: clearable(z.string()),
  framework: clearable(z.string()),
  locked: z.boolean().optional(),
  validationState: z.enum(['PENDING', 'VALID', 'INVALID']).optional(),
  tags: z.array(TypedTagSchema).optional(),
  // `published`/`origin` predate this layer with their own carry-forward (the 'null' sentinel
  // and COALESCE in upsert) — the original hand-rolled merge-patch; they stay as declared.
});
export type TrackPatch = z.infer<typeof TrackPatchSchema>;

export const SourcePatchSchema = SourceSchema.extend({
  author: clearable(z.string()),
  bibliographicUrl: clearable(z.string().url()),
  personalUrl: clearable(z.string()),
  modality: ModalitySchema.optional(),
  estimatedDurationMins: clearable(z.number().int()),
  status: SourceStatusSchema.optional(),
  tags: z.array(TypedTagSchema).optional(),
});
export type SourcePatch = z.infer<typeof SourcePatchSchema>;

export const SnippetPatchSchema = SnippetSchema.extend({
  anchor: clearable(z.string()),
  tags: z.array(TypedTagSchema).optional(),
});
export type SnippetPatch = z.infer<typeof SnippetPatchSchema>;

export const QuestionPatchSchema = QuestionSchema.extend({
  description: clearable(z.string()),
  tags: z.array(TypedTagSchema).optional(),
});
export type QuestionPatch = z.infer<typeof QuestionPatchSchema>;

/** The import envelope in patch form — what `desugar` emits and `upsertPayload` consumes. */
export const CanonicalPatchPayloadSchema = z.object({
  version: z.literal(2),
  frameworks: FrameworkManifestSchema.optional(),
  learners: z.array(LearnerSchema).default([]),
  tracks: z.array(TrackPatchSchema).default([]),
  concepts: z.array(ConceptPatchSchema).default([]),
  sources: z.array(SourcePatchSchema).default([]),
  snippets: z.array(SnippetPatchSchema).default([]),
  questions: z.array(QuestionPatchSchema).default([]),
  events: z.array(EventSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
});
export type CanonicalPatchPayload = z.infer<typeof CanonicalPatchPayloadSchema>;
