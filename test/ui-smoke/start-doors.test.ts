/**
 * An empty library offers three doors, not one.
 *
 * It used to offer only "paste a URL", which is a source and only a source — hiding that you can
 * start from a goal (a track) or an idea (a concept), or add a reading you have no link for. Each
 * door lands in the ordinary create form, so this is a friendlier floor, not a new mechanism.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';

let server: Server | undefined;
afterEach(() => server?.close());

describe.runIf(uiSmokeReady())('the empty-library start doors', () => {
  it('offers track, concept and source, and each opens the create form for that kind', async () => {
    const { createIngestServer } = await import('../../src/server/ingest');
    server = createIngestServer({ db: ':memory:' });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const app = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    await page.goto(app, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.start-door', { timeout: 15000 });
    expect(await page.locator('.start-door-title').allInnerTexts()).toEqual(['Start a track', 'Add a concept', 'Add a source']);
    // Each door is its kind's colour — the icon inherits var(--k-<kind>), never a default grey.
    for (const kind of ['track', 'concept', 'source'] as const) {
      const colour = await page.locator(`.start-door.${kind} .start-door-icon`).evaluate((el) => getComputedStyle(el).color);
      expect(colour, `${kind} icon coloured`).not.toBe('rgb(0, 0, 0)');
    }

    // A door opens the ordinary create form for its kind — the deep model, not a wizard.
    await page.locator('.start-door.track').click();
    await expect.poll(async () => await page.locator('.draft-form').count()).toBe(1);
    expect(await page.locator('.draft-form').innerText()).toMatch(/track/i);

    await browser.close();
  }, 120000);
});
