/**
 * Accepting a community SOURCE is ONE decision — it must never feel like accepting twice.
 * Captures normally land STAGED for validation — but the owner's Accept in the community
 * inbox IS that validation, so the source must land accepted, not reappear in the ordinary
 * "pending validation" list.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, openWorkbench, type OneOrigin } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('accept once', () => {
  it('an accepted source recommendation does not re-enter validation', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Stu' });
    await prof.ingest({ track: 'T1', url: 'https://ex.com/r', title: 'Reading' });
    const trackId = (await prof.publishAndPush('T1')).publication.trackId;
    expect((await stu.join(trackId, await prof.mintInvite(trackId))).status).toBe(200);
    // A recommended SOURCE (the reported case).
    expect((await stu.contribute(trackId, { kind: 'source', text: 'a video', title: 'Intro Video', url: 'https://youtube.com/watch', modality: 'video' })).status).toBe(200);

    const { browser, page } = await openWorkbench(stack, prof);
    await page.locator('.tab', { hasText: 'Inbox' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(1);
    const stagedBefore = Number((await page.locator('.list-head').first().innerText()).replace(/\D+/g, '') || '0');
    await page.locator('.cmail-row .pm-btn', { hasText: 'Accept' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(0);
    await page.waitForTimeout(1000);
    const stagedAfter = Number((await page.locator('.list-head').first().innerText()).replace(/\D+/g, '') || '0');
    expect(stagedAfter, 'the accepted source did not re-stage for a second accept').toBe(stagedBefore);

    // And it is really in the library — accepted, not staged.
    const src = (await graphOf(prof)).sources.find((s) => s.title === 'Intro Video');
    expect(src, 'source landed').toBeDefined();
    expect(src!.staged ?? false, 'landed accepted, not staged').toBe(false);
    await browser.close();
  }, 120000);
});
