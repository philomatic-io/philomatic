/**
 * The publish-state chip: one glance answers "is the public copy current?"
 *
 *   published · up to date      the registry serves exactly this library's content
 *   published · library ahead   this library changed since the last push (or never pushed)
 *   published · library behind  the registry moved past this library (pushed from elsewhere) —
 *                               detected by finding OUR hash in the registry's archive while a
 *                               newer version is current
 *
 * Renders nothing for unpublished tracks and origins with no registry. Cached ~30s per track,
 * module-wide, so the rail can wear one per row without hammering anything — but a WRITE
 * (the context epoch) invalidates immediately, or an edit would wear "up to date" for half a
 * minute after it stopped being true.
 */
import { useEffect, useState } from 'react';
import { useEngine } from '../engine-context';

export type PubState = 'current' | 'ahead' | 'behind';

const cache = new Map<string, { state: PubState | undefined; at: number; epoch: number }>();
let registryOrigin: string | null | undefined; // undefined = unasked, null = none

async function compute(client: { publicationMeta(ref: string): Promise<{ contentHash: string; trackId: string } | undefined>; getRegistry(): Promise<{ registry: string } | undefined> }, trackId: string): Promise<PubState | undefined> {
  const meta = await client.publicationMeta(trackId);
  if (meta === undefined) return undefined;
  if (registryOrigin === undefined) registryOrigin = (await client.getRegistry())?.registry ?? null;
  if (registryOrigin === null) return undefined;
  try {
    const r = await fetch(`${registryOrigin}/t/${encodeURIComponent(meta.trackId)}.json?meta=1`);
    if (r.status === 404) return 'ahead';
    if (!r.ok) return undefined;
    const reg = (await r.json()) as { contentHash: string };
    if (reg.contentHash === meta.contentHash) return 'current';
    const mine = await fetch(`${registryOrigin}/t/${encodeURIComponent(meta.trackId)}.json?version=${meta.contentHash}`);
    return mine.ok ? 'behind' : 'ahead';
  } catch {
    return undefined;
  }
}

export function PubStateChip({ trackId }: { trackId: string }) {
  const { client, epoch } = useEngine();
  const [state, setState] = useState<PubState | undefined>();
  useEffect(() => {
    let live = true;
    const hit = cache.get(trackId);
    if (hit !== undefined && hit.epoch === epoch && Date.now() - hit.at < 30_000) {
      setState(hit.state);
      return;
    }
    void compute(client, trackId).then((s) => {
      cache.set(trackId, { state: s, at: Date.now(), epoch });
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [client, trackId, epoch]);
  if (state === undefined) return null;
  const label = state === 'current' ? 'published · up to date' : state === 'ahead' ? 'published · library ahead' : 'published · library behind';
  const title =
    state === 'current'
      ? 'the registry serves exactly this content'
      : state === 'ahead'
        ? 'this library changed since the last push — publish the update to share it'
        : 'the registry has a newer version than this library — pushed from somewhere else; pull or republish deliberately';
  return (
    <span className={`pubstate-chip ${state}`} title={title}>
      {label}
    </span>
  );
}
