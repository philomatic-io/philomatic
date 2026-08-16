/**
 * Registry accounts and sign-in.
 *
 * The provider is the one part of sign-in that cannot be exercised here — it needs real
 * credentials, a real redirect and a real person clicking. So it sits behind a seam and these
 * tests drive a fake through the parts that CAN be wrong: the CSRF round trip, identity keyed on
 * the provider's subject rather than a mutable email, and a session cookie that cannot be forged
 * or replayed after expiry.
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRegistryServer } from '../src/registry/server';
import { AccountStore, sessionRevoked, signSession, verifySession, readCookie } from '../src/registry/accounts';
import { identityFromIdToken, type OAuthProvider } from '../src/registry/oauth';

const SECRET = 'test-session-secret';
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A provider that hands back whatever identity the test wants, without leaving the process. */
function fakeProvider(subject: string, extra: { email?: string; name?: string } = {}): OAuthProvider {
  return {
    id: 'fake',
    label: 'Fake',
    authorizeUrl: ({ state, redirectUri, challenge, nonce }) => `https://provider.invalid/auth?state=${state}&r=${encodeURIComponent(redirectUri)}&c=${challenge}&n=${nonce}`,
    exchange: async () => ({ provider: 'fake', subject, ...extra }),
  };
}

async function start(provider: OAuthProvider): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-reg-'));
  const server = createRegistryServer({
    dir,
    introHtml: false,
    providers: [provider],
    sessionSecret: SECRET,
    publicUrl: 'http://127.0.0.1',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('sessions', () => {
  it('a cookie proves an account, and a tampered one proves nothing', () => {
    const good = signSession('acc_1', SECRET);
    expect(verifySession(good, SECRET)).toBe('acc_1');
    // Swapping the account id keeps the shape and breaks the signature — which is the point.
    const forged = `acc_2.${good.split('.')[1]}.${good.split('.')[2]}`;
    expect(verifySession(forged, SECRET)).toBeUndefined();
    expect(verifySession(good, 'a-different-secret')).toBeUndefined();
    expect(verifySession('nonsense', SECRET)).toBeUndefined();
    expect(verifySession(undefined, SECRET)).toBeUndefined();
  });

  it('expires, and the expiry is signed so it cannot be extended', () => {
    const now = 1_000_000;
    const cookie = signSession('acc_1', SECRET, now);
    expect(verifySession(cookie, SECRET, now + 1000)).toBe('acc_1');
    expect(verifySession(cookie, SECRET, now + 31 * 24 * 60 * 60 * 1000)).toBeUndefined();
    // Rewriting the expiry to the far future invalidates the signature over it.
    const [id, , sig] = cookie.split('.') as [string, string, string];
    expect(verifySession(`${id}.9999999999999.${sig}`, SECRET, now)).toBeUndefined();
  });
});

describe('signing out everywhere', () => {
  it('ends sessions issued before it, and leaves later ones alone', () => {
    const store = new AccountStore();
    const acc = store.upsert({ provider: 'google', subject: 'sub-1' });
    const old = signSession(acc.id, SECRET, 1_000_000);
    expect(sessionRevoked(old, store.get(acc.id)!)).toBe(false);

    store.signOutEverywhere(acc.id, () => 2_000_000);
    expect(sessionRevoked(old, store.get(acc.id)!)).toBe(true);
    // Signing in again afterwards works — this ends sessions, it does not disable the account.
    const fresh = signSession(acc.id, SECRET, 5_000_000);
    expect(sessionRevoked(fresh, store.get(acc.id)!)).toBe(false);
  });

  it('is per ACCOUNT — one stolen laptop is not everybody’s problem', () => {
    // The lever before this was rotating SESSION_SECRET, which signs out every account on the
    // instance: too expensive to pull, so it would not have been pulled.
    const store = new AccountStore();
    const mine = store.upsert({ provider: 'google', subject: 'sub-1' });
    const theirs = store.upsert({ provider: 'google', subject: 'sub-2' });
    const theirSession = signSession(theirs.id, SECRET, 1_000_000);
    store.signOutEverywhere(mine.id, () => 2_000_000);
    expect(sessionRevoked(theirSession, store.get(theirs.id)!)).toBe(false);
  });

  it('the issue time is SIGNED, so it cannot be pushed forward to survive', () => {
    const cookie = signSession('acc_1', SECRET, 1_000);
    const [id, , exp, sig] = cookie.split('.') as [string, string, string, string];
    // Rewriting the issue time to after the cutoff breaks the signature over it.
    expect(verifySession(`${id}.9999999999999.${exp}.${sig}`, SECRET, 2_000)).toBeUndefined();
  });
});

describe('accounts', () => {
  it('are keyed on provider + subject, never the email', () => {
    const store = new AccountStore();
    const first = store.upsert({ provider: 'google', subject: 'sub-1', email: 'old@example.com', name: 'Bob' });
    // Same person, new address: the SAME account, with the display fields refreshed.
    const again = store.upsert({ provider: 'google', subject: 'sub-1', email: 'new@example.com', name: 'Bob' });
    expect(again.id).toBe(first.id);
    expect(again.email).toBe('new@example.com');
    expect(store.all()).toHaveLength(1);

    // A different subject at the SAME address is a different person — an email is not identity.
    const other = store.upsert({ provider: 'google', subject: 'sub-2', email: 'new@example.com' });
    expect(other.id).not.toBe(first.id);
    // …and so is the same subject from another provider.
    expect(store.upsert({ provider: 'github', subject: 'sub-1' }).id).not.toBe(first.id);
    expect(store.all()).toHaveLength(3);
  });

  it('survive a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-acc-'));
    const path = join(dir, 'accounts.json');
    const id = new AccountStore(path).upsert({ provider: 'google', subject: 'sub-1' }).id;
    expect(new AccountStore(path).get(id)?.subject).toBe('sub-1');
  });
});

describe('the sign-in round trip', () => {
  it('sends you to the provider with a state it parked in a cookie', async () => {
    const url = await start(fakeProvider('sub-1'));
    const res = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state');
    expect(state).not.toBeNull();
    // The cookie carries state, the PKCE verifier and the nonce — the verifier is what makes an
    // intercepted authorization code useless to whoever caught it.
    const parked = readCookie(res.headers.get('set-cookie') ?? undefined, 'pm_oauth_state')!.split('.');
    expect(parked[0]).toBe(state);
    // state . verifier . nonce. A requested return path adds a base64url fourth field;
    // with no `next`, as here, the cookie is exactly the three fields.
    expect(parked).toHaveLength(3);
    expect(new URL(res.headers.get('location')!).searchParams.get('c')).toBeTruthy();
    // The redirect URI must be the one the provider has registered — built from publicUrl.
    expect(new URL(res.headers.get('location')!).searchParams.get('r')).toBe('http://127.0.0.1/auth/fake/callback');
  });

  it('completes with the right state and signs you in', async () => {
    const url = await start(fakeProvider('sub-1', { email: 'bob@example.com', name: 'Bob' }));
    const started = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${url}/auth/fake/callback?code=xyz&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
    expect(back.status).toBe(302);
    const session = readCookie((back.headers.getSetCookie?.() ?? []).join('; '), 'pm_session');
    expect(session).toBeDefined();
    expect(verifySession(session, SECRET)).toMatch(/^acc_/);

    const me = await (await fetch(`${url}/auth/me`, { headers: { cookie: `pm_session=${session}` } })).json();
    expect(me.signedIn).toBe(true);
    expect(me.account.email).toBe('bob@example.com');
    // The provider's subject is the join key to that provider's directory; no page needs it.
    expect(JSON.stringify(me)).not.toContain('sub-1');
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    const url = await start(fakeProvider('sub-1'));
    const started = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    // The attacker's own state, and the victim's cookie: the pair is what must agree.
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const res = await fetch(`${url}/auth/fake/callback?code=xyz&state=attacker`, { redirect: 'manual', headers: { cookie: parked } });
    expect(res.status).toBe(400);
    // …and with no cookie at all, which is a callback nobody here started.
    expect((await fetch(`${url}/auth/fake/callback?code=xyz&state=${state}`, { redirect: 'manual' })).status).toBe(400);
  });

  it('answers /auth/me for a signed-OUT visitor rather than erroring', async () => {
    const url = await start(fakeProvider('sub-1'));
    const me = await (await fetch(`${url}/auth/me`)).json();
    expect(me.signedIn).toBe(false);
    expect(me.providers).toEqual([{ id: 'fake', label: 'Fake' }]);
  });

  it('is ABSENT, not half-present, when the deployment offers no provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-reg-'));
    const server = createRegistryServer({ dir, introHtml: false, providers: [], sessionSecret: SECRET, publicUrl: 'http://127.0.0.1' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/auth/google`, { redirect: 'manual' })).status).toBe(404);
    expect((await (await fetch(`${url}/auth/me`)).json()).providers).toEqual([]);
  });
});

describe('the Google id_token, checked for what TLS cannot tell us', () => {
  const token = (claims: Record<string, unknown>) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const base = { iss: 'https://accounts.google.com', aud: 'client-1', sub: 'sub-1', exp: 2_000 };

  it('accepts a well-formed token for this client', () => {
    const id = identityFromIdToken(token({ ...base, email: 'b@x.com', email_verified: true, name: 'Bob' }), 'client-1', 1_000_000);
    expect(id).toEqual({ provider: 'google', subject: 'sub-1', email: 'b@x.com', name: 'Bob' });
  });

  it('refuses a token minted for a DIFFERENT application', () => {
    // The one check that matters most: without it, any Google app's token would sign someone in.
    expect(() => identityFromIdToken(token(base), 'client-1', 1_000_000)).not.toThrow();
    expect(() => identityFromIdToken(token({ ...base, aud: 'someone-else' }), 'client-1', 1_000_000)).toThrow(/this client/);
  });

  it('refuses another issuer, an expired token, and a subjectless one', () => {
    expect(() => identityFromIdToken(token({ ...base, iss: 'https://evil.example' }), 'client-1', 1_000_000)).toThrow(/issuer/);
    expect(() => identityFromIdToken(token({ ...base, exp: 1 }), 'client-1', 1_000_000)).toThrow(/expired/);
    expect(() => identityFromIdToken(token({ ...base, sub: '' }), 'client-1', 1_000_000)).toThrow(/subject/);
    expect(() => identityFromIdToken('not-a-jwt', 'client-1', 1_000_000)).toThrow(/malformed/);
  });

  it('drops an UNVERIFIED email rather than displaying it as vouched for', () => {
    const id = identityFromIdToken(token({ ...base, email: 'someone@else.com', email_verified: false }), 'client-1', 1_000_000);
    expect(id.email).toBeUndefined();
  });
});
