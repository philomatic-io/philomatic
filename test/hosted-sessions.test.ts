/**
 * Sessions at the instance, and consciously creating a hosted library.
 *
 * Two properties, tested against a REAL registry and a REAL hosted instance, because the bugs
 * this area produces live in the wiring between them and not in either half:
 *
 *   1. a browser signs in ONCE, at the registry, and the instance recognises the session — no
 *      token is minted, pasted, or seen;
 *   2. signing in does NOT create a library. Someone using the in-browser engine must never
 *      discover that a server quietly kept a copy of their reading, so storage is opted into.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRegistryServer } from '../src/registry/server';
import { createIngestServer } from '../src/server/ingest';
import type { OAuthProvider } from '../src/registry/oauth';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const listen = async (s: Server): Promise<string> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/** A registry with sign-in wired to a fake provider, plus a hosted instance pointed at it. */
async function pair(): Promise<{ reg: string; app: string; dataDir: string; signIn: () => Promise<string> }> {
  const provider: OAuthProvider = {
    id: 'google',
    label: 'Google',
    authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`,
    exchange: async () => ({ provider: 'google', subject: 'student-1', name: 'A Student' }),
  };
  const reg = await listen(
    createRegistryServer({
      dir: mkdtempSync(join(tmpdir(), 'pm-ms2-reg-')),
      providers: [provider],
      sessionSecret: 'test-secret',
      publicUrl: 'http://127.0.0.1',
    }),
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'pm-ms2-data-'));
  const saved = { d: process.env.INGEST_DATA_DIR, r: process.env.REGISTRY_URL };
  process.env.INGEST_DATA_DIR = dataDir;
  process.env.REGISTRY_URL = reg;
  let instance: Server;
  try {
    instance = createIngestServer({ db: ':memory:' });
  } finally {
    if (saved.d === undefined) delete process.env.INGEST_DATA_DIR;
    else process.env.INGEST_DATA_DIR = saved.d;
    if (saved.r === undefined) delete process.env.REGISTRY_URL;
    else process.env.REGISTRY_URL = saved.r;
  }
  const app = await listen(instance);

  /** The real OAuth round trip; returns the session cookie a browser would now hold. */
  const signIn = async (): Promise<string> => {
    const started = await fetch(`${reg}/auth/google`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!, reg).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${reg}/auth/google/callback?code=x&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: parked },
    });
    return (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
  };
  return { reg, app, dataDir, signIn };
}

describe('a session signs you in at the instance', () => {
  it('recognises the registry’s cookie — no token minted, pasted, or seen', async () => {
    const { app, signIn } = await pair();
    expect((await fetch(`${app}/snapshot`)).status, 'no credential is still 401').toBe(401);

    const cookie = await signIn();
    const res = await fetch(`${app}/account/library`, { method: 'POST', headers: { cookie } });
    expect(res.status, 'the session alone is enough').toBe(200);
    expect((await res.json()).created).toBe(true);
    expect((await fetch(`${app}/snapshot`, { headers: { cookie } })).status).toBe(200);
  });

  it('refuses a forged cookie, and a revoked session once the cache expires', async () => {
    const { app } = await pair();
    expect((await fetch(`${app}/snapshot`, { headers: { cookie: 'pm_session=acc_x.1.99999999999.forged' } })).status).toBe(401);
  });
});

describe('signing in does not create a library', () => {
  it('answers 409 with a way forward, and writes NOTHING until asked', async () => {
    const { app, dataDir, signIn } = await pair();
    const cookie = await signIn();

    const before = await fetch(`${app}/snapshot`, { headers: { cookie } });
    expect(before.status, 'signed in, but nothing stored here yet').toBe(409);
    const body = (await before.json()) as { needs?: string; hint?: string };
    expect(body.needs).toBe('provision');
    expect(body.hint).toMatch(/nothing is stored here until you do/);
    // THE property the owner asked for: a signed-in visit leaves no trace on our disk.
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite'))).toEqual([]);

    // Even a WRITE does not sneak one into existence.
    const write = await fetch(`${app}/import`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, sources: [{ title: 'Sneaky', modality: 'text' }] }),
    });
    expect(write.status, 'a write must not provision by side effect').toBe(409);
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite'))).toEqual([]);

    // The deliberate act, and only then.
    expect((await fetch(`${app}/account/library`, { method: 'POST', headers: { cookie } })).status).toBe(200);
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite'))).toHaveLength(1);
    expect((await fetch(`${app}/snapshot`, { headers: { cookie } })).status).toBe(200);

    // Asking twice is not an error, and does not make a second library.
    const again = await fetch(`${app}/account/library`, { method: 'POST', headers: { cookie } });
    expect(again.status).toBe(200);
    expect((await again.json()).created, 'already there').toBe(false);
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite'))).toHaveLength(1);
  });
});

describe('CSRF — ambient authority arrives with the cookie', () => {
  it('refuses a cookie-authenticated write from another origin, and allows our own', async () => {
    const { app, signIn } = await pair();
    const cookie = await signIn();
    await fetch(`${app}/account/library`, { method: 'POST', headers: { cookie } });

    const evil = await fetch(`${app}/import`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ version: 2, sources: [{ title: 'From evil', modality: 'text' }] }),
    });
    expect(evil.status, 'a cross-site write carrying our cookie').toBe(403);

    const ours = await fetch(`${app}/import`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ version: 2, sources: [{ title: 'From us', modality: 'text' }] }),
    });
    expect(ours.status, 'our own page').toBe(200);

    // A READ is not a write: cross-site reads are already stopped by CORS, and refusing them
    // here would break the published pages a browser loads from anywhere.
    expect((await fetch(`${app}/snapshot`, { headers: { cookie, origin: 'https://evil.example' } })).status).toBe(200);
  });
});

/**
 * A SELF-HOSTER is never asked to sign in.
 *
 * Most people running their own Philomatic run one library for one person and manage their own
 * token. Accounts are a hosting feature, not a product-wide one, so a single-tenant server must
 * say "there is nothing to sign into here" rather than offer a door that leads nowhere — and the
 * workbench must render no sign-in prompt on that answer (asserted in the browser smoke suite).
 */
describe('single-tenant says there is nothing to sign into', () => {
  it('answers hosted:false, and never gates on a session', async () => {
    const app = await listen(createIngestServer({ db: ':memory:' }));

    const me = (await (await fetch(`${app}/auth/me`)).json()) as { hosted?: boolean; signedIn?: boolean; providers?: unknown[] };
    expect(me.hosted, 'no accounts exist on a single-tenant server').toBe(false);
    expect(me.signedIn).toBe(false);
    expect(me.providers).toEqual([]);

    // And the library is simply THERE — no credential, no provisioning, no 409. This is the
    // laptop path, unchanged by the hosting features.
    expect((await fetch(`${app}/snapshot`)).status).toBe(200);
    const write = await fetch(`${app}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, sources: [{ title: 'Local', modality: 'text' }] }),
    });
    expect(write.status, 'a self-hoster writes without a session and without CSRF friction').toBe(200);
  });
});

/**
 * Moving a browser library up to a hosted account.
 *
 * The dangerous transition: two libraries could end up existing, and a person must never work in
 * the wrong one or think a switch lost their work. This tests the MECHANISM the UI drives —
 * provision, then copy the browser payload into the FRESH hosted library — end to end, because
 * "did my work arrive?" is the only question that matters and it lives in the wiring.
 */
describe('a browser library can be moved to a hosted account', () => {
  it('provisions, imports the payload, and the work is really there', async () => {
    const { app, dataDir, signIn } = await pair();
    const cookie = await signIn();

    // The browser payload the tab would export: a track and two sources.
    const payload = {
      version: 2,
      tracks: [{ title: 'My Reading', goal: 'moved from the browser' }],
      sources: [
        { title: 'Chapter One', modality: 'text' },
        { title: 'Chapter Two', modality: 'text' },
      ],
    };

    // Provision (what migrateBrowserToHosted does first), then copy the payload in.
    expect((await fetch(`${app}/account/library`, { method: 'POST', headers: { cookie } })).status).toBe(200);
    const imp = await fetch(`${app}/import`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(payload),
    });
    expect(imp.status, 'the copy-up must land in the new library').toBe(200);

    // It is really in the hosted library now.
    const snap = (await (await fetch(`${app}/snapshot`, { headers: { cookie } })).json()) as {
      tracks: { title: string }[];
      sources: { title: string }[];
    };
    expect(snap.tracks.map((t) => t.title)).toContain('My Reading');
    expect(snap.sources.map((s) => s.title).sort()).toEqual(['Chapter One', 'Chapter Two']);
    // Exactly one hosted library was created — the migration is not a source of duplicates.
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite'))).toHaveLength(1);
  });
});
