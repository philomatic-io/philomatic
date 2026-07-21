/**
 * The framework layer, F0: declarations only (implementation_plan_model_v2.md §4).
 *
 * A framework is a DATA FILE — it tells the system what edge tags exist, what they mean, their
 * directionality, and (for overlay edges only, D8) metadata-field vocabularies. The engine never
 * interprets any of it: unknown tags import fine and render unstyled (accepted-but-unstyled,
 * D4); frameworks are a lens the UIs render and future validation rules (F1) report over.
 * `philomatic-core` ships built-in and is treated exactly like a user framework will be.
 *
 * The `on` selector shape ({type, srcKind?, dstKind?}) is deliberately the seed of the F1/F2
 * rule/hook selector — rules will match edges the same way tags scope to them.
 */
import { z } from 'zod';
import core from './philomatic-core.json';
import argumentDiagramming from './experimental/argument-diagramming.json';
import propositionalLogic from './experimental/propositional-logic.json';
import hermeneutics from './experimental/hermeneutics.json';
// experimental/defeasible-deontic.json is a DRAFT (design notes; version 0) — deliberately NOT loaded:
// serving vocabulary nothing lints is a trap. It registers when F1 lint lands (ROADMAP §2.4)
// and its open norm→act selector question is decided (see the file's own notes).

/** Where a tag (or rule, later) applies — matches edges by type and endpoint kinds. */
const OnSchema = z.object({
  type: z.string().min(1),
  srcKind: z.string().optional(),
  dstKind: z.string().optional(),
});

const EdgeTagSchema = z.object({
  name: z.string().min(1),
  on: OnSchema,
  /** 'symmetric' relations mean the same read from either end; directed ones may name how the
   *  reverse reads (`inverseLabel`) for rendering the inbound direction. */
  direction: z.enum(['directed', 'symmetric']),
  inverseLabel: z.string().optional(),
  /** MACHINE-READABLE meaning of the tag's subtype, so third-party front ends (an Obsidian
   *  plugin, a future mobile client) can render the semantics without hardcoding conventions:
   *  'bundle' = same-subtype edges into one target form a conjoint group (#Supports:a — the
   *  linked-premises convention). Prose in `description` is for humans; this field is for code. */
  subtypeRole: z.enum(['bundle']).optional(),
  /** MACHINE-READABLE: this tag's edges participate in the named hierarchy (e.g. 'taxonomy').
   *  Clients derive node RANKS from the declared hierarchy — root (nothing above), inner
   *  (a parent-link outward), attachment (content hung onto a rank) — and map ranks to their
   *  own design system. Semantic token, never presentation: no colors/sizes live here. */
  hierarchy: z.string().min(1).optional(),
  /** How this tag's edges relate to its `hierarchy`: 'parent' = src sits UNDER dst in the
   *  hierarchy (#SubfieldOf); 'attachment' = src is content attached to the dst rank
   *  (#TopicOf). Required whenever `hierarchy` is set. */
  hierarchyRole: z.enum(['parent', 'attachment']).optional(),
  description: z.string().optional(),
});

/** D8 + audit A2: metadata vocabularies apply to learner-OVERLAY edges only in F0 — shared-edge
 *  metadata must not grow before the assertion layer makes it addressable. */
const MetadataFieldSchema = z.object({
  name: z.string().min(1),
  on: OnSchema,
  vocabulary: z.array(z.object({ token: z.string().min(1), label: z.string().optional() })).optional(),
});

export const FrameworkFileSchema = z.object({
  framework: z.string().min(1),
  version: z.number().int(),
  description: z.string().optional(),
  edgeTags: z.array(EdgeTagSchema).default([]),
  metadataFields: z.array(MetadataFieldSchema).default([]),
});

export type FrameworkFile = z.infer<typeof FrameworkFileSchema>;
export type EdgeTagDecl = FrameworkFile['edgeTags'][number];

/** The built-in frameworks, validated at module load — a malformed file fails fast. */
export const PHILOMATIC_CORE: FrameworkFile = FrameworkFileSchema.parse(core);
/** The first non-core framework: argument structure over passages (snippet↔snippet LINKs). */
export const ARGUMENT_DIAGRAMMING: FrameworkFile = FrameworkFileSchema.parse(argumentDiagramming);
/** Propositional structure over passages — argument-diagramming's formal cousin. */
export const PROPOSITIONAL_LOGIC: FrameworkFile = FrameworkFileSchema.parse(propositionalLogic);
/** Interpretive structure over texts — readings, parallels, allusions, the quadriga overlay. */
export const HERMENEUTICS: FrameworkFile = FrameworkFileSchema.parse(hermeneutics);

/** Every installed framework, core first. User frameworks join this list (Phase 2). */
export const FRAMEWORKS: readonly FrameworkFile[] = [
  PHILOMATIC_CORE,
  ARGUMENT_DIAGRAMMING,
  PROPOSITIONAL_LOGIC,
  HERMENEUTICS,
];

/** The declared tags applicable to an edge shape (UI selectors; F1 rule scoping later). */
export function edgeTagsFor(fw: FrameworkFile, type: string, srcKind?: string, dstKind?: string): EdgeTagDecl[] {
  return fw.edgeTags.filter(
    (t) =>
      t.on.type === type &&
      (t.on.srcKind === undefined || srcKind === undefined || t.on.srcKind === srcKind) &&
      (t.on.dstKind === undefined || dstKind === undefined || t.on.dstKind === dstKind),
  );
}

/** A metadata field's declared vocabulary (e.g. ANNOTATES sentiment), if any. */
export function metadataVocabulary(fw: FrameworkFile, type: string, field: string): { token: string; label?: string }[] {
  return fw.metadataFields.find((m) => m.on.type === type && m.name === field)?.vocabulary ?? [];
}
