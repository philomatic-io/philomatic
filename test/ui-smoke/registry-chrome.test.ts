/**
 * UI smoke — the REGISTRY's own pages, checked for controls the browser is painting.
 *
 * `chrome.test.ts` makes this check on the workbench. The registry's pages are server-rendered
 * HTML with their own stylesheet, so they get it independently — and they needed it: the token
 * form shipped with an unstyled input and a button whose label vanished into its own background
 * — the same failure class the workbench's own token form once had.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiSmokeReady } from './harness';
import type { OAuthProvider } from '../../src/registry/oauth';

const DEFAULT_CHROME = ['rgb(239, 239, 239)', 'rgb(255, 255, 255)'];

describe.skipIf(!uiSmokeReady())('no registry control renders in browser chrome', () => {
  it('the library, sign-in, and account pages', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const provider: OAuthProvider = {
      id: 'google',
      label: 'Google',
      authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`,
      exchange: async () => ({ provider: 'google', subject: 's', name: 'Tyler Wilbers' }),
    };
    const server = createRegistryServer({
      dir: mkdtempSync(join(tmpdir(), 'pm-regchrome-')),
      introHtml: false,
      providers: [provider],
      sessionSecret: 'test-secret',
      publicUrl: 'http://127.0.0.1',
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

    // Sign in through the real round trip, so /account is reachable.
    const started = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location')!, url).searchParams.get('state')!;
    const parked = (started.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const back = await fetch(`${url}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
    const session = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await ctx.addCookies([{ name: 'pm_session', value: session.split('=')[1]!, url }]);
    const page = await ctx.newPage();

    const unstyled = async (): Promise<string[]> =>
      await page.evaluate((defaults: string[]) => {
        const out = new Set<string>();
        document.querySelectorAll<HTMLElement>('button, input, select, textarea').forEach((el) => {
          const box = el.getBoundingClientRect();
          if (box.width < 4 || box.height < 4) return;
          const cs = getComputedStyle(el);
          if (!defaults.includes(cs.backgroundColor)) return;
          out.add(`${el.tagName.toLowerCase()}.${el.className || '(no class)'}`);
        });
        return [...out];
      }, DEFAULT_CHROME);

    for (const path of ['/', '/signin', '/signup', '/account']) {
      await page.goto(`${url}${path}`, { waitUntil: 'networkidle' });
      expect(await unstyled(), path).toEqual([]);
    }
    // The registry index says whose site this is, top left, and SURVIVES hydration —
    // the brand lives outside #root for the same reason the sign-in control does.
    await page.goto(`${url}/`, { waitUntil: 'networkidle' });
    await expect.poll(async () => await page.locator('.reg-brand').innerText()).toContain('Philomatic');
    expect(await page.locator('.reg-brand svg').count()).toBe(1);

    // Not vacuous: /account really does carry the controls that were broken.
    await page.goto(`${url}/account`, { waitUntil: 'networkidle' });
    expect(await page.locator('.reg-username input, .reg-username button').count()).toBe(2);

    // THE ACCOUNT CORNER PIN (regressed three times): on the index, the
    // control sits in the RIGHT half of the bar and its dropdown actually opens, signed in and
    // signed out alike. Any change that drops the slot's margin, the wrapper, or the React
    // mount fails HERE instead of in a real browser session.
    await page.goto(`${url}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#acct-root .topbar-account', { timeout: 15000 });
    const bar = (await page.locator('.reg-authbar').boundingBox())!;
    const av = (await page.locator('#acct-root .topbar-account').boundingBox())!;
    expect(av.x, 'avatar in the right half of the bar').toBeGreaterThan(bar.x + bar.width / 2);
    await page.locator('#acct-root .topbar-account').click();
    await page.waitForSelector('.acct-menu', { timeout: 5000 });
    expect(await page.locator('.acct-menu').innerText()).toContain('Sign out');
    const anonCtx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const anon = await anonCtx.newPage();
    await anon.goto(`${url}/`, { waitUntil: 'networkidle' });
    await anon.waitForSelector('#acct-root .topbar-signin', { timeout: 15000 });
    const bar2 = (await anon.locator('.reg-authbar').boundingBox())!;
    const si = (await anon.locator('#acct-root .topbar-signin').boundingBox())!;
    expect(si.x, 'sign-in in the right half of the bar').toBeGreaterThan(bar2.x + bar2.width / 2);
    await anonCtx.close();

    await browser.close();
    server.close();
  }, 120000);
});
