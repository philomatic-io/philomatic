/**
 * The ONE way every surface creates a source (the New-source form AND the track pickers), so they
 * can't drift. Explicit, never guessing: a `url` is captured (url IS the identity; title/author/
 * tags enrich it); with no url, the `title` is the identity — an OFFLINE source (a physical book,
 * a lecture). Requires at least one of {url, title}. `created` reports whether THIS call minted the
 * source, so an undo un-mints only what the gesture actually made (mirrors resolveOrCreateConcept).
 */
import type { EngineClient } from '../client/transport';

export interface NewSourceInput {
  title?: string;
  url?: string;
  author?: string;
  tags?: string[];
}

export async function createSource(client: EngineClient, input: NewSourceInput): Promise<{ id: string; created: boolean }> {
  const url = input.url?.trim();
  const title = input.title?.trim();
  const author = input.author?.trim();
  const tags = input.tags?.length ? input.tags : undefined;
  if (url) {
    // The capture contract: url is identity; title/author/tags enrich it. Idempotent — an existing
    // url is reused (created:false), so undo won't un-mint a source this gesture merely re-touched.
    const r = (await client.captureSource({
      url,
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(tags ? { tags } : {}),
    })) as { sourceId?: string; created?: boolean };
    if (r.sourceId === undefined) throw new Error('captured the source but could not resolve its id');
    return { id: r.sourceId, created: !!r.created };
  }
  if (!title) throw new Error('a source needs a url or a title');
  // No url: an offline source keyed by its title. Reuse a live one of the same title if present.
  const existing = (await client.getSnapshot()).sources.find((s) => s.title === title);
  await client.importPayload({ version: 2, sources: [{ title, modality: 'text', ...(author ? { author } : {}), ...(tags ? { tags } : {}) }] });
  const id = existing?.id ?? (await client.getSnapshot()).sources.find((s) => s.title === title)?.id;
  if (id === undefined) throw new Error('created the offline source but could not resolve its id');
  return { id, created: existing === undefined };
}
