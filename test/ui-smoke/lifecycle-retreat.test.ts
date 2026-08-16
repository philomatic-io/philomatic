/**
 * The RETREAT family of the shared-track lifecycle: the unpublish, and
 * upstream retreats — the stories where the upstream takes something back, asserted at
 * every transition on the one-origin deploy shape. Pure HTTP; no browser needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uiSmokeReady } from './harness';
import { oneOriginStack, cast, graphOf, followingOf, registryEntryOf, type OneOrigin } from './lifecycle';

let stack: OneOrigin | undefined;
afterEach(() => stack?.close());

describe.runIf(uiSmokeReady())('lifecycle retreats (T-S4)', () => {
  it('P6 — the unpublish: the page 404s honestly, pull fails with a named reason, the follow drops, republish restores', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });
    await prof.ingest({ url: 'https://ex.com/r1', title: 'Reading One', track: 'Logic 101' });
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;

    // A follower (not a member — the pill, not a join) and a forker.
    expect((await stu.post(`/t/${trackId}/follow`, { follow: true })).status).toBe(200);
    expect((await followingOf(stu)).map((f) => f.trackId)).toContain(trackId);
    expect((await stu.forkRegistry(trackId)).status).toBe(200);

    // The owner withdraws — account-authed, from anywhere.
    expect((await prof.post('/unpublish', { trackId })).status).toBe(200);

    // The public face 404s HONESTLY — no ghost page, no stale bundle.
    expect((await registryEntryOf(stack, trackId)).status).toBe(404);
    expect((await fetch(`${stack.url}/t/${trackId}`)).status, 'the HTML page too').toBe(404);

    // A pull fails with a NAMED reason, not a hang or a silent no-op.
    const failed = await stu.post('/app/pull', { ref: trackId });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const reason = (await failed.json()) as { error?: string };
    expect(reason.error, 'the refusal says why').toBeTruthy();

    // The follower's feed DROPS the track — the follow lived on the entry, and the entry is
    // the owner's to take down (copies persist; the feed does not advertise a ghost).
    expect((await followingOf(stu)).map((f) => f.trackId)).not.toContain(trackId);

    // The forker's LIBRARY is untouched: their copy persists, same doctrine as local retraction.
    expect((await graphOf(stu)).sources.some((s) => s.title === 'Reading One'), 'the fork keeps its copy').toBe(true);

    // REPUBLISH restores the public face, and pulls flow again.
    await prof.publishAndPush('Logic 101');
    expect((await registryEntryOf(stack, trackId)).status).toBe(200);
    const pull = await stu.pull(trackId);
    expect(pull.took).toBe(0); // nothing new — the restore is the same content
  }, 120000);

  it('P8 — upstream retreats: deletion reported never applied, retitle taken where base-unchanged, local edits and local removals both survive', async () => {
    stack = await oneOriginStack();
    const { prof, stu } = await cast(stack, { prof: 'Prof', stu: 'Studious Stu' });
    for (const [n, title] of [['r1', 'Reading One'], ['r2', 'Reading Two'], ['r3', 'Reading Three'], ['r4', 'Reading Four']] as const) {
      await prof.ingest({ url: `https://ex.com/${n}`, title, track: 'Logic 101' });
    }
    const v1 = await prof.publishAndPush('Logic 101');
    const trackId = v1.publication.trackId;
    const idOf = (t: string) => v1.payload.sources.find((s) => s.title === t)!.id;

    // The member forks, EDITS one reading, and locally REMOVES another.
    expect((await stu.forkRegistry(trackId)).status).toBe(200);
    expect((await stu.update(idOf('Reading Two'), { author: 'Stu Note' })).status).toBe(200);
    expect((await stu.post('/app/remove', { ref: idOf('Reading Three') })).status).toBe(200);

    // Upstream retreats: one source removed, one retitled where the member never touched it,
    // and one retitled where the member DID edit.
    expect((await prof.post('/app/remove', { ref: idOf('Reading One') })).status).toBe(200);
    expect((await prof.update(idOf('Reading Four'), { title: 'Reading Four, 2nd ed' })).status).toBe(200);
    expect((await prof.update(idOf('Reading Two'), { title: 'Reading Two, Revised' })).status).toBe(200);
    const v2 = await prof.publishAndPush('Logic 101');
    expect(v2.payload.sources.map((s) => s.title)).not.toContain('Reading One');

    // The member pulls.
    const pull = await stu.pull(trackId);
    expect(pull.upstreamDeleted, 'the deletion is REPORTED').toBeGreaterThanOrEqual(1);
    const g = await graphOf(stu);
    const titles = g.sources.map((s) => s.title);

    // …but never APPLIED: the member keeps their copy of what upstream removed.
    expect(titles, 'upstream deletion did not reach into the fork').toContain('Reading One');
    // The retitle is TAKEN where the member's base was unchanged.
    expect(titles).toContain('Reading Four, 2nd ed');
    expect(titles).not.toContain('Reading Four');
    // The member's own edit is KEPT where they edited.
    const r2 = g.sources.find((s) => s.id === idOf('Reading Two'))!;
    expect(r2.author, 'the local edit outranks the pull').toBe('Stu Note');
    // A locally-REMOVED entity STAYS removed despite the pull carrying it.
    expect(titles, 'the local removal is respected').not.toContain('Reading Three');
  }, 120000);
});
