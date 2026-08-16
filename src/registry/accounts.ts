/**
 * Registry accounts and sessions (the auth design).
 *
 * The registry pins each track to the Ed25519 key that first published it, so ownership is
 * possession of a file: lose the key and the track can never be updated or withdrawn by anyone,
 * including its author. An account is the identity that survives that — and, per
 * the hosting design, the same identity that will later decide *whose library* a
 * hosted request touches.
 *
 * Storage is a plain JSON file under the registry's `dir`, matching how the index and bundles
 * are already stored: this server has no database, and giving it one for a few hundred rows
 * would be a dependency bought for nothing.
 *
 * IDENTITY IS `provider:subject`, NEVER the email. A provider's subject (`sub` from Google) is
 * stable for the life of the account; an email address is a display attribute that people
 * change, and re-keying on it would silently merge or orphan accounts when they do.
 */
import { readPrivateJson, writePrivateJson } from './registry-crypto';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// The cookie's NAME is shared with the host, which must recognise one; the SECRET is not, and
// stays here. See src/server/session.ts for why that file is on the other side.
import { readCookie, readSessionCookie, sessionCookieName } from '../server/session';
export { readCookie, readSessionCookie, sessionCookieName };
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Account {
  /** `acc_<24 hex>` — the registry's own id, never a provider's. */
  id: string;
  /** Which provider vouched for this person ('google'). */
  provider: string;
  /** The provider's stable subject id. Unique WITH `provider`, not on its own. */
  subject: string;
  /** Display only, and refreshed on every sign-in — people change these. */
  email?: string;
  name?: string;
  /** The PUBLIC handle: the only name that ever leaves to other people —
   *  attribution, member lists, published author. Chosen at first sign-in; the provider's real
   *  `name` stays private to the account's own screens. Unique, case-insensitively. */
  username?: string;
  createdAt: string;
  lastSeenAt: string;
  /**
   * Sessions issued before this moment no longer count (hardening). One field
   * instead of a session table: "sign out everywhere" is a timestamp bump, and there is nothing
   * to sweep, expire, or leave behind when it goes wrong.
   */
  sessionsInvalidBefore?: string;
}

/** What a provider tells us about the person who just signed in. */
export interface Identity {
  provider: string;
  subject: string;
  email?: string;
  name?: string;
}

interface Persisted {
  version: 1;
  accounts: Account[];
}

/**
 * Accounts on disk. Small enough to hold in memory and rewrite whole — the registry serves one
 * process, and a rewrite is atomic via rename so a crash mid-write cannot truncate the file.
 */
export class AccountStore {
  private readonly path: string | undefined;
  private readonly dek: Buffer | undefined;
  private accounts: Account[] = [];

  /** `undefined` path keeps everything in memory — for tests, and for a registry with no disk.
   *  `dek` (when a KEK is configured) encrypts the file at rest — it holds emails and subjects. */
  constructor(path?: string, dek?: Buffer) {
    this.path = path;
    this.dek = dek;
    if (path !== undefined && existsSync(path)) {
      try {
        const raw = readPrivateJson<Persisted>(path, dek);
        this.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      } catch {
        // A corrupt file must not take the registry down: publishing and reading are unaffected
        // by accounts, so an empty list degrades sign-in rather than the whole server.
        this.accounts = [];
      }
    }
  }

  private flush(): void {
    if (this.path === undefined) return;
    writePrivateJson(this.path, { version: 1, accounts: this.accounts } satisfies Persisted, this.dek);
  }

  get(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  /** Find by the identity a provider vouched for, or mint one. Display fields refresh. */
  upsert(identity: Identity, now: () => number = Date.now): Account {
    const at = new Date(now()).toISOString();
    const found = this.accounts.find((a) => a.provider === identity.provider && a.subject === identity.subject);
    if (found !== undefined) {
      found.lastSeenAt = at;
      if (identity.email !== undefined) found.email = identity.email;
      if (identity.name !== undefined) found.name = identity.name;
      this.flush();
      return found;
    }
    const account: Account = {
      id: `acc_${randomBytes(12).toString('hex')}`,
      provider: identity.provider,
      subject: identity.subject,
      ...(identity.email !== undefined ? { email: identity.email } : {}),
      ...(identity.name !== undefined ? { name: identity.name } : {}),
      createdAt: at,
      lastSeenAt: at,
    };
    this.accounts.push(account);
    this.flush();
    return account;
  }

  /**
   * Invalidate every session this account holds — the answer to a lost laptop.
   *
   * Before this the only lever was rotating `SESSION_SECRET`, which signs out EVERY account on
   * the instance: one person's stolen machine became everybody's problem, so the lever was too
   * expensive to pull and would not have been.
   */
  signOutEverywhere(accountId: string, now: () => number = Date.now): boolean {
    const account = this.get(accountId);
    if (account === undefined) return false;
    // A second into the future, so a session minted in this same millisecond by the very request
    // being signed out cannot survive on a rounding tie.
    account.sessionsInvalidBefore = new Date(now() + 1000).toISOString();
    this.flush();
    return true;
  }

  /** Is this handle free? Case-insensitive; a person keeping their own is not a collision. */
  usernameAvailable(username: string, forAccountId?: string): boolean {
    const norm = username.trim().toLowerCase();
    return !this.accounts.some((a) => a.id !== forAccountId && a.username?.toLowerCase() === norm);
  }

  /** Set the public handle. Returns false if taken; validity (shape) is the caller's to check. */
  setUsername(accountId: string, username: string): boolean {
    const account = this.get(accountId);
    if (account === undefined) return false;
    if (!this.usernameAvailable(username, accountId)) return false;
    account.username = username.trim();
    this.flush();
    return true;
  }

  /** Exposed for tests and for an operator counting heads; never serialised to a public page. */
  all(): readonly Account[] {
    return this.accounts;
  }
}

/** Where the account file lives beside the registry's index and bundles. */
export function accountsPath(dir: string): string {
  return join(dir, 'accounts.json');
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────
//
// A session is a signed statement of "this account, until this moment" — no server-side session
// table, because the registry already has exactly one thing worth storing and a second store
// that must be swept and expired is a liability for no gain. Rotating the secret invalidates
// every session, which is the intended emergency lever.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `<accountId>.<issuedAtMs>.<expiryMs>.<hmac>` — opaque to the client, verifiable without a
 * lookup. The ISSUE TIME is carried and signed so a session can be judged against an account's
 * `sessionsInvalidBefore` without a session table existing anywhere.
 */
export function signSession(accountId: string, secret: string, now: number = Date.now()): string {
  const body = `${accountId}.${now}.${now + SESSION_TTL_MS}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** The account id a cookie proves, or undefined — malformed, mis-signed, and expired are one
 *  answer on purpose: a caller that could tell them apart would leak which it was. */
export function verifySession(cookie: string | undefined, secret: string, now: number = Date.now()): string | undefined {
  if (cookie === undefined) return undefined;
  const parts = cookie.split('.');
  // Cookies in the older three-part shape simply fail here, which costs one re-sign-in and is
  // the honest outcome: a session that cannot be judged against a revocation must not pass.
  if (parts.length !== 4) return undefined;
  const [accountId, issuedRaw, expRaw, sig] = parts as [string, string, string, string];
  const expected = createHmac('sha256', secret).update(`${accountId}.${issuedRaw}.${expRaw}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return undefined;
  return accountId;
}

/**
 * When a cookie says it was issued. Only meaningful AFTER `verifySession` has accepted it — the
 * timestamp is inside the signature, so reading it from a verified cookie is reading a fact, and
 * reading it from an unverified one is reading whatever the client typed.
 */
export function sessionIssuedAt(cookie: string): number | undefined {
  const issued = Number(cookie.split('.')[1]);
  return Number.isFinite(issued) ? issued : undefined;
}

/** Whether a verified cookie predates this account's "sign out everywhere". */
export function sessionRevoked(cookie: string, account: Pick<Account, 'sessionsInvalidBefore'>): boolean {
  if (account.sessionsInvalidBefore === undefined) return false;
  const issued = sessionIssuedAt(cookie);
  return issued === undefined || issued < Date.parse(account.sessionsInvalidBefore);
}




/**
 * A Set-Cookie for a session. `secure` is off only for loopback development — a session cookie
 * sent over plaintext on a public host is the whole account.
 */
export function sessionCookie(value: string, opts: { secure: boolean; maxAgeMs?: number }): string {
  const age = Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  // SameSite=Lax, not Strict: the OAuth callback is a top-level GET arriving from the provider,
  // and Strict would withhold the cookie we just set on the way out.
  return [
    `${sessionCookieName(opts.secure)}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${age}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

/** The same cookie, cleared. */
export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAgeMs: 0 });
}
