/**
 * UI smoke — ORDERING and UNDO, driven through the real Journey.
 *
 * These are the rules that were reported broken four separate times in one week, each time
 * needing a hand-driven browser to confirm. lib/reorder unit-tests the PLANS; this suite proves
 * the plans reach the engine through real gestures and come back on the screen.
 *
 * The Journey's second column is the shared
 * TrackSection — the same rows the Library track page draws — which retired the bespoke
 * editor (drag-in palette, ↑/↓ buttons, drag-to-reorder), and with it the reorder gestures
 * went away: membership is managed through the picker, and NO surface currently exposes a way
 * to reorder a track's sources (the drag rules are built and unit-tested but unwired; see
 * implementation_plan_drag.md). The tests for those gestures were asserting against markup that
 * has not existed for over a week, and they failed by timing out rather than by saying so.
 *
 * So what remains here is what the screen can still do: DISPLAY an order, remove a member and
 * take its ordering edges with it, and mark a source read — each undoable. The gestures are
 * listed as todos, to come back the moment drag is wired to TrackSection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_TRACK, openJourneyEditing, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

const COL = '.journey-col.reading-col';
const ROW = `${COL} .rail-topic.spine .rail-topic-source`;

describe.skipIf(!uiSmokeReady())('ordering + undo (Journey, reading column)', () => {
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

  it('a member no ordering edge touches shows an EMPTY marker, below the chain', async () => {
    // Joining a track asserts membership and NOTHING about order — the bug that kept coming
    // back. Added through the write contract rather than a gesture: the gesture that used to
    // do this (drag from the palette) no longer exists, but the DISPLAY rule still must hold.
    const snap = await w.snapshot();
    const trackId = snap.tracks.find((t: { title: string }) => t.title === FIXTURE_TRACK)!.id;
    const spare = snap.sources.find((s: { title: string }) => s.title.startsWith('Spare'))!.id;
    const before = (await w.track()).precedes.length;
    await fetch(`${w.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        edges: [{ srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'source', dstId: spare }],
      }),
    });
    await w.page.reload({ waitUntil: 'domcontentloaded' });
    await w.page.waitForTimeout(1000);
    await openJourneyEditing(w);

    const t = await w.track();
    expect(t.precedes).toHaveLength(before); // ← the bug class: a browse-order write gaining a pair
    expect(t.sourceIds).toHaveLength(4);
    expect(await w.markers()).toEqual(['1', '2', '3', '']); // '' holds the gutter, claims no place
  }, 60000);

  it('removing a member takes its ordering edges with it, and undo restores both', async () => {
    const before = await w.track();
    const row = w.page.locator(ROW).first();
    await row.hover(); // the × is revealed on hover
    await row.locator('.row-remove-x').click();
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
    const readState = async () =>
      (await w.track()).sourceIds.length && (await w.snapshot()).sources.filter((s: { consumed?: boolean }) => s.consumed).length;
    const before = await readState();
    await w.page.locator(`${ROW} .read-dot`).first().click();
    await w.page.waitForTimeout(1000);
    expect(await readState()).not.toBe(before);

    await w.undo();
    expect(await readState()).toBe(before);
  }, 60000);

  it('numbers count DOWN THE PAGE — across the spine and on into the concept groups', async () => {
    // The failure this pins: a concept group reading "6, 16, 21, 24, 25". Numbering was
    // computed from the PRECEDES chain while the page laid rows out by concept group, so the
    // two orders disagreed wherever a chain crossed a grouping boundary.
    //
    // This fixture makes them disagree on purpose: Alpha is FIRST in the chain, and is tied to
    // the included concept, so it renders LAST — under the old rule the column read 2, 3, …, 1.
    const snap = await w.snapshot();
    const trackId = snap.tracks.find((t: { title: string }) => t.title === FIXTURE_TRACK)!.id;
    const conceptId = (await w.graph()).nodes.find((n: { kind: string; label: string }) => n.kind === 'concept' && n.label === 'Smoke Concept')!.id;
    const alpha = snap.sources.find((s: { title: string }) => s.title === 'Alpha Reading')!.id;
    await fetch(`${w.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        edges: [
          { srcType: 'source', srcId: alpha, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: 'EXPLAINS' }] },
          { srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'concept', dstId: conceptId },
        ],
      }),
    });
    await w.page.reload({ waitUntil: 'domcontentloaded' });
    await w.page.waitForTimeout(1000);
    await openJourneyEditing(w);

    // Not vacuous: the grouping really did take a numbered row off the spine.
    const grouped = await w.page.locator(`${COL} .rail-topic:not(.spine) .rail-topic-n.step`).allInnerTexts();
    expect(grouped.filter((m) => m.trim() !== '')).not.toHaveLength(0);

    // THE property: every number on the page, read top to bottom, is 1, 2, 3, … Rows nothing
    // orders show an empty gutter and the count runs straight over them.
    const down = (await w.page.locator(`${COL} .rail-topic-n.step`).allInnerTexts()).map((m) => m.trim()).filter((m) => m !== '');
    expect(down).toEqual(down.map((_, i) => String(i + 1)));

    // Only the UNCATEGORIZED rows wear a mark: a dashed grey left bar —
    // "something goes here". Filed rows wear nothing; a solid bar on the normal case was tried
    // and removed the same day. Computed styles of the pseudo-element, because a class being
    // present says nothing about what it looks like.
    expect(await w.page.locator(`${COL} .detail-section`, { hasText: 'Sources (uncategorized)' }).count()).toBe(0);
    const bar = (sel: string) =>
      w.page.locator(sel).first().evaluate((el) => {
        const cs = getComputedStyle(el, '::before');
        return { style: cs.borderLeftStyle, width: cs.borderLeftWidth };
      });
    expect((await bar(`${COL} .rail-topic:not(.spine) .rail-topic-source`)).style).toBe('none');
    expect(await bar(`${COL} .rail-topic.spine.uncat .rail-topic-source`)).toEqual({ style: 'dashed', width: '2px' });

    // The collapsed adders SHOW their labels when not hovered. A CSS edit that split the
    // hover selector once left them as blank dashed slivers — text is the assertion that matters.
    for (const label of ['+ add source', '+ add concept']) {
      expect(await w.page.locator(`${COL} .connection-add-label`, { hasText: label }).evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    }
  }, 60000);

  // Gone with the by-sources column; to be restored as acceptance tests when drag
  // is wired to the shared TrackSection — the rules they covered live on in lib/reorder's unit
  // tests, so what is missing is proof the GESTURE reaches them.
  it.todo('dragging a non-member in from the palette ADDS it without asserting an order');
  it.todo('↑ on an unordered member joins the chain as its LAST step, and undoes');
  it.todo('↓ on an unordered member is a no-op — it is already at the bottom');
  it.todo('dragging an ordered member to the front reorders it, with no cycle rejection');
});
