/**
 * Read-only Mermaid rendering (MVP.md §4).
 * The cheapest "see the graph" payoff: concepts and sources as nodes, PREREQUISITE_OF and
 * EXPLAINS as edges, concept nodes colored by the learner's state overlay. No editor UI.
 */
import type { CanonicalPayload } from '../schema/entities';

export interface MermaidOverlay {
  /** Concepts the learner has answered a question about — the question-overlay progress signal. */
  answered?: Set<string>;
}

const escapeLabel = (s: string): string => s.replace(/"/g, "'");

export function toMermaid(payload: CanonicalPayload, overlay: MermaidOverlay = {}): string {
  const lines: string[] = ['graph TD'];

  for (const c of payload.concepts) lines.push(`  ${c.id}["${escapeLabel(c.name)}"]`);
  for (const s of payload.sources) lines.push(`  ${s.id}(["${escapeLabel(s.title)}"])`);

  for (const e of payload.edges) {
    if (e.type === 'PREREQUISITE_OF') lines.push(`  ${e.srcId} --> ${e.dstId}`);
    else if (e.type === 'ABOUT' && e.srcType === 'source') lines.push(`  ${e.srcId} -.-> ${e.dstId}`);
    else if (e.type === 'PRECEDES') lines.push(`  ${e.srcId} ==> ${e.dstId}`); // reading order
  }

  lines.push('  classDef answered fill:#c6f6d5,stroke:#22c55e,color:#14532d;');

  const answered = [...(overlay.answered ?? [])].sort();
  if (answered.length > 0) lines.push(`  class ${answered.join(',')} answered;`);

  return lines.join('\n');
}
