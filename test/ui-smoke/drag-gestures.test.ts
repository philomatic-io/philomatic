/**
 * The drag gesture matrix, driven end-to-end. One test per gesture
 * family, each proving the WRITE and its UNDO — the throwaway verification scripts that
 * built the wave, made permanent. Real DragEvents with a DataTransfer (the harness lesson:
 * synthetic mouse moves silently do nothing for `draggable` elements).
 */
import { describe, it, afterEach, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uiSmokeReady } from './harness';

const S: Server[] = [];
afterEach(() => { for (const s of S.splice(0)) s.close(); });

async function stack() {
  const { createIngestServer } = await import('../../src/server/ingest');
  const srv = createIngestServer({ db: ':memory:' });
  S.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const app = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(app + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/import', {
    version: 2,
    concepts: [{ name: 'Model Theory' }],
    sources: [
      { title: 'Alpha Book', modality: 'text' },
      { title: 'Beta Book', modality: 'text' },
      { title: 'Gamma Book', modality: 'text' },
      { title: 'Loose Book', modality: 'text', explains: ['Model Theory'] },
    ],
    tracks: [{ title: 'Drag Track', includes: ['Model Theory'], includeSources: ['Alpha Book', 'Beta Book', 'Gamma Book', 'Loose Book'] }],
  });
  const snap = (await (await fetch(`${app}/snapshot`)).json()) as { sources: { id: string; title: string }[]; tracks: { id: string }[] };
  const idOf = (t: string) => snap.sources.find((x) => x.title.startsWith(t))!.id;
  // One in-context pair and one GLOBAL pair — the two stored shapes cuts must honour.
  await post('/link', { srcType: 'source', srcId: idOf('Alpha'), type: 'PRECEDES', dstType: 'source', dstId: idOf('Beta'), trackContextId: snap.tracks[0]!.id });
  await post('/link', { srcType: 'source', srcId: idOf('Beta'), type: 'PRECEDES', dstType: 'source', dstId: idOf('Gamma') });
  const edges = async () => {
    const g = (await (await fetch(`${app}/graph`)).json()) as { edges: { srcId: string; dstId: string; type: string }[] };
    return g.edges.filter((e) => e.type === 'PRECEDES').map((e) => `${e.srcId}>${e.dstId}`).sort();
  };
  const abouts = async (sid: string) => {
    const g = (await (await fetch(`${app}/graph`)).json()) as { edges: { srcId: string; type: string }[] };
    return g.edges.filter((e) => e.type === 'ABOUT' && e.srcId === sid).length;
  };
  return { app, idOf, edges, abouts };
}

async function openEditing(app: string) {
  const { chromium } = await import('playwright-core');
  const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
  const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(), headless: true, args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
  await page.goto(app, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 20000 });
  await page.locator('.item', { hasText: 'Drag Track' }).first().click();
  await page.waitForSelector('.detail .edit-toggle', { timeout: 15000 });
  await page.locator('.detail .edit-toggle').click();
  await page.waitForTimeout(200);
  return { b, page };
}

describe.runIf(uiSmokeReady())('drag gestures (DR-S5)', () => {
  it('gap strips: additive pairwise drops, folding hints, no-nav, one-undo', async () => {
    const { app, idOf, edges } = await stack();
    const { b, page } = await openEditing(app);
    const before = await edges();

    // Edit mode kills navigation: clicking a row stays on the track.
    await page.locator('.detail .rail-topic-source', { hasText: 'Alpha Book' }).first().click();
    await page.waitForTimeout(250);
    expect((await page.locator('.detail').innerText()).includes('Drag Track'), 'no navigation while editing').toBe(true);

    // Drag Loose: hints fold; only gaps with a sayable strip glow; hovering unfolds LIVE only.
    const row = page.locator('.detail .rail-topic-source', { hasText: 'Loose Book' }).first();
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await row.dispatchEvent('dragstart', { dataTransfer: dt });
    await page.waitForTimeout(150);
    expect(await page.locator('.detail .gap-strip').count(), 'strips folded until hover').toBe(0);
    expect(await page.locator('.detail .gap-hint.live').count()).toBeGreaterThan(0);
    const hint = page.locator('.detail .gap-hint.live').first();
    await hint.dispatchEvent('dragover', { dataTransfer: dt });
    await page.waitForTimeout(200);
    expect(await page.locator('.detail .gap-strip.off').count(), 'inert strips never render').toBe(0);

    // Drop on the first live strip; exactly the strip's edges land, additively.
    const strip = page.locator('.detail .gap-strip').first();
    await strip.dispatchEvent('dragover', { dataTransfer: dt });
    await strip.dispatchEvent('drop', { dataTransfer: dt });
    await row.dispatchEvent('dragend', { dataTransfer: dt });
    await page.waitForTimeout(600);
    const after = await edges();
    expect(after.length, 'drop asserted, nothing retracted').toBeGreaterThan(before.length);
    expect(before.every((e) => after.includes(e)), 'additive: old pairs survive').toBe(true);
    expect(after.some((e) => e.includes(idOf('Loose'))), 'the dragged source gained the relation').toBe(true);

    // ONE Ctrl+Z reverts the whole gesture.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    expect(await edges(), 'undo restores the exact prior state').toEqual(before);
    await b.close();
  }, 120000);

  it('order chips cut AS STORED (global and in-context), with undo round-trip', async () => {
    const { app, edges } = await stack();
    const { b, page } = await openEditing(app);
    const before = await edges();

    // Beta wears a ↓ chip for its GLOBAL pair (Beta>Gamma, no context) — the shape that
    // that makes a stored-shape-blind delete miss while the toast celebrates.
    const beta = page.locator('.detail .rail-topic-source', { hasText: 'Beta Book' }).first();
    await beta.locator('.gut-rel').first().hover();
    await beta.locator('.gut-x').first().click();
    await page.waitForTimeout(600);
    const cut = await edges();
    expect(cut.length, 'the × actually removed one pair').toBe(before.length - 1);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    expect(await edges(), 'undo restores the pair in its stored shape').toEqual(before);
    await b.close();
  }, 120000);

  it('ABOUT gestures: source → concept heading, chip → row; repeats no-op', async () => {
    const { app, idOf, abouts } = await stack();
    const { b, page } = await openEditing(app);

    // Source onto the concept-group heading.
    const alpha = page.locator('.detail .rail-topic-source', { hasText: 'Alpha Book' }).first();
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await alpha.dispatchEvent('dragstart', { dataTransfer: dt });
    const head = page.locator('.detail .rail-topic-head', { hasText: 'Model Theory' }).first();
    await head.dispatchEvent('dragover', { dataTransfer: dt });
    await head.dispatchEvent('drop', { dataTransfer: dt });
    await alpha.dispatchEvent('dragend', { dataTransfer: dt });
    await page.waitForTimeout(600);
    expect(await abouts(idOf('Alpha')), 'source→heading wrote ONE about').toBe(1);

    // Concept chip off Loose's row onto Beta's row.
    const chip = page.locator('.detail .rail-topic-source', { hasText: 'Loose Book' }).locator('.outline-cchip', { hasText: 'Model Theory' }).first();
    const dt2 = await page.evaluateHandle(() => new DataTransfer());
    await chip.dispatchEvent('dragstart', { dataTransfer: dt2 });
    const beta = page.locator('.detail .rail-topic-source', { hasText: 'Beta Book' }).first();
    await beta.dispatchEvent('dragover', { dataTransfer: dt2 });
    await beta.dispatchEvent('drop', { dataTransfer: dt2 });
    await page.waitForTimeout(600);
    expect(await abouts(idOf('Beta')), 'chip→row wrote ONE about').toBe(1);

    // A repeat drop is a silent no-op — still one edge.
    const dt3 = await page.evaluateHandle(() => new DataTransfer());
    await alpha.dispatchEvent('dragstart', { dataTransfer: dt3 });
    await head.dispatchEvent('dragover', { dataTransfer: dt3 });
    await head.dispatchEvent('drop', { dataTransfer: dt3 });
    await alpha.dispatchEvent('dragend', { dataTransfer: dt3 });
    await page.waitForTimeout(500);
    expect(await abouts(idOf('Alpha')), 'repeat drop no-ops').toBe(1);

    // Undo unwinds the LAST write (Beta's about), one gesture at a time.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    expect(await abouts(idOf('Beta')), 'undo removed the chip-drop about').toBe(0);
    expect(await abouts(idOf('Alpha')), 'the earlier gesture untouched').toBe(1);
    await b.close();
  }, 120000);
});
