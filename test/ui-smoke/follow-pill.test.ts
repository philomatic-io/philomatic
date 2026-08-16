/**
 * The follow pill renders on the REGISTRY's own track page.
 *
 * The registry INLINES the bundle into its rendered page, so the viewer mounts with no trackId
 * prop — and the community fetch was gated on that prop, which is why the pill worked on
 * .json-fetch mounts (the fixture) and never in production. This test drives the registry's
 * actual rendered page, signed in, and clicks the pill both ways. (Personas from the harness;
 * the author publishes from a LOCAL engine — the pill's story is registry-side.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, followingOf, openWorkbench, type OneOrigin } from './lifecycle';
import { PhilomaticEngine } from '../../src/engine';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('the follow pill', () => {
  it('shows on the registry-rendered page, toggles, and joins land on the track', async () => {
    stack = await oneOriginStack();
    const { url } = stack;
    const { author, viewer, joiner } = await cast(stack, { author: 'Author', viewer: 'Viewer', joiner: 'Joiner' }, { provision: false });
    const e = PhilomaticEngine.open(':memory:');
    e.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Follow Me' });
    e.publish({ ref: 'Follow Me' });
    expect((await author.push(e.publication('Follow Me'))).status).toBe(200);

    const { browser, page } = await openWorkbench(stack, viewer, '/t/syl_follow-me');
    // THE pill — on the registry's own rendered page, signed in.
    await expect.poll(async () => await page.locator('.pub-follow').count(), { timeout: 15000 }).toBe(1);
    expect(await page.locator('.pub-follow').innerText()).toContain('Follow');
    await page.locator('.pub-follow').click();
    await expect.poll(async () => await page.locator('.pub-follow').innerText(), { timeout: 10000 }).toContain('Following');
    // And it is real: the feed knows.
    expect((await followingOf(viewer)).map((f) => f.trackId)).toContain('syl_follow-me');

    // A browser-form JOIN lands on the track page, not a JSON screen.
    const token = await author.mintInvite('syl_follow-me');
    const jctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await jctx.addCookies([{ name: 'pm_session', value: joiner.cookie, url }]);
    const jpage = await jctx.newPage();
    await jpage.goto(`${url}/t/syl_follow-me/join?c=${token}`, { waitUntil: 'domcontentloaded' });
    await jpage.locator('button', { hasText: 'Join this track' }).click();
    await jpage.waitForURL(/\/t\/syl_follow-me$/, { timeout: 15000 });
    await jpage.waitForSelector('.pub-toolbar', { timeout: 15000 });
    // Members follow by default — the pill arrives already on.
    await expect.poll(async () => await jpage.locator('.pub-follow').innerText().catch(() => ''), { timeout: 15000 }).toContain('Following');

    await browser.close();
  }, 180000);
});
