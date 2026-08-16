/**
 * Community sharing on a published track, talked to same-origin.
 *
 * The endpoints live on the REGISTRY (`/t/<id>/community`, `/t/<id>/join`). On the one-origin
 * deploy the registry is this page's own origin, so these are plain relative fetches; the session
 * cookie rides along and the CSRF guard sees a same-origin write. A track pushed to some OTHER
 * registry is not manageable from here — `owner: false` comes back, and the UI shows nothing.
 */

/** One piece of community mail — the registry's record, as the workbench reads it. */
// Deliberate twin of ContributionRecord in src/registry/server.ts — the mailbox wire shape,
// mirrored because the lock line forbids a shared module across src/ and ui/.
export interface ContributionRecord {
  id: string;
  kind: 'question' | 'source';
  text: string;
  title?: string;
  author?: string;
  modality?: string;
  answersId?: string;
  answersText?: string;
  aboutId?: string;
  aboutTitle?: string;
  url?: string;
  accountId: string;
  name: string;
  at: number;
}

export interface CommunityView {
  owner: boolean;
  member?: boolean;
  following?: boolean;
  unlisted?: boolean;
  invite?: { link?: string; createdAt: number; expiresAt?: number } | null;
  members?: { accountId: string; name: string; role: string; joinedAt: number }[];
}

/** Ownership/membership of a track on THIS origin's registry, or undefined if it is not one. */
export async function communityOf(trackId: string): Promise<CommunityView | undefined> {
  try {
    const res = await fetch(`/t/${encodeURIComponent(trackId)}/community`, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    return (await res.json()) as CommunityView;
  } catch {
    return undefined;
  }
}

/** Follow, unfollow, or acknowledge a version of a track (any signed-in viewer). */
export async function setFollow(trackId: string, body: { follow?: boolean; saw?: string }): Promise<{ following: boolean }> {
  const res = await fetch(`/t/${encodeURIComponent(trackId)}/follow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not update following');
  return (await res.json()) as { following: boolean };
}

/** What moved among the tracks this account follows — the inbox cursor feed. */
export async function followingFeed(): Promise<{ trackId: string; title: string; contentHash: string; sawHash: string }[]> {
  try {
    const res = await fetch('/account/following', { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    return ((await res.json()) as { following: { trackId: string; title: string; contentHash: string; sawHash: string }[] }).following;
  } catch {
    return [];
  }
}

/** Owner-only writes: set unlisted, mint or revoke the shared invite. Returns the fresh view. */
export async function setCommunity(trackId: string, body: { unlisted?: boolean; invite?: 'mint' | 'revoke'; removeMember?: string }): Promise<CommunityView> {
  const res = await fetch(`/t/${encodeURIComponent(trackId)}/community`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not update sharing');
  return (await res.json()) as CommunityView;
}
