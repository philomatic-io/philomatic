/**
 * Communities: sharing a published track.
 *
 * The first test IS the security line: the invite token and the member list must never appear on
 * the public index, and an unlisted track must not appear there at all. Everything else — mint,
 * join, roles, revoke — follows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { readReg, writeReg } from './registry-file';
import { createRegistryServer } from '../src/registry/server';
import { PhilomaticEngine } from '../src/engine';
import type { OAuthProvider } from '../src/registry/oauth';

const SECRET = 'x'.repeat(32);
const open: Server[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

// Identity rides in the OAuth `code`, so each signIn is a distinct account on the one registry.
const provider = (): OAuthProvider => ({
  id: 'fake',
  label: 'Fake',
  authorizeUrl: ({ state }) => `/auth/fake/callback?code=CODE&state=${state}`,
  exchange: async ({ code }) => ({ provider: 'fake', subject: code, name: code }),
});

/** A registry + a helper to sign someone in (returns their session cookie). */
async function reg() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-comm-'));
  const server = createRegistryServer({ dir, introHtml: false, providers: [provider()], sessionSecret: SECRET, publicUrl: 'http://reg.test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, dir };
}
/** Sign in WITHOUT choosing a handle (for testing the first-run username step). */
async function signInRaw(url: string, subject: string): Promise<string> {
  const st = await fetch(`${url}/auth/fake?next=/`, { redirect: 'manual' });
  const state = new URL(st.headers.get('location')!, url).searchParams.get('state')!;
  const parked = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
  const back = await fetch(`${url}/auth/fake/callback?code=${subject}&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
  return (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
}
/** Sign in AND claim the handle `subject` — the ordinary state most tests want. */
async function signIn(url: string, subject: string): Promise<string> {
  const cookie = await signInRaw(url, subject);
  await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: subject }) });
  return cookie;
}
async function publish(url: string, cookie: string, title: string): Promise<void> {
  const e = PhilomaticEngine.open(':memory:');
  e.captureSource({ url: 'https://ex.com/a', title: 'A', track: title });
  e.publish({ ref: title, license: 'CC-BY-SA-4.0' });
  const res = await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(e.publication(title)) });
  expect(res.status, 'publish').toBe(200);
}

describe('community sharing', () => {
  it('never leaks the invite token or members on the public index, and hides unlisted', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Set Theory');
    // Mint an invite (which defaults the track unlisted).
    const minted = await (await fetch(`${url}/t/syl_set-theory/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    expect(minted.invite.link, 'the owner gets a real link').toMatch(/\/t\/syl_set-theory\/join\?c=[a-f0-9]{32}/);

    // THE SECURITY LINE: the public index shows neither the track (unlisted) nor any token.
    const index = await (await fetch(`${url}/index.json`)).text();
    expect(index).not.toContain('syl_set-theory'); // unlisted → absent
    expect(index).not.toMatch(/[a-f0-9]{32}/); // no capability token anywhere
    expect(index).not.toContain('members');
    expect(index).not.toContain('invite');
  });

  it('an owner mints a link, a stranger redeems it and becomes a contributor', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Bias 101');
    const minted = await (await fetch(`${url}/t/syl_bias-101/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;

    // A second person signs in and redeems the SAME shared link.
    const student = await signIn(url, 'student');
    const joined = await fetch(`${url}/t/syl_bias-101/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });
    expect(joined.status).toBe(200);
    expect((await joined.json()).joined).toBe(true);

    // The owner's view now lists the student as a contributor; the student sees they are a member.
    const ownerView = await (await fetch(`${url}/t/syl_bias-101/community`, { headers: { cookie: owner } })).json();
    expect(ownerView.members.map((m: { role: string }) => m.role)).toEqual(['contributor']);
    const studentView = await (await fetch(`${url}/t/syl_bias-101/community`, { headers: { cookie: student } })).json();
    expect(studentView).toEqual({ owner: false, member: true, following: true });

    // Redeeming again is idempotent — no duplicate.
    await fetch(`${url}/t/syl_bias-101/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });
    expect((await (await fetch(`${url}/t/syl_bias-101/community`, { headers: { cookie: owner } })).json()).members).toHaveLength(1);

    // Revoke: the old token stops working, joined members stay.
    await fetch(`${url}/t/syl_bias-101/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'revoke' }) });
    const late = await fetch(`${url}/t/syl_bias-101/join?c=${token}`, { method: 'POST', headers: { cookie: await signIn(url, 'late'), 'sec-fetch-site': 'same-origin' } });
    expect(late.status).toBe(410);
    expect((await (await fetch(`${url}/t/syl_bias-101/community`, { headers: { cookie: owner } })).json()).members).toHaveLength(1);
  });

  it('only the owner can change sharing, and a non-member learns nothing', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Private Track');
    const stranger = await signIn(url, 'nobody');
    // A stranger cannot mint or read the member list.
    expect((await fetch(`${url}/t/syl_private-track/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: stranger, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).status).toBe(403);
    const view = await (await fetch(`${url}/t/syl_private-track/community`, { headers: { cookie: stranger } })).json();
    expect(view).toEqual({ owner: false, member: false, following: false });
  });

  it('contributions: a member sends, attributed; the owner reads and resolves; strangers are refused', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Class Track');
    const minted = await (await fetch(`${url}/t/syl_class-track/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    const student = await signIn(url, 'student');
    await fetch(`${url}/t/syl_class-track/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });

    // A stranger (signed in, not a member) may not contribute.
    const stranger = await signIn(url, 'stranger');
    const refused = await fetch(`${url}/t/syl_class-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: stranger, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'question', text: 'hi?' }) });
    expect(refused.status).toBe(403);

    // The member sends a question tied to a source, and a recommended source.
    const q = await fetch(`${url}/t/syl_class-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'question', text: 'Why does the diagonal argument need decimals?', aboutId: 'src_a', aboutTitle: 'A' }) });
    expect(q.status).toBe(200);
    await fetch(`${url}/t/syl_class-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'source', text: 'great intro video', url: 'https://ex.com/vid' }) });

    // The owner's mailbox has both, NAMED; the member sees only their own; a stranger reads none.
    const mail = await (await fetch(`${url}/t/syl_class-track/contributions`, { headers: { cookie: owner } })).json();
    expect(mail.contributions).toHaveLength(2);
    expect(mail.contributions[0]).toMatchObject({ kind: 'question', name: 'student', aboutTitle: 'A' });
    const strangerView = await (await fetch(`${url}/t/syl_class-track/contributions`, { headers: { cookie: stranger } })).json();
    expect(strangerView.contributions).toHaveLength(0);

    // Resolving is the owner's act alone, and clears the pending list without erasing history.
    const cid = mail.contributions[0].id;
    expect((await fetch(`${url}/t/syl_class-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ resolve: cid, action: 'accepted' }) })).status).toBe(403);
    expect((await fetch(`${url}/t/syl_class-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ resolve: cid, action: 'accepted' }) })).status).toBe(200);
    const after = await (await fetch(`${url}/t/syl_class-track/contributions`, { headers: { cookie: owner } })).json();
    expect(after.contributions).toHaveLength(1);
    expect(after.contributions[0].kind).toBe('source');
  });

  it('a refused fork republishes AS its own version — new entry, original untouched (M-S6)', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Prof Track');
    const upstream = await (await fetch(`${url}/t/syl_prof-track.json`)).json();

    // The student forks it, edits, and naively pushes — refused: the name belongs to the prof.
    const student = await signIn(url, 'student');
    const mine = PhilomaticEngine.open(':memory:');
    mine.importPublication(upstream, { originUrl: `${url}/t/syl_prof-track` });
    mine.captureSource({ url: 'https://ex.com/mine', title: 'My Addition', track: 'Prof Track' });
    mine.publish({ ref: 'Prof Track' });
    const naive = await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(mine.publication('Prof Track')) });
    expect(naive.status).toBe(403);
    expect(((await naive.json()) as { error: string }).error).toContain('belongs to someone else');

    // Publish AS their own version: a new name, a new entry, owned by the student.
    mine.publish({ ref: 'Prof Track', as: "Stu's Track" });
    const own = await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(mine.publication('Prof Track')) });
    expect(own.status).toBe(200);
    const idx = (await (await fetch(`${url}/index.json`)).json()) as { tracks: { trackId: string; title: string; sources: number; ownerAccountId?: string }[] };
    const stu = idx.tracks.find((t) => t.trackId === 'syl_stu-s-track')!;
    expect(stu.title).toBe("Stu's Track");
    expect(stu.sources, 'the fork carries its addition').toBe(2);
    // The professor's entry is exactly as it was.
    const prof = idx.tracks.find((t) => t.trackId === 'syl_prof-track')!;
    expect(prof.sources).toBe(1);
    expect(prof.ownerAccountId).not.toBe(stu.ownerAccountId);
  });

  it('the account page lists tracks you contribute to', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Joinable');
    const minted = await (await fetch(`${url}/t/syl_joinable/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    const student = await signIn(url, 'student');
    await fetch(`${url}/t/syl_joinable/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });
    const page = await (await fetch(`${url}/account`, { headers: { cookie: student } })).text();
    expect(page).toContain('Tracks you contribute to');
    expect(page).toContain('Joinable');
    // The owner's page does NOT list it there — owning is not contributing.
    const ownerPage = await (await fetch(`${url}/account`, { headers: { cookie: owner } })).text();
    expect(ownerPage).not.toContain('Tracks you contribute to');
  });

  it('follow: members follow by default; the feed answers what moved; seen advances the cursor', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Watched');
    const minted = await (await fetch(`${url}/t/syl_watched/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    const student = await signIn(url, 'student');
    await fetch(`${url}/t/syl_watched/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });

    // Joining followed by default, current as of the joined version — nothing pending.
    const view = await (await fetch(`${url}/t/syl_watched/community`, { headers: { cookie: student } })).json();
    expect(view.following).toBe(true);
    let feed = await (await fetch(`${url}/account/following`, { headers: { cookie: student } })).json();
    expect(feed.following).toHaveLength(1);
    expect(feed.following[0].sawHash).toBe(feed.following[0].contentHash);

    // The owner republishes (a new version) — the feed now shows movement.
    const e = PhilomaticEngine.open(':memory:');
    e.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Watched' });
    e.captureSource({ url: 'https://ex.com/b', title: 'B', track: 'Watched' });
    e.publish({ ref: 'Watched' });
    await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(e.publication('Watched')) });
    feed = await (await fetch(`${url}/account/following`, { headers: { cookie: student } })).json();
    expect(feed.following, 'a republish must not dissolve the class').toHaveLength(1);
    expect(feed.following[0].sawHash).not.toBe(feed.following[0].contentHash);
    // And membership survived the republish too — same carry-forward.
    expect(((await (await fetch(`${url}/t/syl_watched/community`, { headers: { cookie: student } })).json()) as { member: boolean }).member).toBe(true);

    // Marking seen quiets it; unfollow empties the feed.
    await fetch(`${url}/t/syl_watched/follow`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ saw: feed.following[0].contentHash }) });
    feed = await (await fetch(`${url}/account/following`, { headers: { cookie: student } })).json();
    expect(feed.following[0].sawHash).toBe(feed.following[0].contentHash);
    await fetch(`${url}/t/syl_watched/follow`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ follow: false }) });
    feed = await (await fetch(`${url}/account/following`, { headers: { cookie: student } })).json();
    expect(feed.following).toHaveLength(0);

    // A stranger may follow a LISTED track, but an unlisted one only as a member; and the
    // public index never leaks followers.
    const strangerC = await signIn(url, 'strangerf');
    expect((await fetch(`${url}/t/syl_watched/follow`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: strangerC, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ follow: true }) })).status).toBe(403); // unlisted (community default)
    expect(await (await fetch(`${url}/index.json`)).text()).not.toContain('followers');
  });

  it('username: public name is the handle, not the real name; required and unique', async () => {
    const { url } = await reg();
    const owner = await signInRaw(url, 'owner');
    // Freshly signed in: /auth/me flags needsUsername, and the account carries the provider name.
    const me1 = await (await fetch(`${url}/auth/me`, { headers: { cookie: owner } })).json();
    expect(me1.needsUsername).toBe(true);
    expect(me1.account.name).toBe('owner'); // the provider's "real name" (own view only)

    // Shape enforced: too short, spaces, underscores, and bad hyphens
    // all rejected; alphanumeric runs joined by single hyphens accepted.
    const bad = ['no', 'has space', 'under_score', '-lead', 'trail-', 'double--hyphen', 'a'.repeat(33)];
    for (const u of bad) {
      expect((await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: u }) })).status, u).toBe(400);
    }
    expect((await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'ok-handle-1' }) })).status).toBe(200);
    // Reset for the rest of the test to expect 'ProfHandle'.
    expect((await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'no' }) })).status).toBe(400);
    expect((await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'ProfHandle' }) })).status).toBe(200);
    const me2 = await (await fetch(`${url}/auth/me`, { headers: { cookie: owner } })).json();
    expect(me2.needsUsername).toBe(false);
    expect(me2.account.username).toBe('ProfHandle');

    // A second account cannot take it (case-insensitive).
    const other = await signInRaw(url, 'other');
    expect((await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: other, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'profhandle' }) })).status).toBe(409);

    // Contributions and member lists carry the HANDLE, never the real name.
    await publish(url, owner, 'Handle Track');
    const minted = await (await fetch(`${url}/t/syl_handle-track/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: other, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'StudentHandle' }) });
    await fetch(`${url}/t/syl_handle-track/join?c=${token}`, { method: 'POST', headers: { cookie: other, 'sec-fetch-site': 'same-origin' } });
    await fetch(`${url}/t/syl_handle-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: other, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'question', text: 'q?', aboutId: 'x', aboutTitle: 'X' }) });
    const members = (await (await fetch(`${url}/t/syl_handle-track/community`, { headers: { cookie: owner } })).json()).members;
    expect(members[0].name).toBe('StudentHandle');
    expect(JSON.stringify(members)).not.toContain('other'); // the provider name never appears
    const mail = (await (await fetch(`${url}/t/syl_handle-track/contributions`, { headers: { cookie: owner } })).json()).contributions;
    expect(mail[0].name).toBe('StudentHandle');
  });

  it('removing a member ends their contributing (and following); history stays', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Eject Track');
    const minted = await (await fetch(`${url}/t/syl_eject-track/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json();
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    const student = await signIn(url, 'student');
    await fetch(`${url}/t/syl_eject-track/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } });
    await fetch(`${url}/t/syl_eject-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'question', text: 'before eject?', aboutId: 'x', aboutTitle: 'X' }) });

    const view = await (await fetch(`${url}/t/syl_eject-track/community`, { headers: { cookie: owner } })).json();
    const sid = view.members[0].accountId;
    await fetch(`${url}/t/syl_eject-track/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ removeMember: sid }) });

    // No longer a member: contributing refused, follow gone, membership view honest.
    expect((await fetch(`${url}/t/syl_eject-track/contributions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: student, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ kind: 'question', text: 'after eject?' }) })).status).toBe(403);
    const after = await (await fetch(`${url}/t/syl_eject-track/community`, { headers: { cookie: student } })).json();
    expect(after).toMatchObject({ member: false, following: false });
    // The past contribution remains in the owner's mailbox, attributed.
    const mail = await (await fetch(`${url}/t/syl_eject-track/contributions`, { headers: { cookie: owner } })).json();
    expect(mail.contributions).toHaveLength(1);
    expect(mail.contributions[0].name).toBe('student');
  });

  it('following your OWN track: republishing does not deliver your own update to yourself', async () => {
    const { url } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Mine');
    // The owner follows their own track (allowed — a listed track anyone signed-in may follow).
    await fetch(`${url}/t/syl_mine/follow`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ follow: true }) });
    let feed = (await (await fetch(`${url}/account/following`, { headers: { cookie: owner } })).json()).following;
    expect(feed[0].sawHash).toBe(feed[0].contentHash); // current

    // Republish a NEW version. The owner's own cursor advances with the push — no self-news.
    const e = PhilomaticEngine.open(':memory:');
    e.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Mine' });
    e.captureSource({ url: 'https://ex.com/b', title: 'B', track: 'Mine' });
    e.publish({ ref: 'Mine' });
    await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(e.publication('Mine')) });
    feed = (await (await fetch(`${url}/account/following`, { headers: { cookie: owner } })).json()).following;
    expect(feed[0].sawHash, 'the pusher has seen what they just pushed').toBe(feed[0].contentHash);
  });
it('a PRE-SPLIT index (flat community fields) lifts on boot — nothing dissolves (2026-08-11)', async () => {
    // Build real community state, then rewrite the index file to the OLD flat shape and boot a
    // second registry on the same dir: the one-time lift must restore the exact same answers.
    const { url, dir } = await reg();
    const owner = await signIn(url, 'owner');
    await publish(url, owner, 'Lift Me');
    const trackId = 'syl_lift-me';
    const minted = (await (await fetch(`${url}/t/${trackId}/community`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ invite: 'mint' }) })).json()) as { invite: { link: string } };
    const token = new URL(minted.invite.link).searchParams.get('c')!;
    const student = await signIn(url, 'student');
    expect((await fetch(`${url}/t/${trackId}/join?c=${token}`, { method: 'POST', headers: { cookie: student, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    open.splice(0).forEach((srv) => srv.close());

    // Flatten: the shape every entry had before the split.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    const idx = readReg<Record<string, { community?: Record<string, unknown> } & Record<string, unknown>>>(dir, 'index.json');
    for (const e of Object.values(idx)) {
      Object.assign(e, e.community);
      delete e.community;
    }
    writeReg(dir, 'index.json', idx);

    const server2 = createRegistryServer({ dir, introHtml: false, providers: [provider()], sessionSecret: SECRET, publicUrl: 'http://reg.test' });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    open.push(server2);
    const url2 = `http://127.0.0.1:${(server2.address() as import('node:net').AddressInfo).port}`;
    const view = (await (await fetch(`${url2}/t/${trackId}/community`, { headers: { cookie: owner } })).json()) as { members: unknown[]; invite?: unknown; unlisted: boolean };
    expect(view.members, 'the member survived the lift').toHaveLength(1);
    expect(view.invite, 'the invite survived').toBeDefined();
    expect(view.unlisted, 'visibility survived').toBe(true);
    // And the public index stays leak-free: no community key, flat or nested.
    const pub = JSON.stringify(await (await fetch(`${url2}/index.json`)).json());
    for (const word of ['invite', 'members', 'followers', 'community']) expect(pub, `no ${word} leaks`).not.toContain(word);
  });
});
