/**
 * Recency projection (freshness 8a §2.6) — a **pure function of explicit
 * inputs** (payload in, map out; no DB, no clock), per the functional-core principle
 * (ARCHITECTURE.md §5).
 *
 * Engagement events (`CONSUMED` / `ANNOTATES` / `ANSWERED`) land on a source / snippet / question;
 * those roll up to the concept(s) that target attaches to (`EXPLAINS`/`DEMONSTRATES`/`EXERCISES`
 * for sources, `CLARIFIES`/`CONTRADICTS` for snippets, `ABOUT` for questions). The result is the
 * most-recent engagement `occurredAt` per concept. It reports and orders **stored** times only —
 * decay relative to "now" is Slice 8b.
 */
import type { CanonicalPayload, EventVerb } from '../schema/entities';

/** Verbs that count as engaging a concept (STAGED never does; ASKS is deferred to 8b weights). */
const ENGAGEMENT_VERBS: ReadonlySet<EventVerb> = new Set(['CONSUMED', 'ANNOTATES', 'ANSWERED']);

/** Edge types that attach a source/snippet/question to a concept. */
const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'EXPLAINS',
  'DEMONSTRATES',
  'EXERCISES',
  'CLARIFIES',
  'CONTRADICTS',
  'ABOUT',
]);

/** conceptId → most-recent engagement time (epoch-ms) for `learnerId`. Concepts with no
 *  engagement are absent from the map. */
export function recencyByConcept(p: CanonicalPayload, learnerId: string): Map<string, number> {
  // target entity id → concept ids it attaches to
  const conceptsOfTarget = new Map<string, string[]>();
  for (const e of p.edges) {
    if (!ATTACHMENT_TYPES.has(e.type)) continue;
    const arr = conceptsOfTarget.get(e.srcId);
    if (arr) arr.push(e.dstId);
    else conceptsOfTarget.set(e.srcId, [e.dstId]);
  }

  const lastEngaged = new Map<string, number>();
  for (const ev of p.events) {
    if (ev.learnerId !== learnerId || !ENGAGEMENT_VERBS.has(ev.verb)) continue;
    for (const cid of conceptsOfTarget.get(ev.targetId) ?? []) {
      const prev = lastEngaged.get(cid);
      if (prev === undefined || ev.occurredAt > prev) lastEngaged.set(cid, ev.occurredAt);
    }
  }
  return lastEngaged;
}
