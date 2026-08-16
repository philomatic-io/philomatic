/**
 * The UI smoke harness — boots a REAL workbench over a
 * REAL engine and drives it in a browser, so the checks that kept being re-improvised by hand
 * run automatically instead.
 *
 * Every lesson from a week of manual drives is baked in here, because each one produced a
 * false result at least once:
 *  - the engine runs IN-PROCESS on an ephemeral port (createIngestServer + listen(0)), so
 *    there is no port to guess and no chance of driving a stale server from an earlier run;
 *  - the database is a fresh temp file seeded through the engine — never the developer's
 *    own .philomatic (a copy of which, taken carelessly, replays a stale -wal sidecar);
 *  - HTML5 drag-and-drop is dispatched as real DragEvents with a DataTransfer, because
 *    synthetic mouse moves silently do nothing for `draggable` elements;
 *  - `undo()` blurs first — the Ctrl+Z handler deliberately ignores INPUT/TEXTAREA so native
 *    text-undo keeps working inside fields.
 *
 * Requires a built workbench (`pnpm ui:build`) and a Chromium that playwright-core can drive;
 * without either, the suites skip with a message rather than failing (see `uiSmokeReady`).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createIngestServer } from '../../src/server/ingest';
import { PhilomaticEngine } from '../../src/engine';

const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));

/** Chromium for playwright-core: an explicit override, else the standard browser cache. */
function findChromium(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const home = process.env.HOME ?? '';
  const roots = [join(home, '.cache/ms-playwright'), join(home, 'Library/Caches/ms-playwright')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // chromium-<rev>/chrome-linux64/chrome — probe the known layouts without globbing.
    for (const dir of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const entry of readdirSync(root)) {
        if (!entry.startsWith('chromium-')) continue;
        const candidate = join(root, entry, dir);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

let playwrightAvailable: boolean | undefined;
function hasPlaywright(): boolean {
  if (playwrightAvailable === undefined) {
    try {
      require.resolve('playwright-core');
      playwrightAvailable = true;
    } catch {
      playwrightAvailable = false;
    }
  }
  return playwrightAvailable;
}

/** Why the UI smoke suites can't run here, or undefined when they can. */
export function uiSmokeBlocker(): string | undefined {
  if (!existsSync(join(UI_DIST, 'index.html'))) return 'ui/dist missing — run `pnpm ui:build` first';
  if (!hasPlaywright()) return 'playwright-core not installed';
  if (findChromium() === undefined) return 'no Chromium found (set PLAYWRIGHT_CHROMIUM, or `npx playwright install chromium`)';
  return undefined;
}
export const uiSmokeReady = (): boolean => uiSmokeBlocker() === undefined;

/** The seeded world every smoke test starts from: one ORDERED track, plus spares to drag in. */
export const FIXTURE_TRACK = 'Smoke Track';
const SEED_SOURCES = ['Alpha Reading', 'Beta Reading', 'Gamma Reading'];
const SPARE_SOURCES = ['Spare One', 'Spare Two'];

export interface Workbench {
  url: string;
  page: import('playwright-core').Page;
  /** The live snapshot, straight from the engine's read contract. */
  snapshot: () => Promise<any>;
  /** The typed-edge graph (nodes + edges). */
  graph: () => Promise<any>;
  /** The fixture track as the read contract sees it (members, levels, precedes). */
  track: () => Promise<any>;
  /** Step markers down the path column: '1','2',… or '' for unordered. */
  markers: () => Promise<string[]>;
  /** Row titles down the path column, in display order. */
  rowTitles: () => Promise<string[]>;
  /** Ctrl+Z — blurs first, since the handler ignores text fields by design. */
  undo: () => Promise<void>;
  /** A real HTML5 drag: element → element, dropping at `frac` down the target's height. */
  dragTo: (fromSel: string, fromIdx: number, toSel: string, toIdx: number, frac: number) => Promise<void>;
  close: () => Promise<void>;
}

/** Boot a seeded engine + workbench and open it in a browser. */
export async function startWorkbench(): Promise<Workbench> {
  const blocker = uiSmokeBlocker();
  if (blocker !== undefined) throw new Error(`UI smoke unavailable: ${blocker}`);

  // 1. A fresh database, seeded through the engine itself.
  const dir = mkdtempSync(join(tmpdir(), 'pm-ui-smoke-'));
  const db = join(dir, 'smoke.sqlite');
  const engine = PhilomaticEngine.open(db);
  engine.importPayload({
    version: 2,
    tracks: [{ title: FIXTURE_TRACK, goal: 'a fixture for the UI smoke suite' }],
    sources: [...SEED_SOURCES, ...SPARE_SOURCES].map((title) => ({ title, modality: 'text' })),
    concepts: [{ name: 'Smoke Concept' }],
  });
  const snap0 = engine.snapshot() as any;
  const idOf = (title: string) => snap0.sources.find((s: any) => s.title === title).id;
  const trackId = snap0.tracks.find((t: any) => t.title === FIXTURE_TRACK).id;
  engine.importPayload({
    version: 2,
    edges: [
      ...SEED_SOURCES.map((title) => ({ srcType: 'track', srcId: trackId, type: 'INCLUDES', dstType: 'source', dstId: idOf(title) })),
      // Alpha → Beta → Gamma: a real chain, so ordering rules have something to act on.
      { srcType: 'source', srcId: idOf(SEED_SOURCES[0]!), type: 'PRECEDES', dstType: 'source', dstId: idOf(SEED_SOURCES[1]!), trackContextId: trackId },
      { srcType: 'source', srcId: idOf(SEED_SOURCES[1]!), type: 'PRECEDES', dstType: 'source', dstId: idOf(SEED_SOURCES[2]!), trackContextId: trackId },
    ],
  });

  // 2. The real server, on a port the OS picks (nothing to guess, nothing stale to hit).
  const server: Server = createIngestServer({ db });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 3. The browser.
  const { chromium } = (await import('playwright-core')) as typeof import('playwright-core');
  const browser = await chromium.launch({ executablePath: findChromium()!, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await page.waitForTimeout(600); // the first snapshot/projection round-trip

  const json = async (path: string) => (await (await fetch(url + path)).json()) as any;
  // The Journey's reading column is the shared TrackSection — the same rows
  // the Library track page draws, not the old by-sources column with its own markup.
  const pathCol = () => page.locator('.journey-col.reading-col');

  return {
    url,
    page,
    snapshot: () => json('/snapshot'),
    graph: () => json('/graph'),
    track: async () => (await json('/snapshot')).tracks.find((t: any) => t.title === FIXTURE_TRACK),
    markers: async () => await pathCol().locator('.rail-topic.spine .rail-topic-n.step').allInnerTexts(),
    rowTitles: async () => await pathCol().locator('.rail-topic.spine .rail-topic-name').allInnerTexts(),
    undo: async () => {
      await page.locator('.brand').first().click({ position: { x: 4, y: 4 } }).catch(() => {});
      await page.waitForTimeout(120);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(900);
    },
    // Kept for the drag wiring (implementation_plan_drag.md): the rules are built and unit
    // tested, but no surface currently exposes a reorder gesture, so nothing calls this yet.
    dragTo: async (fromSel, fromIdx, toSel, toIdx, frac) => {
      const result = await page.evaluate(
        ([fs, fi, ts, ti, f]: [string, number, string, number, number]) => {
          // Browser realm: `document`/DragEvent/DataTransfer exist here, not in the Node types.
          const doc = (globalThis as unknown as { document: any }).document;
          const DragEventC = (globalThis as unknown as { DragEvent: any }).DragEvent;
          const DataTransferC = (globalThis as unknown as { DataTransfer: any }).DataTransfer;
          const src = doc.querySelectorAll(fs)[fi];
          const dst = doc.querySelectorAll(ts)[ti];
          if (!src || !dst) return 'missing';
          const dt = new DataTransferC();
          src.dispatchEvent(new DragEventC('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          const r = dst.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height * f };
          dst.dispatchEvent(new DragEventC('dragover', o));
          dst.dispatchEvent(new DragEventC('drop', o));
          src.dispatchEvent(new DragEventC('dragend', { bubbles: true, dataTransfer: dt }));
          return 'ok';
        },
        [fromSel, fromIdx, toSel, toIdx, frac] as [string, number, string, number, number],
      );
      if (result === 'missing') throw new Error(`drag: no element for ${fromSel}[${fromIdx}] → ${toSel}[${toIdx}]`);
      await page.waitForTimeout(1100);
    },
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (pageErrors.length > 0) throw new Error(`console errors during the run:\n  ${pageErrors.join('\n  ')}`);
    },
  };
}

/** Open Journey on the fixture track, in edit mode, on the by-sources lens. */
export async function openJourneyEditing(w: Workbench): Promise<void> {
  const tabs = w.page.locator('button');
  for (let i = 0; i < (await tabs.count()); i++) {
    const t = (await tabs.nth(i).innerText().catch(() => '')).trim();
    if (/journey/i.test(t) && t.length < 12) {
      await tabs.nth(i).click();
      break;
    }
  }
  await w.page.waitForTimeout(500);
  await w.page.locator('.col-row', { hasText: FIXTURE_TRACK }).first().click();
  await w.page.waitForTimeout(400);
  await w.page.locator('.edit-toggle').click();
  await w.page.waitForTimeout(500);
}

/**
 * Put the detail rail in EDIT mode: membership editing — the add pickers and
 * the row × — is hidden until the rail is editing. Idempotent, so tests can call it after any
 * navigation without worrying about toggling it back off.
 */
export async function enterDetailEditing(w: Workbench): Promise<void> {
  const toggle = w.page.locator('.pane.detail .edit-toggle').first();
  if ((await toggle.getAttribute('class'))?.includes('on') !== true) {
    await toggle.click();
    await w.page.waitForTimeout(400);
  }
}

/**
 * Open one of the detail rail's add pickers. The dotted "+ add <kind>" box stays COLLAPSED
 * until hovered, so the trigger inside it is display:none to a test
 * that clicks straight at it — hover the box first, exactly as a hand would.
 */
export async function openAdder(w: Workbench, kind: 'source' | 'track' | 'concept'): Promise<void> {
  const box = w.page.locator('.pane.detail .connection-add').filter({ has: w.page.locator(`.picker-trigger.${kind}`) }).first();
  await box.hover();
  await w.page.waitForTimeout(200);
  await w.page.locator(`.pane.detail .picker-trigger.${kind}`).first().click();
  await w.page.waitForTimeout(300);
}

/** Open the Library list for a kind and click its "+ New <kind>" button. */
export async function openCreateForm(w: Workbench, kind: string): Promise<void> {
  const rail = new RegExp(`^${kind}s`, 'i');
  await w.page.locator('button', { hasText: rail }).first().click();
  await w.page.waitForTimeout(300);
  await w.page.locator('.new-draft', { hasText: new RegExp(kind, 'i') }).first().click();
  await w.page.waitForTimeout(400);
}
