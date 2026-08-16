/**
 * One detail rail, one set of chrome.
 *
 * The header froze in the main rail and not in a pinned one, and never froze on a concept at all
 * — three implementations of "the same rail". The pinned case is the THIRD appearance of one
 * bug: a sticky element can only travel as far as its own parent, so a wrapper that scrolls
 * leaves the pane inside it exactly as tall as its content and the header has nowhere to stick.
 */
import { describe, it, expect } from 'vitest';
import { startWorkbench, uiSmokeReady } from './harness';

/**
 * Scroll a rail and report how far its header drifted from the top of its own scroller.
 *
 * `scrolled` is returned too and asserted by every caller: on a pane too short to scroll, a
 * header that cannot stick and a header that does not need to look identical, and the test would
 * pass on the bug.
 */
const scrollRail = async (
  page: import('playwright-core').Page,
  railSel: string,
): Promise<{ drift: number; scrolled: number }> =>
  await page.evaluate((sel: string) => {
    const rail = document.querySelector(sel)!;
    const pane = (rail.matches('.pane') ? rail : rail.querySelector('.pane')!) as HTMLElement;
    const head = pane.querySelector('.detail-head-stick')!;
    pane.scrollTop = 10_000;
    return { drift: head.getBoundingClientRect().top - pane.getBoundingClientRect().top, scrolled: pane.scrollTop };
  }, railSel);

describe.runIf(uiSmokeReady())('the detail rail', () => {
  it('freezes its header in the main rail and in a pinned one', async () => {
    const w = await startWorkbench();

    // A short window, so a rail HAS to scroll. On a tall one the fixture's detail fits and a
    // header that cannot stick looks exactly like one that does not need to.
    await w.page.setViewportSize({ width: 1500, height: 380 });
    await w.page.locator('button.item', { hasText: 'Smoke Track' }).first().click();
    await expect.poll(async () => await w.page.locator('.pane.detail .detail-head-stick').count()).toBeGreaterThan(0);
    const main = await scrollRail(w.page, '.pane.detail');
    expect(main.scrolled, 'the main rail actually scrolled').toBeGreaterThan(0);
    expect(main.drift, 'main rail header stayed at the top').toBeLessThan(2);

    // A PINNED rail — the reported bug. Ctrl+click stacks one on the far right.
    await w.page.locator('button.item', { hasText: 'Smoke Track' }).first().click({ modifiers: ['Control'] });
    await expect.poll(async () => await w.page.locator('.pinned-rail').count()).toBe(1);
    const pin = await scrollRail(w.page, '.pinned-rail');
    expect(pin.scrolled, 'the pinned rail actually scrolled').toBeGreaterThan(0);
    expect(pin.drift, 'pinned rail header stayed at the top').toBeLessThan(2);

    await w.close();
  }, 120000);

  it('closes from the × and stays closed', async () => {
    const w = await startWorkbench();
    await w.page.locator('button.item', { hasText: 'Alpha Reading' }).first().click();
    await expect.poll(async () => await w.page.locator('.pane.detail .pinned-x').count()).toBe(1);

    const listBefore = (await w.page.locator('.pane.list').boundingBox())!.width;

    await w.page.locator('.pane.detail .pinned-x').first().click();
    // COLLAPSES, like closing a pinned rail — no empty pane left saying "select an item".
    await expect.poll(async () => await w.page.locator('.pane.detail').count()).toBe(0);
    // Not just empty for a frame: the auto-select must not put the first item straight back.
    await w.page.waitForTimeout(300);
    expect(await w.page.locator('.pane.detail').count(), 'stayed closed').toBe(0);
    // The width goes back to the list rather than to a blank column.
    const listAfter = (await w.page.locator('.pane.list').boundingBox())!.width;
    expect(listAfter, `list ${listBefore} → ${listAfter}`).toBeGreaterThan(listBefore + 100);

    // And choosing something brings it back.
    await w.page.locator('button.item', { hasText: 'Beta Reading' }).first().click();
    await expect.poll(async () => await w.page.locator('.pane.detail .detail-top').count()).toBe(1);
    await w.close();
  }, 120000);

  it('freezes a CONCEPT header too — it had no sticky wrapper at all', async () => {
    const w = await startWorkbench();
    // Concepts are not in the item list, and the read contract's snapshot does not carry them;
    // the deep link is how a `pm:` chip in a note reaches one, and ids are slugs of the name.
    await w.page.goto(`${w.url}#item=cpt_smoke-concept`);
    await expect.poll(async () => await w.page.locator('.pane.detail .detail-head-stick').count()).toBeGreaterThan(0);
    // And it carries the same × as every other rail.
    expect(await w.page.locator('.pane.detail .detail-head-stick .pinned-x').count()).toBe(1);
    await w.close();
  }, 120000);
});
