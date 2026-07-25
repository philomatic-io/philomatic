/**
 * UI smoke — ORDERING and UNDO, driven through the real Journey.
 *
 * These are the rules that were reported broken four separate times in one week, each time
 * needing a hand-driven browser to confirm. lib/reorder unit-tests the PLANS; this suite
 * proves the plans reach the engine through the real gestures and come back on the screen:
 *   - adding never asserts an order (button, empty-space drop, palette drag all agree)
 *   - unordered members sit below the chain and show · instead of a step number
 *   - ↑ joins the chain's end; drag reorders inside it (without a cycle rejection)
 *   - every one of those is undoable
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openJourneyEditing, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

const PATH_ROW = '.journey-col:nth-of-type(2) .col-row';

describe.skipIf(!uiSmokeReady())('ordering + undo (Journey, by sources)', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
    await openJourneyEditing(w);
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('the fixture starts as a fully ordered chain', async () => {
    expect(await w.markers()).toEqual(['1', '2', '3']);
    expect((await w.track()).precedes).toHaveLength(2);
  }, 60000);

  it('dragging a NON-member in from the palette ADDS it — · at the bottom, no ordering', async () => {
    const before = (await w.track()).precedes.length;
    await w.dragTo('.palette-item', 0, PATH_ROW, 2, 0.9); // onto the bottom third of the last row

    const t = await w.track();
    expect(t.precedes).toHaveLength(before); // ← the 2026-07-23 bug: this used to gain a pair
    expect(t.sourceIds).toHaveLength(4);
    expect(await w.markers()).toEqual(['1', '2', '3', '']);
  }, 60000);

  it('↑ on the unordered member joins the chain as its LAST step, and undoes', async () => {
    const row = w.page.locator(PATH_ROW).filter({ hasText: 'Spare' }).first();
    await row.locator('.path-x', { hasText: '↑' }).click();
    await w.page.waitForTimeout(1100);
    expect(await w.markers()).toEqual(['1', '2', '3', '4']); // ← not "jumps ahead" (2026-07-22)

    await w.undo();
    expect(await w.markers()).toEqual(['1', '2', '3', '']);
  }, 60000);

  it('↓ on an unordered member is a no-op — it is already at the bottom', async () => {
    const before = await w.markers();
    const row = w.page.locator(PATH_ROW).filter({ hasText: 'Spare' }).first();
    await row.locator('.path-x', { hasText: '↓' }).click();
    await w.page.waitForTimeout(900);
    expect(await w.markers()).toEqual(before);
  }, 60000);

  it('dragging an ORDERED member to the front reorders it — no cycle rejection — and undoes', async () => {
    const before = await w.rowTitles();
    await w.dragTo(PATH_ROW, 2, PATH_ROW, 0, 0.1); // 3rd row onto the top third of the 1st

    const after = await w.rowTitles();
    expect(after[0]).toBe(before[2]); // ← the 2026-07-23 bug: this used to fail as a cycle
    expect(await w.markers()).toEqual(['1', '2', '3', '']); // the tail stays unordered

    await w.undo();
    expect(await w.rowTitles()).toEqual(before);
  }, 60000);

  it('removing a member takes its ordering edges with it, and undo restores both', async () => {
    const before = await w.track();
    const row = w.page.locator(PATH_ROW).first();
    await row.locator('.path-x.x-del').click();
    await w.page.waitForTimeout(1100);

    const mid = await w.track();
    expect(mid.sourceIds).toHaveLength(before.sourceIds.length - 1);
    expect(mid.precedes.length).toBeLessThan(before.precedes.length);

    await w.undo();
    const back = await w.track();
    expect(back.sourceIds).toHaveLength(before.sourceIds.length);
    expect(back.precedes).toHaveLength(before.precedes.length);
  }, 60000);

  it('marking a source read is undoable (Journey had NO undo coverage before 2026-07-22)', async () => {
    const readState = async () => (await w.track()).sourceIds.length && (await w.snapshot()).sources.filter((s: any) => s.consumed).length;
    const before = await readState();
    await w.page.locator(`${PATH_ROW} .read-toggle`).first().click();
    await w.page.waitForTimeout(1000);
    expect(await readState()).not.toBe(before);

    await w.undo();
    expect(await readState()).toBe(before);
  }, 60000);
});
