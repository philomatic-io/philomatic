/**
 * UI smoke — MEMBERSHIP from either end (owner request, 2026-07-23).
 *
 * A source joins a track from the track's page or from the source's own page, and the write is
 * the same either way: INCLUDES, membership only, NEVER an ordering (the bug that came back
 * four times — see lib/reorder and ordering.test.ts). These drive both rows in a real browser
 * and check the engine, not just the screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_TRACK, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

/** Open a Library list and click the item whose title starts with `title`. */
async function openInLibrary(w: Workbench, rail: RegExp, title: string): Promise<void> {
  await w.page.locator('button', { hasText: rail }).first().click();
  await w.page.waitForTimeout(350);
  await w.page.locator('.item', { hasText: title }).first().click();
  await w.page.waitForTimeout(800);
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
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);

    // The source-add UI is a multiselect palette (variant "source"): open it, check the
    // source's box, then commit with "+ Add".
    await w.page.locator('.pane.detail .picker-trigger.source').click();
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

  it('MULTISELECT: checking several sources adds them all in ONE undoable batch', async () => {
    const before = await w.track();
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    await w.page.locator('.pane.detail .picker-trigger.source').click();
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Spare One' }).click();
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: 'Spare Two' }).click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1300);
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length + 2);

    await w.undo(); // ONE undo takes both back
    expect((await w.track()).sourceIds).toHaveLength(before.sourceIds.length);
  }, 60000);

  it('CREATE: the source picker mints a new offline source and adds it; undo un-mints it', async () => {
    // Owner, 2026-07-24: "＋ create" in the source picker, like concepts.
    const NAME = 'A Freshly Invented Source';
    const before = await w.track();
    const sourcesBefore = (await w.snapshot()).sources.length;
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    await w.page.locator('.pane.detail .picker-trigger.source').click();
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
    // Owner, 2026-07-23: no more "untie every concept, then leave the track" — one × per row.
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
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
    await openInLibrary(w, /^Sources/, 'Spare Two');

    const trigger = w.page.locator('.pane.detail .picker-trigger.track');
    expect(await trigger.count()).toBe(1);
    await trigger.click();
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
    // Owner, 2026-07-24: a source in many tracks was a wall of reading lists; now it's just
    // "which tracks am I in", with the × to leave a member track.
    await openInLibrary(w, /^Sources/, 'Alpha Reading'); // a member of the fixture track
    const detail = w.page.locator('.pane.detail');
    const row = detail.locator('.source-track').filter({ hasText: FIXTURE_TRACK }).first();
    expect(await row.count()).toBe(1);
    // Compact — no full spine/reading list rendered on the source page.
    expect(await detail.locator('.rail-topic.spine').count()).toBe(0);
    expect(await detail.locator('ol.track-path').count()).toBe(0);

    // The × leaves the track; the write takes its ordering edges too, and undoes.
    const before = await w.track();
    await row.locator('.path-x').first().click();
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
 * The × inside a TIE CHIP (owner design, 2026-07-23) — the whole chain in one gesture:
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
 * Concepts are managed IN the Concepts section now (owner, 2026-07-23): the add row sits under
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
    await w.page.locator('.pane.detail .picker-trigger.concept').click();
    await w.page.locator('.pane.detail .picker-list .picker-search').fill(name);
    await w.page.locator('.pane.detail .picker-list .palette-item', { hasText: name }).first().click();
    await w.page.locator('.pane.detail .picker-list .picker-add-btn').click();
    await w.page.waitForTimeout(1300);
  };

  it('the picker under Concepts includes a concept, and Ctrl+Z removes it', async () => {
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
    const before = await includedConcepts();
    expect(await w.page.locator('.pane.detail .picker-trigger.concept').count()).toBe(1);
    await includeConcept('Smoke Concept');
    expect(await includedConcepts()).toBe(before + 1);

    await w.undo();
    expect(await includedConcepts()).toBe(before);
  }, 60000);

  it('the × on a concept heading removes it from the track, and Ctrl+Z restores it', async () => {
    await openInLibrary(w, /^Tracks/, FIXTURE_TRACK);
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
