import { describe, it, afterEach, expect } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, type OneOrigin } from './one-origin';
import { PhilomaticEngine } from '../../src/engine';
let stack: OneOrigin | undefined;
afterEach(() => stack?.close());
describe.runIf(uiSmokeReady())('verify', () => {
  it('hungry recursion + tag, visible sources, folding concepts', async () => {
    stack = await oneOriginStack();
    const author = await stack.signIn('Author');
    const e = PhilomaticEngine.open(':memory:');
    e.importPayload({
      version: 2,
      concepts: [
        { name: 'Algebra' },                                    // covered ONLY via child → not hungry
        { name: 'Boolean', prerequisites: ['Algebra'] },        // direct source → not hungry
        { name: 'Bare' },                                       // nothing → hungry
        { name: 'AskedFor', tags: ['#NeedsSources'] },          // covered BUT tagged → flagged
      ],
      sources: [
        { title: 'Boolean Book', modality: 'text', explains: ['Boolean'] },
        { title: 'Asked Book', modality: 'text', explains: ['AskedFor'] },
      ],
      tracks: [{ title: 'Cover', includes: ['Algebra', 'Boolean', 'Bare', 'AskedFor'], includeSources: ['Boolean Book', 'Asked Book'] }],
    });
    e.publish({ ref: 'Cover' });
    await fetch(`${stack.url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `pm_session=${author}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(e.publication('Cover')) });
    const { chromium } = await import('playwright-core'); const { findChromium } = (await import('./harness')) as any;
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1700, height: 1000 } });
    await ctx.addCookies([{ name: 'pm_session', value: author, url: stack.url }]);
    const page = await ctx.newPage();
    await page.goto(`${stack.url}/t/syl_cover`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pub-tabs', { timeout: 15000 });
    await page.locator('.pub-tab', { hasText: 'Contributions' }).click();
    await page.waitForSelector('.askx-grid', { timeout: 15000 });
    const cards = await page.locator('.askx-card .askx-card-name').allInnerTexts();
    console.log('FLAGGED CARDS:', JSON.stringify(cards));
    expect(cards).toContain('Bare');
    expect(cards).toContain('AskedFor');
    expect(cards).not.toContain('Algebra'); // covered via its child
    expect(cards).not.toContain('Boolean');
    // Sources VISIBLE in the graph (nested under open-by-default concepts), concepts foldable.
    // Scoped to .askx — the hidden Track tab renders its own graph behind this one.
    await expect.poll(async () => await page.locator('.askx .agraph-box:not(.concept)').count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator('.askx .agraph-box.concept .agraph-caret').count()).toBeGreaterThan(0);
    expect(await page.locator('.askx .agraph-box:not(.concept) .agraph-caret').count(), 'sources flat').toBe(0);
    await b.close();
  }, 120000);

  it('the chip: current → ahead → behind', async () => {
    stack = await oneOriginStack();
    const author = await stack.signIn('Author');
    const { chromium } = await import('playwright-core'); const { findChromium } = (await import('./harness')) as any;
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
    await ctx.addCookies([{ name: 'pm_session', value: author, url: stack.url }]);
    await ctx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const page = await ctx.newPage();
    await page.goto(`${stack.url}/app`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await page.evaluate(async () => {
      const c = (globalThis as any).__PM_CLIENT__;
      await c.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Chip Track' });
      await c.publish('Chip Track', 'CC-BY-SA-4.0');
      await c.pushToRegistry('Chip Track', location.origin);
    });
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    // rail row chip: current
    await expect.poll(async () => (await page.locator('.item .pubstate-chip').allInnerTexts().catch(() => [])).join(' '), { timeout: 15000 }).toContain('up to date');
    // edit → ahead (detail header chip; cache busts on remount after reload)
    await page.evaluate(async () => { const c = (globalThis as any).__PM_CLIENT__; await c.captureSource({ url: 'https://ex.com/b', title: 'B', track: 'Chip Track' }); });
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await expect.poll(async () => (await page.locator('.pubstate-chip').allInnerTexts().catch(() => [])).join(' '), { timeout: 35000 }).toContain('library ahead');
    // registry moves past us (same account, newer content pushed by "another device") → behind
    const e2 = PhilomaticEngine.open(':memory:');
    e2.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Chip Track' });
    e2.captureSource({ url: 'https://ex.com/c', title: 'C', track: 'Chip Track' });
    e2.captureSource({ url: 'https://ex.com/d', title: 'D', track: 'Chip Track' });
    e2.publish({ ref: 'Chip Track' });
    // our library's CURRENT hash must be in the archive for behind-detection; it is (we pushed it? no—
    // our AHEAD state means local hash unpushed). So push OUR current first, then the newer one.
    const mine = await page.evaluate(async () => { const c = (globalThis as any).__PM_CLIENT__; return await c.exportAll(); });
    const e3 = PhilomaticEngine.open(':memory:');
    e3.importPayload(mine);
    e3.publish({ ref: 'Chip Track' });
    await fetch(`${stack.url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `pm_session=${author}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(e3.publication('Chip Track')) });
    await fetch(`${stack.url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `pm_session=${author}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(e2.publication('Chip Track')) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    await expect.poll(async () => (await page.locator('.pubstate-chip').allInnerTexts().catch(() => [])).join(' '), { timeout: 35000 }).toContain('library behind');
    await page.locator('.item', { hasText: 'Chip Track' }).first().click();
    await page.waitForTimeout(800);
    await b.close();
  }, 180000);
});
