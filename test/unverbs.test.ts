/**
 * The first un-verb (owner ruling, 2026-07-18): UNCONSUMED. Read state toggles — the CONSUMED
 * fact edge is removed (the core's timeless "has read"), while the log keeps BOTH directions
 * as events (event-only verb, like RETRACTED/RESTORED). Pinned: the toggle round-trip, the
 * no-op case, the history trail, and that the event survives an export/import cycle.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

const URL = 'https://example.com/paper';

function seeded(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(':memory:', { now: () => 1_000 });
  engine.captureSource({ url: URL, title: 'Paper' });
  return engine;
}

describe('unconsume', () => {
  it('toggles the read state round-trip', () => {
    const engine = seeded();
    engine.consume(URL);
    expect(engine.snapshot().sources[0]!.consumed).toBe(true);

    expect(engine.unconsume(URL).changed).toBe(true);
    expect(engine.snapshot().sources[0]!.consumed).toBe(false);

    engine.consume(URL); // and back again
    expect(engine.snapshot().sources[0]!.consumed).toBe(true);
    engine.close();
  });

  it('is a no-op on a source never read', () => {
    const engine = seeded();
    expect(engine.unconsume(URL).changed).toBe(false);
    expect(engine.exportAll().events.some((e) => e.verb === 'UNCONSUMED')).toBe(false); // no phantom history
    engine.close();
  });

  it('history keeps both directions, and the log survives export → import', () => {
    const engine = seeded();
    engine.consume(URL);
    engine.unconsume(URL);
    const verbs = engine.exportAll().events.map((e) => e.verb);
    expect(verbs).toContain('CONSUMED');
    expect(verbs).toContain('UNCONSUMED');

    const fresh = PhilomaticEngine.open();
    fresh.importPayload(engine.exportAll()); // UNCONSUMED must pass schema + validator
    expect(fresh.snapshot().sources[0]!.consumed).toBe(false);
    expect(fresh.exportAll().events.map((e) => e.verb)).toContain('UNCONSUMED');
    engine.close();
    fresh.close();
  });
});
