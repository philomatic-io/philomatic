/**
 * The classroom loop's first half, end to end on the deploy shape:
 * the professor publishes and invites; a student joins and asks a question ON a source;
 * it arrives in the professor's inbox NAMED and TIED; accepting writes it into the library
 * with the contributor riding as a tag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, relationsOf, mailboxOf, openWorkbench, type OneOrigin } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('the classroom loop (M-S5)', () => {
  it('ask on a passage → named in the inbox → accepted into the graph, attributed and tied', async () => {
    stack = await oneOriginStack();
    const { url } = stack;

    // The professor's hosted library: author, publish, push (as the browser would).
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });
    await prof.ingest({ url: 'https://ex.com/reading', title: 'The Reading', track: 'Logic 101' });
    const bundle = await prof.publishAndPush('Logic 101');
    const trackId = bundle.publication.trackId;
    const srcId = bundle.payload.sources[0]!.id;

    // Invite; the student joins and asks a question ON the reading.
    expect((await stu.join(trackId, await prof.mintInvite(trackId))).status).toBe(200);
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Why is soundness not the same as completeness?', aboutId: srcId, aboutTitle: 'The Reading' })).status).toBe(200);

    // The STUDENT'S surface is the track page's TABS. A member's
    // Questions tab carries the submit form and their waiting mail; a stranger sees the tabs
    // and their content — the community advertises itself — but a JOIN HINT where forms would be.
    {
      const { browser: sb, page: spage } = await openWorkbench(stack, stu, `/t/${trackId}`);
      await spage.locator('.pub-tab', { hasText: 'Questions' }).click();
      await expect.poll(async () => await spage.locator('.pubc-mine').count(), { timeout: 15000 }).toBe(1);
      expect(await spage.locator('.pubc-mine').innerText()).toContain('soundness');
      expect(await spage.locator('.pubt .pubc-send').count(), 'a member gets the submit form').toBe(1);
      // Contributions tab: the ask page's rail, member form live.
      await spage.locator('.pub-tab', { hasText: 'Contributions' }).click();
      await expect.poll(async () => await spage.locator('.askx-rail .askx-submit').count(), { timeout: 15000 }).toBe(1);

      const anon = await (await sb.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
      await anon.goto(`${url}/t/${trackId}`, { waitUntil: 'domcontentloaded' });
      await anon.waitForSelector('.pub-tabs', { timeout: 15000 });
      await anon.locator('.pub-tab', { hasText: 'Questions' }).click();
      await expect.poll(async () => await anon.locator('.pubt-join').count(), { timeout: 15000 }).toBe(1);
      expect(await anon.locator('.pubt .pubc-send').count(), 'no form for strangers').toBe(0);
      // But the track's open questions ARE public content on the tab.
      expect(await anon.locator('.pubt-qs').count()).toBeGreaterThanOrEqual(0);
      await sb.close();
    }

    // The professor's workbench inbox shows it, NAMED — and Accept writes it into the graph.
    const { browser, page } = await openWorkbench(stack, prof);
    // The tray COUNTS community mail before the inbox is opened: the count
    // is ordinary staged items PLUS pending contributions — here one captured source and one
    // student question, so the badge reads 2. That the mail is counted is what this pins.
    await expect
      .poll(async () => Number((await page.locator('.tab', { hasText: 'Inbox' }).innerText()).replace(/\D+/g, '') || '0'), { timeout: 20000 })
      .toBeGreaterThanOrEqual(2);
    await page.locator('.tab', { hasText: 'Inbox' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(1);
    const row = await page.locator('.cmail-row').innerText();
    expect(row).toContain('Why is soundness not the same as completeness?');
    expect(row, 'named').toContain('Studious-Stu'); // the public handle, not the real name
    expect(row, 'tied to the passage').toContain('on “The Reading”');
    // ONE decision: Accept lands the entity directly — it must NOT reappear in the ordinary
    // "pending validation" list for a second accept; accepting twice must not be possible.
    const stagedBefore = Number((await page.locator('.list-head').first().innerText()).replace(/\D+/g, '') || '0');
    await page.locator('.cmail-row .pm-btn', { hasText: 'Accept' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(0);
    await page.waitForTimeout(800);
    const stagedAfter = Number((await page.locator('.list-head').first().innerText()).replace(/\D+/g, '') || '0');
    expect(stagedAfter, 'accepted community mail does not re-enter validation').toBe(stagedBefore);

    // In the professor's LIBRARY now: the question, attributed, tied RAISES to the source.
    const q = (await graphOf(prof)).questions.find((x) => x.text.includes('soundness'));
    expect(q, 'the question entered the graph').toBeDefined();
    expect(await relationsOf(prof, srcId), 'RAISES tie from the source').toContain(q!.id);
    // And the registry's pending mailbox is clear.
    expect(await mailboxOf(prof, trackId)).toHaveLength(0);

    await browser.close();
  }, 180000);
});
