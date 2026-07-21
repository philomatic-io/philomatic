/**
 * Concept resolution for the relation editors (anchors on sources/snippets, ties between
 * concepts): match by name against the library, or create-then-resolve — the server owns id
 * derivation, so a fresh mint is looked up from /graph, never derived client-side.
 */
import { FRAMEWORKS } from '../generated/framework';
import type { EngineClient } from '../client/transport';

export interface ConceptRef {
  id: string;
  name: string;
}

/** `created` reports which branch ran — an undo must reverse the whole GESTURE, so a link
 *  that minted its concept un-mints it too (owner ruling, 2026-07-18). */
export async function resolveOrCreateConcept(
  client: EngineClient,
  concepts: readonly ConceptRef[],
  name: string,
): Promise<ConceptRef & { created: boolean }> {
  const existing = concepts.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ...existing, created: false };
  await client.importPayload({ version: 2, concepts: [{ name }] });
  const g = await client.getGraph();
  const node = g.nodes.find((n) => n.kind === 'concept' && n.label === name);
  if (!node) throw new Error('created the concept, but could not resolve its id');
  return { id: node.id, name: node.label, created: true };
}

/** A rendered tag label ("#SubfieldOf", "#Supports:a") back to its canonical shape — the
 *  re-assertion path of unlink's undo. Mirrors the sugar lexer's grammar. */
export function unrenderTag(label: string): { name: string; subtype?: string; degree?: number } {
  const [name, a, b] = label.replace(/^#/, '').split(':');
  if (a === undefined) return { name: name! };
  if (b !== undefined) return { name: name!, subtype: a, degree: Number(b) };
  return /^\d+$/.test(a) ? { name: name!, degree: Number(a) } : { name: name!, subtype: a };
}

/** The full canonical edge for a Relation row seen from `self` — unlink coordinates AND the
 *  undo's re-import payload. */
export function relationEdge(
  self: { id: string; kind: string },
  r: { direction: 'out' | 'in'; type: string; tags: readonly string[]; otherId: string; otherKind: string },
): { srcType: string; srcId: string; type: string; dstType: string; dstId: string; tags: { name: string; subtype?: string; degree?: number }[] } {
  const out = r.direction === 'out';
  return {
    srcType: out ? self.kind : r.otherKind,
    srcId: out ? self.id : r.otherId,
    type: r.type,
    dstType: out ? r.otherKind : self.kind,
    dstId: out ? r.otherId : self.id,
    tags: r.tags.map(unrenderTag),
  };
}

/** The anchor vocabulary for sources — declared by the frameworks (ABOUT source→concept),
 *  never hardcoded (portability contract); widened view over the as-const baked tuples. */
interface EdgeTagView {
  name: string;
  on: { type: string; srcKind?: string; dstKind?: string };
}
export const ABOUT_TAGS: string[] = FRAMEWORKS.flatMap((f): readonly EdgeTagView[] => f.edgeTags)
  .filter((t) => t.on.type === 'ABOUT' && t.on.srcKind === 'source' && t.on.dstKind === 'concept')
  .map((t) => t.name);
