/**
 * The FORK-IDENTITY family of the shared-track lifecycle: the fork
 * that diverges, and the propose-back round trip — each asserted at every transition
 * on the one-origin deploy shape.
 *
 * The diverging fork also carries the framework-carriage story: the author's minted framework
 * rides the bundle (manifest + defs), the push stamps attribution, and the fork auto-installs
 * it — the full carriage chain on the deploy shape, not just the route tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, mailboxOf, registryEntryOf, openWorkbench, type OneOrigin } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('lifecycle fork identity (T-S3)', () => {
  it('P2 — the fork that diverges: push refused, publish-as-own coexists, lineage intact, frameworks travel stamped', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });

    // The author's library speaks a MINTED framework and the track uses it.
    const LENS = {
      framework: 'prof-lenses',
      version: 1,
      edgeTags: [{ name: 'EchoesTheme', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'symmetric', publish: true }],
    };
    expect((await prof.post('/app/framework/mine', LENS)).status).toBe(200);
    expect(
      (
        await prof.post('/app/import', {
          version: 2,
          concepts: [{ name: 'Alpha' }, { name: 'Beta' }],
          sources: [{ title: 'Reading One', url: 'https://ex.com/r1', modality: 'text' }],
          tracks: [{ title: 'Logic 101', includes: ['Alpha', 'Beta'], includeSources: ['Reading One'] }],
        })
      ).status,
    ).toBe(200);
    expect((await prof.post('/app/link', { srcType: 'concept', srcId: 'cpt_alpha', type: 'LINK', dstType: 'concept', dstId: 'cpt_beta', tags: [{ name: 'EchoesTheme' }] })).status).toBe(200);
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;

    // The bundle CARRIES the framework; the push STAMPED attribution and fed the archive.
    const served = await registryEntryOf(stack, trackId);
    expect(served.status).toBe(200);
    const defs = (served.bundle as unknown as { frameworkDefs?: { framework: string; author?: string }[] }).frameworkDefs;
    expect(defs?.map((d) => d.framework), 'the used framework ships with the bundle').toContain('prof-lenses');
    expect(defs?.find((d) => d.framework === 'prof-lenses')?.author, 'attribution minted by the push').toBe(prof.handle);
    const archived = (await (await fetch(`${stack.url}/frameworks/prof-lenses.json`)).json()) as { author?: string; version: number };
    expect(archived.author, 'the archive resolves it by name, stamped').toBe(prof.handle);
    const upstreamHashV1 = served.meta?.contentHash;

    // The stranger forks — and the framework AUTO-INSTALLS into their library, stamped.
    expect((await stu.forkRegistry(trackId)).status).toBe(200);
    const stuFw = await stu.getJson<{ installed: { framework: string; author?: string }[] }>('/app/framework');
    const installed = stuFw.installed.find((f) => f.framework === 'prof-lenses');
    expect(installed, "the fork carries the author's framework").toBeDefined();
    expect(installed!.author).toBe(prof.handle);

    // The fork diverges…
    expect((await stu.ingest({ url: 'https://ex.com/extra', title: 'My Extra', track: 'Logic 101' })).status).toBe(200);

    // …and a push UPSTREAM is refused: the registry knows whose track this is.
    await stu.publishLocal(trackId);
    const refused = await stu.push(await stu.publication(trackId));
    expect(refused.status, 'not your track — never a push').toBe(403);

    // Publish-AS-OWN: the alias mints a new public identity; the push lands under it.
    expect((await stu.post('/app/publish', { ref: trackId, as: 'Stu Remix' })).status).toBe(200);
    const remix = await stu.publication(trackId);
    expect(remix.publication.trackId).toBe('syl_stu-remix');
    expect((await stu.push(remix)).status).toBe(200);

    // Two tracks coexist; the upstream is UNTOUCHED by everything above.
    const upstream = await registryEntryOf(stack, trackId);
    const own = await registryEntryOf(stack, 'syl_stu-remix');
    expect(upstream.status).toBe(200);
    expect(own.status).toBe(200);
    expect(upstream.meta?.contentHash, 'upstream hash unchanged').toBe(upstreamHashV1);
    expect(upstream.bundle!.payload.sources.map((s) => s.title)).not.toContain('My Extra');
    expect(own.bundle!.payload.sources.map((s) => s.title)).toContain('My Extra');

    // The fork's ORIGIN lineage is intact — it still knows where it came from.
    const snap = await stu.getJson<{ tracks: { id: string; origin?: { trackId: string } }[] }>('/app/snapshot');
    expect(snap.tracks.find((t) => t.id === trackId)?.origin?.trackId, 'lineage survives the alias').toBe(trackId);

    // Each publishes independently after: both move, neither disturbs the other.
    await prof.ingest({ url: 'https://ex.com/r2', title: 'Reading Two', track: 'Logic 101' });
    await prof.publishAndPush('Logic 101');
    await stu.ingest({ url: 'https://ex.com/extra2', title: 'Extra Two', track: 'Logic 101' });
    await stu.publishLocal(trackId);
    expect((await stu.push(await stu.publication(trackId))).status).toBe(200);
    const upstreamV2 = await registryEntryOf(stack, trackId);
    const ownV2 = await registryEntryOf(stack, 'syl_stu-remix');
    expect(upstreamV2.meta?.contentHash).not.toBe(upstreamHashV1);
    expect(upstreamV2.bundle!.payload.sources.map((s) => s.title)).not.toContain('Extra Two');
    expect(ownV2.bundle!.payload.sources.map((s) => s.title)).toContain('Extra Two');
    expect(ownV2.bundle!.payload.sources.map((s) => s.title)).not.toContain('Reading Two');
  }, 120000);

  it('P5 — propose-back round trip: accept one, decline one; the accepted item returns deduped, the declined stays local; a re-propose sends nothing', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });
    await prof.ingest({ url: 'https://ex.com/r1', title: 'Reading One', track: 'Logic 101' });
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;
    const baseSrc = v1.payload.sources[0]!.id;
    expect((await stu.join(trackId, await prof.mintInvite(trackId))).status).toBe(200);

    // The member forks and BUILDS: a new source on the track, a question raised on the base.
    expect((await stu.forkRegistry(trackId)).status).toBe(200);
    expect((await stu.ingest({ url: 'https://ex.com/mine', title: 'My Addition', track: 'Logic 101' })).status).toBe(200);
    expect((await stu.post('/app/snippet', { sourceId: baseSrc, text: 'passage', raises: ['Why is soundness different?'] })).status).toBe(200);

    // PROPOSE is a workbench gesture (the diff runs client-side) — drive the real button.
    {
      const { browser, page } = await openWorkbench(stack, stu);
      await page.locator('.item', { hasText: 'Logic 101' }).first().click();
      await expect.poll(async () => await page.locator('.upstream-row').count(), { timeout: 15000 }).toBe(1);
      await page.locator('.upstream-actions button', { hasText: 'Propose my additions' }).click();
      await expect.poll(async () => (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' '), { timeout: 15000 }).toContain('Proposed 2');
      await browser.close();
    }
    expect(await mailboxOf(prof, trackId)).toHaveLength(2);

    // The owner accepts the SOURCE and declines the QUESTION — piecewise, from the inbox.
    {
      const { browser, page } = await openWorkbench(stack, prof);
      await page.locator('.tab', { hasText: 'Inbox' }).click();
      await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 20000 }).toBe(2);
      await page.locator('.cmail-row', { hasText: 'My Addition' }).locator('.pm-btn', { hasText: 'Accept' }).click();
      await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(1);
      await page.locator('.cmail-row', { hasText: 'soundness' }).locator('.pm-btn', { hasText: 'Decline' }).click();
      await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(0);
      await browser.close();
    }
    const profGraph = await graphOf(prof);
    expect(profGraph.sources.some((s) => s.title === 'My Addition'), 'accepted source landed upstream').toBe(true);
    expect(profGraph.questions.some((q) => q.text.includes('soundness')), 'declined question never entered').toBe(false);

    // Republish; the forker pulls: the accepted item comes back DEDUPED — no double.
    const v2 = await prof.publishAndPush('Logic 101');
    expect(v2.payload.sources.map((s) => s.title)).toContain('My Addition');
    await stu.pull(trackId);
    const stuGraph = await graphOf(stu);
    expect(stuGraph.sources.filter((s) => s.title === 'My Addition'), 'ONE copy, not two').toHaveLength(1);
    // The declined question stays LOCAL only — one copy in the fork, none upstream.
    expect(stuGraph.questions.filter((q) => q.text.includes('soundness'))).toHaveLength(1);

    // A second propose sends NOTHING — upstream has the source, the question is pending-free
    // but already-declined content is the member's to keep, not to re-mail automatically.
    {
      const { browser, page } = await openWorkbench(stack, stu);
      await page.locator('.item', { hasText: 'Logic 101' }).first().click();
      await expect.poll(async () => await page.locator('.upstream-row').count(), { timeout: 15000 }).toBe(1);
      await page.locator('.upstream-actions button', { hasText: 'Propose my additions' }).click();
      await page.waitForTimeout(1500);
      await browser.close();
    }
    const after = await mailboxOf(prof, trackId);
    expect(after.filter((m) => m.title === 'My Addition'), 'the accepted source is not re-mailed').toHaveLength(0);
  }, 180000);
});
