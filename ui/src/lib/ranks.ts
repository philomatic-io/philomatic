/**
 * Concept ranks, derived from the framework-declared hierarchy (owner request, 2026-07-18):
 * the frameworks say WHICH tags form a hierarchy (`hierarchy` + `hierarchyRole` — semantic
 * tokens, no presentation); the client derives each concept's rank from the live edges and
 * maps ranks to its own design system. Ranks:
 *   field    — something sits under it (inbound parent-links or attachments), nothing above
 *   subfield — has a parent-link outward (it sits under a field, whatever else it has)
 *   topic    — attached content (an outward attachment-link: subject matter within a rank)
 *   plain    — participates in no declared hierarchy
 */
import { FRAMEWORKS } from '../generated/framework';

export type ConceptRank = 'field' | 'subfield' | 'topic' | 'plain';

interface EdgeTagView {
  name: string;
  on: { type: string };
  hierarchy?: string;
  hierarchyRole?: 'parent' | 'attachment';
}

const decls = FRAMEWORKS.flatMap((f): readonly EdgeTagView[] => f.edgeTags).filter((t) => t.hierarchy !== undefined);
const PARENT_TAGS = new Set(decls.filter((t) => t.hierarchyRole === 'parent').map((t) => `#${t.name}`));
const ATTACH_TAGS = new Set(decls.filter((t) => t.hierarchyRole === 'attachment').map((t) => `#${t.name}`));

/** The declared-hierarchy links OUT of each concept: srcId → its parents/ranks, with the
 *  role the declaration gives the tag ('parent' = sits under, 'attachment' = subject matter
 *  within) and the tag's display name. Same declaration source as conceptRanks — clients
 *  render taxonomy from THIS, never from tag-name literals (ARCHITECTURE #2 corollary). */
export function hierarchyLinks(
  edges: readonly { srcId: string; dstId: string; tags?: readonly string[] }[],
): Map<string, { dstId: string; role: 'parent' | 'attachment'; tag: string }[]> {
  const out = new Map<string, { dstId: string; role: 'parent' | 'attachment'; tag: string }[]>();
  for (const e of edges) {
    for (const t of e.tags ?? []) {
      const role = PARENT_TAGS.has(t) ? ('parent' as const) : ATTACH_TAGS.has(t) ? ('attachment' as const) : undefined;
      if (role === undefined) continue;
      if (!out.has(e.srcId)) out.set(e.srcId, []);
      out.get(e.srcId)!.push({ dstId: e.dstId, role, tag: t });
    }
  }
  return out;
}

/** Rank every concept node from the graph's tagged LINK edges. */
export function conceptRanks(
  nodes: readonly { id: string; kind: string }[],
  edges: readonly { srcId: string; dstId: string; tags?: readonly string[] }[],
): Map<string, ConceptRank> {
  const outParent = new Set<string>();
  const inParent = new Set<string>();
  const outAttach = new Set<string>();
  const inAttach = new Set<string>();
  for (const e of edges) {
    for (const t of e.tags ?? []) {
      if (PARENT_TAGS.has(t)) {
        outParent.add(e.srcId);
        inParent.add(e.dstId);
      } else if (ATTACH_TAGS.has(t)) {
        outAttach.add(e.srcId);
        inAttach.add(e.dstId);
      }
    }
  }
  const ranks = new Map<string, ConceptRank>();
  for (const n of nodes) {
    if (n.kind !== 'concept') continue;
    ranks.set(
      n.id,
      outParent.has(n.id)
        ? 'subfield'
        : outAttach.has(n.id)
          ? 'topic'
          : inParent.has(n.id) || inAttach.has(n.id)
            ? 'field'
            : 'plain',
    );
  }
  return ranks;
}
