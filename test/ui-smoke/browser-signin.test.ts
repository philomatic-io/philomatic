import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';
import type { OAuthProvider } from '../../src/registry/oauth';
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
const listen = async (s: Server): Promise<string> => { servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
describe.runIf(uiSmokeReady())('browser-mode sign-in and migration entry points', () => {
  it('shows a sign-in button in browser mode, and a Move button in Settings', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');
    const provider: OAuthProvider = { id: 'google', label: 'Google', authorizeUrl: ({ state }) => `/auth/google/callback?code=x&state=${state}`, exchange: async () => ({ provider: 'google', subject: 's', name: 'A Student' }) };
    const reg = await listen(createRegistryServer({ dir: mkdtempSync(join(tmpdir(), 'pm-si-reg-')), providers: [provider], sessionSecret: 'test-secret', publicUrl: 'http://127.0.0.1' }));
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-si-data-'));
    const saved = { d: process.env.INGEST_DATA_DIR, r: process.env.REGISTRY_URL };
    process.env.INGEST_DATA_DIR = dataDir; process.env.REGISTRY_URL = reg;
    let instance: Server;
    try { instance = createIngestServer({ db: ':memory:' }); } finally {
      if (saved.d === undefined) delete process.env.INGEST_DATA_DIR; else process.env.INGEST_DATA_DIR = saved.d;
      if (saved.r === undefined) delete process.env.REGISTRY_URL; else process.env.REGISTRY_URL = saved.r;
    }
    const app = await listen(instance);
    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const b = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem('pm.backend', 'browser'));
    const page = await ctx.newPage();
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 15000 });
    // The topbar sign-in is present, top-right (the "I can't find sign-in" fix), badge says browser.
    await expect.poll(async () => await page.locator('.topbar-signin').count()).toBe(1);
    expect(await page.locator('.lib-badge').innerText()).toMatch(/this browser/i);
    // Settings (opened via the badge) offers the Move button.
    await page.locator('.lib-badge').click();
    await expect.poll(async () => await page.locator('.settings-hosted').count()).toBe(1);
    expect(await page.locator('.settings-hosted').innerText()).toMatch(/Move this library to Philomatic/);
    expect(await page.locator('.settings-hosted-actions button', { hasText: 'Sign in' }).count()).toBe(1);
    // Clicking the topbar sign-in navigates to the registry's sign-in with a return path.
    await page.keyboard.press('Escape').catch(() => {});
    await b.close();
  }, 120000);
});
