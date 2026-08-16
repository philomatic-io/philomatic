/**
 * Publishing works for a SIGNED-IN person, from either library.
 *
 * Two bugs met here. A browser library on a registry origin was refused publishing outright by a
 * backend-only capability gate. A hosted library offered the button, then failed 401: its push
 * went server→registry with no session, so the registry saw no account. Both are about the same
 * fact — publishing belongs to a user, and the user's credential lives in the BROWSER.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';
import type { OAuthProvider } from '../../src/registry/oauth';

const S: Server[] = [];
afterEach(() => { for (const s of S.splice(0)) s.close(); });
const listen = async (s: Server) => { S.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
/** Sign-in needs PUBLIC_URL before the server listens, so the port must be known first. */
const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:http');
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
};

describe.runIf(uiSmokeReady())('publishing while signed in', () => {
  it('a browser library on a registry origin is OFFERED publishing, and publishes with its cookie', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const provider: OAuthProvider = { id: 'google', label: 'Google', authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`, exchange: async () => ({ provider: 'google', subject: 'p', name: 'Prof' }) };
    const { createIngestServer } = await import('../../src/server/ingest');
    const { createServer } = await import('node:http');
    const dir = mkdtempSync(join(tmpdir(), 'pm-pub-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    // ONE ORIGIN, the deploy shape (what Caddy does): /app* is the workbench instance — in
    // HOSTING mode, as deployed — everything else is the registry. Publishing from a browser
    // library only works when they share an origin, so a test that does not proxy cannot see
    // this bug at all; and the sign-in gate keys on the instance knowing accounts exist, so a
    // non-hosting instance cannot see THAT.
    const reg = createRegistryServer({ dir, providers: [provider], sessionSecret: 'x'.repeat(32), publicUrl: url });
    const saved = { b: process.env.BASE_PATH, r: process.env.REGISTRY_URL, d: process.env.INGEST_DATA_DIR };
    process.env.BASE_PATH = '/app';
    process.env.REGISTRY_URL = url;
    process.env.INGEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'pm-pub-data-'));
    let instance: Server;
    try {
      instance = createIngestServer({ db: ':memory:' });
    } finally {
      for (const [k, v] of [['BASE_PATH', saved.b], ['REGISTRY_URL', saved.r], ['INGEST_DATA_DIR', saved.d]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    // Route exactly as the deployed Caddyfile does: the app AND its static assets come from the
    // instance, everything else from the registry. (Sending /assets to the registry 404s the
    // bundle and the workbench never boots — which is how this proxy first went wrong.)
    const toInstance = (u: string) => u.startsWith('/app') || u.startsWith('/assets/') || u.startsWith('/ask/') || u === '/favicon.ico' || u === '/health';
    const proxy = createServer((rq, rs) => (toInstance(rq.url ?? '/') ? instance : reg).emit('request', rq, rs));
    S.push(proxy);
    await new Promise<void>((r) => proxy.listen(port, '127.0.0.1', r));

    const st = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    const state = new URL(st.headers.get('location')!, url).searchParams.get('state')!;
    const pk = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const bk = await fetch(`${url}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: pk } });
    const sess = (bk.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
    await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'tester1' }) });

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'pm_session', value: sess.split('=')[1]!, url }]);
    await ctx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const page = await ctx.newPage();
    await page.goto(`${url}/app`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });

    // Make and publish a track in the browser library, then open it.
    const made = await page.evaluate(async () => {
      const c = (globalThis as { __PM_CLIENT__?: { captureSource: (i: unknown) => Promise<unknown>; publish: (r: string, l: string) => Promise<unknown>; getRegistry: () => Promise<unknown> } }).__PM_CLIENT__;
      if (c === undefined) return 'no in-browser client';
      await c.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Set Theory' });
      await c.publish('Set Theory', 'CC-BY-SA-4.0');
      // The origin IS a registry — the fact the publishing gate must consult.
      return JSON.stringify(await c.getRegistry());
    });
    expect(made, 'the in-browser engine sees a registry at this origin').toContain('registry');

    // THE FIX: the browser library is offered publishing here — not the "not served by a
    // registry" refusal, which is what a backend-only gate produced.
    await page.waitForTimeout(1500); // the in-browser engine persists asynchronously
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await page.locator('.item', { hasText: 'Set Theory' }).first().click();
    await expect.poll(async () => await page.locator('.needs-server-note').count(), { timeout: 15000 }).toBe(0);
    expect(await page.locator('.publish-box').count(), 'publishing controls are shown').toBeGreaterThan(0);

    // And the push actually lands, authenticated by the cookie this browser holds.
    const pushed = await page.evaluate(async () => {
      const c = (globalThis as { __PM_CLIENT__?: { pushToRegistry: (r: string, u: string) => Promise<{ url: string }> } }).__PM_CLIENT__!;
      try { return JSON.stringify(await c.pushToRegistry('Set Theory', window.location.origin)); } catch (e) { return `ERR ${(e as Error).message}`; }
    });
    expect(pushed, 'published as the signed-in account, not refused 401').not.toContain('ERR');
    // The registry now holds it, owned by the account.
    const listed = await (await fetch(`${url}/index.json`)).json();
    expect(listed.tracks.map((t: { title: string }) => t.title)).toContain('Set Theory');

    // And "Open public page" points somewhere that EXISTS. A browser library has no server of
    // its own, so its public page is the registry's — and the origin-root link the box used to
    // build answered "no such track" until the push landed.
    const href = await page.locator('.publish-actions a', { hasText: 'Open public page' }).first().getAttribute('href');
    expect(href).toBe(`${url}/t/syl_set-theory`);
    expect((await fetch(href!)).status, 'the public page link resolves').toBe(200);

    // THE EXACT REPORTED SEQUENCE: fork a community track, add a source, hit
    // Publish ONCE — the registry copy must carry the addition. (The mint and the push had
    // split into two presses in browser mode; "check link, no update; publish again, there".)
    // A fresh, empty browser library (a second person's machine), same account signed in.
    const forkCtx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await forkCtx.addCookies([{ name: 'pm_session', value: sess.split('=')[1]!, url }]);
    await forkCtx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const forkPage = await forkCtx.newPage();
    await forkPage.goto(`${url}/app`, { waitUntil: 'domcontentloaded' });
    await forkPage.waitForSelector('.topbar', { timeout: 20000 });
    const forked = await forkPage.evaluate(async () => {
      const c = (globalThis as { __PM_CLIENT__?: { forkRegistryTrack: (id: string) => Promise<unknown>; captureSource: (i: unknown) => Promise<unknown> } }).__PM_CLIENT__!;
      await c.forkRegistryTrack('syl_set-theory');
      await c.captureSource({ url: 'https://ex.com/added', title: 'Added After Fork', track: 'Set Theory' });
      return 'ok';
    });
    expect(forked).toBe('ok');
    await forkPage.waitForTimeout(1200);
    await forkPage.reload({ waitUntil: 'domcontentloaded' });
    await forkPage.waitForSelector('.topbar', { timeout: 20000 });
    await forkPage.locator('.item', { hasText: 'Set Theory' }).first().click();
    // ONE press: the fork is unpublished, so the confirm panel opens; Publish mints AND pushes.
    await forkPage.locator('.link-btn', { hasText: 'Publish…' }).click();
    await forkPage.locator('.publish-go', { hasText: 'Publish' }).click();
    await expect.poll(async () => {
      const r = await fetch(`${url}/t/syl_set-theory.json`);
      if (!r.ok) return [];
      return ((await r.json()) as { payload: { sources: { title: string }[] } }).payload.sources.map((x) => x.title).sort();
    }, { timeout: 20000 }).toEqual(['A', 'Added After Fork']);

    // And SIGNED OUT, the same track offers no Publish button — a mint that toasts success and
    // lands nowhere is a lie; the box asks for the account publishing needs.
    const anon = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await anon.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const anonPage = await anon.newPage();
    await anonPage.goto(`${url}/app`, { waitUntil: 'domcontentloaded' });
    await anonPage.waitForSelector('.topbar', { timeout: 20000 });
    await anonPage.evaluate(async () => {
      const c = (globalThis as { __PM_CLIENT__?: { captureSource: (i: unknown) => Promise<unknown> } }).__PM_CLIENT__!;
      await c.captureSource({ url: 'https://ex.com/b', title: 'B', track: 'Anon Track' });
    });
    await anonPage.waitForTimeout(1200);
    await anonPage.reload({ waitUntil: 'domcontentloaded' });
    await anonPage.waitForSelector('.topbar', { timeout: 20000 });
    await anonPage.locator('.item', { hasText: 'Anon Track' }).first().click();
    await expect.poll(async () => await anonPage.locator('.publish-signedout').count(), { timeout: 15000 }).toBe(1);
    expect(await anonPage.locator('.publish-signedout').innerText()).toContain('Sign in to publish');
    expect(await anonPage.locator('.publish-go', { hasText: 'Publish' }).filter({ hasText: /^((?!Sign).)*$/ }).count(), 'no live Publish button').toBe(0);

    await b.close();
  }, 180000);

  it('a HOSTED library publishes to the registry — the bundle read must not follow H-D12 to a 404', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');
    const { createServer } = await import('node:http');
    const provider: OAuthProvider = { id: 'google', label: 'Google', authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`, exchange: async () => ({ provider: 'google', subject: 'p', name: 'Prof' }) };
    const dir = mkdtempSync(join(tmpdir(), 'pm-pub-h-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-pub-h-data-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const reg = createRegistryServer({ dir, providers: [provider], sessionSecret: 'x'.repeat(32), publicUrl: url });
    const saved = { b: process.env.BASE_PATH, r: process.env.REGISTRY_URL, d: process.env.INGEST_DATA_DIR };
    process.env.BASE_PATH = '/app';
    process.env.REGISTRY_URL = url;
    process.env.INGEST_DATA_DIR = dataDir; // hosting mode — the one-registry redirect is live
    let instance: Server;
    try {
      instance = createIngestServer({ db: ':memory:' });
    } finally {
      for (const [k, v] of [['BASE_PATH', saved.b], ['REGISTRY_URL', saved.r], ['INGEST_DATA_DIR', saved.d]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    const toInstance = (u: string) => u.startsWith('/app') || u.startsWith('/assets/') || u.startsWith('/ask/') || u === '/favicon.ico' || u === '/health';
    const proxy = createServer((rq, rs) => (toInstance(rq.url ?? '/') ? instance : reg).emit('request', rq, rs));
    S.push(proxy);
    await new Promise<void>((r) => proxy.listen(port, '127.0.0.1', r));

    const st = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    const state = new URL(st.headers.get('location')!, url).searchParams.get('state')!;
    const pk = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const bk = await fetch(`${url}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: pk } });
    const sess = (bk.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
    await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'tester2' }) });

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'pm_session', value: sess.split('=')[1]!, url }]);
    await ctx.addInitScript(() => sessionStorage.setItem('pm.hostIntent', '1'));
    const page = await ctx.newPage();
    await page.goto(`${url}/app`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await expect.poll(async () => readdirSync(dataDir).filter((f) => f.endsWith('.sqlite')).length, { timeout: 20000 }).toBe(1);

    // Author a published track in the HOSTED library, through the same doors the workbench uses.
    const prep = await page.evaluate(async () => {
      const post = async (p: string, body: unknown) => {
        const r = await fetch(`/app${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return `${p}:${r.status}`;
      };
      const a = await post('/ingest', { url: 'https://ex.com/a', title: 'A', track: 'Live Track' });
      const b2 = await post('/publish', { ref: 'Live Track' });
      return `${a} ${b2}`;
    });
    expect(prep).toBe('/ingest:200 /publish:200');

    // The box publishes to the origin registry — this is the exact click that answered
    // "no such track" while the hosting-mode redirect rewrote the bundle read.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await page.locator('.item', { hasText: 'Live Track' }).first().click();
    const go = page.locator('.publish-go');
    await expect.poll(async () => await go.count(), { timeout: 15000 }).toBeGreaterThan(0);
    await go.first().click();

    // It lands: the registry lists it, owned by the account.
    await expect.poll(async () => {
      const listed = (await (await fetch(`${url}/index.json`)).json()) as { tracks: { title: string }[] };
      return listed.tracks.map((t) => t.title);
    }, { timeout: 20000 }).toContain('Live Track');

    // The box knows the public copy is CURRENT — and knows when it stops being so
    // (a source added after publishing must not silently miss the registry).
    await expect.poll(async () => await page.locator('.sync-state').innerText().catch(() => ''), { timeout: 15000 }).toContain('up to date');
    await page.evaluate(async () => {
      await fetch('/app/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ex.com/late', title: 'Late Addition', track: 'Live Track' }) });
    });
    await expect.poll(async () => await page.locator('.sync-state').innerText().catch(() => ''), { timeout: 15000 }).toContain('older version');
    // One press catches the registry up, and the bundle carries BOTH sources.
    await page.locator('.publish-go', { hasText: /Publish the update/ }).click();
    await expect.poll(async () => {
      const r = await fetch(`${url}/t/syl_live-track.json`);
      if (!r.ok) return [];
      return ((await r.json()) as { payload: { sources: { title: string }[] } }).payload.sources.map((x) => x.title).sort();
    }, { timeout: 20000 }).toEqual(['A', 'Late Addition']);

    await b.close();
  }, 180000);
});
