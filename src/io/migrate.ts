/**
 * The v1→v2 payload migration (implementation_plan_model_v2.md §3) — ONE pure function applied
 * by `importPayload` whenever a payload says `version: 1`, so every v1 artifact (alpha exports,
 * old seeds, live-DB exports via `migrate-v2`) crosses over without its author lifting a finger.
 * Runs BEFORE desugar on the raw JSON: it must fix things the v2 schemas would reject.
 *
 * Three concerns, in order:
 *   1. **Id re-key (D10)** — v1 source ids hashed `url|author`; v2 pins author to ''. Only
 *      sources that carried an author change id; the cascade re-keys their snippets
 *      (`snp_ = sha(sourceId|text)`) and every edge/event reference. Explicit human ids
 *      (anything not matching the old derived hash) are left alone.
 *   2. **Edge collapse (§1)** — retired types rewrite to LINK/ABOUT/INCLUDES + injected tags,
 *      REFERENCE_FOR inverts its endpoints (v1 "A is a reference FOR B" reads src→dst as
 *      #RefersTo only from B), and same-identity edges merge with tag-set union (v1's
 *      EXPLAINS + EXERCISES between one pair become ONE ABOUT edge carrying both tags).
 *   3. `version` bumps to 2.
 *
 * Defensive by design: input is raw JSON (pre-validation), so every access is guarded and
 * unknown shapes pass through for the v2 parser to judge.
 */
import { legacySourceIdV1, snippetId, sourceId } from '../schema/ids';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Retired edge type → its v2 representation. `invert` swaps the endpoints. */
const COLLAPSE: Record<string, { type: string; tag: string; invert?: boolean }> = {
  EXPLAINS: { type: 'ABOUT', tag: 'Explains' },
  DEMONSTRATES: { type: 'ABOUT', tag: 'Demonstrates' },
  EXERCISES: { type: 'ABOUT', tag: 'Exercises' },
  ANALOGOUS_TO: { type: 'LINK', tag: 'AnalogousTo' },
  IS_EVIDENCE_FOR: { type: 'LINK', tag: 'IsEvidenceFor' },
  REFINES: { type: 'LINK', tag: 'Refines' },
  COMPLEMENTS: { type: 'LINK', tag: 'Complements' },
  EXPANDS: { type: 'LINK', tag: 'Expands' },
  DERIVATIVE_OF: { type: 'LINK', tag: 'DerivativeOf' },
  REFERENCE_FOR: { type: 'LINK', tag: 'RefersTo', invert: true },
  SEMINAL: { type: 'INCLUDES', tag: 'Seminal' },
};

const tagKey = (t: Rec): string => `${str(t.name)}|${str(t.subtype)}|${t.degree ?? ''}`;

function unionTags(a: unknown, b: unknown): Rec[] {
  const out = new Map<string, Rec>();
  for (const t of [...arr(a), ...arr(b)]) out.set(tagKey(t), t);
  return [...out.values()];
}

/**
 * Does this raw payload contain anything the v2 schema would reject or v2 ids would miss?
 * Used by the live-DB migration to decide whether a store file needs the rebuild at all.
 */
export function needsV2Migration(input: unknown): boolean {
  if (!isRec(input)) return false;
  if (arr(input.edges).some((e) => str(e.type) in COLLAPSE)) return true;
  return arr(input.sources).some((s) => {
    const url = str(s.directUrl) || str(s.bibliographicUrl);
    const author = str(s.author);
    if (!url || !author) return false;
    try {
      return str(s.id) === legacySourceIdV1(url, author);
    } catch {
      return false;
    }
  });
}

/**
 * Legacy-key normalization (track rename, 2026-07-18): every payload ever exported before the
 * rename says `syllabi:` / `syllabusContextId` / (sugared sources) `syllabus:` — accepted
 * FOREVER, rewritten to the canonical `tracks` vocabulary before any parsing. Runs on v1 and
 * v2 alike; a no-op on post-rename payloads. Never emitted on export.
 */
export function normalizeLegacyKeys(input: unknown): unknown {
  if (!isRec(input)) return input;
  const hasLegacyEdge = Array.isArray(input.edges) && input.edges.some((e) => isRec(e) && e.syllabusContextId !== undefined);
  // Post-rename payloads pass through IDENTICALLY (reference and all) — pinned behavior.
  if (input.syllabi === undefined && !hasLegacyEdge) return input;
  const out: Record<string, unknown> = { ...input };
  if (out.tracks === undefined && out.syllabi !== undefined) out.tracks = out.syllabi;
  delete out.syllabi;
  if (hasLegacyEdge && Array.isArray(out.edges)) {
    out.edges = out.edges.map((e) => {
      if (!isRec(e) || e.trackContextId !== undefined || e.syllabusContextId === undefined) return e;
      const { syllabusContextId, ...rest } = e;
      return { ...rest, trackContextId: syllabusContextId };
    });
  }
  return out;
}

export function migrateV1(rawInput: unknown): unknown {
  const input = normalizeLegacyKeys(rawInput);
  if (!isRec(input) || input.version !== 1) return input;

  // 1. Re-key authored URL sources (and cascade to their snippets).
  const idMap = new Map<string, string>();
  const sources = arr(input.sources).map((s) => {
    const url = str(s.directUrl) || str(s.bibliographicUrl);
    const author = str(s.author);
    if (!url || !author) return s;
    let oldDerived: string;
    try {
      oldDerived = legacySourceIdV1(url, author);
    } catch {
      return s; // unparsable URL — leave it for the validator
    }
    if (str(s.id) !== oldDerived) return s; // explicit human id — identity is not derived
    const next = sourceId({ title: str(s.title) || url, directUrl: url });
    idMap.set(oldDerived, next);
    return { ...s, id: next };
  });

  const snippets = arr(input.snippets).map((s) => {
    const owner = idMap.get(str(s.sourceId));
    if (owner === undefined) return s;
    const oldDerived = snippetId({ sourceId: str(s.sourceId), text: str(s.text) });
    const next = str(s.id) === oldDerived ? snippetId({ sourceId: owner, text: str(s.text) }) : s.id;
    idMap.set(str(s.id), str(next)); // snippet references in edges/events follow too
    return { ...s, id: next, sourceId: owner };
  });

  const remap = (id: unknown): unknown => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id);

  // 2. Collapse retired edge types onto LINK/ABOUT/INCLUDES + tags, then merge by identity.
  const merged = new Map<string, Rec>();
  for (const e of arr(input.edges)) {
    const rule = COLLAPSE[str(e.type)];
    let next: Rec = { ...e, srcId: remap(e.srcId), dstId: remap(e.dstId) };
    if (rule) {
      if (rule.invert) {
        next = { ...next, srcType: next.dstType, srcId: next.dstId, dstType: next.srcType, dstId: next.srcId };
      }
      next = { ...next, type: rule.type, tags: unionTags(next.tags, [{ name: rule.tag }]) };
    }
    const key = `${str(next.srcId)}|${str(next.dstId)}|${str(next.type)}|${str(next.trackContextId)}`;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, tags: unionTags(prior.tags, next.tags) } : next);
  }

  const events = arr(input.events).map((ev) => ({ ...ev, targetId: remap(ev.targetId) }));

  return {
    ...input,
    version: 2,
    sources,
    snippets,
    edges: [...merged.values()],
    events,
  };
}
