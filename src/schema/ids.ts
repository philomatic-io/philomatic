/**
 * Deterministic id derivation (DATA_MODEL.md §2).
 *
 * Deterministic, type-prefixed ids are what make bulk upsert idempotent: the same logical
 * entity always derives the same id, so a re-import merges instead of duplicating.
 */
// Universal sha256 (browser + node): the engine must run inside the extension host (alpha UI
// plan §2.7), and node:crypto was the frozen core's ONE node binding above the storage tier.
// @noble/hashes is synchronous and byte-identical to createHash('sha256'), so every derived id
// is unchanged (pinned by the full suite's derived-id expectations).
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Lowercase, diacritic-stripped, hyphen-joined slug. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics -> hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

export function conceptId(name: string): string {
  return `cpt_${slugify(name)}`;
}

export function trackId(title: string): string {
  return `syl_${slugify(title)}`;
}

/**
 * Canonical URL normalization (DATA_MODEL.md §2): used both to compute a
 * Source id and to catch cheap duplicates. Lowercase scheme+host, strip `www.`, drop the
 * fragment, remove tracking params, sort remaining params, trim trailing slash.
 */
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|ref)$/i;

export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString().replace(/\/$/, '');
}

function sha256(input: string): string {
  return bytesToHex(sha256Bytes(utf8ToBytes(input)));
}

/**
 * Source id: deterministic hash of the canonical URL when one exists (so two users clipping
 * the same link converge); otherwise a slug of the title.
 *
 * Model v2 (implementation_plan_model_v2.md §2 / ROADMAP §1.2): `author` no longer
 * participates — it is a pure attribute, so adapter-resolved authors can't change identity
 * and idempotency survives enrichment. v1 payloads carrying author-derived ids are remapped
 * at import by `src/io/migrate.ts` (which owns the legacy derivation).
 */
export function sourceId(input: {
  title: string;
  directUrl?: string;
  bibliographicUrl?: string;
}): string {
  const url = input.directUrl ?? input.bibliographicUrl;
  if (url) {
    // The trailing `|` is v1's author separator with the author now pinned to '' — kept so the
    // ids of never-authored sources (the vast majority) survive v2 unchanged; only sources that
    // actually carried an author re-key (the migration's whole blast radius).
    return `src_${sha256(`${canonicalizeUrl(url)}|`).slice(0, 24)}`;
  }
  return `src_${slugify(input.title)}`;
}

/** Exposed for the v1→v2 migration only (src/io/migrate.ts): the retired author-bearing hash. */
export function legacySourceIdV1(url: string, author: string): string {
  return `src_${sha256(`${canonicalizeUrl(url)}|${author}`).slice(0, 24)}`;
}

/**
 * Snippet id (snippets §2.4): a deterministic hash of the owning source
 * plus the normalized passage text, so re-importing the same highlight converges. Whitespace and
 * case are normalized; near-identical text is the same fuzzy-identity problem as sources, whose
 * dedup is deferred to Phase 2.
 */
export function snippetId(input: { sourceId: string; text: string }): string {
  const normalized = input.text.trim().replace(/\s+/g, ' ').toLowerCase();
  return `snp_${sha256(`${input.sourceId}|${normalized}`).slice(0, 24)}`;
}

/**
 * Question id (questions §2.4): a hash of the normalized question text,
 * so a snippet's `raises` and a directly-authored question with the same text converge. Same
 * fuzzy-text identity as snippets; near-duplicate phrasings are deferred to Phase-2 dedup.
 */
export function questionId(input: { text: string }): string {
  const normalized = input.text.trim().replace(/\s+/g, ' ').toLowerCase();
  return `qst_${sha256(normalized).slice(0, 24)}`;
}
