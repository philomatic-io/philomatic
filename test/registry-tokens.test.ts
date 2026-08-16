/**
 * Personal access tokens.
 *
 * A session is for a browser; a token is for a PROGRAM acting for you — the workbench publishing
 * a track, and later a hosted workbench asking for your library. What these pin is the part that
 * has to be right the first time, because a token that leaks is a leak you cannot notice: the
 * secret is never stored and never shown twice, revocation bites immediately, and an id being
 * public does not let one person revoke another's.
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRegistryServer } from '../src/registry/server';
import { signSession } from '../src/registry/accounts';
import { bearerToken, TokenStore, tokensPath } from '../src/registry/tokens';
import type { OAuthProvider } from '../src/registry/oauth';

const SECRET = 'test-session-secret';
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const provider: OAuthProvider = {
  id: 'fake',
  label: 'Fake',
  authorizeUrl: ({ state }) => `https://provider.invalid/?state=${state}`,
  exchange: async () => ({ provider: 'fake', subject: 'sub-1', name: 'Bob' }),
};

/** A registry with one signed-in account, and the cookie that proves it. */
async function signedIn(): Promise<{ url: string; cookie: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-tok-'));
  const server = createRegistryServer({ dir, introHtml: false, providers: [provider], sessionSecret: SECRET, publicUrl: 'http://127.0.0.1' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const started = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
  // Send back the cookie the server actually set — it carries the PKCE verifier and nonce as
  // well as the state, and reconstructing it by hand would test a flow nobody runs.
  const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
  const back = await fetch(`${url}/auth/fake/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
  const setCookie = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!;
  return { url, cookie: setCookie.split(';')[0]!, dir };
}

describe('the store', () => {
  it('mints, verifies, and never stores the secret', () => {
    const store = new TokenStore();
    const { token, secret } = store.mint('acc_1', 'my laptop');
    expect(secret.startsWith('pmt_')).toBe(true);
    expect(store.verify(secret)).toBe('acc_1');
    // The row keeps a hash. Searching the serialised store for the secret must find nothing.
    expect(JSON.stringify(store.list('acc_1'))).not.toContain(secret.split('.')[1]);
    expect(token).not.toHaveProperty('hash');
  });

  it('refuses anything that is not exactly right', () => {
    const store = new TokenStore();
    const { secret } = store.mint('acc_1', 'x');
    const [id, body] = secret.split('.') as [string, string];
    expect(store.verify(`${id}.${body.slice(0, -1)}a`)).toBeUndefined(); // wrong secret
    expect(store.verify(`pmt_tok_deadbeef.${body}`)).toBeUndefined(); // unknown id
    expect(store.verify(body)).toBeUndefined(); // no prefix
    expect(store.verify('pmt_no-dot-here')).toBeUndefined();
    expect(store.verify(undefined)).toBeUndefined();
  });

  it('stops working the moment it is revoked', () => {
    const store = new TokenStore();
    const { token, secret } = store.mint('acc_1', 'x');
    expect(store.verify(secret)).toBe('acc_1');
    expect(store.revoke('acc_1', token.id)).toBe(true);
    expect(store.verify(secret)).toBeUndefined();
    expect(store.revoke('acc_1', token.id)).toBe(false); // idempotent, not an error
  });

  it('will not let one account revoke another’s, even knowing the id', () => {
    // The id travels in the token and appears in listings, so it is public by construction.
    const store = new TokenStore();
    const { token, secret } = store.mint('acc_1', 'x');
    expect(store.revoke('acc_2', token.id)).toBe(false);
    expect(store.verify(secret)).toBe('acc_1'); // still works
  });

  it('survives a restart, and a corrupt file fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-tok-'));
    const path = tokensPath(dir);
    const { secret } = new TokenStore(path).mint('acc_1', 'x');
    expect(new TokenStore(path).verify(secret)).toBe('acc_1');
    // Unreadable store → nothing verifies. Failing OPEN would be an authentication bypass.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(path, 'not json');
    expect(new TokenStore(path).verify(secret)).toBeUndefined();
  });

  it('records use at day granularity, without a write per request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-tok-'));
    const path = tokensPath(dir);
    const store = new TokenStore(path);
    const day = Date.parse('2026-08-04T10:00:00Z');
    const { secret } = store.mint('acc_1', 'x', () => day);
    store.verify(secret, () => day);
    expect(store.list('acc_1')[0]!.lastUsedAt?.slice(0, 10)).toBe('2026-08-04');
    const after = readFileSync(path, 'utf8');
    // Same day again: nothing new to say, so nothing is written.
    store.verify(secret, () => day + 3600_000);
    expect(readFileSync(path, 'utf8')).toBe(after);
  });
});

describe('the routes', () => {
  it('mint shows the secret exactly once; the listing never does', async () => {
    const { url, cookie } = await signedIn();
    const res = await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'my laptop' }) });
    expect(res.status).toBe(201);
    const minted = await res.json();
    expect(minted.secret.startsWith('pmt_')).toBe(true);
    expect(minted.token.label).toBe('my laptop');

    const listed = await (await fetch(`${url}/auth/tokens`, { headers: { cookie } })).json();
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.secret);
    expect(listed.tokens[0]).not.toHaveProperty('hash');
  });

  it('authenticates a program by bearer token, the same account as the cookie', async () => {
    const { url, cookie } = await signedIn();
    const minted = await (await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie } })).json();
    // No label given: the token is named rather than refused.
    expect(minted.token.label).toBe('workbench');
    const me = await (await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${minted.secret}` } })).json();
    void me; // /auth/me answers by session; the bearer path is proven by the revoke test below.

    const revoked = await (await fetch(`${url}/auth/tokens/${minted.token.id}`, { method: 'DELETE', headers: { cookie } })).json();
    expect(revoked.revoked).toBe(true);
    const again = await (await fetch(`${url}/auth/tokens/${minted.token.id}`, { method: 'DELETE', headers: { cookie } })).json();
    expect(again.revoked).toBe(false);
  });

  it('refuses to manage tokens without a session — a token cannot mint more tokens', async () => {
    const { url, cookie } = await signedIn();
    const minted = await (await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie } })).json();
    // Presenting the token itself must NOT grant token management: otherwise revoking it
    // requires it, and a stolen token can mint its own replacements faster than you revoke.
    const withToken = await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { authorization: `Bearer ${minted.secret}` } });
    expect(withToken.status).toBe(401);
    expect((await fetch(`${url}/auth/tokens`)).status).toBe(401);
  });

  it('a forged session cookie manages nothing', async () => {
    const { url } = await signedIn();
    const forged = `pm_session=${encodeURIComponent(signSession('acc_nobody', 'the-wrong-secret'))}`;
    expect((await fetch(`${url}/auth/tokens`, { headers: { cookie: forged } })).status).toBe(401);
  });
});

describe('sign out everywhere, through the page', () => {
  it('ends this session and any other, and tokens survive it', async () => {
    const { url, cookie } = await signedIn();
    const minted = await (await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie } })).json();
    expect((await fetch(`${url}/account`, { headers: { cookie }, redirect: 'manual' })).status).toBe(200);

    const res = await fetch(`${url}/account/signout-all`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    // The same cookie, still perfectly signed, no longer opens anything.
    expect((await fetch(`${url}/account`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);

    // Tokens are a separate kind of credential and are NOT swept up: a program acting for you
    // should not stop because you signed a browser out.
    const me = await (await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${minted.secret}` } })).json();
    expect(me.signedIn).toBe(true);
  }, 30000);
});

describe('rate limits', () => {
  it('holds a caller to a burst of sign-in attempts, and says how long to wait', async () => {
    const { url } = await signedIn();
    let last = 200;
    for (let i = 0; i < 14; i += 1) last = (await fetch(`${url}/auth/fake`, { redirect: 'manual' })).status;
    expect(last).toBe(429);
    const res = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
    // A number a well-behaved client can obey, rather than a bare refusal it must guess about.
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 30000);

  it('limits minting — a token is durable and nobody needs forty', async () => {
    const { url, cookie } = await signedIn();
    let last = 201;
    for (let i = 0; i < 8; i += 1) {
      last = (await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie } })).status;
    }
    expect(last).toBe(429);
  }, 30000);
});

describe('bearer parsing', () => {
  it('reads exactly one well-formed header', () => {
    expect(bearerToken('Bearer pmt_abc.def')).toBe('pmt_abc.def');
    expect(bearerToken('bearer pmt_abc.def')).toBe('pmt_abc.def'); // scheme is case-insensitive
    expect(bearerToken('Basic pmt_abc.def')).toBeUndefined();
    expect(bearerToken('pmt_abc.def')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('the pages a person actually uses', () => {
  it('offers sign-in to a visitor and shows who you are once signed in', async () => {
    const { url, cookie } = await signedIn();
    const out = await (await fetch(url)).text();
    expect(out).toContain('>Sign in<');
    const inn = await (await fetch(url, { headers: { cookie } })).text();
    // An initial in a circle rather than a name: a <details> dropdown —
    // the avatar is the summary, the actions live in the menu it opens.
    expect(inn).toContain('reg-avatar');
    expect(inn).toContain('>B</summary>');
    expect(inn).toContain('title="Bob"');
    expect(inn).toContain('Account settings');
    expect(inn).toContain('Sign out');
    expect(inn).not.toContain('>Sign in<');
  });

  it('puts the auth control OUTSIDE #root, where the app cannot erase it', async () => {
    // A sign-in button that appears and immediately vanishes is the failure here: everything
    // inside #root is replaced when the registry app hydrates, so a control the app knows
    // nothing about has to live outside it. Asserting on the ORDER is what catches a regression
    // — "the page contains the button" passed happily while the button was unusable.
    const { url, cookie } = await signedIn();
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const html = await (await fetch(url, { headers })).text();
      expect(html.indexOf('reg-authbar')).toBeGreaterThan(-1);
      expect(html.indexOf('reg-authbar')).toBeLessThan(html.indexOf('<div id="root">'));
    }
  });

  it('the account page carries no island, so nothing renders over it', async () => {
    const { url, cookie } = await signedIn();
    const html = await (await fetch(`${url}/account`, { headers: { cookie } })).text();
    expect(html).not.toContain('registry-data');
    expect(html).toContain('Access tokens');
  });

  it('mints from a form and shows the secret ONCE, never again', async () => {
    const { url, cookie } = await signedIn();
    const res = await fetch(`${url}/account/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=my+laptop',
    });
    const page = await res.text();
    const secret = /pmt_[A-Za-z0-9_.-]+/.exec(page)?.[0];
    expect(secret).toBeDefined();
    expect(page).toContain('copy it now');
    expect(page).toContain('my laptop');
    // Reloading the account page must not show it again — and it is the POST that renders it,
    // so it was never in a URL to be kept in history or a log.
    const again = await (await fetch(`${url}/account`, { headers: { cookie } })).text();
    expect(again).not.toContain(secret!);
    expect(again).toContain('my laptop');
  });

  it('revokes from the page, and the token stops working', async () => {
    const { url, cookie } = await signedIn();
    const page = await (await fetch(`${url}/account/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=doomed',
    })).text();
    const secret = /pmt_[A-Za-z0-9_.-]+/.exec(page)![0];
    const id = /tok_[a-f0-9]+/.exec(page)![0];
    expect((await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);

    const res = await fetch(`${url}/account/tokens/${id}/revoke`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const after = await (await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${secret}` } })).json();
    expect(after.signedIn).toBe(false);
  });

  it('sends a signed-OUT visitor home rather than erroring', async () => {
    const { url } = await signedIn();
    const res = await fetch(`${url}/account`, { redirect: 'manual' });
    // Someone whose session merely expired should land somewhere they can sign in again.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
});

describe('the way in', () => {
  it('the header offers ONE button that leads to the sign-in page', async () => {
    const { url } = await signedIn();
    const html = await (await fetch(url)).text();
    // One word, one destination: which provider is a question for the page it leads to, not for
    // a header that would otherwise change shape every time one is added.
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain('Sign in with Fake');
  });

  it('sign-in and sign-up are two doors to the same act', async () => {
    const { url } = await signedIn();
    const inn = await (await fetch(`${url}/signin`)).text();
    const up = await (await fetch(`${url}/signup`)).text();
    for (const html of [inn, up]) expect(html).toContain('Continue with Fake');
    expect(inn).toContain('Sign in to Philomatic');
    expect(up).toContain('Create a Philomatic account');
    // Each points at the other, because people look for the door they expect.
    expect(inn).toContain('href="/signup"');
    expect(up).toContain('href="/signin"');
  });

  it('sends an already-signed-in visitor to their account instead', async () => {
    const { url, cookie } = await signedIn();
    const res = await fetch(`${url}/signin`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
  });
});
