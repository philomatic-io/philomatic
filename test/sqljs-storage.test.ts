/**
 * The sql.js storage sibling (alpha UI plan §2.7, milestone 3) — the engine must behave
 * IDENTICALLY over sql.js (browser WASM driver) and better-sqlite3 (node driver):
 *   - the same capture/verb/edit flow yields deep-equal exportAll/snapshot/assemble
 *   - the retraction fold and update-RMW work over sql.js
 *   - the persistence model is the payload value: exportAll → fresh sql.js db →
 *     importPayload → identical views (what the extension host does with chrome.storage.local)
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

const URL_A = 'https://example.com/dl';
const URL_B = 'https://youtu.be/talk';
const Q = 'Why does the gradient point uphill?';

/** The one flow, driver-agnostic: captures, anchors, verbs, an edit — every write surface. */
function drive(engine: PhilomaticEngine): void {
  engine.captureSource({ url: URL_A, title: 'DL Book', tags: ['#ml'], track: 'Optimization 101' });
  engine.captureSource({ url: URL_B, title: 'Backprop Talk', tags: ['#ai'] });
  engine.captureSnippet({
    url: URL_A,
    text: 'The gradient points uphill.',
    clarifies: ['Gradient Descent'],
    raises: [Q],
    note: 'key intuition',
    sentiment: 'insightful',
  });
  engine.captureSnippet({ url: URL_B, text: 'No full Jacobian needed.', contradicts: ['Backprop'] });
  engine.ask(Q);
  engine.answer(Q);
  engine.track('Gradient Descent');
}

function tick(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

describe('sql.js storage sibling (plan §2.7)', () => {
  it('the same flow yields identical exportAll / snapshot / assemble on both drivers', async () => {
    const node = PhilomaticEngine.open(':memory:', { now: tick() });
    const wasm = await PhilomaticEngine.openBrowser({ now: tick() });
    for (const engine of [node, wasm]) {
      engine.captureSource({ url: URL_A, title: 'DL Book', tags: ['#ml'], track: 'Optimization 101' });
      engine.captureSource({ url: URL_B, title: 'Backprop Talk', tags: ['#ai'] });
      engine.captureSnippet({
        url: URL_A,
        text: 'The gradient points uphill.',
        clarifies: ['Gradient Descent'],
        raises: [Q],
        note: 'key intuition',
        sentiment: 'insightful',
      });
      engine.ask(Q);
      engine.answer(Q);
      engine.track('Gradient Descent');
    }
    expect(wasm.exportAll()).toEqual(node.exportAll());
    expect(wasm.snapshot()).toEqual(node.snapshot());
    expect(wasm.assemble()).toEqual(node.assemble());
    node.close();
    wasm.close();
  });

  it('retraction fold + restore + update-RMW work over sql.js', async () => {
    const engine = await PhilomaticEngine.openBrowser({ now: tick() });
    engine.captureSource({ url: URL_A, title: 'DL Book' });
    engine.captureSnippet({ url: URL_A, text: 'A passage.', clarifies: ['Gradient Descent'] });

    engine.remove({ ref: URL_A }); // URL-carrying sources resolve by URL, not title (DATA_MODEL.md §6)
    expect(engine.snapshot().sources).toEqual([]);
    expect(engine.snapshot().snippets).toEqual([]); // ownership cascade
    expect(engine.removed()[0]).toMatchObject({ kind: 'source', label: 'DL Book' });

    engine.restore({ ref: URL_A });
    expect(engine.snapshot().sources.map((s) => s.title)).toEqual(['DL Book']);
    expect(engine.snapshot().snippets).toHaveLength(1);

    const r = engine.update({ ref: URL_A, patch: { title: 'DL Book (2e)' } });
    expect(r.changed).toBe(true); // URL-carrying source: title is editable metadata
    expect(engine.snapshot().sources[0]!.title).toBe('DL Book (2e)');
    engine.close();
  });

  it('hydration round-trip: exportAll → fresh sql.js db → importPayload → identical views', async () => {
    const first = await PhilomaticEngine.openBrowser({ now: tick() });
    drive(first);
    const jacobian = first.snapshot().snippets.find((s) => s.text.startsWith('No full'))!;
    first.remove({ ref: jacobian.id }); // a retraction must survive the round trip
    const payload = first.exportAll();

    // What the extension host does on every boot: fresh in-memory DB, replay the stored value.
    const reborn = await PhilomaticEngine.openBrowser({ now: tick() });
    reborn.importPayload(payload);

    expect(reborn.snapshot()).toEqual(first.snapshot());
    expect(reborn.assemble()).toEqual(first.assemble());
    expect(reborn.removed().map((r) => r.label)).toEqual(first.removed().map((r) => r.label));
    expect(reborn.exportAll()).toEqual(payload); // the value is a fixed point of replay

    // And replay is idempotent: importing again changes nothing.
    reborn.importPayload(payload);
    expect(reborn.exportAll()).toEqual(payload);
    first.close();
    reborn.close();
  });

  it('integrity parity: both drivers reject the same dangling reference the same way', async () => {
    // Integrity is owned by the validation pipeline, not the driver — so the SAME payload must
    // produce the SAME rejection on both drivers (the driver is genuinely interchangeable).
    const dangling = {
      version: 1,
      snippets: [{ id: 'snp_000000000000000000000000', sourceId: 'src_000000000000000000000000', text: 'orphan', tags: [] }],
    };
    const node = PhilomaticEngine.open(':memory:', { now: tick() });
    const wasm = await PhilomaticEngine.openBrowser({ now: tick() });
    const message = (engine: PhilomaticEngine): string => {
      try {
        engine.importPayload(dangling);
        return 'no error';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const nodeMsg = message(node);
    expect(nodeMsg).toMatch(/dangling_reference/);
    expect(message(wasm)).toBe(nodeMsg);
    node.close();
    wasm.close();
  });
});
