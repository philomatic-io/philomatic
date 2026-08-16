/**
 * THE edge-gesture library (maintainability doctrine: derive in lib/, mutate through one hook,
 * render in views — and centralize writes first). Every tie that can be authored from a detail
 * rail writes through ONE function here, no matter which end's rail initiates it — so the
 * concept page's "add a source" and the source page's "add a concept" cannot drift, and a
 * change to a gesture propagates to every surface it shows on. Each gesture performs its
 * writes and returns the typed inverse for `useAction`; create-if-unseen resolution composes
 * the shared resolvers, and undo un-mints only what the gesture created.
 */
import type { EngineClient } from '../client/transport';
import { resolveOrCreateConcept, type ConceptRef } from './concepts';

export interface Gesture {
  label: string;
  invert: () => Promise<void>;
}

// ── track ⟵INCLUDES⟶ concept ─────────────────────────────────────────────────────────────

/** Standing on the TRACK: include concepts by name (create-if-unseen). */
export async function includeConceptsInTrack(
  client: EngineClient,
  trackId: string,
  names: string[],
  known: readonly ConceptRef[],
): Promise<Gesture & { made: { id: string; name: string; created: boolean }[] }> {
  const made: { id: string; name: string; created: boolean }[] = [];
  for (const name of names) {
    const c = await resolveOrCreateConcept(client, known, name.trim());
    await client.link({ srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'concept', dstId: c.id });
    made.push(c);
  }
  return {
    label: `include ${made.length === 1 ? `“${made[0]!.name.slice(0, 30)}”` : `${made.length} concepts`}`,
    invert: async () => {
      for (const c of made) {
        await client.unlink({ srcId: trackId, type: 'INCLUDES', dstId: c.id });
        if (c.created) await client.remove(c.id);
      }
    },
    made,
  };
}

/** Standing on the CONCEPT: the same edge, tracks picked by id. */
/** Standing on the TRACK: un-include a concept. Also cuts its PREREQUISITE_OF ties to the
 *  track's OTHER included concepts — the positioning edges that would otherwise keep it in
 *  the family as a child of its anchor. Lived as two hand-rolled copies in TrackBody and
 *  Journey; one implementation, one inverse. */
export async function unIncludeConceptFromTrack(
  client: EngineClient,
  trackId: string,
  concept: { id: string; name: string },
  siblingIds: Iterable<string>,
): Promise<Gesture> {
  const siblings = new Set([...siblingIds].filter((id) => id !== concept.id));
  const rels = await client.getRelations(concept.id);
  const ties = rels.relations
    .filter((r) => r.type === 'PREREQUISITE_OF' && siblings.has(r.otherId))
    .map((r) => (r.direction === 'in' ? { srcId: r.otherId, dstId: concept.id } : { srcId: concept.id, dstId: r.otherId }));
  await client.unlink({ srcId: trackId, type: 'INCLUDES', dstId: concept.id });
  for (const t of ties) await client.unlink({ srcId: t.srcId, type: 'PREREQUISITE_OF', dstId: t.dstId });
  return {
    label: `un-include “${concept.name.slice(0, 30)}”`,
    invert: async () => {
      await client.link({ srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'concept', dstId: concept.id });
      for (const t of ties) await client.link({ srcType: 'concept', srcId: t.srcId, type: 'PREREQUISITE_OF', dstType: 'concept', dstId: t.dstId });
    },
  };
}

export async function includeConceptInTracks(client: EngineClient, conceptId: string, trackIds: string[]): Promise<Gesture> {
  for (const tid of trackIds) {
    await client.link({ srcType: 'track', srcId: tid, type: 'INCLUDES', dstType: 'concept', dstId: conceptId });
  }
  return {
    label: `add to ${trackIds.length === 1 ? 'a track' : `${trackIds.length} tracks`}`,
    invert: async () => {
      for (const tid of trackIds) await client.unlink({ srcId: tid, type: 'INCLUDES', dstId: conceptId });
    },
  };
}

// ── content (source|snippet) ⟶ concept anchors ───────────────────────────────────────────

/** THE anchor edge: a source anchors via ABOUT + a flavor tag; a snippet via the polarity
 *  primitives (CLARIFIES/CONTRADICTS as the type itself). */
export function anchorEdge(content: { kind: 'source' | 'snippet'; id: string }, conceptId: string, flavor: string) {
  return content.kind === 'source'
    ? { srcType: 'source', srcId: content.id, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: flavor }] }
    : { srcType: 'snippet', srcId: content.id, type: flavor, dstType: 'concept', dstId: conceptId, tags: [] as { name: string }[] };
}

/** Standing on the CONTENT: anchor to concepts by name (create-if-unseen). */
export async function anchorConcepts(
  client: EngineClient,
  content: { kind: 'source' | 'snippet'; id: string },
  names: string[],
  flavor: string,
  known: readonly ConceptRef[],
): Promise<Gesture> {
  const made: { id: string; created: boolean; edge: ReturnType<typeof anchorEdge> }[] = [];
  for (const nm of names) {
    const concept = await resolveOrCreateConcept(client, known, nm.trim());
    const edge = anchorEdge(content, concept.id, flavor);
    await client.link(edge);
    made.push({ id: concept.id, created: concept.created, edge });
  }
  return {
    label: `link ${made.length === 1 ? 'a concept' : `${made.length} concepts`}`,
    invert: async () => {
      for (const m of made) {
        await client.unlink({ srcId: m.edge.srcId, type: m.edge.type, dstId: m.edge.dstId });
        if (m.created) await client.remove(m.id);
      }
    },
  };
}

/** Standing on the CONCEPT: the same edge, content picked by id. */
export async function anchorContents(
  client: EngineClient,
  contents: { kind: 'source' | 'snippet'; id: string }[],
  conceptId: string,
  flavor: string,
): Promise<Gesture> {
  const edges = contents.map((c) => anchorEdge(c, conceptId, flavor));
  for (const e of edges) await client.link(e);
  return {
    label: `anchor ${edges.length === 1 ? 'one' : edges.length}`,
    invert: async () => {
      for (const e of edges) await client.unlink({ srcId: e.srcId, type: e.type, dstId: e.dstId });
    },
  };
}

// ── content (source|snippet) ⟶RAISES|ANSWERS⟶ question ──────────────────────────────────

/** THE provenance edge. */
export function provenanceEdge(content: { kind: 'source' | 'snippet'; id: string }, verb: 'RAISES' | 'ANSWERS', questionId: string) {
  return { srcType: content.kind, srcId: content.id, type: verb, dstType: 'question', dstId: questionId, tags: [] as { name: string }[] };
}

/** Tie existing questions — from either end's rail. */
export async function tieQuestions(
  client: EngineClient,
  content: { kind: 'source' | 'snippet'; id: string },
  verb: 'RAISES' | 'ANSWERS',
  questionIds: string[],
): Promise<Gesture> {
  const edges = questionIds.map((qid) => provenanceEdge(content, verb, qid));
  for (const e of edges) await client.link(e);
  return {
    label: `tie ${verb.toLowerCase()} → ${edges.length === 1 ? 'a question' : `${edges.length} questions`}`,
    invert: async () => {
      for (const e of edges) await client.unlink({ srcId: e.srcId, type: e.type, dstId: e.dstId });
    },
  };
}

/** Author-if-unseen by text, then tie (ask-from-here). */
export async function tieQuestionByText(
  client: EngineClient,
  content: { kind: 'source' | 'snippet'; id: string },
  verb: 'RAISES' | 'ANSWERS',
  text: string,
  questions: readonly { id: string; text: string }[],
): Promise<Gesture> {
  const value = text.trim();
  let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
  let created = false;
  if (q === undefined) {
    await client.importPayload({ version: 2, questions: [{ text: value }] });
    q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
    created = true;
  }
  if (q === undefined) throw new Error('could not resolve the question');
  const edge = provenanceEdge(content, verb, q.id);
  await client.link(edge);
  const qId = q.id;
  return {
    label: `tie ${verb.toLowerCase()} → question`,
    invert: async () => {
      await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId });
      if (created) await client.remove(qId);
    },
  };
}

// ── question ⟶ABOUT⟶ concept ─────────────────────────────────────────────────────────────

/** The question anchor, concepts by name (create-if-unseen). */
export async function questionAboutConcepts(
  client: EngineClient,
  questionId: string,
  names: string[],
  known: readonly ConceptRef[],
): Promise<Gesture> {
  const made: { id: string; created: boolean }[] = [];
  for (const nm of names) {
    const other = await resolveOrCreateConcept(client, known, nm.trim());
    await client.link({ srcType: 'question', srcId: questionId, type: 'ABOUT', dstType: 'concept', dstId: other.id, tags: [] });
    made.push(other);
  }
  return {
    label: `about ${made.length === 1 ? 'a concept' : `${made.length} concepts`}`,
    invert: async () => {
      for (const m of made) {
        await client.unlink({ srcId: questionId, type: 'ABOUT', dstId: m.id });
        if (m.created) await client.remove(m.id);
      }
    },
  };
}

/** Create a NEW track by title and include the target in it — the track pickers' "＋ create".
 *  Undo unlinks and removes the track this gesture minted. */
export async function includeInNewTrack(
  client: EngineClient,
  title: string,
  target: { kind: 'concept' | 'source'; id: string },
): Promise<Gesture> {
  const t = title.trim();
  await client.importPayload({ version: 2, tracks: [{ title: t }] });
  const trackId = (await client.getSnapshot()).tracks.find((x) => x.title === t)?.id;
  if (trackId === undefined) throw new Error('created the track but could not resolve its id');
  await client.link({ srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: target.kind, dstId: target.id });
  return {
    label: `create track “${t.slice(0, 30)}”`,
    invert: async () => {
      await client.unlink({ srcId: trackId, type: 'INCLUDES', dstId: target.id });
      await client.remove(trackId);
    },
  };
}

// ── source ⟵SNIPPET_OF⟶ snippet (creation — a snippet's one source is its identity) ────────

/** Capture a NEW snippet on a source — the Snippets adder on the source rail and Journey's
 *  snippet column write THIS. Undo removes the snippet (retraction; restorable). */
export async function captureSnippetOnSource(client: EngineClient, sourceId: string, text: string): Promise<Gesture> {
  const r = (await client.captureSnippet({ sourceId, text: text.trim() })) as { snippetId?: string };
  const sid = r.snippetId;
  return {
    label: 'capture snippet',
    invert: async () => {
      if (sid !== undefined) await client.remove(sid);
    },
  };
}

/** Standing on the CONCEPT: tie existing questions ABOUT it (the question anchor, other end). */
export async function tieQuestionsToConcept(client: EngineClient, conceptId: string, questionIds: string[]): Promise<Gesture> {
  for (const qid of questionIds) {
    await client.link({ srcType: 'question', srcId: qid, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [] });
  }
  return {
    label: `about ${questionIds.length === 1 ? 'a question' : `${questionIds.length} questions`}`,
    invert: async () => {
      for (const qid of questionIds) await client.unlink({ srcId: qid, type: 'ABOUT', dstId: conceptId });
    },
  };
}

/** Standing on the CONCEPT: author-if-unseen a question by text and tie it ABOUT the concept. */
export async function questionAboutConceptByText(
  client: EngineClient,
  conceptId: string,
  text: string,
  questions: readonly { id: string; text: string }[],
): Promise<Gesture> {
  const value = text.trim();
  let q = questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
  let created = false;
  if (q === undefined) {
    await client.importPayload({ version: 2, questions: [{ text: value }] });
    q = (await client.getQuestions()).questions.find((x) => x.text.toLowerCase() === value.toLowerCase());
    created = true;
  }
  if (q === undefined) throw new Error('could not resolve the question');
  const qId = q.id;
  await client.link({ srcType: 'question', srcId: qId, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [] });
  return {
    label: 'about a question',
    invert: async () => {
      await client.unlink({ srcId: qId, type: 'ABOUT', dstId: conceptId });
      if (created) await client.remove(qId);
    },
  };
}

