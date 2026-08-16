/**
 * Whose library is this request about? (the hosting design)
 *
 * Today the server opens one database chosen at startup, so everyone who connects sees the same
 * library — hand a beta user the `INGEST_TOKEN` and they are looking at yours. Hosting needs one
 * further answer, and the standing commitment fixes its shape: *tenancy is enforced
 * at the transport boundary that decides which learner's graph a request may touch*, with no
 * `learner_id` inside the frozen core. So it is one FILE per account, chosen out here.
 *
 * Two things live in this file, and they are separate on purpose:
 *
 *   - **the resolver** turns a request into a tenant, and answers ONLY "which library". It does
 *     not authenticate in single-tenant mode: "may you?" is `requireToken`, which sits inside the
 *     router after the deliberately public routes have returned. Conflating the two put a token
 *     in front of published pages, which three tests caught immediately. Hosted
 *     mode is the exception and cannot avoid it — the credential IS the library selector there.
 *   - **the pool** keeps opened databases around. The server cannot open every file at startup
 *     (it does not know who will arrive) and must not reopen per request.
 *
 * On concurrency: `better-sqlite3` is synchronous and Node is single-threaded, so two requests
 * cannot interleave *inside* a query and there is no write-tearing to defend against. What the
 * pool must defend against is eviction — an async handler awaits between engine calls, so a
 * sweeper could otherwise close a database out from under one. Hence borrowing.
 */
import type { IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import { readSessionCookie } from './session';
import { safeChild } from './safe-path';
import { createHash } from 'node:crypto';
import { PhilomaticEngine } from '../engine';

/** The library a request is entitled to touch. */
export interface Tenant {
  /** The account it belongs to, or `'local'` in single-tenant mode. */
  accountId: string;
  dbPath: string;
  /**
   * Does a hosted library actually EXIST for this account?
   *
   * Signing in must not silently start storing someone's reading on our disk — a person who
   * believes they are using the in-browser engine, and is, should not discover later that a
   * server has been keeping a copy. So provisioning is a deliberate act, and this says whether
   * it has happened. The FILE's existence is the record: no extra state to drift, and a library
   * restored from backup is provisioned again by virtue of being there.
   *
   * Single-tenant mode is always true — that server was started with a database.
   */
  provisioned: boolean;
}

export interface TenantResolver {
  /** The tenant for this request, or undefined — which the caller turns into a 401. */
  resolve(req: IncomingMessage): Promise<Tenant | undefined>;
}

/**
 * The token a caller presented, from either header it might arrive in.
 *
 * `Authorization: Bearer` is what a program sends and what the registry's own routes speak.
 * `X-Ingest-Token` is what the WORKBENCH sends — it is the header the client has always used and
 * the one a user's pasted token ends up in (`ui/src/client/transport.ts`). Accepting both is what
 * lets an unchanged workbench point at a hosted server: the same string a learner pastes into
 * Settings for a single-tenant box selects their library on a hosted one.
 */
export function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const m = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (m !== null) return m[1];
  const direct = req.headers['x-ingest-token'];
  return typeof direct === 'string' && direct !== '' ? direct : undefined;
}

/**
 * One library — today's behaviour, unchanged. A laptop must experience exactly what it
 * does now, so this is the default and the hosted path is opt-in.
 *
 * It authenticates NOTHING, deliberately. In single-tenant mode "may you?" is already answered
 * by `requireToken` inside the router, AFTER the deliberately public routes have returned —
 * /health, /framework, the UI files, and published /t/<id> bundles.
 * Moving that check out here would put a token in front of a published page, which is the one
 * thing it must never guard. Two questions, two places: this one answers only *which library*.
 */
export function singleTenant(dbPath: string): TenantResolver {
  // Always provisioned: this server was STARTED with a database, so there is nothing to opt in
  // to and no way to be surprised by storage you did not ask for.
  return { resolve: async () => ({ accountId: 'local', dbPath, provisioned: true }) };
}

/** Asks something else "whose token is this?" — see `registryVerifier`. */
export type TokenVerifier = (token: string) => Promise<string | undefined>;

/**
 * Whose SESSION is this?
 *
 * The same question as `registryVerifier`, asked with a cookie instead of a bearer token — and
 * asked for the same reason. The host COULD verify the HMAC itself if it held `SESSION_SECRET`,
 * but then the signing key would live in two processes and the host would still have to ask
 * about revocation, since "sign out everywhere" is a fact only the registry knows. One question
 * answers both, and one process keeps the secret.
 */
export function sessionVerifier(registryUrl: string, fetchImpl: typeof fetch = fetch): TokenVerifier {
  const base = registryUrl.trim().replace(/\/$/, '');
  return (cookieValue) =>
    askAuthMe(fetchImpl, base, {
      // Sent under BOTH names: the host cannot tell from the request whether the registry sits
      // behind TLS, and the registry reads either (see sessionCookieName).
      cookie: `pm_session=${encodeURIComponent(cookieValue)}; __Host-pm_session=${encodeURIComponent(cookieValue)}`,
    });
}

/** The one /auth/me question both verifiers ask — only the credential header differs. */
async function askAuthMe(fetchImpl: typeof fetch, base: string, headers: Record<string, string>): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${base}/auth/me`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { signedIn?: boolean; account?: { id?: string } };
    return body.signedIn === true && typeof body.account?.id === 'string' ? body.account.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask a registry. The host may not read the registry's token store directly: the lock line
 * keeps `src/server` out of `src/registry`, and a registry and a host must stay
 * separable boxes. So this is an HTTP question with an HTTP answer.
 *
 * A failure to REACH the registry is not an authentication failure, but it is treated as one
 * here: the alternative is a host that keeps serving libraries while the thing that says who
 * owns them is unreachable.
 */
export function registryVerifier(registryUrl: string, fetchImpl: typeof fetch = fetch): TokenVerifier {
  const base = registryUrl.trim().replace(/\/$/, '');
  return (token) => askAuthMe(fetchImpl, base, { authorization: `Bearer ${token}` });
}

/**
 * Remember an answer for a while, so a hosted request does not cost an HTTP round trip to the
 * registry. Without this, every click a hosted user makes waits on another server —
 * which is both slow and a hard dependency on the registry being up for reads it has already
 * answered.
 *
 * The TTL *is* the revocation delay, and that is the trade being made: a revoked token keeps
 * working for at most this long. Sixty seconds is chosen so revocation is fast enough to be
 * meaningful while a busy library costs the registry one call a minute rather than thousands.
 *
 * Failures are cached far more briefly. A token minted seconds ago must not be locked out for a
 * minute because it was tried once before the registry saw it, and a registry that just came back
 * up should be retried promptly rather than treated as down for a minute.
 *
 * Keys are HASHED: this map lives as long as the process, and a heap dump that yields working
 * credentials is a worse day than one that yields hashes.
 */
export function cachedVerifier(
  verify: TokenVerifier,
  opts: { ttlMs?: number; negativeTtlMs?: number; now?: () => number } = {},
): TokenVerifier {
  const ttl = opts.ttlMs ?? 60_000;
  const negativeTtl = opts.negativeTtlMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const seen = new Map<string, { accountId: string | undefined; until: number }>();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('base64url');
    const hit = seen.get(key);
    if (hit !== undefined && hit.until > now()) return hit.accountId;
    const accountId = await verify(token);
    seen.set(key, { accountId, until: now() + (accountId === undefined ? negativeTtl : ttl) });
    // The map would otherwise grow with every token ever presented, valid or not — which is a
    // memory leak an attacker can drive by presenting garbage.
    if (seen.size > 4096) for (const [k, v] of seen) if (v.until <= now()) seen.delete(k);
    return accountId;
  };
}

/**
 * Several libraries, one per account. The credential is a personal access token —
 * there is no separate key list to maintain, because the accounts store already holds one.
 *
 * The database is created on first request: sign up, generate a token, paste it in, and
 * the library exists. Nothing is handed out by an administrator.
 */
export function hostedTenants(opts: {
  dataDir: string;
  verify: TokenVerifier;
  /** Whose SESSION cookie is this? Absent = cookies are not accepted (token-only host). */
  verifySession?: TokenVerifier;
}): TenantResolver {
  return {
    resolve: async (req) => {
      // A token is deliberate; a cookie is ambient. Token first, so a CLI or extension request
      // that carries both is treated as the deliberate thing it is.
      const token = presentedToken(req);
      const cookie = readSessionCookie(req.headers.cookie);
      const accountId =
        token !== undefined
          ? await opts.verify(token)
          : cookie !== undefined && opts.verifySession !== undefined
            ? await opts.verifySession(cookie)
            : undefined;
      if (accountId === undefined) return undefined;
      // The account id is the filename, and it is ours: `acc_<hex>` from the registry, never a
      // provider's subject and never anything a user chose. Still checked, because a filename
      // built from a remote answer is a path-traversal waiting for the day that answer is
      // wrong.
      if (!/^acc_[a-z0-9]+$/.test(accountId)) return undefined;
      const dbPath = safeChild(opts.dataDir, `${accountId}.sqlite`);
      return { accountId, dbPath, provisioned: existsSync(dbPath) };
    },
  };
}

/**
 * Databases held open between requests, closed when idle.
 *
 * `withEngine` BORROWS: the sweeper will not close a database a request still holds, because an
 * async handler awaits between engine calls and would otherwise find its engine closed
 * mid-flight. Borrowing is what makes idle eviction safe rather than a race.
 */
export class EnginePool {
  private readonly open = new Map<string, { engine: PhilomaticEngine; borrowed: number; lastUsed: number }>();
  private readonly cap: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(opts: { cap?: number; idleMs?: number; now?: () => number } = {}) {
    // A cap, because file handles are finite and the failure without one lands on whoever
    // connects NEXT — which looks random and is miserable to diagnose.
    this.cap = opts.cap ?? 64;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Run `fn` against the engine for `dbPath`, opening it if needed and holding it meanwhile. */
  async withEngine<T>(dbPath: string, fn: (engine: PhilomaticEngine) => T | Promise<T>): Promise<T> {
    let entry = this.open.get(dbPath);
    if (entry === undefined) {
      this.evictIdle();
      if (this.open.size >= this.cap) {
        throw new Error(`too many libraries open at once (cap ${this.cap}) — raise the cap or shorten the idle timeout`);
      }
      entry = { engine: PhilomaticEngine.open(dbPath), borrowed: 0, lastUsed: this.now() };
      this.open.set(dbPath, entry);
    }
    entry.borrowed += 1;
    try {
      return await fn(entry.engine);
    } finally {
      entry.borrowed -= 1;
      entry.lastUsed = this.now();
    }
  }

  /** Close what nobody is using and nobody has used lately. Safe to call at any time. */
  evictIdle(): number {
    const cutoff = this.now() - this.idleMs;
    let closed = 0;
    for (const [path, entry] of [...this.open]) {
      if (entry.borrowed > 0 || entry.lastUsed > cutoff) continue;
      entry.engine.close();
      this.open.delete(path);
      closed += 1;
    }
    return closed;
  }

  /**
   * Drop one library NOW — for a revoked token, so the next request reopens rather than
   * reusing a handle opened under a credential that has since been withdrawn. A borrowed engine
   * is left to its in-flight request and simply forgotten by the pool.
   */
  drop(dbPath: string): boolean {
    const entry = this.open.get(dbPath);
    if (entry === undefined) return false;
    this.open.delete(dbPath);
    if (entry.borrowed === 0) entry.engine.close();
    return true;
  }

  /** Close everything on shutdown, so nothing is left half-written. */
  closeAll(): void {
    for (const [, entry] of this.open) entry.engine.close();
    this.open.clear();
  }

  /** How many are open — for a health route, and for tests. */
  get size(): number {
    return this.open.size;
  }
}

/**
 * The browser-ambient-write guard's SHARED CORE: is this request's origin acceptable for a
 * cookie-authed write? `Sec-Fetch-Site` first (it states the relationship directly); the
 * Origin/Host string comparison only where the browser didn't send it; no-browser requests
 * pass. Both the instance and the registry gate writes with exactly this chain — one
 * implementation, two callers.
 */
export function originAllowed(req: import('node:http').IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (origin === undefined) return true; // no browser involved
  const host = req.headers.host;
  return host !== undefined && (origin === `https://${host}` || origin === `http://${host}`);
}
