/**
 * The Schema Parser. Two decoupled tiers:
 *   Tier 1 (structural): edge endpoint typing + referential integrity.
 *   Tier 2 (graph logic): PREREQUISITE_OF cycle detection over the combined payload+store.
 *
 * Zod already guarantees entity/edge *shape* upstream (in desugar); this layer adds the
 * checks Zod cannot express. `existing` lets the parser reason about a payload in the
 * context of what is already persisted (so refs and cycles can span both).
 */
import { EVENT_ONLY_VERBS, RETRACTABLE_KINDS, type CanonicalPatchPayload } from '../schema/entities';
import { describeEndpoints, isLegalEndpoint } from '../schema/edges';
import { findCycle, type DirectedEdge } from '../graph/cycles';
import type { Issue, ValidationReport } from './report';

/** A PRECEDES edge tagged with the track it is scoped to. */
interface ScopedEdge extends DirectedEdge {
  context: string;
}

export interface ExistingGraph {
  /** Ids already persisted (all kinds), for referential-integrity checks. */
  nodeIds: Set<string>;
  /** PREREQUISITE_OF edges already persisted, for cross-payload cycle detection. */
  prereqEdges: DirectedEdge[];
  /** PRECEDES edges already persisted, with their track context. */
  precedesEdges: ScopedEdge[];
  /** INCLUDES memberships already persisted, for the external-prerequisite check. */
  includes: { trackId: string; memberId: string }[];
}

const EMPTY: ExistingGraph = { nodeIds: new Set(), prereqEdges: [], precedesEdges: [], includes: [] };

// The param is the PATCH shape (a full payload is structurally a valid patch): this layer only
// reads ids, edges and events, so absence-preserving entities pass through untouched.
export function validate(payload: CanonicalPatchPayload, existing: ExistingGraph = EMPTY): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const payloadIds = new Set<string>([
    ...payload.learners.map((l) => l.id),
    ...payload.tracks.map((s) => s.id),
    ...payload.concepts.map((c) => c.id),
    ...payload.sources.map((s) => s.id),
    ...payload.snippets.map((s) => s.id),
    ...payload.questions.map((q) => q.id),
  ]);
  const known = (id: string) => payloadIds.has(id) || existing.nodeIds.has(id);

  // Tier 1 — endpoint typing + referential integrity.
  payload.edges.forEach((e, i) => {
    if (!isLegalEndpoint(e.srcType, e.type, e.dstType)) {
      errors.push({
        code: 'illegal_endpoint',
        message: `Edge ${e.type} cannot connect ${e.srcType} → ${e.dstType}. Legal: ${describeEndpoints(e.type)}.`,
        pointer: `edges[${i}]`,
      });
    }
    if (!known(e.srcId)) {
      errors.push({ code: 'dangling_reference', message: `Edge source "${e.srcId}" does not exist.`, pointer: `edges[${i}].srcId` });
    }
    if (!known(e.dstId)) {
      errors.push({ code: 'dangling_reference', message: `Edge target "${e.dstId}" does not exist.`, pointer: `edges[${i}].dstId` });
    }
  });

  // A snippet is a passage OF a source; its sourceId must resolve.
  payload.snippets.forEach((snip, i) => {
    if (!known(snip.sourceId)) {
      errors.push({
        code: 'dangling_reference',
        message: `Snippet "${snip.id}" references source "${snip.sourceId}" which does not exist.`,
        pointer: `snippets[${i}].sourceId`,
      });
    }
  });

  // An event references an existing learner and target. The verb↔target-kind legality is
  // checked where the fact edge is derived; this pass guards the references. Event-only
  // verbs (RETRACTED/RESTORED) derive no edge, so their target-kind legality is checked here:
  // retraction targets content, never tenants.
  payload.events.forEach((ev, i) => {
    if (!known(ev.learnerId)) {
      errors.push({ code: 'dangling_reference', message: `Event learner "${ev.learnerId}" does not exist.`, pointer: `events[${i}].learnerId` });
    }
    if (!known(ev.targetId)) {
      errors.push({ code: 'dangling_reference', message: `Event target "${ev.targetId}" does not exist.`, pointer: `events[${i}].targetId` });
    }
    if (EVENT_ONLY_VERBS.has(ev.verb) && !RETRACTABLE_KINDS.has(ev.targetType)) {
      errors.push({
        code: 'illegal_endpoint',
        message: `Event ${ev.verb} cannot target a ${ev.targetType}; retractable kinds: ${[...RETRACTABLE_KINDS].join(', ')}.`,
        pointer: `events[${i}].targetType`,
      });
    }
  });

  // Tier 2 — cycle detection over the combined PREREQUISITE_OF graph (global, concept-level).
  const prereq: DirectedEdge[] = [
    ...existing.prereqEdges,
    ...payload.edges.filter((e) => e.type === 'PREREQUISITE_OF').map((e) => ({ src: e.srcId, dst: e.dstId })),
  ];
  const cycle = findCycle(prereq);
  if (cycle) {
    errors.push({ code: 'prerequisite_cycle', message: `PREREQUISITE_OF cycle detected: ${cycle.join(' → ')}.` });
  }

  // NB (model v2): the REFINES acyclicity check retired with the type — refinement is now a
  // framework-tagged LINK (#Refines), and its DAG rule returns as a framework validation rule
  // (future lint rules report; imports never fail on it). Accepted unchecked, interim.

  // A Map<K, V[]> accumulator: append `v` under `k`, creating the bucket on first use.
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => {
    const bucket = m.get(k);
    if (bucket) bucket.push(v);
    else m.set(k, [v]);
  };

  // Tier 2 — PRECEDES cycles are detected *per track context*: an ordering is only ever
  // meaningful within its own track, so cycles cannot span contexts.
  const byContext = new Map<string, DirectedEdge[]>();
  for (const e of existing.precedesEdges) push(byContext, e.context, { src: e.src, dst: e.dst });
  for (const e of payload.edges.filter((e) => e.type === 'PRECEDES')) {
    push(byContext, e.trackContextId ?? '', { src: e.srcId, dst: e.dstId });
  }
  for (const [ctx, es] of byContext) {
    const c = findCycle(es);
    if (c) {
      errors.push({
        code: 'precedence_cycle',
        message: `PRECEDES cycle in track "${ctx || '(global)'}": ${c.join(' → ')}.`,
      });
    }
  }

  // Warning — an included concept whose prerequisite lies outside its track.
  // Prerequisites of a concept c are { p : p PREREQUISITE_OF c }.
  const addTo = <K, V>(m: Map<K, Set<V>>, k: K, v: V): void => {
    const set = m.get(k);
    if (set) set.add(v);
    else m.set(k, new Set([v]));
  };
  const prereqsOf = new Map<string, Set<string>>();
  for (const { src, dst } of prereq) addTo(prereqsOf, dst, src);
  const includedConcepts = new Map<string, Set<string>>();
  const addInclude = (trackId: string, memberId: string) => {
    if (!memberId.startsWith('cpt_')) return; // only concepts carry prerequisites
    addTo(includedConcepts, trackId, memberId);
  };
  for (const inc of existing.includes) addInclude(inc.trackId, inc.memberId);
  for (const e of payload.edges.filter((e) => e.type === 'INCLUDES')) addInclude(e.srcId, e.dstId);

  for (const [syl, members] of includedConcepts) {
    for (const c of members) {
      for (const p of prereqsOf.get(c) ?? []) {
        if (!members.has(p)) {
          warnings.push({
            code: 'external_prerequisite',
            message: `Concept "${c}" in track "${syl}" has prerequisite "${p}" not included in the track.`,
            pointer: syl,
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
