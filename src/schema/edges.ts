/**
 * Edge endpoint taxonomy (DATA_MODEL.md §4) — model v2.
 *
 * The single source of truth for which entity kinds each edge type may connect. The parser
 * uses this for Tier-1 endpoint typing; desugar uses the companion relation map (io/sugar.ts)
 * to emit correctly-typed, correctly-directed edges.
 *
 * The v2 razor: an edge stays a first-class TYPE only when the engine itself consumes or
 * enforces its semantics — membership (INCLUDES), ordering/acyclicity (PREREQUISITE_OF,
 * PRECEDES, PREREQUISITE_OF_SYL), gap computation (RAISES/ANSWERS), aboutness (ABOUT),
 * NEGATION (CLARIFIES/CONTRADICTS — polarity is a primitive, never framework vocabulary),
 * and the learner overlay. Everything purely descriptive is a generic LINK (or ABOUT) whose
 * meaning rides framework-declared tags (#Explains, #Refines, #Seminal on INCLUDES, …) —
 * see implementation_plan_model_v2.md §1 for the collapse map from the v1 taxonomy.
 */
import type { EntityKind, EdgeType } from './entities';

type Pair = readonly [EntityKind, EntityKind];

export const ENDPOINT_RULES: Record<EdgeType, ReadonlyArray<Pair>> = {
  // Engine-enforced semantics (the razor's keep list).
  PREREQUISITE_OF: [['concept', 'concept']], // rigid, global, acyclic (cycle-checked)
  CLARIFIES: [['snippet', 'concept']], // the polarity pair: golden explanation …
  CONTRADICTS: [['snippet', 'concept']], // … vs. poor/confusing — negation is a primitive
  RAISES: [
    ['source', 'question'],
    ['snippet', 'question'],
  ],
  ANSWERS: [
    ['source', 'question'],
    ['snippet', 'question'],
  ],
  // "Content is about a concept; tags say how" — the question anchor plus the v2 home of the
  // former EXPLAINS/DEMONSTRATES/EXERCISES (as #Explains/#Demonstrates/#Exercises tags).
  ABOUT: [
    ['question', 'concept'],
    ['source', 'concept'],
  ],
  INCLUDES: [
    ['track', 'source'],
    ['track', 'concept'],
  ], // THE membership relation; member roles ride tags (#Seminal, #Foundational)
  PREREQUISITE_OF_SYL: [['track', 'track']],
  PRECEDES: [['source', 'source']], // soft reading order; track-scoped + acyclic per track
  // The generic descriptive link — same-kind pairs; meaning rides framework-declared tags
  // (#Refines, #Complements, #AnalogousTo, #IsEvidenceFor, #RefersTo, #Expands, #DerivativeOf;
  // snippet↔snippet carries the argument-diagramming framework's #Supports/#Opposes).
  // A bare untagged LINK is legal: "these relate; unclassified".
  LINK: [
    ['concept', 'concept'],
    ['source', 'source'],
    ['track', 'track'],
    ['question', 'question'],
    ['snippet', 'snippet'],
  ],
  // Learner -> Entity (the behavioral overlay).
  STAGED: [['learner', 'source']],
  CONSUMED: [['learner', 'source']],
  ANNOTATES: [['learner', 'snippet']],
  ASKS: [['learner', 'question']],
  ANSWERED: [['learner', 'question']],
  TRACKS: [['learner', 'concept']],
};

export function isLegalEndpoint(src: EntityKind, type: EdgeType, dst: EntityKind): boolean {
  return ENDPOINT_RULES[type].some(([s, d]) => s === src && d === dst);
}

/** Human-readable "src→dst, src→dst" listing of an edge type's legal endpoints. */
export function describeEndpoints(type: EdgeType): string {
  return ENDPOINT_RULES[type].map(([s, d]) => `${s}→${d}`).join(', ');
}
