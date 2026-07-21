/**
 * The command layer (ARCHITECTURE.md §7, ROADMAP §2.6) — application services that COMPOSE core
 * primitives into safe write payloads: id derivation, clobber policy, edge building, ref
 * resolution. Physically split from the facade so the tier boundary is a directory boundary:
 * this module never touches storage — every write goes through `ctx.importPayload`, the frozen
 * core's single gate (enforced by test/lockline.test.ts).
 *
 * Expected to evolve with capture/edit UX (lock-line kind 2); that evolution is not a core change.
 * Future primitives (`remove` = retraction, `update` = supersession — ROADMAP §2.3) land here.
 */
import { z } from 'zod';
import { conceptId, questionId, sourceId, snippetId, trackId } from '../schema/ids';
import {
  ModalitySchema,
  SourceStatusSchema,
  type CanonicalPayload,
  type EntityKind,
  type EventVerb,
} from '../schema/entities';
import {
  CaptureError,
  CaptureSnippetInput,
  CaptureSourceInput,
  CAPTURE_VERSION,
  coerceTags,
  DEFAULT_LEARNER,
  DEFAULT_LICENSE,
  EditRefInput,
  inferModality,
  parseCapture,
  PublishInput,
  UnpublishInput,
  UpdateInput,
  type CaptureSnippetResult,
  type CaptureSourceResult,
  type EditKind,
  type EditResult,
} from './capture';
import { isRetracted } from './read';

/**
 * The narrow surface a command needs from the facade. `importPayload` is the only write path;
 * `now` is the injected clock, sampled only here at the imperative boundary (principle #5).
 */
export interface CommandCtx {
  importPayload(input: unknown): unknown;
  exportAll(): CanonicalPayload;
  now(): number;
}

/** Optional per-call overrides for a behavioral verb (freshness 8a). */
export interface VerbOptions {
  learnerId?: string;
  /** Event time (epoch-ms). Omitted → the injected clock samples `now()` at this boundary. */
  occurredAt?: number;
}

/** Natural-reference resolvers: clients pass a title/name/text or a typed id; never derive ids. */
// A URL ref must derive the id capture derived (sourceId hashes the canonical URL when present;
// title-only slugs) — the same dispatch resolveEditRef uses, so `consume(<url>)` matches
// `captureSource({url})` instead of slugging the URL as a title.
export const resolveSourceRef = (ref: string): string =>
  ref.startsWith('src_') ? ref : /:\/\//.test(ref) ? sourceId({ title: ref, directUrl: ref }) : sourceId({ title: ref });
export const resolveConceptRef = (ref: string): string =>
  ref.startsWith('cpt_') ? ref : conceptId(ref);
export const resolveQuestionRef = (ref: string): string =>
  ref.startsWith('qst_') ? ref : questionId({ text: ref });

/**
 * Pure decision, effectful append: build the event as a value, then persist via one
 * `importPayload` transaction (desugar derives the fact edge — write-both, single derivation
 * point). The only impurity — sampling the clock — happens here.
 */
export function recordVerb(
  ctx: CommandCtx,
  verb: EventVerb,
  targetType: EntityKind,
  targetId: string,
  opts: VerbOptions = {},
): void {
  const learnerId = opts.learnerId ?? DEFAULT_LEARNER;
  const occurredAt = opts.occurredAt ?? ctx.now();
  // Seed the learner row only when it doesn't exist — the placeholder displayName must never
  // clobber a real one (a verb write used to rename an 'Ada' back to 'default').
  const exists = ctx.exportAll().learners.some((l) => l.id === learnerId);
  ctx.importPayload({
    version: 2,
    ...(exists ? {} : { learners: [{ id: learnerId, displayName: learnerId === DEFAULT_LEARNER ? 'default' : learnerId }] }),
    events: [{ learnerId, verb, targetType, targetId, occurredAt }],
  });
}

/**
 * Capture a source (the write API the browser/CLI/agents target — see `./capture`). Validates
 * the intent, derives the URL-based id (so re-capture is an idempotent no-op), folds any
 * write-time adapter output fill-still-empty-on-every-capture (re-capture = retry), upserts, and stages it.
 */
export function captureSource(ctx: CommandCtx, input: unknown): CaptureSourceResult {
  const req = parseCapture(CaptureSourceInput, input);
  const url = req.url?.trim();
  if (!url) throw new CaptureError('url is required');
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new CaptureError(`not a valid URL: ${url}`);
  }

  const resolved = req.resolved ?? {};
  const modality = req.modality ?? inferModality(url);
  // `sourceId` ignores `title` when a directUrl is present, so identity is unaffected by enrichment.
  const sid = sourceId({ title: req.title?.trim() || url, directUrl: url });
  const store = ctx.exportAll();
  const prior = store.sources.find((s) => s.id === sid);
  const existed = prior !== undefined;

  // Clobber policy (adapters §2.3, amended 2026-07-18): adapter output fills STILL-EMPTY
  // fields on EVERY capture, not only the first — the owner's first arXiv capture hit a 429
  // and first-capture-only made that gap permanent; re-capture is now the retry gesture
  // (same doctrine as revival: coming back means "I want this"). Existing values are never
  // overwritten: user input > stored value > fresh resolver > fallback. A title equal to the
  // URL is the fallback, not a value — it stays upgradeable.
  const priorTitle = prior && prior.title !== url ? prior.title : undefined;
  const title = req.title?.trim() || priorTitle || resolved.title?.trim() || url;
  const estimatedDurationMins = prior?.estimatedDurationMins ?? resolved.estimatedDurationMins;
  const author = req.author?.trim() || prior?.author || resolved.author?.trim();

  // Source-level questions (feedback round 2): create unseen questions and RAISES edges,
  // mirroring captureSnippet — the popup's page-level "ask" with nothing selected.
  const raises = [...new Set((req.raises ?? []).map((t) => t.trim()).filter(Boolean))];
  const knownQuestions = new Set(store.questions.map((q) => q.id));
  const newQuestions = raises
    .filter((textVal) => !knownQuestions.has(questionId({ text: textVal })))
    .map((textVal) => ({ text: textVal }));

  const payload: Record<string, unknown> = {
    version: 2,
    sources: [
      {
        title,
        ...(author ? { author } : {}),
        directUrl: url,
        modality,
        ...(estimatedDurationMins !== undefined ? { estimatedDurationMins } : {}),
        tags: coerceTags([...(req.tags ?? []), ...(resolved.tags ?? [])]),
      },
    ],
    ...(newQuestions.length ? { questions: newQuestions } : {}),
    ...(raises.length
      ? {
          edges: raises.map((t) => ({
            srcType: 'source', srcId: sid, type: 'RAISES', dstType: 'question', dstId: questionId({ text: t }),
          })),
        }
      : {}),
  };
  if (req.track) payload.tracks = [{ title: req.track, includeSources: [title] }];
  ctx.importPayload(payload);

  // Re-capture revives, explicitly (DATA_MODEL.md §6): capturing a URL whose source is removed
  // means "I want this back" — the log reads captured → retracted → restored.
  const learnerId = req.learnerId ?? DEFAULT_LEARNER;
  const revived = existed && isRetracted(store, sid);
  if (revived) appendEditEvents(ctx, learnerId, 'RESTORED', [{ targetType: 'source', targetId: sid }], ctx.now());

  const stage = req.stage ?? true;
  if (stage) recordVerb(ctx, 'STAGED', 'source', sid, { learnerId });
  return { version: CAPTURE_VERSION, sourceId: sid, created: !existed, staged: stage, revived, raised: raises.length };
}

/**
 * Capture a highlighted passage as a Snippet of its source, optionally anchored to concepts
 * (CLARIFIES/CONTRADICTS), posing questions (RAISES), and carrying the learner's note/sentiment
 * (ANNOTATES). Idempotent by source+normalized text. The source is referenced by id and only
 * declared when unseen, so a snippet capture never clobbers existing source metadata; concepts
 * and questions are created only when unseen, for the same reason.
 */
export function captureSnippet(ctx: CommandCtx, input: unknown): CaptureSnippetResult {
  const req = parseCapture(CaptureSnippetInput, input);
  const text = req.text?.trim();
  if (!text) throw new CaptureError('text is required');

  let sid: string;
  if (req.sourceId) sid = req.sourceId;
  else if (req.url?.trim()) {
    try {
      // eslint-disable-next-line no-new
      new URL(req.url.trim());
    } catch {
      throw new CaptureError(`not a valid URL: ${req.url}`);
    }
    // Title is irrelevant to a URL-derived id, so we needn't scrape it to resolve the source.
    sid = sourceId({ title: req.url.trim(), directUrl: req.url.trim() });
  } else throw new CaptureError('url or sourceId is required');

  const store = ctx.exportAll();
  const sourceExists = store.sources.some((s) => s.id === sid);
  if (!sourceExists && !req.url?.trim()) {
    throw new CaptureError(`unknown sourceId ${sid} — ingest the source first`);
  }

  const snpId = snippetId({ sourceId: sid, text });
  const created = !store.snippets.some((s) => s.id === snpId);
  const learnerId = req.learnerId ?? DEFAULT_LEARNER;

  const anchors: { name: string; type: 'CLARIFIES' | 'CONTRADICTS' }[] = [
    ...(req.clarifies ?? []).map((name) => ({ name, type: 'CLARIFIES' as const })),
    ...(req.contradicts ?? []).map((name) => ({ name, type: 'CONTRADICTS' as const })),
  ];
  const knownConcepts = new Set(store.concepts.map((c) => c.id));
  const newConcepts = [...new Set(anchors.map((a) => a.name))]
    .filter((name) => !knownConcepts.has(conceptId(name)))
    .map((name) => ({ name }));
  const edges: unknown[] = anchors.map((a) => ({
    srcType: 'snippet', srcId: snpId, type: a.type, dstType: 'concept', dstId: conceptId(a.name),
  }));

  // Questions the passage poses: declare each unseen Question, then link snippet RAISES question.
  const raises = [...new Set((req.raises ?? []).map((t) => t.trim()).filter(Boolean))];
  const knownQuestions = new Set(store.questions.map((q) => q.id));
  const newQuestions = raises
    .filter((textVal) => !knownQuestions.has(questionId({ text: textVal })))
    .map((textVal) => ({ text: textVal }));
  for (const textVal of raises) {
    edges.push({
      srcType: 'snippet', srcId: snpId, type: 'RAISES', dstType: 'question', dstId: questionId({ text: textVal }),
    });
  }

  const annotated = req.note !== undefined || req.sentiment !== undefined;
  if (annotated) {
    edges.push({
      srcType: 'learner', srcId: learnerId, type: 'ANNOTATES', dstType: 'snippet', dstId: snpId,
      metadata: {
        ...(req.note !== undefined ? { note: req.note } : {}),
        ...(req.sentiment !== undefined ? { sentiment: req.sentiment } : {}),
      },
    });
  }

  const payload: Record<string, unknown> = {
    version: 2,
    learners: [{ id: learnerId, displayName: learnerId === DEFAULT_LEARNER ? 'default' : learnerId }],
    ...(newConcepts.length ? { concepts: newConcepts } : {}),
    ...(newQuestions.length ? { questions: newQuestions } : {}),
    // Reference the source by id; declare it only if unseen (url path guaranteed above).
    ...(sourceExists ? {} : { sources: [{ title: req.url!.trim(), directUrl: req.url!.trim(), modality: inferModality(req.url!.trim()) }] }),
    // Top-level snippets are a canonical passthrough (no desugaring), so coerce tags ourselves.
    snippets: [{ id: snpId, sourceId: sid, text, ...(req.tags?.length ? { tags: coerceTags(req.tags) } : {}) }],
    edges,
  };
  ctx.importPayload(payload);

  // Re-capture revives, explicitly (DATA_MODEL.md §6): capturing a removed passage — or a passage
  // of a removed source — means "I want this back". Restore minimal ancestors so it is live.
  const revive: { targetType: EditKind; targetId: string }[] = [];
  if (sourceExists && isRetracted(store, sid)) revive.push({ targetType: 'source', targetId: sid });
  if (!created && isRetracted(store, snpId)) revive.push({ targetType: 'snippet', targetId: snpId });
  if (revive.length > 0) appendEditEvents(ctx, learnerId, 'RESTORED', revive, ctx.now());

  return {
    version: CAPTURE_VERSION, snippetId: snpId, sourceId: sid, created, annotated,
    raised: raises.length, revived: revive.length > 0,
  };
}

// ── Edit primitives (DATA_MODEL.md §6): remove = retraction, restore, update = supersession ──
// Generic by construction: one primitive per operation, dispatched on the ref's id prefix — the
// command surface does not grow per entity kind (ARCHITECTURE.md §7).

const KIND_BY_PREFIX: Record<string, EditKind> = {
  syl_: 'track', cpt_: 'concept', src_: 'source', snp_: 'snippet', qst_: 'question',
};

const entitiesOf = (store: CanonicalPayload, kind: EditKind): ReadonlyArray<{ id: string }> =>
  ({ track: store.tracks, concept: store.concepts, source: store.sources, snippet: store.snippets, question: store.questions })[kind];

const existsIn = (store: CanonicalPayload, kind: EditKind, id: string): boolean =>
  entitiesOf(store, kind).some((e) => e.id === id);

/**
 * Resolve an edit ref to a known entity: a typed id dispatches on its prefix; a URL resolves to
 * its source; any other text is tried as a source title / concept name / question text /
 * track title against the store — exactly one hit resolves, several is an ambiguity error
 * (the typed id is the escape), none is unknown. Snippets have no natural ref (their text only
 * means something under a source) — use the id from the read views.
 */
function resolveEditRef(store: CanonicalPayload, ref: string): { kind: EditKind; id: string } {
  const byPrefix = KIND_BY_PREFIX[ref.slice(0, 4)];
  if (byPrefix) {
    if (!existsIn(store, byPrefix, ref)) throw new CaptureError(`unknown ${byPrefix} "${ref}"`);
    return { kind: byPrefix, id: ref };
  }
  if (/:\/\//.test(ref)) {
    const id = sourceId({ title: ref, directUrl: ref });
    if (!existsIn(store, 'source', id)) throw new CaptureError(`no source captured from "${ref}"`);
    return { kind: 'source', id };
  }
  const candidates: { kind: EditKind; id: string }[] = [
    { kind: 'source', id: sourceId({ title: ref }) },
    { kind: 'concept', id: conceptId(ref) },
    { kind: 'question', id: questionId({ text: ref }) },
    { kind: 'track', id: trackId(ref) },
  ];
  const hits = candidates.filter((c) => existsIn(store, c.kind, c.id));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new CaptureError(
      `ambiguous reference "${ref}" (${hits.map((h) => h.id).join(', ')}) — use the typed id`,
    );
  }
  throw new CaptureError(`unknown reference "${ref}"`);
}

/** Append editorial (event-only) observations in one transaction. */
function appendEditEvents(
  ctx: CommandCtx,
  learnerId: string,
  verb: 'RETRACTED' | 'RESTORED',
  targets: readonly { targetType: EditKind; targetId: string }[],
  occurredAt: number,
): void {
  // Same rule as recordVerb: seed the learner only if missing — never clobber a displayName.
  const exists = ctx.exportAll().learners.some((l) => l.id === learnerId);
  ctx.importPayload({
    version: 2,
    ...(exists ? {} : { learners: [{ id: learnerId, displayName: learnerId === DEFAULT_LEARNER ? 'default' : learnerId }] }),
    events: targets.map((t) => ({ targetType: t.targetType, targetId: t.targetId, learnerId, verb, occurredAt })),
  });
}

/** Remove = append a RETRACTED observation; views fold it away. Idempotent: removing an
 *  already-removed entity is a no-op (`changed: false`). The UI may still say "delete". */
export function remove(ctx: CommandCtx, input: unknown): EditResult {
  const req = parseCapture(EditRefInput, input);
  const store = ctx.exportAll();
  const { kind, id } = resolveEditRef(store, req.ref);
  if (isRetracted(store, id)) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
  appendEditEvents(ctx, req.learnerId ?? DEFAULT_LEARNER, 'RETRACTED', [{ targetType: kind, targetId: id }], req.occurredAt ?? ctx.now());
  return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
}

/** Restore = the counter-observation. Minimal-ancestors (DATA_MODEL.md §6): restoring a snippet
 *  whose source is removed restores the source too — a snippet cannot float without its source.
 *  Restoring a live entity is a no-op. */
export function restore(ctx: CommandCtx, input: unknown): EditResult {
  const req = parseCapture(EditRefInput, input);
  const store = ctx.exportAll();
  const { kind, id } = resolveEditRef(store, req.ref);
  const targets: { targetType: EditKind; targetId: string }[] = [];
  if (kind === 'snippet') {
    const owner = store.snippets.find((s) => s.id === id)!.sourceId;
    if (isRetracted(store, owner)) targets.push({ targetType: 'source', targetId: owner });
  }
  if (isRetracted(store, id)) targets.push({ targetType: kind, targetId: id });
  if (targets.length === 0) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
  appendEditEvents(ctx, req.learnerId ?? DEFAULT_LEARNER, 'RESTORED', targets, req.occurredAt ?? ctx.now());
  return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
}

// What update() may touch, per kind (DATA_MODEL.md §6). Identity-participating fields are named
// with their reason; everything else absent from the editable schema is simply not a field of
// the kind. `tags` REPLACES the list (RMW semantics, documented).
const IDENTITY_FIELDS: Record<EditKind, ReadonlyArray<string>> = {
  // `author` left the source id in model v2 — a pure attribute, editable like any other.
  source: ['url', 'directUrl'],
  // `text` hashes into the snippet id, but update() handles it as EDIT-BY-SUPERSESSION (the
  // track-rename pattern): mint under the new id, migrate edges, retract the old.
  snippet: ['sourceId', 'url'],
  question: ['text'],
  concept: ['name'],
  // `title` slugs the track id, but update() handles it as RENAME-BY-SUPERSESSION (mint the
  // new id, re-assert edges, retract the old) — identity stays content-derived, nothing mutates.
  track: [],
};

const tagsField = z.array(z.unknown()).optional();
const EDITABLE: Record<EditKind, z.ZodType<Record<string, unknown>>> = {
  source: z.object({
    title: z.string().min(1).optional(), // identity only for URL-less sources; guarded in update()
    author: z.string().optional(),
    bibliographicUrl: z.string().url().optional(),
    personalUrl: z.string().optional(),
    modality: ModalitySchema.optional(),
    estimatedDurationMins: z.number().int().optional(),
    status: SourceStatusSchema.optional(),
    tags: tagsField,
  }).strict(),
  snippet: z.object({
    text: z.string().min(1).optional(), // edit-by-supersession; handled in update()
    note: z.string().optional(),
    sentiment: z.string().optional(),
    anchor: z.string().optional(),
    tags: tagsField,
  }).strict(),
  concept: z.object({
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: tagsField,
  }).strict(),
  question: z.object({ description: z.string().optional(), tags: tagsField }).strict(),
  track: z.object({
    title: z.string().min(1).optional(), // rename-by-supersession; handled in update()
    goal: z.string().optional(),
    framework: z.string().optional(),
    locked: z.boolean().optional(),
    tags: tagsField,
  }).strict(),
};

/**
 * Update = honest MVP supersession (DATA_MODEL.md §6): read–modify–write done ONCE, in the engine
 * — only provided fields change; the merged entity re-enters through the normal validate→upsert
 * gate, so unpatched fields survive the full-replace upsert (the anti-clobber guarantee).
 * True per-field supersession arrives with the assertion layer (ROADMAP §2.1).
 */
// ── The publish act (publish plan P2; DATA_GOVERNANCE §2) ──────────────────────────────────────

/** Resolve a ref that must be a live track, or say why not. */
function resolveTrack(store: CanonicalPayload, ref: string): { id: string; cur: CanonicalPayload['tracks'][number] } {
  const { kind, id } = resolveEditRef(store, ref);
  if (kind !== 'track') throw new CaptureError(`${ref} is a ${kind} — only tracks (tracks) can be published`);
  if (isRetracted(store, id)) throw new CaptureError(`${id} is removed — restore it before publishing`);
  return { id, cur: store.tracks.find((s) => s.id === id)! };
}

/** Stamp the track published ({at, license}). Idempotent: already published = no-op (the
 *  original stamp stands — changing the license is unpublish + publish, both deliberate). */
export function publishTrack(ctx: CommandCtx, input: unknown): EditResult {
  const req = parseCapture(PublishInput, input);
  const { id, cur } = resolveTrack(ctx.exportAll(), req.ref);
  if (cur.published) return { version: CAPTURE_VERSION, kind: 'track', targetId: id, changed: false };
  ctx.importPayload({
    version: 2,
    tracks: [{ ...cur, published: { at: ctx.now(), license: req.license ?? DEFAULT_LICENSE } }],
  });
  return { version: CAPTURE_VERSION, kind: 'track', targetId: id, changed: true };
}

/** Clear the stamp: distribution stops (routes 404, future aggregates exclude it). The
 *  command's surface must stay honest that copies made while public persist (governance §2). */
export function unpublishTrack(ctx: CommandCtx, input: unknown): EditResult {
  const req = parseCapture(UnpublishInput, input);
  const { id, cur } = resolveTrack(ctx.exportAll(), req.ref);
  if (!cur.published) return { version: CAPTURE_VERSION, kind: 'track', targetId: id, changed: false };
  const { published: _published, ...rest } = cur;
  ctx.importPayload({ version: 2, tracks: [{ ...rest, published: null }] });
  return { version: CAPTURE_VERSION, kind: 'track', targetId: id, changed: true };
}

export function update(ctx: CommandCtx, input: unknown): EditResult {
  const req = parseCapture(UpdateInput, input);
  const store = ctx.exportAll();
  const { kind, id } = resolveEditRef(store, req.ref);

  const offending = Object.keys(req.patch).filter((k) => IDENTITY_FIELDS[kind].includes(k));
  if (offending.length > 0) {
    throw new CaptureError(
      `${offending.join(', ')}: identity field${offending.length > 1 ? 's' : ''} of a ${kind} — ` +
        'becomes editable with the Phase-2 identity work; remove + re-capture instead',
    );
  }
  const fields = parseCapture(EDITABLE[kind], req.patch);

  if (isRetracted(store, id)) throw new CaptureError(`${id} is removed — restore it before editing`);
  if (kind === 'snippet' && isRetracted(store, store.snippets.find((s) => s.id === id)!.sourceId)) {
    throw new CaptureError(`${id}'s source is removed — restore it before editing`);
  }

  const learnerId = req.learnerId ?? DEFAULT_LEARNER;
  const tags = fields.tags !== undefined ? coerceTags(fields.tags as unknown[]) : undefined;
  const changedFrom = (cur: unknown, next: unknown): boolean => JSON.stringify(next) !== JSON.stringify(cur);

  switch (kind) {
    case 'source': {
      const cur = store.sources.find((s) => s.id === id)!;
      if ('title' in fields && !cur.directUrl) {
        throw new CaptureError('title derives this source\'s id (it has no URL) — an identity field; remove + re-capture instead');
      }
      const next = { ...cur, ...fields, ...(tags ? { tags } : {}) };
      if (!changedFrom(cur, next)) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
      ctx.importPayload({ version: 2, sources: [next] });
      return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
    }
    case 'concept': {
      const cur = store.concepts.find((c) => c.id === id)!;
      const next = { ...cur, ...fields, ...(tags ? { tags } : {}) };
      if (!changedFrom(cur, next)) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
      ctx.importPayload({ version: 2, concepts: [next] });
      return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
    }
    case 'question': {
      const cur = store.questions.find((q) => q.id === id)!;
      const next = { ...cur, ...fields, ...(tags ? { tags } : {}) };
      if (!changedFrom(cur, next)) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
      ctx.importPayload({
        version: 2,
        questions: [{ text: next.text, ...(next.description !== undefined ? { description: next.description } : {}), tags: next.tags }],
      });
      return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
    }
    case 'track': {
      const cur = store.tracks.find((s) => s.id === id)!;
      const next = { ...cur, ...fields, ...(tags ? { tags } : {}) };
      if (!changedFrom(cur, next)) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };

      // Rename-by-supersession: the title slugs the id, so a title change cannot mutate in
      // place. Instead mint the track under its NEW id (all other fields carried), re-assert
      // every edge that references the old id (endpoints and PRECEDES contexts), and retract the
      // old entity — restorable like any removal, and identity stays content-derived throughout.
      const newTitle = typeof fields.title === 'string' ? fields.title.trim() : undefined;
      // A retitle that slugs to the SAME id (case/spacing only) is an in-place update below,
      // not a supersession — the collision check would refuse the track against itself.
      if (newTitle !== undefined && newTitle !== cur.title && trackId(newTitle) !== id) {
        const newId = trackId(newTitle);
        const priorAtNewId = store.tracks.find((s) => s.id === newId);
        if (priorAtNewId && !isRetracted(store, newId)) {
          throw new CaptureError(`a track titled “${newTitle}” already exists — merging two tracks is a Phase-2 dedup action`);
        }
        const movedEdges = store.edges
          .filter((e) => e.srcId === id || e.dstId === id || e.trackContextId === id)
          .map((e) => ({
            ...e,
            srcId: e.srcId === id ? newId : e.srcId,
            dstId: e.dstId === id ? newId : e.dstId,
            ...(e.trackContextId === id ? { trackContextId: newId } : {}),
          }));
        ctx.importPayload({ version: 2, tracks: [{ ...next, id: newId, title: newTitle }], edges: movedEdges });
        appendEditEvents(ctx, learnerId, 'RETRACTED', [{ targetType: 'track', targetId: id }], ctx.now());
        // Round-trip revive — renaming BACK to an earlier title must un-retract that id (the
        // same latent vanish the snippet editor surfaced; liveness is the event fold).
        if (priorAtNewId && isRetracted(store, newId)) {
          appendEditEvents(ctx, learnerId, 'RESTORED', [{ targetType: 'track', targetId: newId }], ctx.now());
        }
        return { version: CAPTURE_VERSION, kind, targetId: newId, changed: true };
      }

      ctx.importPayload({ version: 2, tracks: [next] });
      return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
    }
    case 'snippet': {
      const cur = store.snippets.find((s) => s.id === id)!;
      const { note, sentiment, text: _text, ...entityFields } = fields;
      const nextEntity = { ...cur, ...entityFields, ...(tags ? { tags } : {}) };
      // note/sentiment live on the learner's ANNOTATES edge — merge into its current metadata
      // (already edge-carried, no new mechanism; DATA_MODEL.md §6).
      const curEdge = store.edges.find((e) => e.type === 'ANNOTATES' && e.srcId === learnerId && e.dstId === id);
      const curMeta = (curEdge?.metadata ?? {}) as Record<string, unknown>;
      const nextMeta = {
        ...curMeta,
        ...('note' in fields ? { note } : {}),
        ...('sentiment' in fields ? { sentiment } : {}),
      };
      const metaChanged = ('note' in fields || 'sentiment' in fields) && changedFrom(curMeta, nextMeta);
      // Edit-by-supersession (owner ruling, 2026-07-18 — the raw-source toggle made text edits
      // an obvious gesture): text hashes into the id, so a text change mints the snippet under
      // its NEW id, migrates every edge (anchors, question ties, argument links, and the
      // ANNOTATES row — updated in the same act when the patch also carries note/sentiment),
      // and retracts the old — restorable like any removal.
      const newText = typeof fields.text === 'string' ? fields.text.trim() : undefined;
      const textChanged = newText !== undefined && newText !== cur.text;
      // The id normalizes whitespace and case, so a formatting-only edit hashes to the SAME
      // id — that is an in-place update (below), not a supersession: the collision check
      // would refuse the snippet against itself (owner hit this post-reset, 2026-07-18).
      const newId = textChanged ? snippetId({ sourceId: cur.sourceId, text: newText }) : id;
      if (textChanged && newId !== id) {
        const priorAtNewId = store.snippets.find((s) => s.id === newId);
        if (priorAtNewId && !isRetracted(store, newId)) {
          throw new CaptureError('an identical snippet already exists on this source — merging is a Phase-2 dedup action');
        }
        const movedEdges = store.edges
          .filter((e) => e.srcId === id || e.dstId === id)
          .map((e) => ({
            ...e,
            srcId: e.srcId === id ? newId : e.srcId,
            dstId: e.dstId === id ? newId : e.dstId,
            ...(e.type === 'ANNOTATES' && e.srcId === learnerId && metaChanged ? { metadata: nextMeta } : {}),
          }));
        ctx.importPayload({ version: 2, snippets: [{ ...nextEntity, id: newId, text: newText }], edges: movedEdges });
        appendEditEvents(ctx, learnerId, 'RETRACTED', [{ targetType: 'snippet', targetId: id }], ctx.now());
        // Round-trip revive (owner bug, 2026-07-18): editing BACK to earlier text lands on a
        // RETRACTED id — re-importing the row doesn't un-retract it (liveness is the event
        // fold), so without an explicit RESTORED both versions end up folded away and the
        // snippet vanishes. Same doctrine as re-capture: coming back means "I want this live".
        if (priorAtNewId && isRetracted(store, newId)) {
          appendEditEvents(ctx, learnerId, 'RESTORED', [{ targetType: 'snippet', targetId: newId }], ctx.now());
        }
        return { version: CAPTURE_VERSION, kind, targetId: newId, changed: true };
      }

      const inPlaceEntity = textChanged ? { ...nextEntity, text: newText } : nextEntity;
      const entityChanged = changedFrom(cur, inPlaceEntity);
      const metaChanged2 = ('note' in fields || 'sentiment' in fields) && changedFrom(curMeta, nextMeta);
      if (!entityChanged && !metaChanged2) return { version: CAPTURE_VERSION, kind, targetId: id, changed: false };
      ctx.importPayload({
        version: 2,
        learners: [{ id: learnerId, displayName: learnerId === DEFAULT_LEARNER ? 'default' : learnerId }],
        snippets: [inPlaceEntity],
        ...(metaChanged2
          ? { edges: [{ srcType: 'learner', srcId: learnerId, type: 'ANNOTATES', dstType: 'snippet', dstId: id, metadata: nextMeta }] }
          : {}),
      });
      return { version: CAPTURE_VERSION, kind, targetId: id, changed: true };
    }
  }
}
