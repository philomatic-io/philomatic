/**
 * Fork, one click: on an origin that also serves a workbench, the public
 * page's Fork button opens the workbench with the track imported and selected — no file
 * download, no manual import. (Everywhere else the button keeps downloading the bundle.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, type OneOrigin } from './one-origin';
import { PhilomaticEngine } from '../../src/engine';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('fork hand-off', () => {
  it('the public page Fork opens the workbench with the track yours', async () => {
    stack = await oneOriginStack();
    const { url } = stack;
    // A community track on the registry, published by its (signed-in) author.
    const author = await stack.signIn('Author');
    const e = PhilomaticEngine.open(':memory:');
    e.captureSource({ url: 'https://ex.com/a', title: 'The Reading', track: 'Logic 101' });
    e.publish({ ref: 'Logic 101' });
    expect(
      (
        await fetch(`${url}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `pm_session=${author}`, 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify(e.publication('Logic 101')),
        })
      ).status,
    ).toBe(200);

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const page = await ctx.newPage();
    await page.goto(`${url}/t/syl_logic-101`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pub-fork.top', { timeout: 15000 });
    // The probe needs a beat; then the button should NAVIGATE, not download.
    await page.waitForTimeout(800);
    await page.locator('.pub-fork.top').click();
    await page.waitForURL(/\/app/, { timeout: 15000 });
    // The workbench comes up with the fork done: the track is in the library, selected.
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await expect.poll(async () => await page.locator('.item', { hasText: 'Logic 101' }).count(), { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await page.locator('.detail').innerText().catch(() => '')).includes('Logic 101'), { timeout: 15000 }).toBe(true);
    await b.close();
  }, 180000);
});
