/**
 * Sugared authoring format + desugar (MVP.md).
 *
 * The sugared payload is a strict superset of the canonical payload that lets a human (and,
 * later, an LLM) author by name: ids are optional, tags are strings, and relationships are
 * declared inline on the entity that owns them instead of in a raw `edges` array.
 * `desugar()` expands all of that into the canonical payload BEFORE validation, so the
 * parser and storage only ever see canonical shapes.
 *
 * Slice 2 relation targets are always Concepts (deterministic slug ids), so a target id is
 * derived directly from its name — no lookup needed. Referential integrity (does that
 * concept actually exist?) is the parser's job, not desugar's.
 */
import { z } from 'zod';
import {
  CanonicalPayloadSchema,
  EdgeSchema,
  OriginSchema,
  PublishedSchema,
  EVENT_ONLY_VERBS,
  LearnerSchema,
  EventSchema,
  ModalitySchema,
  SnippetSchema,
  SourceStatusSchema,
  TypedTagSchema,
  type CanonicalPayload,
  type Edge,
  type EdgeType,
  type EntityKind,
  type Snippet,
  type Question,
  type TypedTag,
} from '../schema/entities';
import { conceptId, questionId, snippetId, sourceId, trackId } from '../schema/ids';
import { lexTag } from '../schema/tags';

/** Mirrors engine.DEFAULT_LEARNER; kept local to avoid a sugar→engine import cycle. */
const DEFAULT_CREATOR = 'lnr_default';

/** Which edge a sugar key produces, whether the owning entity is its src or dst, and (v2) the
 *  framework tag that carries the relation's meaning when the type is generic (LINK/ABOUT). */
interface Relation {
  type: EdgeType;
  ownerRole: 'src' | 'dst';
  targetKind: EntityKind;
  tag?: string;
}

const CONCEPT_RELATIONS: Record<string, Relation> = {
  // "my prerequisites are X" => X PREREQUISITE_OF me (owner is the dst)
  prerequisites: { type: 'PREREQUISITE_OF', ownerRole: 'dst', targetKind: 'concept' },
  analogousTo: { type: 'LINK', ownerRole: 'src', targetKind: 'concept', tag: 'AnalogousTo' },
  evidenceFor: { type: 'LINK', ownerRole: 'src', targetKind: 'concept', tag: 'IsEvidenceFor' },
};

// "Content is about a concept; the tag says how" (model v2 §1).
const SOURCE_RELATIONS: Record<string, Relation> = {
  // `about` is the canonical field (READ_VERSION 2 cleanup); `explains` stays as the v1 alias.
  about: { type: 'ABOUT', ownerRole: 'src', targetKind: 'concept', tag: 'Explains' },
  explains: { type: 'ABOUT', ownerRole: 'src', targetKind: 'concept', tag: 'Explains' },
  demonstrates: { type: 'ABOUT', ownerRole: 'src', targetKind: 'concept', tag: 'Demonstrates' },
  exercises: { type: 'ABOUT', ownerRole: 'src', targetKind: 'concept', tag: 'Exercises' },
};

const SNIPPET_RELATIONS: Record<string, Relation> = {
  clarifies: { type: 'CLARIFIES', ownerRole: 'src', targetKind: 'concept' },
  contradicts: { type: 'CONTRADICTS', ownerRole: 'src', targetKind: 'concept' },
};

const relationField = z.array(z.string()).default([]);

// Tags may be authored as sugar strings ("#difficulty:3") OR arrive already-canonical (objects),
// so an exported payload round-trips back through desugar. `coerceTag` lexes strings, passes
// objects through.
const tagField = z.array(z.union([z.string(), TypedTagSchema])).default([]);
const coerceTag = (t: string | TypedTag): TypedTag => (typeof t === 'string' ? lexTag(t) : t);

// Relation keys are declared explicitly (not via dynamic .extend) so Zod infers precise
// types. They must stay in sync with CONCEPT_RELATIONS / SOURCE_RELATIONS above.
const SugaredConceptSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  tags: tagField,
  prerequisites: relationField,
  analogousTo: relationField,
  evidenceFor: relationField,
});

// A highlighted passage authored inline under its source. `clarifies`/`contradicts` name the
// concepts it anchors to; `note`/`sentiment` become the authoring learner's ANNOTATES overlay.
const SugaredSnippetSchema = z.object({
  id: z.string().optional(),
  text: z.string().min(1),
  anchor: z.string().optional(),
  tags: tagField,
  clarifies: relationField,
  contradicts: relationField,
  note: z.string().optional(),
  sentiment: z.string().optional(),
  raises: relationField, // question texts this passage poses → snippet RAISES question
  answers: relationField, // question texts this passage satisfies → snippet ANSWERS question
  /** Snippet↔snippet framework LINKs by TEXT (id doctrine: authors never hand-derive snippet
   *  ids). `to` names the target passage's text; `source` (a source title) disambiguates when
   *  the same text appears under two sources; `tag` carries the meaning as a sugar tag string
   *  (e.g. "#Supports:a", "#Implies" — the framework layer declares what's renderable). */
  links: z
    .array(z.object({ to: z.string().min(1), tag: z.string().min(1), source: z.string().optional() }))
    .default([]),
});

const SugaredSourceSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  author: z.string().optional(),
  directUrl: z.string().url().optional(),
  bibliographicUrl: z.string().url().optional(),
  personalUrl: z.string().optional(),
  modality: ModalitySchema,
  estimatedDurationMins: z.number().int().optional(),
  status: SourceStatusSchema.optional(),
  tags: tagField,
  about: relationField,
  explains: relationField,
  demonstrates: relationField,
  exercises: relationField,
  snippets: z.array(SugaredSnippetSchema).default([]), // highlighted passages of this source
  raises: relationField, // question texts this source poses → source RAISES question
  answers: relationField, // question texts this source satisfies → source ANSWERS question
  /** Titles of sources to read FIRST — each becomes a GLOBAL PRECEDES edge (other → this).
   *  Source-level reading order, independent of any track; membership is not implied. */
  readsAfter: z.array(z.string()).default([]),
});

// A question authored directly. `about` names the concept(s) it concerns (→ ABOUT); `refines`
// names the question texts it refines (→ REFINES). Its id is derived from the text, so a
// snippet's/source's `raises`/`answers` referencing the same text converge to this entity.
const SugaredQuestionSchema = z.object({
  text: z.string().min(1),
  description: z.string().optional(),
  tags: tagField,
  about: relationField,
  refines: relationField,
});

// A track names its members by name/title; desugar resolves them to ids and emits the
// INCLUDES membership edges and the scoped PRECEDES ordering edges.
const SugaredTrackSchema = z.object({
  id: z.string().optional(),
  creatorId: z.string().optional(), // defaults to the seeded learner
  title: z.string().min(1),
  goal: z.string().optional(),
  framework: z.string().optional(),
  locked: z.boolean().optional(),
  validationState: z.enum(['PENDING', 'VALID', 'INVALID']).optional(),
  tags: tagField,
  includes: z.array(z.string()).default([]), // concept names → INCLUDES track→concept
  includeSources: z.array(z.string()).default([]), // source titles → INCLUDES track→source
  order: z.array(z.string()).default([]), // source titles; consecutive pairs → scoped PRECEDES
  /** Canonical passthrough: RMW edits re-import the whole entity, so stripping this here would
   *  silently unpublish on every track update. Authors don't hand-write it (publish is a
   *  command); publication bundles deliberately OMIT it (a fork arrives unpublished). */
  published: PublishedSchema.nullable().optional(), // null = explicit clear (unpublish)
  origin: OriginSchema.optional(),
});

export const SugaredPayloadSchema = z.object({
  // v2 is current; v1 is still accepted HERE only for sugar-field-only payloads — anything
  // carrying v1 raw edges/derived ids goes through io/migrate.ts first (engine.importPayload
  // does this automatically).
  version: z.union([z.literal(1), z.literal(2)]),
  learners: z.array(LearnerSchema).default([]), // canonical passthrough (no sugar fields)
  tracks: z.array(SugaredTrackSchema).default([]),
  concepts: z.array(SugaredConceptSchema).default([]),
  sources: z.array(SugaredSourceSchema).default([]),
  snippets: z.array(SnippetSchema).default([]), // canonical passthrough for now; inline sugar arrives in Slice 6 M2
  questions: z.array(SugaredQuestionSchema).default([]),
  events: z.array(EventSchema).default([]), // canonical passthrough; verb methods emit these in 8a M2
  edges: z.array(EdgeSchema).default([]), // raw canonical edges pass straight through
});
export type SugaredPayload = z.infer<typeof SugaredPayloadSchema>;

function makeEdge(rel: Relation, ownerId: string, ownerKind: EntityKind, targetId: string): Edge {
  const tags = rel.tag !== undefined ? [{ name: rel.tag }] : [];
  return rel.ownerRole === 'src'
    ? { srcType: ownerKind, srcId: ownerId, type: rel.type, dstType: rel.targetKind, dstId: targetId, tags }
    : { srcType: rel.targetKind, srcId: targetId, type: rel.type, dstType: ownerKind, dstId: ownerId, tags };
}

/** Expand a sugared payload into a validated canonical payload. */
export function desugar(input: unknown): CanonicalPayload {
  const s = SugaredPayloadSchema.parse(input);
  const edges: Edge[] = [...s.edges];

  const concepts = s.concepts.map((c) => {
    const id = c.id ?? conceptId(c.name);
    const rels = c as unknown as Record<string, string[]>;
    for (const [key, rel] of Object.entries(CONCEPT_RELATIONS)) {
      for (const target of rels[key] ?? []) {
        edges.push(makeEdge(rel, id, 'concept', conceptId(target)));
      }
    }
    return { id, name: c.name, description: c.description, aliases: c.aliases, tags: c.tags.map(coerceTag) };
  });

  // Question accumulator: questions arrive from the top-level `questions` block AND from any
  // source/snippet `raises`/`answers` — all keyed by text-derived id, so they converge to one
  // entity. ABOUT/REFINES edges are emitted once at the end from the accumulated set (§2.2).
  interface QAcc {
    text: string;
    description?: string;
    tags: TypedTag[];
    about: Set<string>;
    explicitAbout: boolean;
    refines: string[];
  }
  const questionAcc = new Map<string, QAcc>();
  const ensureQuestion = (text: string): string => {
    const qid = questionId({ text });
    if (!questionAcc.has(qid)) {
      questionAcc.set(qid, { text, tags: [], about: new Set(), explicitAbout: false, refines: [] });
    }
    return qid;
  };
  for (const q of s.questions) {
    const acc = questionAcc.get(ensureQuestion(q.text))!;
    acc.text = q.text; // the authored form wins as the display text
    if (q.description !== undefined) acc.description = q.description;
    if (q.tags.length > 0) acc.tags = q.tags.map(coerceTag);
    for (const name of q.about) {
      acc.about.add(conceptId(name));
      acc.explicitAbout = true;
    }
    acc.refines.push(...q.refines);
  }

  // Inline snippets desugar into snippet entities (collected here) plus their concept-anchor and
  // annotation edges. `annotated` records whether we emitted a learner ANNOTATES edge, so the
  // default learner can be seeded for referential integrity (like track creatorId).
  const inlineSnippets: Snippet[] = [];
  let annotated = false;

  // Snippet `links` resolve by text AFTER every source's snippets are known (a link may point
  // forward, or into another source); `snippetIndex` records where each passage lives.
  const snippetIndex: { id: string; text: string; sourceTitle: string }[] = [];
  const pendingLinks: { srcId: string; to: string; tag: string; source?: string; owner: string }[] = [];
  // readsAfter resolves by title AFTER all sources are known (references may point forward).
  const pendingOrder: { beforeTitle: string; afterId: string }[] = [];

  const sources = s.sources.map((src) => {
    const id = src.id ?? sourceId(src);
    const rels = src as unknown as Record<string, string[]>;
    for (const [key, rel] of Object.entries(SOURCE_RELATIONS)) {
      for (const target of rels[key] ?? []) {
        edges.push(makeEdge(rel, id, 'source', conceptId(target)));
      }
    }
    for (const text of src.raises) {
      edges.push({ srcType: 'source', srcId: id, type: 'RAISES', dstType: 'question', dstId: ensureQuestion(text), tags: [] });
    }
    for (const text of src.answers) {
      edges.push({ srcType: 'source', srcId: id, type: 'ANSWERS', dstType: 'question', dstId: ensureQuestion(text), tags: [] });
    }
    for (const beforeTitle of src.readsAfter) {
      pendingOrder.push({ beforeTitle, afterId: id });
    }

    for (const snip of src.snippets) {
      const snpId = snip.id ?? snippetId({ sourceId: id, text: snip.text });
      snippetIndex.push({ id: snpId, text: snip.text, sourceTitle: src.title });
      for (const l of snip.links) {
        pendingLinks.push({ srcId: snpId, to: l.to, tag: l.tag, source: l.source, owner: snip.text });
      }
      inlineSnippets.push({
        id: snpId,
        sourceId: id,
        text: snip.text,
        anchor: snip.anchor,
        tags: snip.tags.map(coerceTag),
      });
      const srels = snip as unknown as Record<string, string[]>;
      const anchorConcepts: string[] = [];
      for (const [key, rel] of Object.entries(SNIPPET_RELATIONS)) {
        for (const target of srels[key] ?? []) {
          const cid = conceptId(target);
          anchorConcepts.push(cid);
          edges.push(makeEdge(rel, snpId, 'snippet', cid));
        }
      }
      // A snippet-raised question with no explicit `about` inherits the passage's anchor (§2.2).
      for (const text of snip.raises) {
        const qid = ensureQuestion(text);
        edges.push({ srcType: 'snippet', srcId: snpId, type: 'RAISES', dstType: 'question', dstId: qid, tags: [] });
        const acc = questionAcc.get(qid)!;
        if (!acc.explicitAbout) for (const cid of anchorConcepts) acc.about.add(cid);
      }
      for (const text of snip.answers) {
        edges.push({ srcType: 'snippet', srcId: snpId, type: 'ANSWERS', dstType: 'question', dstId: ensureQuestion(text), tags: [] });
      }
      if (snip.note !== undefined || snip.sentiment !== undefined) {
        annotated = true;
        edges.push({
          srcType: 'learner', srcId: DEFAULT_CREATOR, type: 'ANNOTATES',
          dstType: 'snippet', dstId: snpId,
          metadata: {
            ...(snip.note !== undefined ? { note: snip.note } : {}),
            ...(snip.sentiment !== undefined ? { sentiment: snip.sentiment } : {}),
          },
          tags: [],
        });
      }
    }

    return {
      id,
      title: src.title,
      author: src.author,
      directUrl: src.directUrl,
      bibliographicUrl: src.bibliographicUrl,
      personalUrl: src.personalUrl,
      modality: src.modality,
      estimatedDurationMins: src.estimatedDurationMins,
      status: src.status ?? 'active',
      tags: src.tags.map(coerceTag),
    };
  });

  // Materialize the accumulated questions and emit their ABOUT/REFINES edges once (deduped).
  const questions: Question[] = [];
  for (const [qid, acc] of questionAcc) {
    questions.push({ id: qid, text: acc.text, description: acc.description, tags: acc.tags });
    for (const cid of acc.about) {
      edges.push({ srcType: 'question', srcId: qid, type: 'ABOUT', dstType: 'concept', dstId: cid, tags: [] });
    }
    for (const refText of acc.refines) {
      // v2: refinement is a framework-tagged LINK (#Refines); the acyclicity check moves to a
      // framework rule (model v2 §1 — accepted unchecked interim).
      edges.push({ srcType: 'question', srcId: qid, type: 'LINK', dstType: 'question', dstId: questionId({ text: refText }), tags: [{ name: 'Refines' }] });
    }
  }

  // Behavioral events write-both: derive each event's timeless fact edge (learner→target), so
  // the declarative `events` array drives the same overlays (following, answered, …) as the verb
  // methods. The edge's endpoint typing also validates the verb↔target-kind pairing (8a §2.2).
  // RETRACTED/RESTORED are event-only (DATA_MODEL.md §6): retraction is a temporal claim folded
  // latest-wins by the liveness projection — no timeless fact edge exists for it.
  // CONSUMED folds against UNCONSUMED (the first un-verb, 2026-07-18): the edge is derived only
  // when the FINAL consumption-direction event says read — otherwise an import would resurrect
  // an edge the un-verb deleted. Sequential fold, latest wins; same-ms ties fall to log order
  // (the log preserves append order, so the later action wins — a toggle within one tick).
  const readState = new Map<string, { verb: string; at: number }>();
  for (const ev of s.events) {
    if (ev.verb !== 'CONSUMED' && ev.verb !== 'UNCONSUMED') continue;
    const k = `${ev.learnerId}|${ev.targetId}`;
    const cur = readState.get(k);
    if (!cur || ev.occurredAt >= cur.at) readState.set(k, { verb: ev.verb, at: ev.occurredAt });
  }
  for (const ev of s.events) {
    if (EVENT_ONLY_VERBS.has(ev.verb)) continue;
    if (ev.verb === 'CONSUMED' && readState.get(`${ev.learnerId}|${ev.targetId}`)?.verb !== 'CONSUMED') continue;
    edges.push({ srcType: 'learner', srcId: ev.learnerId, type: ev.verb as EdgeType, dstType: ev.targetType, dstId: ev.targetId, tags: [] });
  }

  // Resolve a track's source reference (by title) to a source id: prefer a source
  // declared in this payload, else derive deterministically (parser flags a dangling ref).
  const sourceIdByTitle = new Map(sources.map((src) => [src.title, src.id]));
  const resolveSource = (ref: string): string => sourceIdByTitle.get(ref) ?? sourceId({ title: ref });

  // Source-level reading order (readsAfter sugar): global PRECEDES, no track context.
  for (const { beforeTitle, afterId } of pendingOrder) {
    edges.push({ srcType: 'source', srcId: resolveSource(beforeTitle), type: 'PRECEDES', dstType: 'source', dstId: afterId, tags: [] });
  }

  const tracks = s.tracks.map((sy) => {
    const id = sy.id ?? trackId(sy.title);

    for (const conceptName of sy.includes) {
      edges.push({ srcType: 'track', srcId: id, type: 'INCLUDES', dstType: 'concept', dstId: conceptId(conceptName), tags: [] });
    }
    // Sources referenced by includeSources OR order are members; dedup and emit INCLUDES.
    for (const ref of new Set([...sy.includeSources, ...sy.order])) {
      edges.push({ srcType: 'track', srcId: id, type: 'INCLUDES', dstType: 'source', dstId: resolveSource(ref), tags: [] });
    }
    // Consecutive pairs in `order` become PRECEDES edges scoped to this track.
    for (let i = 0; i + 1 < sy.order.length; i++) {
      edges.push({
        srcType: 'source', srcId: resolveSource(sy.order[i]!),
        type: 'PRECEDES',
        dstType: 'source', dstId: resolveSource(sy.order[i + 1]!),
        trackContextId: id, tags: [],
      });
    }

    return {
      id,
      creatorId: sy.creatorId ?? DEFAULT_CREATOR,
      title: sy.title,
      goal: sy.goal,
      framework: sy.framework,
      locked: sy.locked ?? false,
      validationState: sy.validationState ?? 'PENDING',
      tags: sy.tags.map(coerceTag),
      ...(sy.published !== undefined ? { published: sy.published } : {}), // null passes through — the clear sentinel
      ...(sy.origin ? { origin: sy.origin } : {}),
    };
  });

  // Resolve snippet links now that every passage is indexed. Authoring-time errors are loud:
  // a missing or ambiguous target is a typo in the payload, not something to guess about.
  for (const l of pendingLinks) {
    const candidates = snippetIndex.filter((e) => e.text === l.to && (l.source === undefined || e.sourceTitle === l.source));
    if (candidates.length === 0) {
      throw new Error(`snippet link target not found: "${l.to}"${l.source !== undefined ? ` in source "${l.source}"` : ''} (linked from "${l.owner}")`);
    }
    if (candidates.length > 1) {
      throw new Error(`snippet link target "${l.to}" is ambiguous across sources — add "source": <title> to the link (linked from "${l.owner}")`);
    }
    edges.push({
      srcType: 'snippet', srcId: l.srcId, type: 'LINK', dstType: 'snippet', dstId: candidates[0]!.id,
      tags: [coerceTag(l.tag)],
    });
  }

  // Seed the default learner when an inline annotation referenced it (so the ANNOTATES edge's
  // learner endpoint resolves) or a track defaulted its creatorId — the DB-level FK
  // (tracks.creator_id → learners.id) requires the row to exist, not just the id to parse.
  const needsDefault = annotated || tracks.some((sy) => sy.creatorId === DEFAULT_CREATOR);
  const learners =
    needsDefault && !s.learners.some((l) => l.id === DEFAULT_CREATOR)
      ? [...s.learners, { id: DEFAULT_CREATOR, displayName: 'default' }]
      : s.learners;

  // Re-parse through the canonical schema so downstream always receives a canonical shape.
  return CanonicalPayloadSchema.parse({
    version: 2,
    learners,
    tracks,
    concepts,
    sources,
    snippets: [...s.snippets, ...inlineSnippets],
    questions,
    events: s.events,
    edges,
  });
}
