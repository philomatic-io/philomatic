/**
 * "Propose my additions" end to end: a member forks, builds, and
 * proposes — the additions arrive in the upstream mailbox attributed and anchored, ready for
 * the owner's piecewise accept. The PR model on the community machinery; never a push.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, type OneOrigin } from './one-origin';
import { PhilomaticEngine } from '../../src/engine';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('propose my additions', () => {
  it('fork → build → propose → attributed, anchored mail upstream', async () => {
    stack = await oneOriginStack();
    const { url } = stack;
    const prof = await stack.signIn('Prof');
    const e = PhilomaticEngine.open(':memory:');
    e.captureSource({ url: 'https://ex.com/r1', title: 'Reading One', track: 'Logic 101' });
    e.importPayload({ version: 2, concepts: [{ name: 'Completeness' }], tracks: [{ title: 'Logic 101', includes: ['Completeness'] }] });
    e.publish({ ref: 'Logic 101' });
    const withProf = { 'content-type': 'application/json', cookie: `pm_session=${prof}`, 'sec-fetch-site': 'same-origin' } as const;
    expect((await fetch(`${url}/publish`, { method: 'POST', headers: withProf, body: JSON.stringify(e.publication('Logic 101')) })).status).toBe(200);
    const minted = await (await fetch(`${url}/t/syl_logic-101/community`, { method: 'POST', headers: withProf, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL((minted as { invite: { link: string } }).invite.link).searchParams.get('c')!;

    // The student joins, then works in a BROWSER library: fork, add a source tied to the base
    // concept, raise a question on the base reading.
    const stu = await stack.signIn('Stu');
    await fetch(`${url}/t/syl_logic-101/join?c=${token}`, { method: 'POST', headers: { cookie: `pm_session=${stu}`, 'sec-fetch-site': 'same-origin' } });
    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'pm_session', value: stu, url }]);
    await ctx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const page = await ctx.newPage();
    await page.goto(`${url}/app`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    const built = await page.evaluate(async () => {
      type C = {
        forkRegistryTrack: (id: string) => Promise<unknown>;
        captureSource: (i: unknown) => Promise<{ sourceId: string }>;
        captureSnippet: (i: unknown) => Promise<unknown>;
        link: (e: unknown) => Promise<unknown>;
        exportAll: () => Promise<{ concepts: { id: string; name: string }[]; sources: { id: string; title: string }[] }>;
      };
      const c = (globalThis as { __PM_CLIENT__?: C }).__PM_CLIENT__!;
      await c.forkRegistryTrack('syl_logic-101');
      const all = await c.exportAll();
      const conceptId = all.concepts.find((x) => x.name === 'Completeness')!.id;
      const baseSrc = all.sources.find((x) => x.title === 'Reading One')!.id;
      const made = await c.captureSource({ url: 'https://ex.com/mine', title: 'My Addition', author: 'Stu', track: 'Logic 101' });
      await c.link({ srcType: 'source', srcId: made.sourceId, type: 'ABOUT', dstType: 'concept', dstId: conceptId });
      await c.captureSnippet({ sourceId: baseSrc, text: 'passage', raises: ['Why is soundness different?'] });
      return 'ok';
    });
    expect(built).toBe('ok');
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });

    // The fork's publish box shows the upstream row; Propose sends the additions.
    await page.locator('.item', { hasText: 'Logic 101' }).first().click();
    await expect.poll(async () => await page.locator('.upstream-row').count(), { timeout: 15000 }).toBe(1);
    await page.locator('.upstream-actions button', { hasText: 'Propose my additions' }).click();
    await expect.poll(async () => (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' '), { timeout: 15000 }).toContain('Proposed 2');

    // Upstream mailbox: both items, attributed to Stu, anchored to upstream entities.
    const mail = (await (await fetch(`${url}/t/syl_logic-101/contributions`, { headers: { cookie: `pm_session=${prof}` } })).json()) as {
      contributions: { kind: string; name: string; title?: string; text: string; aboutTitle?: string; url?: string; author?: string }[];
    };
    expect(mail.contributions).toHaveLength(2);
    const src = mail.contributions.find((m) => m.kind === 'source')!;
    expect(src).toMatchObject({ name: 'Stu', title: 'My Addition', author: 'Stu', url: 'https://ex.com/mine', aboutTitle: 'Completeness' });
    const q = mail.contributions.find((m) => m.kind === 'question')!;
    expect(q).toMatchObject({ name: 'Stu', text: 'Why is soundness different?', aboutTitle: 'Reading One' });

    // Proposing again sends nothing new — the pending set dedupes.
    await page.locator('.upstream-actions button', { hasText: 'Propose my additions' }).click();
    await page.waitForTimeout(1500);
    const again = (await (await fetch(`${url}/t/syl_logic-101/contributions`, { headers: { cookie: `pm_session=${prof}` } })).json()) as { contributions: unknown[] };
    expect(again.contributions).toHaveLength(2);

    await b.close();
  }, 180000);
});
