/**
 * The edge-taxonomy of record, annotated for humans (alpha UI §2.6/§3.4) — generated views of
 * `ENDPOINT_RULES`, never drawn by hand. Two consumers, one source:
 *   - `taxonomyMermaid()` → the diagram embedded in DATA_MODEL.md (`pnpm diagram`), drift-tested
 *     so the picture cannot rot away from the schema (same philosophy as the lock line);
 *   - `TAXONOMY` → the tester-language glossary the UI's Model tab renders (baked into
 *     `ui/src/generated/model.ts` by the same script — the UI never imports engine source).
 *
 * The glossary sentences are content, not derivation — but COVERAGE is derived: a new edge type
 * or event verb without a sentence fails generation and the drift test, so onboarding can't
 * silently lag the model.
 */
import { ENDPOINT_RULES } from '../schema/edges';
import { EventVerbSchema, type EdgeType, type EntityKind, type EventVerb } from '../schema/entities';

/** One tester-language sentence per edge type — what the edge MEANS, not how it's stored. */
const EDGE_SENTENCES: Record<EdgeType, string> = {
  PREREQUISITE_OF: 'Learn this concept before that one — orders the levels of your journey.',
  CLARIFIES: 'This passage sheds light on this concept.',
  CONTRADICTS: 'This passage pushes against this concept — a tension worth keeping.',
  RAISES: 'This passage or source made you ask this question.',
  ANSWERS: 'This source or passage answers this question — no longer a gap in your corpus.',
  ABOUT: 'This content is about this concept — tags say how (a source can explain, demonstrate, or exercise it; answering an about-question marks progress there).',
  INCLUDES: 'This track explicitly contains this source or concept — membership is always explicit, never inferred. Roles ride tags (#Seminal, #Foundational).',
  PREREQUISITE_OF_SYL: 'Take this track before that one.',
  PRECEDES: 'Read this source before that one (within a track).',
  LINK: 'These two relate — the tag says how (#Refines, #Complements, #AnalogousTo, #Expands, …); untagged means "related, unclassified".',
  STAGED: 'You saved this source to engage with later.',
  CONSUMED: 'You finished this source.',
  ANNOTATES: 'Your note and sentiment on a passage.',
  ASKS: 'Your open question — you want an answer.',
  ANSWERED: 'You answered this question for yourself.',
  TRACKS: 'You follow this concept (★ in your journey).',
};

/** One sentence per event verb — the timestamped log entry behind the timeless facts above. */
const VERB_SENTENCES: Record<EventVerb, string> = {
  STAGED: 'When you saved it for later.',
  CONSUMED: 'When you finished it.',
  ANNOTATES: 'When you annotated it.',
  ASKS: 'When you asked it.',
  ANSWERED: 'When you answered it.',
  TRACKS: 'When you started following it.',
  RETRACTED: 'You removed something — it hides from every view but is never deleted; restore any time.',
  RESTORED: 'You brought something back (or re-captured it).',
  UNCONSUMED: 'You marked a source unread again — reading state toggles.',
};

export interface TaxonomyEdge {
  type: EdgeType;
  pairs: ReadonlyArray<readonly [EntityKind, EntityKind]>;
  sentence: string;
}
export interface TaxonomyVerb {
  verb: EventVerb;
  sentence: string;
}
export interface Taxonomy {
  edges: TaxonomyEdge[];
  verbs: TaxonomyVerb[];
}

/** The annotated taxonomy. Throws if any edge type or verb lacks a sentence (coverage gate). */
export function taxonomy(): Taxonomy {
  const edges = (Object.keys(ENDPOINT_RULES) as EdgeType[]).map((type) => {
    const sentence = EDGE_SENTENCES[type];
    if (!sentence) throw new Error(`edge type ${type} has no glossary sentence — add it to src/io/taxonomy.ts`);
    return { type, pairs: ENDPOINT_RULES[type], sentence };
  });
  const verbs = EventVerbSchema.options.map((verb) => {
    const sentence = VERB_SENTENCES[verb];
    if (!sentence) throw new Error(`event verb ${verb} has no glossary sentence — add it to src/io/taxonomy.ts`);
    return { verb, sentence };
  });
  return { edges, verbs };
}

/** The edge taxonomy as a Mermaid flowchart — entity kinds as nodes, one labeled arrow per
 *  legal endpoint pair, event-only verbs as dashed learner arrows. Deterministic output. */
export function taxonomyMermaid(): string {
  const kinds: EntityKind[] = ['learner', 'track', 'concept', 'source', 'snippet', 'question'];
  const lines = ['flowchart LR'];
  for (const k of kinds) lines.push(`  ${k}([${k}])`);
  for (const { type, pairs } of taxonomy().edges) {
    for (const [src, dst] of pairs) lines.push(`  ${src} -- ${type} --> ${dst}`);
  }
  // Event-only verbs never derive a fact edge; shown dashed, targeting the retractable kinds.
  // Containment is a FIELD (`snippet.sourceId`, id-participating), not an edge row — drawn
  // dashed so the diagram stops implying snippets float free of their source (DATA_MODEL §3).
  lines.push('  snippet -. "of (containment — a field, not an edge)" .-> source');
  lines.push('  learner -. "RETRACTED / RESTORED (any item)" .-> source');
  return `${lines.join('\n')}\n`;
}
