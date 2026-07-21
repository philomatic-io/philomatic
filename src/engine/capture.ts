/**
 * The capture contract (adapters; ARCHITECTURE.md §5) — the engine's own,
 * versioned write API for programmatic ingestion. This is the durable seam a browser extension,
 * bookmarklet, CLI, or agent writes against — deliberately NOT the sugar authoring format (which
 * is a human/LLM convenience) nor raw canonical (which would push id derivation into every
 * client). Clients send *intent*; the engine (see `captureSource`/`captureSnippet`) derives ids,
 * builds edges, and upserts safely.
 *
 * These schemas are the wire contract: Zod validates shape, the engine methods enforce the domain
 * rules. Bump `version` when the contract changes so clients and server can negotiate.
 */
import { z } from 'zod';
import { lexTag } from '../schema/tags';
import { ModalitySchema, type Modality, type TypedTag } from '../schema/entities';

/** The current capture-contract version. */
export const CAPTURE_VERSION = 1;

/** The default single-tenant learner for the MVP (spec: multi-tenant, one seeded learner). */
export const DEFAULT_LEARNER = 'lnr_default';

/**
 * Durable facts a write-time adapter may contribute (adapters §2.3). Folded
 * fill-empty-only, first-capture-only, by `captureSource`. Limited to identity-safe, schema-present
 * fields — `author` is excluded because it participates in the URL-derived `sourceId`.
 */
export const ResolvePatchSchema = z.object({
  title: z.string().optional(),
  /** Unlocked by model v2 (author left the source id) — the marquee enrichment example. */
  author: z.string().optional(),
  estimatedDurationMins: z.number().int().optional(),
  tags: z.array(z.unknown()).optional(),
});
export type ResolvePatch = z.infer<typeof ResolvePatchSchema>;

/** Remember a source (a page/video/etc.) by URL. `url` presence/format is checked by the engine. */
export const CaptureSourceInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  /** Sugar tag strings ("#difficulty:2") or canonical tag objects. */
  tags: z.array(z.unknown()).optional(),
  modality: ModalitySchema.optional(),
  /** File the source into this track (by title) via INCLUDES. */
  track: z.string().optional(),
  /** Questions this source RAISES (created if unseen) — the popup's page-level "ask" when no
   *  selection exists to hang a snippet on (feedback round 2). Symmetric to CaptureSnippetInput. */
  raises: z.array(z.string()).optional(),
  /** Record a STAGED edge + event. Default: true. */
  stage: z.boolean().optional(),
  /** Write-time adapter output, resolved by the shell before the call. Folded fill-empty-only. */
  resolved: ResolvePatchSchema.optional(),
  /** Whose capture this is (STAGED/RESTORED land under this learner) — T4 tenancy prep;
   *  additive, defaults to the seeded single tenant. */
  learnerId: z.string().optional(),
});
export type CaptureSourceInput = z.infer<typeof CaptureSourceInput>;

export interface CaptureSourceResult {
  /** The capture-contract version that produced this result (shape-change detection for clients). */
  version: typeof CAPTURE_VERSION;
  sourceId: string;
  /** false when the URL was already in the graph (idempotent re-capture). */
  created: boolean;
  /** whether a STAGED event was recorded this call. */
  staged: boolean;
  /** true when this capture revived a previously removed source — re-capture means "I want this
   *  back", recorded as an explicit RESTORED event (DATA_MODEL.md §6). Additive field. */
  revived?: boolean;
  /** How many questions this capture raised (source-level RAISES). Additive field. */
  raised: number;
}

/** Capture a highlighted passage as a Snippet of its source. */
export const CaptureSnippetInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  /** The owning source, by URL (created if unseen) or by its id (must already exist). */
  url: z.string().optional(),
  sourceId: z.string().optional(),
  text: z.string().optional(),
  note: z.string().optional(),
  sentiment: z.string().optional(),
  /** Concept names this passage clarifies / contradicts (created if unseen). */
  clarifies: z.array(z.string()).optional(),
  contradicts: z.array(z.string()).optional(),
  /** Questions this passage poses — each becomes a Question (if unseen) + a snippet RAISES edge. */
  raises: z.array(z.string()).optional(),
  /** Sugar tag strings (or canonical tags) for the snippet itself. */
  tags: z.array(z.unknown()).optional(),
  learnerId: z.string().optional(),
});
export type CaptureSnippetInput = z.infer<typeof CaptureSnippetInput>;

export interface CaptureSnippetResult {
  /** The capture-contract version that produced this result (shape-change detection for clients). */
  version: typeof CAPTURE_VERSION;
  snippetId: string;
  sourceId: string;
  /** false when the same passage of the same source was already captured (idempotent). */
  created: boolean;
  /** whether a learner ANNOTATES edge (note/sentiment) was attached. */
  annotated: boolean;
  /** how many questions the snippet was linked to via RAISES this call. */
  raised: number;
  /** true when this capture revived a removed snippet and/or its removed owning source
   *  (DATA_MODEL.md §6). Additive field. */
  revived?: boolean;
}

// ── The edit contract (DATA_MODEL.md §6): remove = retraction, restore, update = supersession ────

/** Remove/restore an entity by typed id (`src_…`, `snp_…`, `qst_…`, `cpt_…`, `syl_…`) or a
 *  natural reference (a URL, or a concept/question/track/source name — resolved against the
 *  store; ambiguity is an error naming the typed-id escape). */
export const EditRefInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  ref: z.string().min(1),
  learnerId: z.string().optional(),
  /** Event time (epoch-ms); omitted → the engine clock samples at the boundary. */
  occurredAt: z.number().int().optional(),
});
export type EditRefInput = z.infer<typeof EditRefInput>;
export const RemoveInput = EditRefInput;
export const RestoreInput = EditRefInput;

/** Publish a track (publish plan P2; DATA_GOVERNANCE §2): the explicit act that stamps a
 *  license and opens the public /t routes for exactly this track's publication closure.
 *  Re-publishing a published track is a no-op; changing the license = unpublish + publish. */
export const PublishInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  ref: z.string().min(1),
  /** Named at the act (governance §2). Omitted → DEFAULT_LICENSE (owner question O1). */
  license: z.string().min(1).optional(),
});
export type PublishInput = z.infer<typeof PublishInput>;
export const UnpublishInput = EditRefInput;

/** The recommended default pending owner decision O1 (CC BY-SA 4.0 vs ODbL). */
export const DEFAULT_LICENSE = 'CC-BY-SA-4.0';

/** A publication bundle arriving for import (= a FORK, publish plan P4). The manifest is
 *  validated here; the payload's content shape is desugar/validate's job, as for any import. */
export const PublicationBundleInput = z.object({
  pubVersion: z.literal(1),
  publication: z.object({
    trackId: z.string().min(1),
    title: z.string().min(1),
    author: z.string().optional(),
    license: z.string().min(1),
    publishedAt: z.number().int(),
    contentHash: z.string().min(1),
    authorKey: z.string().optional(), // D3 — absent on pre-signing bundles (unattested forever)
    signature: z.string().optional(),
  }),
  payload: z.record(z.unknown()),
});
export type PublicationBundleInput = z.infer<typeof PublicationBundleInput>;

/**
 * Un-assert a structural edge by its full coordinates (owner ruling, 2026-07-18 — the concept
 * editors made wrong ties cheap to create, so they must be cheap to remove). INTERIM shape:
 * physical deletion, no ids minted, no event log — the inverse is re-assertion. Upgrades to
 * true retraction when the assertion layer gives edges ids (ROADMAP §2.3). Overlay verbs are
 * refused (write-both integrity: un-verbs are their own future primitive), and SNIPPET_OF is
 * refused (containment is a field, not an edge).
 */
export const UnlinkInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  srcId: z.string().min(1),
  type: z.string().min(1),
  dstId: z.string().min(1),
  trackContextId: z.string().optional(),
});
export type UnlinkInput = z.infer<typeof UnlinkInput>;

/**
 * Assert a structural edge (the inverse of unlink; debt/read-contract 2026-07-19). The UI
 * previously hand-built canonical edges through importPayload at every tie site — this is the
 * ONE intent-shaped seam: full coordinates in, validation (dangling refs, cycles) and the
 * idempotent upsert inside the engine. Tags carry edge meaning (#explains on ABOUT, …).
 */
export const LinkInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  srcType: z.string().min(1),
  srcId: z.string().min(1),
  type: z.string().min(1),
  dstType: z.string().min(1),
  dstId: z.string().min(1),
  tags: z.array(z.unknown()).optional(),
  trackContextId: z.string().optional(),
});
export type LinkInput = z.infer<typeof LinkInput>;

/** The edge types unlink may touch — the structural set, nothing behavioral or synthesized. */
export const UNLINKABLE_TYPES = new Set([
  'PREREQUISITE_OF', 'CLARIFIES', 'CONTRADICTS', 'RAISES', 'ANSWERS', 'ABOUT',
  'INCLUDES', 'PREREQUISITE_OF_SYL', 'PRECEDES', 'LINK',
]);

/** Edit non-identity fields. `patch` keys are validated per resolved kind by the engine;
 *  identity-participating fields are rejected with the reason (DATA_MODEL.md §6). */
export const UpdateInput = z.object({
  version: z.literal(CAPTURE_VERSION).optional(),
  ref: z.string().min(1),
  patch: z.record(z.unknown()),
  learnerId: z.string().optional(),
});
export type UpdateInput = z.infer<typeof UpdateInput>;

/** The entity kinds the edit primitives serve (= RETRACTABLE_KINDS, typed for results). */
export type EditKind = 'track' | 'concept' | 'source' | 'snippet' | 'question';

export interface EditResult {
  version: typeof CAPTURE_VERSION;
  kind: EditKind;
  targetId: string;
  /** false = the call was a no-op: remove of an already-removed entity, restore of a live one,
   *  or a patch whose values all matched the current state. */
  changed: boolean;
}

/** A capture input-validation failure. The shell maps it to an HTTP 400; the CLI to a message. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * Coerce capture tag inputs to canonical tags. Forgiving by design — a client need not know the
 * `#` convention (`ml` and `#ml` both work); already-canonical objects pass through. A genuinely
 * malformed tag becomes a `CaptureError` rather than crashing deep in desugar.
 */
export function coerceTags(tags: readonly unknown[] | undefined): TypedTag[] {
  if (!tags?.length) return [];
  return tags.map((t) => {
    if (typeof t !== 'string') return t as TypedTag; // already-canonical object
    const raw = t.trim();
    try {
      return lexTag(raw.startsWith('#') ? raw : `#${raw}`);
    } catch {
      throw new CaptureError(`invalid tag: "${t}"`);
    }
  });
}

/** Validate a capture body against its schema, throwing a `CaptureError` with a readable message. */
export function parseCapture<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.');
    throw new CaptureError(issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'invalid capture input');
  }
  return result.data;
}

/**
 * Host/extension → modality heuristic: the learner shouldn't hand-pick modality for the common
 * cases. Pure; falls through to `text` (most captured pages are articles). Overridable via input.
 */
export function inferModality(url: string): Modality {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    path = u.pathname.toLowerCase();
  } catch {
    return 'text';
  }
  if (/(?:^|\.)(?:youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return 'video';
  if (/(?:^|\.)(?:soundcloud\.com|podcasts\.apple\.com|open\.spotify\.com)$/.test(host)) return 'audio';
  if (path.endsWith('.mp3') || path.endsWith('.m4a') || path.endsWith('.wav')) return 'audio';
  if (path.endsWith('.mp4') || path.endsWith('.webm')) return 'video';
  return 'text';
}
