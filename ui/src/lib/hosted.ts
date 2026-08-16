/**
 * Am I signed in, and is there a library here?
 *
 * Asked of the workbench's OWN origin, so the page never needs the registry's address; the
 * instance proxies the identity question and adds the one answer that is its own — whether a
 * hosted library has been provisioned for this account.
 *
 * Signing in does NOT create one: a person using the in-browser engine
 * must never discover that a server kept a copy of their reading. So `hasLibrary` is false until
 * they ask, and the start surface turns that into an offer rather than an error.
 */
import { serverBase, setBackend, type Backend } from './backend-pref';

export interface HostedIdentity {
  /** False on a single-tenant server: no accounts, no sign-in, nothing to offer. */
  hosted: boolean;
  signedIn: boolean;
  account?: { id: string; name?: string; email?: string; username?: string };
  /** Signed in but no public handle chosen yet — the first-run step. */
  needsUsername?: boolean;
  providers: { id: string; label: string }[];
  hasLibrary?: boolean;
  registry?: string;
}

const SIGNED_OUT: HostedIdentity = { hosted: false, signedIn: false, providers: [] };

export async function hostedIdentity(): Promise<HostedIdentity> {
  try {
    const res = await fetch(`${serverBase()}/auth/me`, { headers: { accept: 'application/json' } });
    if (!res.ok) return SIGNED_OUT;
    return (await res.json()) as HostedIdentity;
  } catch {
    return SIGNED_OUT; // no server, or offline — the in-browser engine is unaffected either way
  }
}

/** Create this account's hosted library — the deliberate act. */
export async function createHostedLibrary(): Promise<void> {
  const res = await fetch(`${serverBase()}/account/library`, { method: 'POST' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not create the library');
}

/** Delete this account's hosted library entirely — it becomes unprovisioned again. */
export async function deleteHostedLibrary(): Promise<void> {
  const res = await fetch(`${serverBase()}/account/library/delete`, { method: 'POST' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not delete the library');
}

/** Sign out of the account (clears the session at the registry), then reload signed-out. The
 *  root `/auth/signout` is the registry's, reached same-origin on the one-origin deploy. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/auth/signout', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
  } catch {
    /* offline — reloading still drops the in-memory view; the cookie clears on the next reach */
  }
  window.location.reload();
}

/** The central account page (registry): tracks, tokens, sign-out-everywhere, account removal. */
export const ACCOUNT_URL = '/account';

/** Send the browser to sign in, returning HERE afterwards. The `next`
 *  is honoured by the registry now, so a workbench sign-in lands back on the workbench, not the
 *  registry root. */
export function signInHere(): void {
  const back = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/signin?next=${back}`;
}

// The storage decision comes BEFORE login: choosing "host it on Philomatic"
// while signed out means signing in, and the CHOICE must survive that round trip so the library
// is provisioned on return without asking a second, confusing question. A one-shot flag does it.
const HOST_INTENT_KEY = 'pm.hostIntent';

export function markHostIntent(): void {
  try {
    sessionStorage.setItem(HOST_INTENT_KEY, '1');
  } catch {
    /* private mode with no sessionStorage — the choice screen simply asks again, which is safe */
  }
}

/** Read the intent AND clear it — it must fire exactly once, on the return from sign-in. */
export function takeHostIntent(): boolean {
  try {
    const had = sessionStorage.getItem(HOST_INTENT_KEY) === '1';
    sessionStorage.removeItem(HOST_INTENT_KEY);
    return had;
  } catch {
    return false;
  }
}

// MOVING a browser library up is the same shape, one step bigger: if signed out, sign in first,
// then COPY this browser's library into the new hosted one on return. A
// separate flag from HOST_INTENT so the return path knows to migrate, not to provision empty.
const MIGRATE_INTENT_KEY = 'pm.migrateIntent';

export function markMigrateIntent(): void {
  try {
    sessionStorage.setItem(MIGRATE_INTENT_KEY, '1');
  } catch {
    /* no sessionStorage — the Settings button simply asks again, which is safe */
  }
}

export function takeMigrateIntent(): boolean {
  try {
    const had = sessionStorage.getItem(MIGRATE_INTENT_KEY) === '1';
    sessionStorage.removeItem(MIGRATE_INTENT_KEY);
    return had;
  } catch {
    return false;
  }
}

// ── which library am I in, and moving between them ──────────────────────
//
// A person can have TWO libraries — the one in this browser, and one on their hosted account —
// and the whole danger is not knowing which they are looking at, or believing a switch deleted
// their work. Two rules make that impossible:
//
//   1. the current library is ALWAYS named in the chrome (see `libraryLabel`), so it can never
//      be the wrong one unknowingly;
//   2. moving from browser to hosted is a ONE-WAY, explicit act that COPIES up and leaves the
//      browser copy as a dormant, labelled archive — never a second live copy that diverges.

/** A localStorage note that the browser library was migrated up, and when. Settings reads it. */
const ARCHIVED_KEY = 'pm.browserArchivedAt';

export function browserArchivedAt(): string | undefined {
  try {
    return localStorage.getItem(ARCHIVED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** What the chrome shows for "which library is this". Never a guess — the backend is the fact. */
export function libraryLabel(backend: Backend, identity: HostedIdentity | undefined): { text: string; title: string } {
  if (backend === 'browser') {
    return { text: 'This browser', title: 'Your library lives only in this browser. Sign in to keep it on your account.' };
  }
  const host = (identity?.registry ?? serverBase() ?? '').replace(/^https?:\/\//, '') || 'your server';
  const who = identity?.account?.name ?? identity?.account?.email;
  return { text: host, title: who !== undefined ? `${host} — signed in as ${who}` : host };
}

/**
 * Move the browser library to the hosted account, then switch to it.
 *
 * Provisions the hosted library, copies the browser payload into it (a FRESH library, so the
 * replace-on-write import has nothing to clobber), records the browser copy as an archive, and
 * flips the backend to server. The caller reloads; boot then opens the hosted library and the
 * chrome names it. The browser bytes are left where they are — dormant, not deleted — so the
 * archive is real and Settings can offer to switch back or clear it.
 */
export async function migrateBrowserToHosted(payload: unknown): Promise<void> {
  await createHostedLibrary();
  const res = await fetch(`${serverBase()}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not copy your library to the server');
  }
  try {
    localStorage.setItem(ARCHIVED_KEY, new Date().toISOString());
  } catch {
    /* the archive still exists in IndexedDB; the note is a convenience, not the record */
  }
  setBackend('server');
}
