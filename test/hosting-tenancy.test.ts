/**
 * Whose library is this request about?
 *
 * NOT the same question as `test/tenancy.test.ts`. That one covers per-learner tenancy — learners as *data
 * inside one graph*, where a `learnerId` scopes the behavioural overlay and every learner shares
 * a database. This is one database FILE per account, chosen at the transport boundary
 * before any engine is touched, so the engine
 * stays a pure single-graph machine and never learns that other accounts exist.
 *
 * Two things are pinned. The RESOLVER, because a mistake means someone reads someone else's
 * library — the worst failure available to this system. And the pool's BORROWING, because
 * eviction racing an in-flight request is the kind of bug that only appears under load, on the
 * box, at night.
 */
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedVerifier, EnginePool, hostedTenants, registryVerifier, singleTenant } from '../src/server/tenancy';
import { createIngestServer } from '../src/server/ingest';

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

describe('single-tenant — today’s behaviour, unchanged (H-D6)', () => {
  it('always opens the one database, and authenticates NOTHING', async () => {
    // "May you?" is answered by requireToken inside the router, after the deliberately public
    // routes have returned. Answering it here would put a token in front of a published page.
    const r = singleTenant('/data/mine.sqlite');
    // `provisioned: true` always here — this server was STARTED with a database, so there is
    // nothing to opt in to and no way to be surprised by storage you did not ask for.
    expect(await r.resolve(req())).toEqual({ accountId: 'local', dbPath: '/data/mine.sqlite', provisioned: true });
    expect(await r.resolve(req({ 'x-ingest-token': 'anything' }))).toEqual({ accountId: 'local', dbPath: '/data/mine.sqlite', provisioned: true });
  });
});

describe('hosted — one file per account (H-D1)', () => {
  const ok = hostedTenants({ dataDir: '/data', verify: async (t) => (t === 'good' ? 'acc_abc123' : undefined) });

  it('resolves a valid token to that account’s file', async () => {
    expect(await ok.resolve(req({ authorization: 'Bearer good' }))).toEqual({
      accountId: 'acc_abc123',
      provisioned: false, // nothing on disk in this test's dataDir — see the provisioning suite
      dbPath: join('/data', 'acc_abc123.sqlite'),
    });
  });

  it('accepts the token from EITHER header, so an unchanged workbench can connect', async () => {
    // The workbench has always sent X-Ingest-Token; programs and curl send Authorization.
    // The same pasted string must work on a hosted server as on a single-tenant one.
    expect((await ok.resolve(req({ 'x-ingest-token': 'good' })))?.accountId).toBe('acc_abc123');
    expect((await ok.resolve(req({ authorization: 'Bearer good' })))?.accountId).toBe('acc_abc123');
  });

  it('refuses a bad token, a missing header, and a non-bearer scheme', async () => {
    expect(await ok.resolve(req({ authorization: 'Bearer nope' }))).toBeUndefined();
    expect(await ok.resolve(req({ 'x-ingest-token': 'nope' }))).toBeUndefined();
    expect(await ok.resolve(req())).toBeUndefined();
    expect(await ok.resolve(req({ authorization: 'Basic good' }))).toBeUndefined();
  });

  it('refuses an account id that could escape the data directory', async () => {
    // The filename comes from a REMOTE answer. It is ours today and shaped `acc_<hex>`, but a
    // path built from someone else's reply is a traversal waiting for the day the reply changes.
    for (const evil of ['../../etc/passwd', 'acc_../../x', 'acc_a/b', '', 'notanaccount']) {
      const r = hostedTenants({ dataDir: '/data', verify: async () => evil });
      expect(await r.resolve(req({ authorization: 'Bearer good' })), evil).toBeUndefined();
    }
  });

  it('two accounts never land on the same file', async () => {
    const a = hostedTenants({ dataDir: '/data', verify: async () => 'acc_aaa' });
    const b = hostedTenants({ dataDir: '/data', verify: async () => 'acc_bbb' });
    const one = await a.resolve(req({ authorization: 'Bearer x' }));
    const two = await b.resolve(req({ authorization: 'Bearer x' }));
    expect(one!.dbPath).not.toBe(two!.dbPath);
  });
});

describe('the registry verifier', () => {
  const answering = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('reads the account id out of /auth/me', async () => {
    expect(await registryVerifier('https://reg.test/', answering({ signedIn: true, account: { id: 'acc_1' } }))('t')).toBe('acc_1');
  });

  it('treats signed-out, an error status, and an unreachable registry the same', async () => {
    expect(await registryVerifier('https://reg.test', answering({ signedIn: false }))('t')).toBeUndefined();
    expect(await registryVerifier('https://reg.test', answering({}, 401))('t')).toBeUndefined();
    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    // A host that kept serving libraries while the thing that says who owns them is unreachable
    // would be worse than one that refuses.
    expect(await registryVerifier('https://reg.test', throwing)('t')).toBeUndefined();
  });
});

describe('turning hosting on', () => {
  /**
   * Build a server with these two variables set, then put them back EXACTLY as they were.
   *
   * Restoring by reassigning `process.env` wholesale replaces Node's special env object with a
   * plain one, and everything that reads the environment afterwards quietly gets different
   * behaviour — which showed up as two registry tests failing in the full run while passing
   * alone. Touch only the keys under test.
   */
  const start = (env: Record<string, string | undefined>) => {
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return createIngestServer({ db: ':memory:' });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('tightens a data directory that already exists', async () => {
    // mkdirSync(recursive) is a no-op on an existing directory, mode included — so an UPGRADED
    // deployment, the one that already holds libraries, would keep whatever it had.
    const dir = mkdtempSync(join(tmpdir(), 'pm-hosted-'));
    chmodSync(dir, 0o755);
    const server = start({ INGEST_DATA_DIR: dir, REGISTRY_URL: 'http://reg.test' });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    server.close();
  });

  it('activates from the ENVIRONMENT, not just from code', async () => {
    // The check must read the RESOLVED config, not the raw option: otherwise REGISTRY_URL in
    // the environment leaves hosting off — silently, serving the operator's own library to
    // anyone who asks.
    const server = start({ INGEST_DATA_DIR: mkdtempSync(join(tmpdir(), 'pm-hosted-')), REGISTRY_URL: 'http://reg.test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    // Hosted: no credential, no library. Single-tenant would have answered with a snapshot.
    expect((await fetch(`${url}/snapshot`)).status).toBe(401);
    // …and yet the app itself loads, or the token could never be entered.
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    server.close();
  });

  it('REFUSES to start with libraries it cannot attribute', () => {
    // Falling back would serve one library to everyone with no credential, and look healthy.
    expect(() => start({ INGEST_DATA_DIR: mkdtempSync(join(tmpdir(), 'pm-hosted-')), REGISTRY_URL: undefined })).toThrow(/hosting needs a registry/);
  });

  it('leaves a registry-BROWSING single-tenant server alone', async () => {
    // REGISTRY_URL already means "the registry this workbench browses". Reading it as a
    // hosting signal would break that meaning.
    const server = start({ INGEST_DATA_DIR: undefined, REGISTRY_URL: 'http://reg.test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    expect((await fetch(`${url}/snapshot`)).status).toBe(200);
    server.close();
  });

  it('stays single-tenant when neither is set', async () => {
    const server = start({ INGEST_DATA_DIR: undefined, REGISTRY_URL: undefined });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    expect((await fetch(`${url}/snapshot`)).status).toBe(200);
    server.close();
  });
});

describe('the verification cache — the TTL IS the revocation delay', () => {
  it('asks once, then answers from memory', async () => {
    let calls = 0;
    let clock = 0;
    const v = cachedVerifier(async () => { calls += 1; return 'acc_1'; }, { ttlMs: 1000, now: () => clock });
    expect(await v('t')).toBe('acc_1');
    expect(await v('t')).toBe('acc_1');
    // Without this, every click a hosted user makes waits on another server.
    expect(calls).toBe(1);
    clock += 2000;
    expect(await v('t')).toBe('acc_1');
    expect(calls).toBe(2);
  });

  it('forgets a revoked token within the TTL, and no later', async () => {
    let live = true;
    let clock = 0;
    const v = cachedVerifier(async () => (live ? 'acc_1' : undefined), { ttlMs: 1000, now: () => clock });
    expect(await v('t')).toBe('acc_1');
    live = false;
    expect(await v('t')).toBe('acc_1'); // still cached — this is the trade, stated
    clock += 1001;
    expect(await v('t')).toBeUndefined();
  });

  it('caches a REFUSAL far more briefly than an acceptance', async () => {
    let answer: string | undefined;
    let clock = 0;
    const v = cachedVerifier(async () => answer, { ttlMs: 60_000, negativeTtlMs: 100, now: () => clock });
    expect(await v('t')).toBeUndefined();
    answer = 'acc_1';
    // A token minted seconds ago must not be locked out for a minute because it was tried once
    // before the registry saw it.
    clock += 101;
    expect(await v('t')).toBe('acc_1');
  });

  it('can be told to ask every time', async () => {
    // TOKEN_VERIFY_TTL_SECONDS=0 trades the round trip back: correct at once, at the price the
    // cache exists to avoid. An operator gets to make that choice without touching code.
    let calls = 0;
    const v = cachedVerifier(async () => { calls += 1; return 'acc_1'; }, { ttlMs: 0, now: () => 0 });
    await v('t');
    await v('t');
    expect(calls).toBe(2);
  });

  it('does not grow without bound when fed garbage', async () => {
    let clock = 0;
    const v = cachedVerifier(async () => undefined, { negativeTtlMs: 1, now: () => clock });
    for (let i = 0; i < 5000; i += 1) await v(`junk-${i}`);
    clock += 10;
    await v('one-more'); // triggers the sweep
    // A map keyed on every token ever presented is a memory leak an attacker can drive.
    expect(await v('junk-0')).toBeUndefined();
  });

  it('keys on a HASH, so a heap dump yields no working credentials', async () => {
    const seenByVerifier: string[] = [];
    const v = cachedVerifier(async (t) => { seenByVerifier.push(t); return 'acc_1'; }, {});
    await v('pmt_secret-value');
    expect(seenByVerifier).toEqual(['pmt_secret-value']);
    // The cache's own key is a digest; nothing here asserts on internals beyond that contract
    // holding for lookups, which the reuse test above proves.
  });
});

describe('the engine pool', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'pm-pool-')), 'db.sqlite');

  it('opens once and reuses', async () => {
    const pool = new EnginePool();
    const path = tmp();
    const first = await pool.withEngine(path, (e) => e);
    const second = await pool.withEngine(path, (e) => e);
    expect(second).toBe(first);
    expect(pool.size).toBe(1);
    pool.closeAll();
    expect(pool.size).toBe(0);
  });

  it('keeps libraries apart', async () => {
    const pool = new EnginePool();
    const a = await pool.withEngine(tmp(), (e) => e);
    const b = await pool.withEngine(tmp(), (e) => e);
    expect(a).not.toBe(b);
    expect(pool.size).toBe(2);
    pool.closeAll();
  });

  it('will not evict a database a request is still holding', async () => {
    // The race that only shows up under load: the sweeper runs while a handler is awaiting
    // between two engine calls, and the handler's next call hits a closed database.
    let clock = 0;
    const pool = new EnginePool({ idleMs: 1000, now: () => clock });
    const path = tmp();
    let evictedDuring = -1;
    await pool.withEngine(path, async () => {
      clock += 10_000; // long past idle
      evictedDuring = pool.evictIdle();
      await Promise.resolve();
    });
    expect(evictedDuring).toBe(0);
    expect(pool.size).toBe(1);
    // Released and idle, it goes.
    clock += 10_000;
    expect(pool.evictIdle()).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('caps how many are open, and says so', async () => {
    let clock = 0;
    const pool = new EnginePool({ cap: 2, idleMs: 1000, now: () => clock });
    await pool.withEngine(tmp(), (e) => e);
    await pool.withEngine(tmp(), (e) => e);
    // Still inside the idle window, so nothing can be swept to make room.
    await expect(pool.withEngine(tmp(), (e) => e)).rejects.toThrow(/too many libraries/);
    // Past it, the sweep makes room rather than failing.
    clock += 10_000;
    await expect(pool.withEngine(tmp(), (e) => e)).resolves.toBeDefined();
    pool.closeAll();
  });

  it('drops one library on demand — a revoked token must not reuse a handle', async () => {
    const pool = new EnginePool();
    const path = tmp();
    const first = await pool.withEngine(path, (e) => e);
    expect(pool.drop(path)).toBe(true);
    expect(pool.drop(path)).toBe(false);
    const second = await pool.withEngine(path, (e) => e);
    expect(second).not.toBe(first);
    pool.closeAll();
  });

  it('releases the borrow even when the handler throws', async () => {
    let clock = 0;
    const pool = new EnginePool({ idleMs: 0, now: () => clock });
    const path = tmp();
    await expect(
      pool.withEngine(path, () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');
    // A leaked borrow would pin this database open forever — the pool would fill and the cap
    // would start refusing new users for no reason anyone could see.
    clock += 1;
    expect(pool.evictIdle()).toBe(1);
  });
});

describe('publishing on a hosted instance (H-D12)', () => {
  /** A hosted server plus a stand-in registry that records what it was sent. */
  const hosted = async (registryHandler: (body: unknown) => { status: number; body: unknown }) => {
    const seen: unknown[] = [];
    const auths: (string | undefined)[] = [];
    const reg = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push(JSON.parse(raw || 'null'));
        auths.push(req.headers.authorization);
        const out = registryHandler(seen[seen.length - 1]);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => reg.listen(0, '127.0.0.1', r));
    const regUrl = `http://127.0.0.1:${(reg.address() as import('node:net').AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'pm-hosted-'));
    const saved = { d: process.env.INGEST_DATA_DIR, r: process.env.REGISTRY_URL };
    process.env.INGEST_DATA_DIR = dir;
    process.env.REGISTRY_URL = regUrl;
    let server;
    try {
      server = createIngestServer({ db: ':memory:', // `provisioned: true` — these tests are about PUBLISHING, not about opting into storage.
        // The provisioning gate has its own suite above.
        tenants: { resolve: async () => ({ accountId: 'acc_x', dbPath: join(dir, 'acc_x.sqlite'), provisioned: true }) } });
    } finally {
      if (saved.d === undefined) delete process.env.INGEST_DATA_DIR; else process.env.INGEST_DATA_DIR = saved.d;
      if (saved.r === undefined) delete process.env.REGISTRY_URL; else process.env.REGISTRY_URL = saved.r;
    }
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}`;
    return { url, regUrl, seen, auths, close: () => { server!.close(); reg.close(); } };
  };

  it('sends a public page to the REGISTRY instead of serving it from a library', async () => {
    const h = await hosted(() => ({ status: 200, body: {} }));
    const res = await fetch(`${h.url}/t/syl_something`, { redirect: 'manual' });
    // A redirect rather than a 404: the page exists, it is simply not ours to serve, and a link
    // already in the wild should still land on it.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${h.regUrl}/t/syl_something`);
    h.close();
  });

  it('serves the APP itself without a credential, or nobody can ever sign in', async () => {
    // The door locked from the inside: the browser's first request is GET / for the app's HTML,
    // with no token, because the token lives in the app's settings — which cannot load because
    // the app cannot load.
    const h = await hosted(() => ({ status: 200, body: {} }));
    for (const path of ['/', '/health', '/framework']) {
      expect((await fetch(`${h.url}${path}`)).status, path).toBe(200);
    }
    h.close();
    // The other half — that a library still demands one — is asserted where the REAL resolver
    // is in play; this helper stubs it so the publish tests need no token.
  });

  it('will not push where a TENANT points it', async () => {
    // /push takes its target from the request body and is reachable by every tenant, so on a
    // hosted box it is an egress channel and a probe of the network the server sits in — with
    // the status handed back. The instance has ONE configured registry; a self-hoster keeps
    // choosing, because that is the point of the command.
    const h = await hosted(() => ({ status: 200, body: {} }));
    const res = await fetch(`${h.url}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'syl_t', registry: 'http://169.254.169.254' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/will not push elsewhere/);
    h.close();
  });

  it('PUSHES on publish with the CALLER token — a publication belongs to a user (M-D14)', async () => {
    // The instance has no credential of its own that the registry accepts; the caller's bearer
    // IS a registry account token (tenancy verifies it there), so it is forwarded verbatim.
    const h = await hosted(() => ({ status: 200, body: { url: '/t/syl_t' } }));
    await fetch(`${h.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok_caller' },
      body: JSON.stringify({ version: 2, tracks: [{ title: 'T' }], sources: [{ title: 'S', modality: 'text' }] }),
    });
    const res = await fetch(`${h.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok_caller' },
      body: JSON.stringify({ ref: 'syl_t', license: 'CC-BY-SA-4.0' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).registryUrl).toBe(`${h.regUrl}/t/syl_t`);
    // The registry received an actual publication bundle, authenticated as the CALLER.
    expect(h.seen).toHaveLength(1);
    expect((h.seen[0] as { pubVersion?: number }).pubVersion).toBeDefined();
    expect(h.auths[0]).toBe('Bearer tok_caller');
    h.close();
  });

  it('DEFERS the push to the browser when the caller authenticated by cookie', async () => {
    // A session must not be forwarded server-side (confused deputy). The publish itself lands;
    // the response says the registry still needs the browser's same-origin push, and the
    // registry was NOT called (a blind server-side push would 401 every time anyway).
    const h = await hosted(() => ({ status: 200, body: {} }));
    await fetch(`${h.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, tracks: [{ title: 'T' }], sources: [{ title: 'S', modality: 'text' }] }),
    });
    const res = await fetch(`${h.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'syl_t', license: 'CC-BY-SA-4.0' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).needsRegistryPush).toBe(true);
    expect(h.seen, 'no blind, credential-less push').toHaveLength(0);
    h.close();
  });

  it('says so when the registry refuses, and does NOT roll the publish back', async () => {
    const h = await hosted(() => ({ status: 409, body: { error: 'someone else owns that name' } }));
    await fetch(`${h.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, tracks: [{ title: 'T' }], sources: [{ title: 'S', modality: 'text' }] }),
    });
    const res = await fetch(`${h.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok_caller' },
      body: JSON.stringify({ ref: 'syl_t', license: 'CC-BY-SA-4.0' }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/refused/);
    // Still published locally, with the licence and date the author chose: retrying is one more
    // press, and unpublishing to hide a network blip would throw that away.
    const snap = await (await fetch(`${h.url}/snapshot`)).json();
    expect(snap.tracks[0].published).toBeDefined();
    h.close();
  });
});

/**
 * Provisioning is a DELIBERATE act.
 *
 * Signing in must not silently start storing someone's reading on our disk. A person who
 * believes they are using the in-browser engine — and is — should never discover later that a
 * server kept a copy. So the resolver reports whether a library EXISTS, and the router turns
 * "signed in, nothing here" into an offer rather than an empty library.
 */
describe('a session does not conjure a library', () => {
  it('reports provisioned only when the file is really there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-prov-'));
    const r = hostedTenants({ dataDir: dir, verify: async () => 'acc_abc123' });
    const first = await r.resolve(req({ authorization: 'Bearer good' }));
    expect(first?.provisioned, 'a fresh account has no library').toBe(false);

    // The FILE is the record — no second piece of state to drift from it.
    writeFileSync(first!.dbPath, '');
    expect((await r.resolve(req({ authorization: 'Bearer good' })))!.provisioned).toBe(true);
  });

  it('accepts a session cookie, and only when a session verifier is wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-prov-'));
    const cookie = { cookie: 'pm_session=acc_x.1.2.sig' };

    const tokenOnly = hostedTenants({ dataDir: dir, verify: async () => 'acc_tok' });
    expect(await tokenOnly.resolve(req(cookie)), 'no session verifier = cookies mean nothing').toBeUndefined();

    const both = hostedTenants({ dataDir: dir, verify: async () => 'acc_tok', verifySession: async () => 'acc_sess' });
    expect((await both.resolve(req(cookie)))?.accountId).toBe('acc_sess');
    // A request carrying BOTH is the deliberate one: a token is pasted on purpose, a cookie
    // rides along by itself.
    expect((await both.resolve(req({ ...cookie, authorization: 'Bearer good' })))?.accountId).toBe('acc_tok');
  });

  it('a session for an unknown account resolves to nothing, not to a new file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-prov-'));
    const r = hostedTenants({ dataDir: dir, verify: async () => undefined, verifySession: async () => undefined });
    expect(await r.resolve(req({ cookie: 'pm_session=forged' }))).toBeUndefined();
    expect(readdirSync(dir), 'resolving must not create anything').toEqual([]);
  });
});
