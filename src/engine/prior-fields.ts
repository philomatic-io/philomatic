/**
 * Re-attach a source's OWN fields to a payload written by someone who could not know them.
 *
 * The problem it solves: a source's identity is its URL, so anyone naming a URL you
 * already hold writes to YOUR row. Upsert is replace-on-write — correct, because a payload is
 * supposed to state the full desired row — but a payload assembled by a stranger, an LLM, or a
 * capture form states only what its author knew. Everything else becomes NULL.
 *
 * `captureSource` already declares the policy this implements — *"existing values are never
 * overwritten: user input > stored value > fresh resolver > fallback"* — and implemented it for
 * title, author and duration only. A public ask submission for a URL the owner already had
 * therefore erased their `personalUrl` (a private file path, stripped from publications for
 * exactly that reason), their `bibliographicUrl`, and every tag on the source.
 *
 * Lived in ingest.ts guarding the LLM propose path, where the same hazard was found first. Moved
 * here so both doors read ONE carry-list: two copies would drift, and the drift would be a
 * privacy failure rather than a rendering one. It sits under `engine/` rather than `io/` because
 * the lock line lets a shell reach the engine and nothing else — and the propose path is a
 * shell.
 *
 * NOT a substitute for merge-patch. This makes a caller's payload COMPLETE; it
 * does not teach the store to tell "absent" from "explicitly cleared". The raw import door — a
 * fork, a resync, a bundle from elsewhere — still needs that.
 */
import { sourceId } from '../schema/ids';

/** Fields only the owner can know, or that an outside writer has no business clearing. */
const CARRY = ['author', 'directUrl', 'bibliographicUrl', 'personalUrl', 'estimatedDurationMins', 'status'] as const;

const tagKey = (t: unknown): string => {
  const g = t as { name?: string; subtype?: string; degree?: number } | string;
  if (typeof g === 'string') return g;
  return `${g.name ?? ''}|${g.subtype ?? ''}|${g.degree ?? ''}`;
};

export function withPriorSourceFields(
  store: { sources: readonly Record<string, unknown>[] },
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const entries = payload.sources;
  if (!Array.isArray(entries)) return payload;
  const priors = new Map(store.sources.map((s) => [s.id as string, s]));
  const sources = entries.map((raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const entry = { ...(raw as Record<string, unknown>) };
    const id =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.title === 'string'
          ? sourceId({
              title: entry.title,
              ...(typeof entry.directUrl === 'string' ? { directUrl: entry.directUrl } : {}),
              ...(typeof entry.bibliographicUrl === 'string' ? { bibliographicUrl: entry.bibliographicUrl } : {}),
            })
          : undefined;
    const prior = id !== undefined ? priors.get(id) : undefined;
    if (prior === undefined) return entry;
    for (const k of CARRY) if (entry[k] === undefined && prior[k] !== undefined) entry[k] = prior[k];
    if (prior.modality !== undefined) entry.modality = prior.modality;
    // Tags UNION, deduped (tags are multi-valued and accumulate across re-asserts).
    // Deduping matters here and not only for tidiness: without it, the same URL submitted to an
    // ask link twice appends `#recommended` twice, and fifty times appends it fifty times.
    const priorTags = Array.isArray(prior.tags) ? (prior.tags as unknown[]) : [];
    const entryTags = Array.isArray(entry.tags) ? (entry.tags as unknown[]) : [];
    if (priorTags.length > 0 || entryTags.length > 0) {
      const seen = new Set<string>();
      entry.tags = [...priorTags, ...entryTags].filter((t) => {
        const k = tagKey(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return entry;
  });
  return { ...payload, sources };
}
