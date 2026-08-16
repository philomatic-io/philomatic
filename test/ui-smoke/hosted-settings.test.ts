/**
 * Settings for a HOSTED Philomatic account looks like a hosted account — not a self-hosted
 * server. It names the account, hides the address/token fields (session auth,
 * not a typed address), and offers to delete the hosted library.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';
import type { OAuthProvider } from '../../src/registry/oauth';
const S: Server[] = [];
afterEach(() => { for (const s of S.splice(0)) s.close(); });
const listen = async (s: Server) => { S.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
describe.runIf(uiSmokeReady())('hosted account settings', () => {
  it('names the account, hides address/token, and deletes the hosted library', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');
    const p: OAuthProvider = { id: 'google', label: 'Google', authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`, exchange: async () => ({ provider: 'google', subject: 's', name: 'A Student' }) };
    const reg = await listen(createRegistryServer({ dir: mkdtempSync(join(tmpdir(), 'r')), providers: [p], sessionSecret: 'x', publicUrl: 'http://127.0.0.1' }));
    const dd = mkdtempSync(join(tmpdir(), 'd')); process.env.INGEST_DATA_DIR = dd; process.env.REGISTRY_URL = reg;
    const inst = createIngestServer({ db: ':memory:' }); delete process.env.INGEST_DATA_DIR; delete process.env.REGISTRY_URL;
    const app = await listen(inst);
    const st = await fetch(`${reg}/auth/google`, { redirect: 'manual' }); const state = new URL(st.headers.get('location')!, reg).searchParams.get('state')!;
    const pk = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
    const bk = await fetch(`${reg}/auth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie: pk } });
    const sess = (bk.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
    await fetch(`${reg}/account/username`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: 'tester1' }) });
    const { chromium } = await import('playwright-core'); const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1000, height: 900 } }); await ctx.addCookies([{ name: 'pm_session', value: sess.split('=')[1]!, url: app }]);
    await ctx.addInitScript(() => sessionStorage.setItem('pm.hostIntent', '1'));
    const page = await ctx.newPage(); await page.goto(app, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 15000 });
    await expect.poll(async () => readdirSync(dd).filter((f) => f.endsWith('.sqlite')).length).toBe(1);

    await page.locator('.lib-badge').click();
    await page.waitForSelector('.settings-panel');
    const panel = await page.locator('.settings-panel').innerText();
    expect(panel, 'the server option is Philomatic-hosted, not "your own server"').toContain('Philomatic (hosted)');
    expect(panel).toMatch(/Signed in as .*A Student/);
    // No self-hosted address/token fields, and no /app leaking as an address.
    expect(await page.locator('.settings-field', { hasText: 'Server address' }).count()).toBe(0);
    expect(panel).not.toContain('/app');
    // Delete is offered — and it removes the hosted library file.
    await page.locator('button', { hasText: 'Delete this library' }).first().click();
    await page.locator('button', { hasText: 'Delete it' }).click();
    await expect.poll(async () => readdirSync(dd).filter((f) => f.endsWith('.sqlite')).length, { timeout: 15000 }).toBe(0);
    await b.close();
  }, 120000);
});
