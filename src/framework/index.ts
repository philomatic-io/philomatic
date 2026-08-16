/**
 * The framework layer: declarations only.
 *
 * A framework is a DATA FILE — it tells the system what edge tags exist, what they mean, their
 * directionality, and (for overlay edges only) metadata-field vocabularies. The engine never
 * interprets any of it: unknown tags import fine and render unstyled (accepted-but-unstyled —
 * frameworks never gate writes); frameworks are a lens the UIs render and future validation
 * rules report over. `philomatic-core` ships built-in and is treated exactly like a user
 * framework will be.
 *
 * The `on` selector shape ({type, srcKind?, dstKind?}) is deliberately the seed of a future
 * validation-rule/hook selector — rules will match edges the same way tags scope to them.
 */
import { z } from 'zod';
import core from './philomatic-core.json';
import argumentDiagramming from './experimental/argument-diagramming.json';
import propositionalLogic from './experimental/propositional-logic.json';
import hermeneutics from './experimental/hermeneutics.json';
// experimental/defeasible-deontic.json is a DRAFT (design notes; version 0) — deliberately NOT loaded:
// serving vocabulary nothing lints is a trap. It registers when framework lint rules land
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
  /** Does it travel in a PUBLISHED bundle? Default false, same as entity tags — a vocabulary
   *  entry leaks only by being declared publishable, never by being forgotten. */
  publish: z.boolean().optional(),
  /** MACHINE-READABLE map mark — part of the DECLARATION, not a viewer
   *  preference: "this relation is a grouping relation" is meaning, and travels with the
   *  framework. Absent = an ordinary line. 'group' = the hull treatment (src members gather
   *  around the dst head, grouped ties suppressed as lines — the taxonomy look); 'comet' =
   *  the tapered mark VISUALLY only (never the ordering gravity); 'hidden' = not drawn (the
   *  edge still exists, exports, and lists in Connections). The palette is CLOSED: a mark,
   *  never a color — hue stays budgeted to state and node kinds. */
  render: z.enum(['line', 'group', 'comet', 'hidden']).optional(),
  /** MACHINE-READABLE epistemic valence, mapping to the standing green/red state pair:
   *  'for' draws the solid bowed support mark, 'against' joins the dashed conflict family.
   *  Retires the rule lib's tag-name literal (ARCH #2: declarations, never names). */
  polarity: z.enum(['for', 'against']).optional(),
  description: z.string().optional(),
});

/** Metadata vocabularies apply to learner-OVERLAY edges only — shared-edge
 *  metadata must not grow before the assertion layer makes it addressable. */
const MetadataFieldSchema = z.object({
  name: z.string().min(1),
  on: OnSchema,
  vocabulary: z.array(z.object({ token: z.string().min(1), label: z.string().optional() })).optional(),
});

/** A tag a framework recognises ON AN ENTITY (source, concept, track, snippet, question).
 *  Before entity tags were declarable every one was free-form —
 *  and the publish projection carried all of them, including ones that describe the LEARNER
 *  rather than the work (#CasualReading, #beginner, personal shorthand). Declaring the
 *  vocabulary is what lets publishing keep the useful ones and leave the rest at home. */
const EntityTagSchema = z.object({
  name: z.string().min(1),
  /** Which entity kinds may wear it; omitted = any. */
  on: z.array(z.enum(['track', 'concept', 'source', 'snippet', 'question'])).optional(),
  /** May it carry `:3`? (`#difficulty:3`) */
  degree: z.boolean().optional(),
  /** Does it travel in a PUBLISHED bundle? Default false — publishing is opt-in per tag, so a
   *  new tag added carelessly cannot leak by being forgotten about. */
  publish: z.boolean().optional(),
  description: z.string().optional(),
});

export const FrameworkFileSchema = z.object({
  framework: z.string().min(1),
  version: z.number().int(),
  /** Stamped by an accounts registry at PUSH time — attribution
   *  rides the definition, minted from the pusher's username, never self-asserted. */
  author: z.string().optional(),
  description: z.string().optional(),
  edgeTags: z.array(EdgeTagSchema).default([]),
  entityTags: z.array(EntityTagSchema).default([]),
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

/**
 * Tag names publishable for a track on `framework` — CORE plus that framework, and nothing else
 * (**publishes are framework-specific**).
 *
 * The union across every INSTALLED framework would be wrong in a way that only shows up later:
 * whether a tag may travel would then depend on what happens to be installed on the publisher's
 * machine, so the same track would publish differently from two computers. Scoping to the
 * track's own declared framework makes the bundle a function of the track, which is what a
 * reader receiving it is entitled to assume.
 *
 * Default-deny within that scope. The CLI and API may still MINT any tag a learner likes — that
 * is their library; what is bounded is what LEAVES.
 *
 * A framework may declare ANY tag publishable, including one core deliberately withholds.
 * Core does not publish `#difficulty` because difficulty is relative to the reader;
 * a framework built around graded exercises could reasonably declare it, and a track on that
 * framework would then carry it. Core's judgement binds core, not everyone — which is the point
 * of the vocabulary being per-framework rather than a single global allowlist.
 *
 * (Loading a framework of one's own is Phase 2 — `FRAMEWORKS` is fixed today. That is a gap in
 * INSTALLATION, not in this rule, which already answers correctly for any framework it is given.)
 */
export function publishableTagsFor(
  framework?: string,
  /** The LIBRARY'S OWN frameworks (personal + installed, from the framework store) — their
   *  publishable tags travel too (a minted relation was once silently
   *  stripped at publish, so a track "published under core"). The store is shell state, so the
   *  hosts pass it in; the projection stays pure. */
  extra?: readonly FrameworkFile[],
): { edges: ReadonlySet<string>; entities: ReadonlySet<string> } {
  const edges = new Set<string>();
  const entities = new Set<string>();
  const inScope = [...FRAMEWORKS.filter((fw) => fw === PHILOMATIC_CORE || fw.framework === framework), ...(extra ?? [])];
  for (const fw of inScope) {
    for (const t of fw.edgeTags) if (t.publish === true) edges.add(t.name);
    for (const t of fw.entityTags) if (t.publish === true) entities.add(t.name);
  }
  return { edges, entities };
}

/** The declared tags applicable to an edge shape (UI selectors; future rule scoping). */
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
