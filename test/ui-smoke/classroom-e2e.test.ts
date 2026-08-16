/**
 * The classroom, END TO END on the deploy shape. Nothing mocked: a real registry and a
 * real hosted instance behind the one-origin proxy, three real accounts, and the workbench UI
 * for the one gesture that IS the product — the professor's accept.
 *
 * The beta story, in order: the professor publishes and invites; two students join, fork, and
 * each asks a question on the reading; the professor accepts BOTH from the workbench inbox,
 * adds a second reading, marks that it ANSWERS one question, republishes; both students pull.
 * The pull is additive and learner-respecting: everyone gains both questions and the answering
 * reading with its ANSWERS tie — and the student who edited the reading's metadata locally
 * KEEPS that edit (a member's own work outranks a pull). A second pull is quiet.
 *
 * Rides the lifecycle scenario harness — the cast/probe plumbing lives there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, relationsOf, openWorkbench, type OneOrigin, type PullSummary } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('the classroom, end to end (M-S7)', () => {
  it('publish → invite → two students fork and ask → accept both → answer → republish → pulls respect local edits', async () => {
    stack = await oneOriginStack();

    // ————— The professor: hosted library, one reading, published and pushed.
    const { prof, alice, bob } = await cast(stack, { prof: 'Prof', alice: 'Alice A', bob: 'Bob B' });
    await prof.ingest({ url: 'https://ex.com/soundness', title: 'The Reading', track: 'Logic 101' });
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;
    const srcId = v1.payload.sources[0]!.id;

    // ————— One class link; two students join, fork, and each asks ON the reading.
    const token = await prof.mintInvite(trackId);
    const asks = [
      { student: alice, text: 'Why is soundness not the same as completeness?' },
      { student: bob, text: 'Does completeness survive adding quantifiers?' },
    ];
    for (const { student, text } of asks) {
      expect((await student.join(trackId, token)).status).toBe(200);
      expect((await student.forkRegistry(trackId)).status).toBe(200);
      expect((await student.contribute(trackId, { kind: 'question', text, aboutId: srcId, aboutTitle: 'The Reading' })).status).toBe(200);
    }

    // Alice edits the reading in her OWN fork before any pull — the edit that must survive.
    expect((await alice.update(srcId, { author: 'G. Boole', estimatedDurationMins: 45 })).status).toBe(200);

    // ————— The professor accepts BOTH questions from the real workbench inbox.
    const { browser, page } = await openWorkbench(stack, prof);
    await page.locator('.tab', { hasText: 'Inbox' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 20000 }).toBe(2);
    for (let i = 0; i < 2; i++) {
      await page.locator('.cmail-row .pm-btn', { hasText: 'Accept' }).first().click();
      await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(1 - i);
    }
    await browser.close();

    // Both questions entered the professor's graph — attributed AND claim-addressed: the
    // #contrib tag is the deterministic {kind, value, assertedBy} hash.
    const profGraph = await graphOf(prof);
    const q1 = profGraph.questions.find((q) => q.text.includes('soundness'));
    expect(q1, "Alice's question is in the professor's graph").toBeDefined();
    expect(profGraph.questions.find((q) => q.text.includes('quantifiers')), "Bob's too").toBeDefined();
    const contrib = (q1!.tags ?? []).find((t) => t.startsWith('#contrib:'));
    expect(contrib, 'the accepted claim carries its deterministic id').toMatch(/^#contrib:c[0-9a-f]{15}$/);

    // ————— The professor adds a second reading and marks that it ANSWERS Alice's question.
    const added = (await (await prof.ingest({ url: 'https://ex.com/answering', title: 'The Answering Reading', track: 'Logic 101' })).json()) as { sourceId: string };
    expect((await prof.link({ srcType: 'source', srcId: added.sourceId, type: 'ANSWERS', dstType: 'question', dstId: q1!.id })).status).toBe(200);

    // Republish: mint v2 locally, push it — community state (members, invite) survives per FOLLOW.
    const v2 = await prof.publishAndPush('Logic 101');
    expect(v2.payload.sources.map((s) => s.title)).toContain('The Answering Reading');

    // ————— Both students pull. Additive: both questions + the answering reading + its tie.
    for (const { student } of asks) {
      const pull: PullSummary = await student.pull(trackId);
      expect(pull.took, `${student.name} takes the questions and the new reading`).toBeGreaterThanOrEqual(3);
      expect(pull.upstreamDeleted).toBe(0);
      const g = await graphOf(student);
      for (const { text } of asks) expect(g.questions.some((q) => q.text.includes(text.slice(0, 20))), `${student.name} has "${text}"`).toBe(true);
      expect(await relationsOf(student, added.sourceId), `${student.name} has the ANSWERS tie`).toContain(q1!.id);
    }

    // Alice's local edit SURVIVED her pull; Bob's copy is the upstream one, untouched.
    const aliceSrc = (await graphOf(alice)).sources.find((x) => x.id === srcId)!;
    expect(aliceSrc.author, 'the edit outranks the pull (M-D11)').toBe('G. Boole');
    expect(aliceSrc.estimatedDurationMins).toBe(45);
    const bobSrc = (await graphOf(bob)).sources.find((x) => x.id === srcId)!;
    expect(bobSrc.author).not.toBe('G. Boole');

    // A second pull is QUIET — the base moved forward with the first.
    const again = await alice.pull(trackId);
    expect(again.took).toBe(0);
    expect(again.edgesAdded).toBe(0);
    expect(again.upstreamDeleted).toBe(0);
  }, 240000);
});
