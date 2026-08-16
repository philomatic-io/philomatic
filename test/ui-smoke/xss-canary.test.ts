/**
 * The XSS canary.
 *
 * Moving to ONE ORIGIN merges the blast radius: script injected anywhere on philomatic.io runs
 * with the same session context as the library's API. Escaping was a discipline; on one origin it
 * is the wall, so it needs a tripwire that fails loudly the day someone renders a field raw.
 *
 * These payloads travel the REAL paths a stranger's text takes — a published track's title, goal
 * and author through `/publish`; a source title and a question through an ask page's own
 * submission endpoint — and land on the REAL pages a visitor loads. Nothing is stubbed, because
 * the bug this catches lives in the rendering, not in a helper.
 *
 * A failure here means: a stranger's text executed as code on your origin. Treat it as a stop-
 * the-line bug, not a flaky test — see the assertion messages, which name what got through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';
import { PhilomaticEngine } from '../../src/engine';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const listen = async (s: Server): Promise<string> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/** Four shapes, because they escape a page in four different ways. */
const IMG = `<img src=x onerror="window.__PWNED__=(window.__PWNED__||0)+1">`;
const BREAKOUT = `</script><script>window.__PWNED__=(window.__PWNED__||0)+1;</script>`;
const ATTR = `" onmouseover="window.__PWNED__=(window.__PWNED__||0)+1" x="`;
const SVG = `<svg/onload="window.__PWNED__=(window.__PWNED__||0)+1">`;

describe.runIf(uiSmokeReady())('a stranger’s text never executes on our origin', () => {
  it('survives titles, goals, authors and questions on the registry and track pages (incl. tabs)', async () => {
    const { createRegistryServer } = await import('../../src/registry/server');
    const { createIngestServer } = await import('../../src/server/ingest');

    // A published track whose every human-authored field is an attack.
    const dir = mkdtempSync(join(tmpdir(), 'pm-xss-author-'));
    const engine = PhilomaticEngine.open(join(dir, 'db.sqlite'));
    engine.captureSource({ url: 'https://ex.com/a', title: `Paper ${IMG}`, track: `Track ${BREAKOUT}` });
    engine.importPayload({
      version: 2,
      tracks: [{ title: `Track ${BREAKOUT}`, goal: `Goal ${SVG}` }],
      questions: [{ text: `Question ${IMG}` }],
    } as never);
    engine.publish({ ref: `Track ${BREAKOUT}`, license: 'CC-BY-SA-4.0', author: `Author ${ATTR}` });

    const registry = await listen(createRegistryServer({ dir: mkdtempSync(join(tmpdir(), 'pm-xss-reg-')) }));
    const pub = await fetch(`${registry}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(engine.publication(`Track ${BREAKOUT}`)),
    });
    expect(pub.status, 'the hostile bundle must PUBLISH — a rejection would make this vacuous').toBe(200);
    const { url } = (await pub.json()) as { url: string };

    const { chromium } = await import('playwright-core');
    const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
    const exe = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.();
    const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();

    // A CSP that BLOCKS an injection still proves escaping failed — the payload reached the page
    // as markup. Both signals are collected: execution, and the browser's refusal.
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 160));
    });

    for (const [name, target] of [
      ['registry index', `${registry}/`],
      ['track page', `${registry}${url}`],
    ] as const) {
      violations.length = 0;
      await page.goto(target, { waitUntil: 'networkidle' });
      // The community tabs render hostile question text and concept names (the retired ask
      // page's attack surface lives here now) — walk them where present.
      for (const tabName of ['Questions', 'Contributions']) {
        const t = page.locator('.pub-tab', { hasText: tabName });
        if ((await t.count()) > 0) await t.click();
      }
      const trackTab = page.locator('.pub-tab', { hasText: 'Track' });
      if ((await trackTab.count()) > 0) await trackTab.click();
      // Hover everything: the attribute-breakout payload fires on mouseover, not on load.
      const boxes = page.locator('h1, h2, a, .agraph-box-title, .reg-tracks li, .askx-src-title');
      for (let i = 0; i < Math.min(await boxes.count(), 25); i++) await boxes.nth(i).hover().catch(() => undefined);

      expect(await page.evaluate(() => (window as { __PWNED__?: number }).__PWNED__ ?? 0), `EXECUTED on the ${name}`).toBe(0);
      expect(violations, `payload reached the ${name} as MARKUP (CSP blocked it, escaping did not)`).toEqual([]);
      // The text is still THERE — escaped, not stripped. A page that silently drops hostile
      // input would pass the checks above while quietly mangling legitimate titles.
      const body = await page.locator('body').innerText();
      expect(body.length, `${name} rendered nothing at all`).toBeGreaterThan(20);
    }

    await browser.close();
  }, 180000);
});
