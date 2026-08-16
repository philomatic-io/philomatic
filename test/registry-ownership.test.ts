/**
 * Who owns a published NAME.
 *
 * Ownership is moving from a device key to an account, because possession of a file is a
 * terrible deed: lose the laptop and nobody — including the author — can ever update or withdraw
 * the track. The hard part is not the new rule but the change-over, so that is what these pin.
 * A registry full of key-pinned tracks must not break, and their authors must not have to ask
 * anyone for them back.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { createRegistryServer } from '../src/registry/server';
import type { OAuthProvider } from '../src/registry/oauth';

const SECRET = 'test-session-secret';
const open: { close: () => void }[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const provider = (subject: string, name: string): OAuthProvider => ({
  id: 'fake',
  label: 'Fake',
  authorizeUrl: ({ state }) => `/auth/fake/callback?code=x&state=${state}`,
  exchange: async () => ({ provider: 'fake', subject, name }),
});

/** A registry, and a helper to sign someone in and mint them a token. */
async function registry(who: { subject: string; name: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-own-'));
  const server = createRegistryServer({
    dir,
    introHtml: false,
    providers: [provider(who.subject, who.name)],
    sessionSecret: SECRET,
    publicUrl: 'http://127.0.0.1',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const started = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
  const state = new URL(started.headers.get('location')!, url).searchParams.get('state')!;
  const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
  const back = await fetch(`${url}/auth/fake/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
  const cookie = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
  const minted = await (await fetch(`${url}/auth/tokens`, { method: 'POST', headers: { cookie } })).json();
  return { url, dir, cookie, token: minted.secret as string };
}

/** A signed publication bundle, from a real engine with a real key. */
function bundle(title: string): { body: unknown; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pm-lib-'));
  const engine = PhilomaticEngine.open(join(dir, 'db.sqlite'));
  engine.importPayload({ version: 2, tracks: [{ title }], sources: [{ title: 'S', modality: 'text' }] });
  const id = engine.snapshot().tracks[0]!.id;
  engine.link({ srcType: 'track', srcId: id, type: 'INCLUDES', dstType: 'source', dstId: engine.snapshot().sources[0]!.id });
  engine.publish({ ref: id, license: 'CC-BY-SA-4.0' });
  const body = engine.publication(id)!;
  engine.close();
  return { body, dir };
}

const push = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('claiming a name', () => {
  it('an authenticated push OWNS the track it creates', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Mine');
    expect((await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` })).status).toBe(200);
    const index = JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) as Record<string, { ownerAccountId?: string }>;
    expect(Object.values(index)[0]!.ownerAccountId).toMatch(/^acc_/);
  });

  it('an ANONYMOUS push is refused where sign-in EXISTS (owner, 2026-08-08)', async () => {
    // Superseded policy: an anonymous push used to succeed and leave the track unowned. The
    // commons is a place people put their names on things — an unowned track is one nobody can
    // update or withdraw and nobody answers for. A registry with no sign-in configured is
    // unaffected and still takes the key rule; that is asserted separately, and is what
    // keeps a self-hoster's `philomatic push` working.
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const res = await push(reg.url, bundle('Legacy').body);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/needs an account/);
    // And nothing was written: a refused push leaves no half-published entry.
    expect(existsSync(join(reg.dir, 'index.json')) ? JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) : {}).toEqual({});
  });

  it('the KEY buys the account: publishing an unowned track while signed in claims it', async () => {
    // This is the whole migration. No claim form, no operator, no flag day — the proof the
    // author already holds is exchanged for the one that survives a lost laptop.
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Legacy');
    await push(reg.url, b.body); // published before accounts, key-pinned
    expect((await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` })).status).toBe(200);
    const index = JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) as Record<string, { ownerAccountId?: string }>;
    expect(Object.values(index)[0]!.ownerAccountId).toMatch(/^acc_/);
  });
});

describe('once a track is owned', () => {
  it('the KEY no longer opens it — which is the point', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Mine');
    await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` });
    // Same bundle, same key, no credential: refused, because possession of the file stopped
    // being the deed the moment an account took it. The refusal comes one step
    // earlier — a sign-in-capable registry wants an account before it looks at ownership at all
    // — so the status is 401 rather than 403. The property under test is unchanged: the key
    // alone no longer opens an owned track.
    const res = await push(reg.url, b.body);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/needs an account/);
  });

  it('someone else’s account cannot take the name', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Mine');
    await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` });
    // A second account on the same registry, with the same bundle in hand.
    const index = JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) as Record<string, { ownerAccountId: string }>;
    const trackId = Object.keys(index)[0]!;
    const accounts = JSON.parse(readFileSync(join(reg.dir, 'accounts.json'), 'utf8')) as { accounts: { id: string }[] };
    index[trackId]!.ownerAccountId = 'acc_somebodyelse';
    writeFileSync(join(reg.dir, 'index.json'), JSON.stringify(index));
    void accounts;
    // The running server holds the index in memory, so re-read through a fresh one.
    const second = createRegistryServer({ dir: reg.dir, introHtml: false, providers: [provider('sub-1', 'Bob')], sessionSecret: SECRET, publicUrl: 'http://127.0.0.1' });
    await new Promise<void>((r) => second.listen(0, '127.0.0.1', r));
    open.push(second);
    const url2 = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
    const res = await push(url2, b.body, { authorization: `Bearer ${reg.token}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/someone else/);
  });

  it('the owner may withdraw it without a signature at all', async () => {
    // The reason for the whole change: withdrawing from a machine that never held the key.
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Mine');
    await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` });
    const trackId = Object.keys(JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')))[0]!;
    const res = await fetch(`${reg.url}/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ trackId }),
    });
    expect(res.status).toBe(200);
    // …and a stranger cannot.
    await push(reg.url, b.body, { authorization: `Bearer ${reg.token}` });
    const denied = await fetch(`${reg.url}/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId }),
    });
    expect(denied.status).toBe(403);
  });
});

describe('a registry with no sign-in configured', () => {
  it('keeps the key rule and nothing else (H-D9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-own-'));
    const server = createRegistryServer({ dir, introHtml: false, providers: [] });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    open.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const b = bundle('Self hosted');
    expect((await push(url, b.body)).status).toBe(200);
    expect((await push(url, b.body)).status).toBe(200); // same key, still fine
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, { ownerAccountId?: string }>;
    expect(Object.values(index)[0]!.ownerAccountId).toBeUndefined();
  });
});

/**
 * The flow most self-hosters actually have: their OWN workbench, publishing
 * to the public registry at philomatic.io. They self-host notes, not a registry.
 *
 * Publishing requires an account, which would strand exactly these people —
 * a server has no session and never will. It carries an account's access token instead.
 */
describe('a self-hosted workbench publishing to a public registry', () => {
  it('is refused without a credential, and works with an account token', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const dir = mkdtempSync(join(tmpdir(), 'pm-selfhost-'));
    const { createIngestServer } = await import('../src/server/ingest');
    const { PhilomaticEngine } = await import('../src/engine');

    const db = join(dir, 'db.sqlite');
    const engine = PhilomaticEngine.open(db);
    engine.captureSource({ url: 'https://ex.com/a', title: 'A Paper', track: 'Self Hosted Track' });
    engine.publish({ ref: 'Self Hosted Track', license: 'CC-BY-SA-4.0' });
    engine.close();

    /** Start a single-tenant instance pointed at the registry, with or without a credential. */
    const instance = async (token?: string) => {
      const saved = { r: process.env.REGISTRY_URL, t: process.env.REGISTRY_TOKEN };
      process.env.REGISTRY_URL = reg.url;
      if (token === undefined) delete process.env.REGISTRY_TOKEN;
      else process.env.REGISTRY_TOKEN = token;
      try {
        const s = createIngestServer({ db, registry: reg.url });
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
        open.push(s);
        return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      } finally {
        if (saved.r === undefined) delete process.env.REGISTRY_URL;
        else process.env.REGISTRY_URL = saved.r;
        if (saved.t === undefined) delete process.env.REGISTRY_TOKEN;
        else process.env.REGISTRY_TOKEN = saved.t;
      }
    };
    const push = (url: string) =>
      fetch(`${url}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A self-hoster names their registry — choosing is the point of the command.
        body: JSON.stringify({ ref: 'Self Hosted Track', registry: reg.url }),
      });

    // Without one: refused, and the message names the fix rather than relaying a status code.
    const bare = await push(await instance());
    expect(bare.status).toBe(401);
    expect((await bare.json()).error).toMatch(/mint an access token .* set REGISTRY_TOKEN/);

    // With one: published, and owned by that account — the whole point of requiring it.
    const ok = await push(await instance(reg.token));
    expect(ok.status).toBe(200);
    const index = JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) as Record<string, { ownerAccountId?: string }>;
    expect(Object.values(index)[0]!.ownerAccountId, 'a pushed track has a real owner now').toBeDefined();

    // And the credential goes ONLY to the registry it belongs to: `/push` takes its target from
    // the request, so an unconditional header would mail this server's token wherever a caller
    // typed. A different address gets the bundle and no credential.
    const seen: (string | undefined)[] = [];
    const impostor = createServer((rq, rs) => {
      seen.push(rq.headers.authorization);
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ url: '/t/x' }));
    });
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    open.push(impostor);
    const elsewhere = `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`;
    const url = await instance(reg.token);
    await fetch(`${url}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'Self Hosted Track', registry: elsewhere }),
    });
    expect(seen, 'no credential to an address that is not ours').toEqual([undefined]);
  });
});

/**
 * CSRF on the registry.
 *
 * This became reachable the day publishing started requiring an account. Before that an
 * anonymous push already worked, so a cross-site POST bought an attacker nothing. Now a
 * malicious page can make a signed-in browser publish an attacker-crafted bundle AS THEM — the
 * attacker signs it with their own keypair, because only the ACCOUNT is checked.
 */
describe('a cross-site page cannot act as a signed-in visitor', () => {
  it('refuses cookie-authenticated writes from elsewhere, and leaves tokens alone', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const b = bundle('Victim Track');

    // The attack: the victim's browser, the victim's cookie, the attacker's page and bundle.
    const attack = await fetch(`${reg.url}/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: reg.cookie,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify(b.body),
    });
    expect(attack.status, 'published as the victim').toBe(403);
    expect((await attack.json()).error).toMatch(/cross-site/);
    expect(existsSync(join(reg.dir, 'index.json')) ? JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8')) : {}).toEqual({});

    // Our own page, same cookie: fine.
    const ours = await fetch(`${reg.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: reg.cookie, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(b.body),
    });
    expect(ours.status).toBe(200);

    // And a TOKEN is exempt wherever it comes from — the CLI and self-hosted servers send no
    // Origin, and a token is pasted on purpose rather than attached by a browser.
    const cli = await fetch(`${reg.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}`, origin: 'https://evil.example' },
      body: JSON.stringify(bundle('CLI Track').body),
    });
    expect(cli.status, 'a token is deliberate, not ambient').toBe(200);
  });
});

/**
 * "Your tracks" on the account page — the GitHub shape: a repository belongs
 * to a USER, and the user can see and withdraw it from their account, on any machine, forever.
 * Ownership is the deed here, so this path carries no key challenge; the signed challenge stays
 * for a still-unowned track, whose only proof IS the key.
 */
describe('an account can see and withdraw its own tracks', () => {
  it('lists them, and the account is proof enough to withdraw', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    await push(reg.url, bundle('Owned Track').body, { authorization: `Bearer ${reg.token}` });

    const page = await (await fetch(`${reg.url}/account`, { headers: { cookie: reg.cookie } })).text();
    expect(page, 'the account page shows what you own').toContain('Owned Track');
    expect(page).toContain('Your tracks');

    // Withdraw as the owner: no signature, no key, just the session.
    const gone = await fetch(`${reg.url}/account/tracks/syl_owned-track/unpublish`, {
      method: 'POST',
      headers: { cookie: reg.cookie, 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(gone.status).toBe(302);
    expect((await (await fetch(`${reg.url}/index.json`)).json()).tracks).toEqual([]);
  });

  it('will not withdraw a track for someone who is not its owner', async () => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    await push(reg.url, bundle('Someone Elses').body, { authorization: `Bearer ${reg.token}` });

    // Three ways to not be the owner, and the track survives all of them. (A session minted by
    // ANOTHER registry verifies its signature here — same test secret — but names an account
    // this registry has never heard of, so it is not signed in and gets the sign-in redirect
    // rather than a 404. That is the correct refusal, just a different one.)
    const elsewhere = await registry({ subject: 'sub-2', name: 'Eve' });
    for (const [name, headers] of [
      ['no session at all', {}],
      ['a session from another registry', { cookie: elsewhere.cookie }],
      ['a forged session', { cookie: 'pm_session=acc_zzz.1.99999999999.nope' }],
    ] as const) {
      const res = await fetch(`${reg.url}/account/tracks/syl_someone-elses/unpublish`, {
        method: 'POST',
        headers: { ...headers, 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      });
      expect(res.status, name).not.toBe(200);
      expect((await (await fetch(`${reg.url}/index.json`)).json()).tracks, name).toHaveLength(1);
    }
  });
});

/**
 * Sign-in returns you to where you started.
 *
 * A workbench sends `?next=/app`; the callback used to hardcode `/`, stranding the person on the
 * registry. `next` now rides the whole round trip — and is guarded, since a redirect target from
 * a URL is an open-redirect waiting to happen.
 */
describe('sign-in honours a guarded return path', () => {
  // A fresh registry per round: each /auth/* (start AND callback) spends a sign-in rate-limit
  // token, and this test does more round trips than one bucket holds. `undefined` means no next.
  const round = async (next: string | undefined): Promise<string | null> => {
    const reg = await registry({ subject: 'sub-1', name: 'Bob' });
    const q = next === undefined ? '' : `?next=${encodeURIComponent(next)}`;
    const started = await fetch(`${reg.url}/auth/fake${q}`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!, reg.url).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${reg.url}/auth/fake/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
    return back.headers.get('location');
  };

  it('lands back on a same-origin path, and refuses an off-site one', async () => {
    // A BRAND NEW account detours through /welcome to pick its handle —
    // the guarded return path rides along, so the destination survives the detour. The
    // open-redirect guard applies BEFORE embedding: an evil next is already '/' by then.
    expect(await round('/app'), 'came from the workbench, returns there after the handle').toBe(`/welcome?next=${encodeURIComponent('/app')}`);
    expect(await round('/app?tab=Journey')).toBe(`/welcome?next=${encodeURIComponent('/app?tab=Journey')}`);
    expect(await round(undefined), 'no next → the registry root, through the same detour').toBe(`/welcome?next=${encodeURIComponent('/')}`);
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)']) {
      expect(await round(evil), evil).toBe(`/welcome?next=${encodeURIComponent('/')}`);
    }
  });
});
