/**
 * UI smoke — MEMBERSHIP from either end.
 *
 * A source joins a track from the track's page or from the source's own page, and the write is
 * the same either way: INCLUDES, membership only, NEVER an ordering (the bug that came back
 * four times — see lib/reorder and ordering.test.ts). These drive both rows in a real browser
 * and check the engine, not just the screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterDetailEditing, FIXTURE_TRACK, openAdder, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

/** Open a Library list and click the item whose title starts with `title`. */
async function openInLibrary(w: Workbench, rail: RegExp, title: string): Promise<void> {
  await w.page.locator('button', { hasText: rail }).first().click();
  await w.page.waitForTimeout(350);
  await w.page.locator('.item', { hasText: title }).first().click();
  await w.page.waitForTimeout(800);
}

/** …and put the rail in edit mode, which is where membership editing lives. */
async function openForEditing(w: Workbench, rail: RegExp, title: string): Promise<void> {
  await openInLibrary(w, rail, title);
  await enterDetailEditing(w);
}

describe.skipIf(!uiSmokeReady())('adding a source to a track, from either page', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('from the TRACK page: joins as an unordered member, and undoes', async () => {
    const before = await w.track();
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);

    // The source-add UI is a multiselect palette (variant "source"): open it, check the
    // source's box, then commit with "+ Add".
    await openAdder(w, 'source');
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Spare One' }).click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1200);

    const after = await w.track();
    expect(after.sourceIds).toHaveLength(before.sourceIds.length + 1);
    expect(after.precedes).toHaveLength(before.precedes.length); // ← adding asserts NO ordering
    // and it reads as unordered: a step number would claim a place it doesn't have
    expect(await w.page.locator('.pane.detail .rail-topic-n.step').allInnerTexts()).toEqual(['1', '2', '3', '']);

    await w.undo();
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length);
  }, 60000);

  it('the rail keeps its identity and its exit FROZEN while the body scrolls', async () => {
    // A 25-source track must not scroll away every clue about what you were reading
    // and every way to leave it. The header (kind, edit, close, title) pins to the top and the
    // action row to the bottom.
    //
    // Short viewport on purpose — the fixture track is small, and a pane that never scrolls
    // would pass this test without testing anything.
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    await w.page.setViewportSize({ width: 1500, height: 380 });
    await w.page.waitForTimeout(400);

    const frame = async () =>
      await w.page.evaluate(() => {
        const pane = document.querySelector('.pane.detail')!;
        const p = pane.getBoundingClientRect();
        const at = (sel: string) => {
          const el = pane.querySelector(sel);
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top - p.top), bottom: Math.round(p.bottom - r.bottom) };
        };
        return { scrollable: pane.scrollHeight > pane.clientHeight + 40, head: at('.detail-head-stick'), foot: at('.detail-foot-stick'), title: (pane.querySelector('h2')?.textContent ?? '').trim() };
      });

    const before = await frame();
    expect(before.scrollable, 'the pane must actually scroll for this to mean anything').toBe(true);
    expect(before.head).not.toBeNull();
    expect(before.foot).not.toBeNull();

    await w.page.locator('.pane.detail').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await w.page.waitForTimeout(400);
    const after = await frame();

    // Flush to both edges, with nothing scrolling through the gap the pane's padding leaves.
    // Within a pixel: the pane's height is fractional, so the bottom edge rounds.
    expect(after.head!.top, 'header pinned to the top').toBe(0);
    expect(after.foot!.bottom, 'action row pinned to the bottom').toBeLessThanOrEqual(1);
    // …and it is still the SAME header, not a second one scrolled into view.
    expect(after.title).toBe(before.title);

    await w.page.setViewportSize({ width: 1500, height: 1100 });
    await w.page.waitForTimeout(300);
  }, 60000);

  it('nothing hides UNDER the frozen bar — not the last row, not an open picker', async () => {
    // The cost of pinning the action row: it floats above the
    // scrolling content, so whatever the page puts in the last stripe of the pane is behind it —
    // laid out, reachable by tab, invisible. Two ways that bit: the final section ended flush
    // against the bar and read as cut off, and a picker opened near the foot put its "+ Add"
    // button underneath it, which is a control you cannot see and therefore cannot use.
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    await w.page.setViewportSize({ width: 1500, height: 380 });
    await w.page.waitForTimeout(400);
    await enterDetailEditing(w);
    await w.page.waitForTimeout(400);

    const clearance = async (sel: string) =>
      await w.page.evaluate((s) => {
        const pane = document.querySelector('.pane.detail')!;
        const bar = pane.querySelector(':scope > .detail-foot-stick')!.getBoundingClientRect();
        const el = pane.querySelector(s);
        return el === null ? null : Math.round(bar.top - el.getBoundingClientRect().bottom);
      }, sel);

    // 1. Scrolled to the end, the last thing on the page sits clear of the bar.
    await w.page.locator('.pane.detail').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await w.page.waitForTimeout(400);
    const last = await w.page.evaluate(() => {
      const pane = document.querySelector('.pane.detail')!;
      const bar = pane.querySelector(':scope > .detail-foot-stick')!;
      const prev = bar.previousElementSibling!.getBoundingClientRect();
      return Math.round(bar.getBoundingClientRect().top - prev.bottom);
    });
    expect(last, 'the last section must not end flush against the bar').toBeGreaterThan(0);

    // 2. A picker opened down here scrolls its commit button into view by itself.
    await openAdder(w, 'concept');
    await w.page.waitForTimeout(900); // the reveal is a smooth scroll
    expect(await w.page.locator('.pane.detail .picker-footer').count(), 'the picker must be open').toBe(1);
    expect(await clearance('.picker-footer'), '+ Add must clear the frozen bar').toBeGreaterThan(0);

    await w.page.keyboard.press('Escape');
    await w.page.setViewportSize({ width: 1500, height: 1100 });
    await w.page.waitForTimeout(300);
  }, 90000);

  it('MULTISELECT: checking several sources adds them all in ONE undoable batch', async () => {
    const before = await w.track();
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);
    await openAdder(w, 'source');
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Spare One' }).click();
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Spare Two' }).click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1300);
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length + 2);

    await w.undo(); // ONE undo takes both back
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length);
  }, 60000);

  it('CREATE: the source picker mints a new offline source and adds it; undo un-mints it', async () => {
    // "＋ create" in the source picker, like concepts.
    const NAME = 'A Freshly Invented Source';
    const before = await w.track();
    const sourcesBefore = (await w.snapshot()).sources.length;
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);
    await openAdder(w, 'source');
    await w.page.locator('.pane.detail .picker-list .picker-search').fill(NAME);
    await w.page.locator('.pane.detail .picker-list .palette-item.create').click();
    await w.page.waitForTimeout(1400);

    const snap = await w.snapshot();
    const made = snap.sources.find((s: any) => s.title === NAME);
    expect(made).toBeDefined();
    expect(snap.sources).toHaveLength(sourcesBefore + 1);
    expect((await w.track()).sourceIds).toContain(made.id); // created AND added

    await w.undo(); // one action: un-mint the source and drop the membership
    const after = await w.snapshot();
    expect(after.sources.find((s: any) => s.title === NAME)).toBeUndefined();
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length);
  }, 60000);

  it('the row × removes a source from the track directly (any row), and undoes', async () => {
    // No more "untie every concept, then leave the track" — one × per row.
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);
    const before = await w.track();
    const row = w.page.locator('.pane.detail .rail-topic.spine .rail-topic-source').filter({ hasText: 'Alpha Reading' }).first();
    await row.hover();
    await row.locator('.row-remove-x').click();
    await w.page.waitForTimeout(1200);

    const mid = await w.track();
    expect(mid.sourceIds).toHaveLength(before.sourceIds.length - 1);
    expect(mid.precedes.length).toBeLessThan(before.precedes.length); // its ordering edge went too

    await w.undo();
    const back = await w.track();
    expect(back.sourceIds).toHaveLength(before.sourceIds.length);
    expect(back.precedes).toHaveLength(before.precedes.length);
  }, 60000);

  it('from the SOURCE page: the mirror row does exactly the same write, and undoes', async () => {
    const before = await w.track();
    await openForEditing(w, /^Sources/, 'Spare Two');

    expect(await w.page.locator('.pane.detail .picker-trigger.track').count()).toBe(1);
    await openAdder(w, 'track');
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: FIXTURE_TRACK }).click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1200);

    const after = await w.track();
    expect(after.sourceIds).toContain((await w.snapshot()).sources.find((s: any) => s.title === 'Spare Two').id);
    expect(after.precedes).toHaveLength(before.precedes.length); // ← same invariant from this end

    await w.undo();
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length);
  }, 60000);

  it("a source's page lists its tracks as compact LINKS, not full reading lists", async () => {
    // A source in many tracks would be a wall of reading lists; instead it's just
    // "which tracks am I in", with the × to leave a member track. The bespoke `.source-track`
    // row this test was written against is a plain Connections row — same shape,
    // same claim, so the test follows the markup rather than pinning a dead class name.
    await openForEditing(w, /^Sources/, 'Alpha Reading'); // a member of the fixture track
    const detail = w.page.locator('.pane.detail');
    const row = detail.locator('.connection').filter({ hasText: FIXTURE_TRACK }).first();
    expect(await row.count()).toBe(1);
    // Compact — no full spine/reading list rendered on the source page.
    expect(await detail.locator('.rail-topic.spine').count()).toBe(0);
    expect(await detail.locator('ol.track-path').count()).toBe(0);

    // The × leaves the track; the write takes its ordering edges too, and undoes.
    const before = await w.track();
    await row.hover();
    await row.locator('.connection-x').first().click();
    await w.page.waitForTimeout(1200);
    const mid = await w.track();
    expect(mid.sourceIds).toHaveLength(before.sourceIds.length - 1);
    expect(mid.precedes.length).toBeLessThan(before.precedes.length);

    await w.undo();
    const back = await w.track();
    expect(back.sourceIds).toHaveLength(before.sourceIds.length);
    expect(back.precedes).toHaveLength(before.precedes.length);
  }, 60000);
});

/**
 * The × inside a TIE CHIP — the whole chain in one gesture:
 * cut one ABOUT edge, and because it was the source's last tie here, the source lands on the
 * track's path instead of vanishing. Ctrl+Z puts back BOTH, with the role tag intact.
 */
describe.skipIf(!uiSmokeReady())('untying a source from a concept', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
    // Smoke Concept, with one MEMBER source about it — a tie chip only appears on members now
    // (a source merely ABOUT the concept is a candidate, and candidates carry no chip). The
    // source is INCLUDED as a member AND about the concept: the shape the gesture acts on.
    const snap = await w.snapshot();
    const nodes = (await w.graph()).nodes as any[];
    const conceptId = nodes.find((n) => n.kind === 'concept' && n.label === 'Smoke Concept').id;
    const sourceId = snap.sources.find((s: any) => s.title === 'Spare One').id;
    const trackId = snap.tracks.find((t: any) => t.title === FIXTURE_TRACK).id;
    await fetch(`${w.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        edges: [
          { srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'concept', dstId: conceptId },
          { srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'source', dstId: sourceId },
          { srcType: 'source', srcId: sourceId, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: 'EXPLAINS' }] },
        ],
      }),
    });
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    await w.page.reload({ waitUntil: 'domcontentloaded' });
    await w.page.waitForTimeout(1200);
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  const aboutIds = async (title: string) => {
    const snap = await w.snapshot();
    const id = snap.sources.find((s: any) => s.title === title).id;
    return ((await w.graph()).edges as any[]).filter((e) => e.type === 'ABOUT' && e.srcId === id).map((e) => e.dstId);
  };

  it('the × lives INSIDE the chip, and cuts only that tie', async () => {
    // The chip × is a WRITE, so it exists only in edit mode.
    await enterDetailEditing(w);
    const detail = w.page.locator('.pane.detail');
    const chip = detail.locator('.rail-topic:not(.spine) .outline-cchip.tie').filter({ hasText: 'Smoke Concept' }).first();
    expect(await chip.count()).toBe(1);
    expect(await aboutIds('Spare One')).toHaveLength(1);

    const before = await w.track();
    await chip.hover();
    await chip.locator('.cchip-x').click();
    await w.page.waitForTimeout(1300);

    // the tie is cut; the source was already a member, so it stays put on the path
    expect(await aboutIds('Spare One')).toHaveLength(0);
    const after = await w.track();
    expect(after.sourceIds).toContain((await w.snapshot()).sources.find((s: any) => s.title === 'Spare One').id);
    expect(after.sourceIds).toHaveLength(before.sourceIds.length);
    expect(after.precedes).toHaveLength(before.precedes.length);

    await w.undo();
    expect(await aboutIds('Spare One')).toHaveLength(1);
  }, 60000);

  it('a concept nothing is tied to shows as a chip on its topic', async () => {
    // Smoke Concept owns nothing else, so once untied it is the empty case itself: the group
    // stays listed (it is INCLUDED) with no source rows left.
    const group = w.page.locator('.pane.detail .rail-topic:not(.spine)').filter({ hasText: 'Smoke Concept' }).first();
    expect(await group.count()).toBe(1);
  }, 60000);
});

/**
 * Concepts are managed IN the Concepts section: the add row sits under
 * the heading, and each concept heading carries the × that removes it — no duplicate chips up
 * top. Both writes are undoable.
 */
describe.skipIf(!uiSmokeReady())('managing a track’s concepts from the Concepts section', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  const includedConcepts = async () => {
    const trackId = (await w.snapshot()).tracks.find((t: any) => t.title === FIXTURE_TRACK).id;
    const g = await w.graph();
    const concepts = new Set((g.nodes as any[]).filter((n) => n.kind === 'concept').map((n) => n.id));
    return (g.edges as any[]).filter((e) => e.type === 'INCLUDES' && e.srcId === trackId && concepts.has(e.dstId)).length;
  };

  it('there is NO "Concepts covered" chip block at the top any more', async () => {
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    expect(await w.page.locator('.pane.detail .detail-section', { hasText: 'Concepts covered' }).count()).toBe(0);
  }, 60000);

  // Include a concept through the palette picker: open it, filter to the name, check its box,
  // then commit with "+ Add".
  const includeConcept = async (name: string) => {
    await openAdder(w, 'concept');
    await w.page.locator('.pane.detail .picker-list .picker-search').fill(name);
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: name }).first().click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1300);
  };

  it('the picker under Concepts includes a concept, and Ctrl+Z removes it', async () => {
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);
    const before = await includedConcepts();
    expect(await w.page.locator('.pane.detail .picker-trigger.concept').count()).toBe(1);
    await includeConcept('Smoke Concept');
    expect(await includedConcepts()).toBe(before + 1);

    await w.undo();
    expect(await includedConcepts()).toBe(before);
  }, 60000);

  it('the × on a concept heading removes it from the track, and Ctrl+Z restores it', async () => {
    await openForEditing(w, /^Tracks/, FIXTURE_TRACK);
    await includeConcept('Smoke Concept'); // ensure one is included to remove
    const before = await includedConcepts();

    const heading = w.page.locator('.pane.detail .rail-topic:not(.spine)').filter({ hasText: 'Smoke Concept' }).first();
    await heading.hover();
    await heading.locator('.concept-x').first().click();
    await w.page.waitForTimeout(1300);
    expect(await includedConcepts()).toBe(before - 1);

    await w.undo();
    expect(await includedConcepts()).toBe(before);
  }, 60000);
});

describe.skipIf(!uiSmokeReady())('filing an uncategorized source under a concept', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
    // Smoke Concept is included (so the track HAS categories) and holds Alpha; Beta stays
    // uncategorized. `Fresh Concept` exists in the library but is NOT included — filing under
    // it must therefore write the INCLUDES too, or nothing visibly happens.
    const snap = await w.snapshot();
    const nodes = (await w.graph()).nodes as any[];
    const conceptId = nodes.find((n) => n.kind === 'concept' && n.label === 'Smoke Concept').id;
    const trackId = snap.tracks.find((t: any) => t.title === FIXTURE_TRACK).id;
    const alpha = snap.sources.find((s: any) => s.title === 'Alpha Reading').id;
    await fetch(`${w.url}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        concepts: [{ name: 'Fresh Concept' }],
        edges: [
          { srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'concept', dstId: conceptId },
          { srcType: 'source', srcId: alpha, type: 'ABOUT', dstType: 'concept', dstId: conceptId, tags: [{ name: 'EXPLAINS' }] },
        ],
      }),
    });
    await w.page.reload({ waitUntil: 'domcontentloaded' });
    await w.page.waitForTimeout(1200);
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('one gesture writes the ABOUT tie AND includes the concept when the track lacks it', async () => {
    // Read mode offers no filing (nor any other membership write).
    expect(await w.page.locator('.pane.detail .picker-trigger.file').count()).toBe(0);
    await enterDetailEditing(w);
    const beta = (await w.snapshot()).sources.find((s: any) => s.title === 'Beta Reading').id;

    // The picker under Beta's row (an uncategorized member) lists library concepts.
    const slot = w.page.locator('.pane.detail .rail-topic.spine .uncat-file-slot').first();
    await slot.locator('.picker-trigger.file').click();
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Fresh Concept' }).first().click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();

    // BOTH edges landed: the tie, and the INCLUDES that makes the row able to move.
    await expect.poll(async () => {
      const edges = (await w.graph()).edges as any[];
      const fresh = ((await w.graph()).nodes as any[]).find((n) => n.label === 'Fresh Concept')!.id;
      return {
        about: edges.some((e) => e.type === 'ABOUT' && e.srcId === beta && e.dstId === fresh),
        includes: edges.some((e) => e.type === 'INCLUDES' && e.dstId === fresh),
      };
    }).toEqual({ about: true, includes: true });
    // And the row now renders under the Fresh Concept heading, not on the spine.
    await expect.poll(async () =>
      await w.page.locator('.pane.detail .rail-topic:not(.spine)', { hasText: 'Fresh Concept' }).locator('.rail-topic-source', { hasText: 'Beta Reading' }).count(),
    ).toBe(1);
  }, 60000);
});
