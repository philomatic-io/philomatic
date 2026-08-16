/**
 * OAuth sign-in for the registry (the auth design), behind a seam.
 *
 * The seam exists for two reasons, and only one of them is "more providers later". The other is
 * that a provider is the one part of sign-in that cannot be exercised in a test: it needs real
 * credentials, a real redirect, and a real person clicking. So the flow — state, cookies,
 * account lookup, session — is written against `OAuthProvider` and tested against a fake, and
 * Google is one implementation of it that the tests never touch.
 *
 * Per the hosting design, a provider is CONFIG: unset credentials mean sign-in
 * is not offered, exactly as an absent LLM key or registry URL means those features are not
 * offered. Nothing here is philomatic.io-only.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Identity } from './accounts';

export interface OAuthProvider {
  /** Stable id, used in routes (`/auth/<id>`) and stored on the account. */
  readonly id: string;
  /** Human label for the sign-in button. */
  readonly label: string;
  /** Where to send the browser to ask this provider who the visitor is. */
  authorizeUrl(input: { state: string; redirectUri: string; challenge: string; nonce: string }): string;
  /** Trade the code the provider handed back for the identity behind it. */
  exchange(input: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<Identity>;
}

/** A random, unguessable value — the CSRF defence for the round trip through the provider. */
export function newState(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * A PKCE verifier and its challenge (RFC 7636), plus a nonce.
 *
 * PKCE is not only for public clients any more: OAuth 2.1 requires it of every authorization-code
 * flow, and it costs nothing here. It closes the window where an authorization code intercepted
 * between the provider and this server — a shared machine, a leaky proxy, a browser extension —
 * could be redeemed by whoever caught it. Only the holder of the verifier can spend the code, and
 * the verifier never leaves this process.
 *
 * The NONCE is the other half, and it defends something PKCE does not: it is echoed inside the
 * id_token, so a token minted for a DIFFERENT login attempt cannot be replayed into this one.
 */
export function newPkce(): { verifier: string; challenge: string; nonce: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
}

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Google, over the authorization-code flow.
 *
 * Scopes are `openid email profile` and nothing else — deliberately. Those are Google's
 * non-sensitive scopes, which is what keeps this app out of the verification queue: an app asking
 * only who you are needs no review, while one scope more (Gmail, Drive, Calendar) changes that.
 */
export function googleProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    id: 'google',
    label: 'Google',
    authorizeUrl: ({ state, redirectUri, challenge, nonce }) => {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Ask for the account chooser rather than silently reusing a signed-in Google account:
        // a shared machine should not sign someone in as the last person who used it.
        prompt: 'select_account',
      });
      return `${GOOGLE_AUTHORIZE}?${q.toString()}`;
    },
    exchange: async ({ code, redirectUri, verifier, nonce }) => {
      const res = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`google token exchange failed (${res.status})`);
      const body = (await res.json()) as { id_token?: string };
      if (typeof body.id_token !== 'string') throw new Error('google returned no id_token');
      return identityFromIdToken(body.id_token, clientId, Date.now(), nonce);
    },
  };
}

/**
 * The claims out of an ID token we fetched OURSELVES from the token endpoint.
 *
 * The signature is deliberately not verified here, and that is standards-sanctioned rather than a
 * shortcut: OpenID Connect Core.3.7 says a token received by direct communication between
 * the client and the token endpoint may be validated by TLS server authentication instead. We
 * made that request over TLS to a pinned URL with our own client secret, so a token in the
 * response came from Google or from someone who has already broken TLS — in which case a
 * signature check they could equally forge buys nothing.
 *
 * What IS checked is what TLS cannot tell us: that the token was minted for THIS client, by the
 * issuer we expect, and has not expired. `aud` is the one that matters — without it a token
 * Google issued for a different application would be accepted here.
 */
export function identityFromIdToken(idToken: string, clientId: string, now: number = Date.now(), nonce?: string): Identity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
    nonce?: string;
  };
  if (claims.iss === undefined || !GOOGLE_ISSUERS.has(claims.iss)) throw new Error('id_token: unexpected issuer');
  if (claims.aud !== clientId) throw new Error('id_token: not issued for this client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('id_token: expired');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('id_token: no subject');
  // Binds the token to THIS login attempt: one minted for another cannot be replayed into it.
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('id_token: nonce does not match this sign-in');
  return {
    provider: 'google',
    subject: claims.sub,
    // An unverified email is a claim about someone else's address; keep it off the account
    // rather than display it as though the provider vouched for it.
    ...(claims.email !== undefined && claims.email_verified === true ? { email: claims.email } : {}),
    ...(claims.name !== undefined ? { name: claims.name } : {}),
  };
}

/** Providers this deployment offers, from config. Empty means sign-in is not offered at all. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthProvider[] {
  const out: OAuthProvider[] = [];
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (id !== undefined && id !== '' && secret !== undefined && secret !== '') out.push(googleProvider(id, secret));
  return out;
}
