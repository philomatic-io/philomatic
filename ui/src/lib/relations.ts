/**
 * The human word for an edge (model v2): framework tags carry the meaning of the generic
 * LINK/ABOUT edges (#Explains → "explains", #AnalogousTo → "analogous to"); a bare LINK is
 * honest about being unclassified; razor-kept types read as their name.
 */
const spacedTag = (t: string): string =>
  t
    .replace(/^#/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

export function relationWord(type: string, tags: readonly string[] = []): string {
  if (tags.length > 0) return tags.map(spacedTag).join(', ');
  if (type === 'LINK') return 'related to';
  if (type === 'PRECEDES') return 'reads before'; // the language of record
  return type.toLowerCase().replace(/_syl$/, '').replace(/_/g, ' ');
}

/** The framework-declared inverse reading of an edge ("A topic-of B" ⇄ "B parent-topic-of A").
 *  Tags use their declaration's `inverseLabel`; the razor-kept primitives get natural inverses
 *  here. `undefined` = no inverse reading declared — the chip is not flippable. */
import { activeFrameworks, frameworksVersion } from './framework-registry';
let inverseBuiltFor = 0;
let INVERSE_BY_TAG = new Map<string, string>();
function inverseMap(): ReadonlyMap<string, string> {
  if (inverseBuiltFor !== frameworksVersion()) {
    INVERSE_BY_TAG = new Map();
    for (const f of activeFrameworks()) {
      for (const t of f.edgeTags as readonly { name: string; inverseLabel?: string }[]) {
        if (t.inverseLabel !== undefined && !INVERSE_BY_TAG.has(`#${t.name}`)) INVERSE_BY_TAG.set(`#${t.name}`, t.inverseLabel);
      }
    }
    inverseBuiltFor = frameworksVersion();
  }
  return INVERSE_BY_TAG;
}
const PRIMITIVE_INVERSE: Record<string, string> = {
  PREREQUISITE_OF: 'requires',
  RAISES: 'raised by',
  ANSWERS: 'answered by',
  CLARIFIES: 'clarified by',
  CONTRADICTS: 'contradicted by',
  INCLUDES: 'included in',
  ABOUT: 'subject of',
  PRECEDES: 'reads after',
};
export function inverseRelationWord(type: string, tags: readonly string[] = []): string | undefined {
  if (tags.length > 0) {
    const m = inverseMap();
    const inv = tags.map((t) => m.get(t));
    return inv.every((w): w is string => w !== undefined) ? inv.join(', ') : undefined;
  }
  return PRIMITIVE_INVERSE[type];
}


/**
 * One display row per MEANING: edge tags union-merge on re-link, so
 * one edge can carry several relation words ("draws on, topic of") — and the row's × then
 * removed both at once, with no way to remove one. A relation with N tags splits into N rows
 * (each carrying its single tag plus `allTags`, the edge's full set) so each meaning gets its
 * own × — removal composes as unlink + re-link-with-the-remaining-tags, the interim answer to
 * the edge-tag set-replace gap.
 */
export function splitRelationRows<R extends { tags: string[] }>(rels: readonly R[]): (R & { allTags: string[] })[] {
  return rels.flatMap((r) =>
    r.tags.length > 1 ? r.tags.map((t) => ({ ...r, tags: [t], allTags: r.tags })) : [{ ...r, allTags: r.tags }],
  );
}
