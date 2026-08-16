/**
 * The owner-side GATES of the shared-track lifecycle: three progressions —
 * the decline, the goodbye, the duplicate — each a story asserted
 * at every transition, on the one-origin deploy shape, nothing mocked.
 *
 * Pure state transitions run over HTTP through the lifecycle harness; the browser appears
 * only for the duplicate, where the assertion is about the inbox surface itself (accept one, decline
 * the twin).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, mailboxOf, followingOf, openWorkbench, type OneOrigin } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

/** Pending mailbox records carry their id (the resolve handle) — widen the probe's view. */
interface MailRecord {
  id: string;
  kind: string;
  name: string;
  text: string;
}
const pendingOf = async (reader: Parameters<typeof mailboxOf>[0], trackId: string): Promise<MailRecord[]> =>
  (await mailboxOf(reader, trackId)) as unknown as MailRecord[];

describe.runIf(uiSmokeReady())('lifecycle gates (T-S2)', () => {
  it('P3 — the decline: both declined, nothing enters the graph, the contributor sees it, a re-submit is possible', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });
    await prof.ingest({ url: 'https://ex.com/reading', title: 'The Reading', track: 'Logic 101' });
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;
    const srcId = v1.payload.sources[0]!.id;

    // The member sends a question AND a source recommendation.
    expect((await stu.join(trackId, await prof.mintInvite(trackId))).status).toBe(200);
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Why soundness?', aboutId: srcId, aboutTitle: 'The Reading' })).status).toBe(200);
    expect((await stu.contribute(trackId, { kind: 'source', text: 'a video', title: 'Intro Video', url: 'https://youtube.com/watch', modality: 'video' })).status).toBe(200);

    // Both wait in the owner's mailbox, attributed to the member's public handle.
    const pending = await pendingOf(prof, trackId);
    expect(pending).toHaveLength(2);
    for (const m of pending) expect(m.name, 'attributed').toBe(stu.handle);
    // The member sees their own waiting mail too.
    expect(await pendingOf(stu, trackId)).toHaveLength(2);

    // The owner DECLINES both — resolution stamps the record, it does not delete it.
    for (const m of pending) {
      expect((await prof.contribute(trackId, { resolve: m.id, action: 'declined' })).status).toBe(200);
    }

    // The mailbox resolves for BOTH parties: nothing pending anywhere.
    expect(await pendingOf(prof, trackId), 'owner mailbox clear').toHaveLength(0);
    expect(await pendingOf(stu, trackId), 'the contributor sees the outcome — nothing of theirs still waits').toHaveLength(0);

    // NOTHING entered the owner's graph — decline never touches it.
    const g = await graphOf(prof);
    expect(g.questions.some((q) => q.text.includes('Why soundness?')), 'declined question absent').toBe(false);
    expect(g.sources.some((s) => s.title === 'Intro Video'), 'declined source absent').toBe(false);

    // A re-submit is possible — decline is not a ban.
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Why soundness?', aboutId: srcId, aboutTitle: 'The Reading' })).status).toBe(200);
    expect(await pendingOf(prof, trackId)).toHaveLength(1);

    // A coda — the REJECTED CAPTURE, in the same session: a staged entity, the
    // REJECT verdict, restorably retracted, and restore works. (The retraction/unverb
    // semantics themselves are unit-covered; this pins the deploy-shape round trip.)
    const parked = (await (await stu.post('/app/ingest', { url: 'https://ex.com/parked', title: 'Parked Capture', track: 'Logic 101', stage: true })).json()) as { sourceId: string };
    expect((await graphOf(stu)).sources.find((s) => s.id === parked.sourceId)?.staged, 'lands staged').toBe(true);
    expect((await stu.post('/app/reject', { ref: parked.sourceId })).status).toBe(200);
    expect((await graphOf(stu)).sources.some((s) => s.id === parked.sourceId), 'reject retracts').toBe(false);
    expect((await stu.post('/app/restore', { ref: parked.sourceId })).status).toBe(200);
    expect((await graphOf(stu)).sources.some((s) => s.id === parked.sourceId), 'restorably').toBe(true);
  }, 120000);

  it('P4 — the goodbye: revoke stops new joins (410), eject removes membership + follow but keeps attributed history, re-invite readmits', async () => {
    stack = await oneOriginStack();
    const { prof, stu, late } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu', late: 'Late Larry' });
    await prof.ingest({ url: 'https://ex.com/reading', title: 'The Reading', track: 'Logic 101' });
    const trackId = (await prof.publishAndPush('Logic 101')).publication.trackId;

    // The member joins (membership auto-follows) and leaves one contribution as history.
    const token1 = await prof.mintInvite(trackId);
    expect((await stu.join(trackId, token1)).status).toBe(200);
    expect((await followingOf(stu)).map((f) => f.trackId), 'members follow by default').toContain(trackId);
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Kept as history?' })).status).toBe(200);

    // REVOKE: the old link dies for NEW joins — the member already in is untouched.
    expect((await prof.community(trackId, { invite: 'revoke' })).status).toBe(200);
    expect((await late.join(trackId, token1)).status, 'a revoked link answers 410').toBe(410);
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Still a member' })).status).toBe(200);

    // EJECT: membership and the follow go together; past contributions stay, attributed.
    const view = await prof.getJson<{ members: { accountId: string; name: string }[] }>(`/t/${trackId}/community`);
    const member = view.members.find((m) => m.name === stu.handle)!;
    expect(member, 'the owner sees the member to remove').toBeDefined();
    const afterEject = (await (await prof.community(trackId, { removeMember: member.accountId })).json()) as { members: unknown[] };
    expect(afterEject.members, 'membership gone').toHaveLength(0);
    expect((await followingOf(stu)).map((f) => f.trackId), 'their follow went with it').not.toContain(trackId);
    const history = await pendingOf(prof, trackId);
    expect(history.length, 'past contributions stay').toBeGreaterThanOrEqual(2);
    for (const m of history) expect(m.name, 'still attributed').toBe(stu.handle);

    // The ejected member's next submit is refused.
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Am I still in?' })).status).toBe(403);

    // RE-INVITE readmits: a fresh link, a fresh join, contributions flow again.
    const token2 = await prof.mintInvite(trackId);
    expect(token2).not.toBe(token1);
    expect((await stu.join(trackId, token2)).status).toBe(200);
    expect((await stu.contribute(trackId, { kind: 'question', text: 'Back in the room' })).status).toBe(200);
  }, 120000);

  it('P7 — the duplicate: two members submit the same question; accept one, decline the twin; the graph holds ONE', async () => {
    stack = await oneOriginStack();
    const { prof, alice, bob } = await cast(stack, { prof: 'Prof', alice: 'Alice A', bob: 'Bob B' });
    await prof.ingest({ url: 'https://ex.com/reading', title: 'The Reading', track: 'Logic 101' });
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;
    const srcId = v1.payload.sources[0]!.id;
    const token = await prof.mintInvite(trackId);

    // Both members ask the SAME question, independently.
    const text = 'Why is soundness not completeness?';
    for (const s of [alice, bob]) {
      expect((await s.join(trackId, token)).status).toBe(200);
      expect((await s.contribute(trackId, { kind: 'question', text, aboutId: srcId, aboutTitle: 'The Reading' })).status).toBe(200);
    }
    const pending = await pendingOf(prof, trackId);
    expect(pending, 'both land, separately attributed').toHaveLength(2);
    expect(new Set(pending.map((m) => m.name))).toEqual(new Set([alice.handle, bob.handle]));

    // The inbox surface: accept the first, DECLINE the twin — one decision each.
    const { browser, page } = await openWorkbench(stack, prof);
    await page.locator('.tab', { hasText: 'Inbox' }).click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 20000 }).toBe(2);
    await page.locator('.cmail-row .pm-btn', { hasText: 'Accept' }).first().click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(1);
    await page.locator('.cmail-row .pm-btn', { hasText: 'Decline' }).first().click();
    await expect.poll(async () => await page.locator('.cmail-row').count(), { timeout: 15000 }).toBe(0);
    await browser.close();

    // The graph holds exactly ONE copy of the question; both mailboxes resolved.
    const g = await graphOf(prof);
    expect(g.questions.filter((q) => q.text === text), 'one question, not two').toHaveLength(1);
    expect(await pendingOf(prof, trackId), 'owner mailbox clear').toHaveLength(0);
    expect(await pendingOf(alice, trackId), "alice's mail resolved").toHaveLength(0);
    expect(await pendingOf(bob, trackId), "bob's mail resolved").toHaveLength(0);
  }, 120000);
});
