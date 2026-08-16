/**
 * Framework registration: register is to frameworks what publish is to tracks — the
 * public name IS the username, versions are immutable and monotonic, latest resolves by name,
 * exact versions resolve forever, and withdraw hides latest without breaking citations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createRegistryServer } from '../src/registry/server';
import { PhilomaticEngine } from '../src/engine';
import type { OAuthProvider } from '../src/registry/oauth';

const SECRET = 'x'.repeat(32);
const open: Server[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

const provider = (): OAuthProvider => ({
  id: 'fake',
  label: 'Fake',
  authorizeUrl: ({ state }) => `/auth/fake/callback?code=CODE&state=${state}`,
  exchange: async ({ code }) => ({ provider: 'fake', subject: code, name: code }),
});

async function reg() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-fwreg-'));
  const server = createRegistryServer({ dir, introHtml: false, providers: [provider()], sessionSecret: SECRET, publicUrl: 'http://reg.test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
}
async function signInRaw(url: string, subject: string): Promise<string> {
  const st = await fetch(`${url}/auth/fake?next=/`, { redirect: 'manual' });
  const state = new URL(st.headers.get('location')!, url).searchParams.get('state')!;
  const parked = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
  const back = await fetch(`${url}/auth/fake/callback?code=${subject}&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
  return (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
}
async function signIn(url: string, subject: string): Promise<string> {
  const cookie = await signInRaw(url, subject);
  await fetch(`${url}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: subject }) });
  return cookie;
}

const DEF = (tags: string[]) => ({
  framework: 'my-framework', // the LOCAL working name — register stamps the public one
  version: 0,
  edgeTags: tags.map((name) => ({ name, on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'directed', publish: true })),
});
const post = (url: string, path: string, cookie: string | undefined, body: unknown) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie !== undefined ? { cookie, 'sec-fetch-site': 'same-origin' } : {}) }, body: JSON.stringify(body) });

describe('framework registration', () => {
  it('requires a session, and a username — the framework is NAMED after it', async () => {
    const { url } = await reg();
    expect((await post(url, '/frameworks', undefined, DEF(['A']))).status).toBe(401);
    const noName = await signInRaw(url, 'anon');
    const r = await post(url, '/frameworks', noName, DEF(['A']));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { needs: string }).needs).toBe('username');
  });

  it('register stamps name+version; versions are monotonic and IMMUTABLE; latest tracks', async () => {
    const { url } = await reg();
    const stu = await signIn(url, 'stu');
    const r1 = (await (await post(url, '/frameworks', stu, DEF(['DisputesWith']))).json()) as { version: number };
    expect(r1.version).toBe(1);
    const v1 = (await (await fetch(`${url}/frameworks/stu.json`)).json()) as { framework: string; version: number; edgeTags: { name: string }[] };
    expect(v1.framework, 'the public name is the username').toBe('stu');
    expect(v1.version).toBe(1);

    const r2 = (await (await post(url, '/frameworks', stu, DEF(['DisputesWith', 'EchoesTheme']))).json()) as { version: number };
    expect(r2.version).toBe(2);
    const latest = (await (await fetch(`${url}/frameworks/stu.json`)).json()) as { version: number; edgeTags: { name: string }[] };
    expect(latest.version).toBe(2);
    expect(latest.edgeTags).toHaveLength(2);
    // v1 is immutable: still resolvable, still exactly one relation.
    const exact = (await (await fetch(`${url}/frameworks/stu@v1.json`)).json()) as { version: number; edgeTags: { name: string }[] };
    expect(exact.version).toBe(1);
    expect(exact.edgeTags).toHaveLength(1);
  });

  it('withdraw hides LATEST but exact versions resolve forever; re-register un-withdraws', async () => {
    const { url } = await reg();
    const stu = await signIn(url, 'stu');
    await post(url, '/frameworks', stu, DEF(['A']));
    expect((await post(url, '/frameworks/withdraw', stu, {})).status).toBe(200);
    expect((await fetch(`${url}/frameworks/stu.json`)).status, 'latest hidden').toBe(404);
    expect((await fetch(`${url}/frameworks/stu@v1.json`)).status, 'citations keep resolving').toBe(200);
    await post(url, '/frameworks', stu, DEF(['A', 'B']));
    expect((await fetch(`${url}/frameworks/stu.json`)).status, 're-register speaks again').toBe(200);
  });

  it('never serves outside the frameworks dir (the name charset is the wall)', async () => {
    const { url } = await reg();
    for (const probe of ['..%2Findex', 'a%2Fb', '.hidden']) {
      expect((await fetch(`${url}/frameworks/${probe}.json`)).status).toBe(404);
    }
  });

  it('a PUSH stamps carried definitions with the pusher username and archives them (FE-D4 rev)', async () => {
    const { url } = await reg();
    const stu = await signIn(url, 'stu');
    const MINE = { framework: 'logic-lenses', version: 1, edgeTags: [{ name: 'EchoesTheme', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'symmetric' as const, publish: true }], entityTags: [], metadataFields: [] };
    const e = PhilomaticEngine.open(':memory:');
    e.importPayload({ version: 2, concepts: [{ name: 'A' }, { name: 'B' }], tracks: [{ title: 'T', includes: ['A', 'B'] }] });
    e.link({ srcType: 'concept', srcId: 'cpt_a', type: 'LINK', dstType: 'concept', dstId: 'cpt_b', tags: [{ name: 'EchoesTheme' }] });
    e.publish({ ref: 'T', license: 'CC-BY-SA-4.0' });
    const bundle = e.publication('T', { frameworks: [MINE] });
    const r = await fetch(`${url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: stu, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(bundle) });
    expect(r.status, 'push accepted').toBe(200);
    // The archive resolves the framework by its OWN name, author stamped from the credential.
    const archived = (await (await fetch(`${url}/frameworks/logic-lenses.json`)).json()) as { author?: string; version: number };
    expect(archived.author, 'attribution minted by the push').toBe('stu');
    expect(archived.version).toBe(1);
    // And the SERVED bundle carries the stamped defs — what forks actually read.
    const served = (await (await fetch(`${url}/t/syl_t.json`)).json()) as { frameworkDefs?: { author?: string }[] };
    expect(served.frameworkDefs?.[0]?.author, 'the stored bundle is the stamped one').toBe('stu');
  });
});
