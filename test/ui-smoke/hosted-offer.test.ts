/**
 * What a signed-in visitor SEES before they have a library.
 *
 * The server-side gate is unit-tested; this is the half that decides whether the rule is kind or
 * baffling. A person who signs in must be OFFERED storage, not told that something failed — and
 * the workbench must keep working in the browser while they decline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';
import type { OAuthProvider } from '../../src/registry/oauth';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const listen = async (s: Server): Promise<string> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

describe.runIf(uiSmokeReady())('the storage choice comes before login', () => {
  it('signed out → a choice, not a nag; choosing host provisions on return; nothing stored until then', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');
    const provider: OAuthProvider = {
      id: 'google',
      label: 'Google',
      authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`,
      exchange: async () => ({ provider: 'google', subject: 's1', name: 'A Student' }),
    };
    const reg = await listen(
      createRegistryServer({
        dir: mkdtempSync(join(tmpdir(), 'pm-offer-reg-')),
        providers: [provider],
        sessionSecret: 'test-secret',
        publicUrl: 'http://127.0.0.1',
      }),
    );
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-offer-data-'));
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

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();

    // 1. Signed out on a hosted origin: the STORAGE CHOICE comes first, not a sign-in nag. Both
    //    options are present, and nothing reads as an error.
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => await page.locator('.storage-choice h2').innerText()).toContain('Where should your learning graph live');
    const options = await page.locator('.storage-option strong').allInnerTexts();
    expect(options.join(' | ')).toMatch(/this browser/i);
    expect(options.join(' | ')).toMatch(/host it/i);
    expect(await page.locator('.error').count(), 'a choice is not a failure').toBe(0);
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.sqlite')), 'looking must not store').toEqual([]);

    // 2. Sign in for real (as if "host it" had sent us and back), carrying the intent flag so the
    //    library provisions on return without a second prompt.
    const started = await fetch(`${reg}/auth/google`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!, reg).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${reg}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
    const session = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
    await ctx.addCookies([{ name: 'pm_session', value: session.split('=')[1]!, url: app }]);
    await page.addInitScript(() => sessionStorage.setItem('pm.hostIntent', '1'));
    await page.goto(app, { waitUntil: 'domcontentloaded' });

    // 3. The chosen outcome, no re-prompt: provisions and the workbench comes up. Exactly one file.
    await expect.poll(async () => readdirSync(dataDir).filter((f) => f.endsWith('.sqlite')).length, { timeout: 20000 }).toBe(1);
    await expect.poll(async () => await page.locator('.storage-choice').count()).toBe(0);

    // 4. And the chrome NAMES the library — hosted-styled, not the browser badge — so which one
    //    you are in is never a surprise.
    const badge = page.locator('.lib-badge').first();
    await expect.poll(async () => await badge.count()).toBe(1);
    expect(await badge.getAttribute('class')).toContain('hosted');
    expect(await badge.innerText()).not.toMatch(/this browser/i);

    await browser.close();
  }, 180000);

  it('a RETURNING hosted person signed out gets the sign-in, not the chooser — and the escape leads back to the browser engine', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');
    const provider: OAuthProvider = {
      id: 'google',
      label: 'Google',
      authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`,
      exchange: async () => ({ provider: 'google', subject: 's1', name: 'A Student' }),
    };
    const reg = await listen(
      createRegistryServer({
        dir: mkdtempSync(join(tmpdir(), 'pm-return-reg-')),
        providers: [provider],
        sessionSecret: 'test-secret',
        publicUrl: 'http://127.0.0.1',
      }),
    );
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-return-data-'));
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

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();

    // Sign in and provision — the first visit's outcome, compressed.
    const started = await fetch(`${reg}/auth/google`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!, reg).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${reg}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
    const session = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
    await ctx.addCookies([{ name: 'pm_session', value: session.split('=')[1]!, url: app }]);
    await page.addInitScript(() => sessionStorage.setItem('pm.hostIntent', '1'));
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => await page.locator('.topbar').count(), { timeout: 20000 }).toBe(1);

    // Opening the hosted library MARKED the choice durably.
    await expect.poll(async () => await page.evaluate(() => localStorage.getItem('pm.hostedChosen')), { timeout: 20000 }).toBe('1');

    // Signed out and back at the front door: the sign-in leads, the chooser stays away,
    // and nothing reads as an error.
    await ctx.clearCookies();
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => await page.locator('.storage-choice h2').innerText().catch(() => ''), { timeout: 20000 }).toContain('Welcome back');
    expect(await page.locator('body').innerText()).not.toContain('Where should your learning graph live');
    // the sign-in pane opens itself for a returning hosted person
    await expect.poll(async () => await page.locator('.pm-signin').count()).toBe(1);
    expect(await page.locator('.error').count()).toBe(0);

    // The escape: the in-browser engine stays reachable without an account — and taking it
    // forgets the hosted choice, so the next hosted visit asks afresh.
    await page.locator('.pm-modal-cancel').click();
    await page.locator('.link-btn', { hasText: 'in-browser library' }).click();
    await expect.poll(async () => await page.locator('.topbar').count(), { timeout: 20000 }).toBe(1);
    expect(await page.locator('.lib-badge').first().getAttribute('class')).toContain('local');
    expect(await page.evaluate(() => localStorage.getItem('pm.hostedChosen'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('pm.backend'))).toBe('browser');

    await browser.close();
  }, 180000);

  it('a SELF-HOSTED workbench is never asked to sign in', async () => {
    // Most self-hosters run one library for one person and manage their own token. A sign-in
    // prompt there offers a door that leads nowhere.
    const { createIngestServer } = await import('../../src/server/ingest');
    const app = await listen(createIngestServer({ db: ':memory:' }));

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    // NOT networkidle: a loaded workbench holds the SSE change feed open, so the network never
    // goes idle and the wait times out.
    await page.goto(app, { waitUntil: 'domcontentloaded' });

    // The workbench, straight away: no offer, no error, no mention of signing in.
    await expect.poll(async () => await page.locator('.topbar').count()).toBe(1);
    expect(await page.locator('.host-offer').count(), 'no sign-in or storage offer').toBe(0);
    expect(await page.locator('.error').count()).toBe(0);
    expect(await page.locator('body').innerText()).not.toMatch(/sign in/i);
    // The badge still names the library — here, the self-hosted server, not "This browser".
    expect(await page.locator('.lib-badge').count()).toBe(1);

    await browser.close();
  }, 180000);
});
