/**
 * Personal access tokens (the auth design).
 *
 * A session is for the registry's own pages, held in a browser. A token is for a PROGRAM acting
 * for you — the workbench publishing a track, and later a hosted workbench asking for your
 * library (the hosting design, where this token is the credential and no
 * separate key system exists).
 *
 * Three properties the format is chosen for:
 *
 *   `pmt_<id>.<secret>`
 *
 *   - **the id is public**, so a presented token names the one row to check. Without it, verifying
 *     means hashing against every token in the store — O(n) on every request, and a timing
 *     surface that grows with the number of users.
 *   - **`.` separates**, because base64url legitimately contains `-` and `_`, so splitting on an
 *     underscore would corrupt secrets at random.
 *   - **`pmt_` prefixes**, so a leaked token is greppable in logs and recognisable in a paste.
 *     Secret scanners key off prefixes exactly like this.
 *
 * The secret is hashed with a single pass of SHA-256, which looks like a shortcut and is not.
 * bcrypt/scrypt/argon2 exist to make GUESSING expensive, and are worth their cost only when the
 * input is a human-chosen password with maybe 30 bits of entropy. This secret is 256 bits from
 * `randomBytes`; there is nothing to guess, and a slow hash would buy only a slow server.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readPrivateJson, writePrivateJson } from './registry-crypto';
import { join } from 'node:path';

export interface AccessToken {
  /** `tok_<24 hex>` — public, carried in the token itself. */
  id: string;
  accountId: string;
  /** What the person called it, so they can tell two apart when revoking. */
  label: string;
  /** SHA-256 of the secret. The secret itself is never stored, anywhere. */
  hash: string;
  createdAt: string;
  /** Day-granularity, so "last used" can answer "is this one still in use?". */
  lastUsedAt?: string;
  revokedAt?: string;
}

/** What a caller may see about their own tokens — everything except the hash. */
export type TokenSummary = Omit<AccessToken, 'hash'>;

interface Persisted {
  version: 1;
  tokens: AccessToken[];
}

const PREFIX = 'pmt_';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

export class TokenStore {
  private readonly path: string | undefined;
  private readonly dek: Buffer | undefined;
  private tokens: AccessToken[] = [];
  private dirty = false;

  /** `dek` (when a KEK is configured) encrypts the file at rest — it holds token hashes. */
  constructor(path?: string, dek?: Buffer) {
    this.path = path;
    this.dek = dek;
    if (path !== undefined && existsSync(path)) {
      try {
        const raw = readPrivateJson<Persisted>(path, dek);
        this.tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
      } catch {
        // A corrupt file must fail CLOSED, unlike accounts: an unreadable token store means no
        // token verifies, which locks programs out. Losing the file would otherwise silently
        // grant nothing and look like a bad token, which is the right failure either way.
        this.tokens = [];
      }
    }
  }

  private flush(): void {
    if (this.path === undefined) {
      this.dirty = false;
      return;
    }
    // 0600 always (it holds token hashes), ciphertext when a KEK is in force. The atomic
    // rename + re-chmod is the writePrivateJson discipline; the format follows the DEK.
    writePrivateJson(this.path, { version: 1, tokens: this.tokens } satisfies Persisted, this.dek);
    this.dirty = false;
  }

  /**
   * Mint one. The secret is returned HERE and never again — not by `list`, not by any route.
   * A store that could show it again is a store that leaks every token when it leaks once.
   */
  mint(accountId: string, label: string, now: () => number = Date.now): { token: TokenSummary; secret: string } {
    const id = `tok_${randomBytes(12).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const token: AccessToken = {
      id,
      accountId,
      label: label.trim().slice(0, 60) || 'workbench',
      hash: hashSecret(secret),
      createdAt: new Date(now()).toISOString(),
    };
    this.tokens.push(token);
    this.flush();
    return { token: summary(token), secret: `${PREFIX}${id}.${secret}` };
  }

  /**
   * The account a presented token proves, or undefined. Unknown, malformed, mis-signed and
   * revoked are deliberately one answer: a caller who could tell them apart learns whether an id
   * exists, which is the first half of guessing one.
   */
  verify(presented: string | undefined, now: () => number = Date.now): string | undefined {
    if (presented === undefined || !presented.startsWith(PREFIX)) return undefined;
    const dot = presented.indexOf('.');
    if (dot < 0) return undefined;
    const id = presented.slice(PREFIX.length, dot);
    const secret = presented.slice(dot + 1);
    const token = this.tokens.find((t) => t.id === id);
    if (token === undefined || token.revokedAt !== undefined) return undefined;
    const a = Buffer.from(hashSecret(secret));
    const b = Buffer.from(token.hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    this.touch(token, now);
    return token.accountId;
  }

  /** Record use at day granularity, and only write when the day changes — this runs on every
   *  authenticated request, and a disk write per request would be a self-inflicted bottleneck. */
  private touch(token: AccessToken, now: () => number): void {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (token.lastUsedAt?.slice(0, 10) === today) return;
    token.lastUsedAt = new Date(now()).toISOString();
    this.dirty = true;
    this.flush();
  }

  /** One account's tokens, newest first. Never includes a hash — the type forbids it. */
  list(accountId: string): TokenSummary[] {
    return this.tokens
      .filter((t) => t.accountId === accountId)
      .map(summary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Revoke one of YOUR tokens. Scoped to the account on purpose: an id is public, so a route
   * that revoked by id alone would let anyone with a token id disable someone else's.
   * Idempotent — revoking twice is not an error, and neither is an id that was never yours.
   */
  revoke(accountId: string, tokenId: string, now: () => number = Date.now): boolean {
    const token = this.tokens.find((t) => t.id === tokenId && t.accountId === accountId);
    if (token === undefined || token.revokedAt !== undefined) return false;
    token.revokedAt = new Date(now()).toISOString();
    this.flush();
    return true;
  }

  /** Whether anything is waiting to be written — exposed so a shutdown can be sure. */
  get hasPendingWrites(): boolean {
    return this.dirty;
  }
}

function summary(t: AccessToken): TokenSummary {
  const { hash: _hash, ...rest } = t;
  return rest;
}

/** Beside the accounts file, in the registry's own directory. */
export function tokensPath(dir: string): string {
  return join(dir, 'tokens.json');
}

/** The `Authorization: Bearer …` a program presents, if it presented one. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m === null ? undefined : m[1];
}
