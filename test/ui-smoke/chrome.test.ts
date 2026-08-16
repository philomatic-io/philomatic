/**
 * UI smoke — no control may fall back to the BROWSER's chrome.
 *
 * An element with no CSS rule of its own does not render "unstyled". It renders the browser's
 * default chrome: a light `ButtonFace` box. On a dark theme it then inherits this app's
 * near-white text onto that light box, and the label disappears into its own background — the
 * element is present, focusable, clickable, and unreadable.
 *
 * The failure reads as "it gets greyed out in edit view": a picker option row, a rename
 * pencil, or the registry-url field loses (or never had) a base rule, keeping only `:hover`
 * and context variants — so the control looks correct the moment you point at it, and wrong
 * the rest of the time.
 *
 * No assertion about markup catches this, which is why it survived: the DOM was right. So this
 * walks the real screens and fails on any control still painted in browser chrome. It names
 * what it found, because "some button is unreadable" is otherwise a bug report with no address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterDetailEditing, openAdder, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

/** Chromium's default form-control background. Nothing in this theme is ever this colour. */
const DEFAULT_CHROME = ['rgb(239, 239, 239)', 'rgb(255, 255, 255)'];

/** Every visible control the browser, not the stylesheet, is currently painting. */
async function unstyled(w: Workbench): Promise<string[]> {
  return await w.page.evaluate((defaults: string[]) => {
    const out = new Set<string>();
    document.querySelectorAll<HTMLElement>('button, input, select, textarea').forEach((el) => {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return; // hidden or collapsed — not on screen
      const cs = getComputedStyle(el);
      if (!defaults.includes(cs.backgroundColor)) return;
      const label = (el.textContent ?? (el as HTMLInputElement).placeholder ?? '').trim().slice(0, 24);
      out.add(`${el.tagName.toLowerCase()}.${el.className || '(no class)'}${label === '' ? '' : ` "${label}"`}`);
    });
    return [...out];
  }, DEFAULT_CHROME);
}

describe.skipIf(!uiSmokeReady())('no control renders in browser chrome', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('the library list', async () => {
    expect(await unstyled(w)).toEqual([]);
  }, 60000);

  it('a track’s detail, reading and editing', async () => {
    await w.page.locator('button', { hasText: /^Tracks/ }).first().click();
    await w.page.waitForTimeout(400);
    await w.page.locator('.item').first().click();
    await w.page.waitForTimeout(900);
    expect(await unstyled(w), 'reading').toEqual([]);

    // Edit mode reveals the pencils, the adders and the publishing row — the controls most
    // prone to keeping only :hover rules.
    await enterDetailEditing(w);
    await w.page.waitForTimeout(500);
    expect(await unstyled(w), 'editing').toEqual([]);

    // …and hovering a title row surfaces its pencil, which is only PAINTED on hover.
    await w.page.locator('.pane.detail .title-row').first().hover();
    await w.page.waitForTimeout(300);
    expect(await unstyled(w), 'title hovered').toEqual([]);
  }, 60000);

  it('every picker, open, with its option rows showing', async () => {
    for (const kind of ['source', 'concept', 'track'] as const) {
      if ((await w.page.locator(`.pane.detail .picker-trigger.${kind}`).count()) === 0) continue;
      await openAdder(w, kind);
      // Not vacuous: an empty list would pass this test without exercising a single row.
      expect(await w.page.locator('.pane.detail .palette-item').count(), `${kind} options`).toBeGreaterThan(0);
      expect(await unstyled(w), `${kind} picker`).toEqual([]);
      await w.page.keyboard.press('Escape');
      await w.page.waitForTimeout(250);
    }
  }, 90000);
});
