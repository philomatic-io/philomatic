/**
 * UI smoke — the Connections block's EMPTY categories.
 *
 * A category renders when it has rows OR an adder, and the adders used to be passed
 * unconditionally — so every kind showed a heading on every entity, whether or not anything was
 * connected. An empty category is noise to a reader and an affordance to an author, so the
 * adders are gated on edit mode and the emptiness follows from that. This pins both halves,
 * because the connection between them is not obvious from either side alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { questionId } from '../../src/schema/ids';
import { enterDetailEditing, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

describe.skipIf(!uiSmokeReady())('empty connection categories', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('are hidden while reading, and back while editing so they can be added to', async () => {
    const p = w.page;
    await p.locator('button', { hasText: /^Sources/ }).first().click();
    await p.waitForTimeout(400);
    // A spare source: in no track, tied to nothing — so EVERY category is empty.
    await p.locator('.item', { hasText: 'Spare Two' }).first().click();
    await p.waitForTimeout(900);

    const labels = async (): Promise<string[]> =>
      (await p.locator('.pane.detail .connection-group-label').allInnerTexts()).map((t) => t.trim());
    expect(await labels()).toEqual([]);
    expect(await p.locator('.pane.detail .connection-add').count()).toBe(0);

    await enterDetailEditing(w);
    await p.waitForTimeout(500);
    // Every kind is offered to an author, each with its adder.
    expect((await labels()).length).toBeGreaterThan(0);
    expect(await p.locator('.pane.detail .connection-add').count()).toBe((await labels()).length);
  }, 90000);

  it('a very long label ellipsizes itself and leaves the kind icon its full size', async () => {
    // A long question must not squash the glyph at the head of its row. The
    // icon is a flex ITEM inside .connection-end, so it shrank like everything else — and it is
    // the one thing on the row that carries meaning at a glance and cannot give.
    const p = w.page;
    const snap = await w.snapshot();
    const spare = snap.sources.find((s: { title: string }) => s.title === 'Spare One')!.id;
    const TEXT = 'Why does a question long enough to run well past the width of the rail squash the little kind glyph at the start of its row instead of simply ellipsizing its own text?';
    await fetch(`${w.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        questions: [{ text: TEXT }],
        edges: [{ srcType: 'source', srcId: spare, type: 'RAISES', dstType: 'question', dstId: questionId({ text: TEXT }) }],
      }),
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.locator('button', { hasText: /^Sources/ }).first().click();
    await p.waitForTimeout(400);
    await p.locator('.item', { hasText: 'Spare One' }).first().click();
    await p.waitForTimeout(900);

    const row = await p.evaluate(() => {
      const end = [...document.querySelectorAll('.pane.detail .connection-end')].find((el) => (el.textContent ?? '').length > 60);
      if (!end) return null;
      const svg = end.querySelector('svg')!.getBoundingClientRect();
      const label = end.querySelector('.connection-target')!;
      return { icon: Math.round(svg.width), clipped: label.scrollWidth > label.clientWidth };
    });
    expect(row, 'the long question row must be on screen').not.toBeNull();
    expect(row!.icon, 'the kind glyph keeps its 14px').toBe(14);
    expect(row!.clipped, 'the LABEL is what gives — it ellipsizes').toBe(true);

    // …and the SELF end, which is icon-only — the one that actually squashes:
    // with no label to give up, flex-shrink comes out of the glyph and
    // `.connection-end`'s overflow:hidden clipped the book to a sliver.
    //
    // Measure the END, not the svg: `.connection-end` clips with overflow:hidden, so a squashed
    // glyph still REPORTS 14px of layout while showing a sliver. The container's width is what
    // says whether the glyph survives.
    const selves = await p.evaluate(() =>
      [...document.querySelectorAll('.pane.detail .connection-end.self')].map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(selves.length, 'every row has a self end').toBeGreaterThan(0);
    expect(selves.filter((w) => w < 14), 'no self end may be narrower than its glyph').toEqual([]);
  }, 90000);
});
