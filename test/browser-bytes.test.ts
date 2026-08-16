/**
 * Durable local storage, the engine half.
 *
 * The browser engine persists the database FILE, not a DESCRIPTION of the library —
 * replaying `exportAll()` JSON into a fresh database would cost the size of the library
 * on every load and re-stamp row metadata. Persisting the bytes makes loading an open
 * rather than a rebuild.
 *
 * What these pin: bytes out and bytes in reconstitute the SAME library, the reopened database
 * is live (writes continue, ids stay stable), and the node engine says so honestly rather than
 * pretending it can serialize itself.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

function tick(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

/** Enough of every write surface that a shallow round-trip would not survive it. */
function drive(engine: PhilomaticEngine): void {
  engine.captureSource({ url: 'https://example.com/a', title: 'A Book', tags: ['#ml'], track: 'A Track' });
  engine.captureSnippet({
    url: 'https://example.com/a',
    text: 'A captured passage.',
    clarifies: ['Gradient Descent'],
    raises: ['Why does it work?'],
  });
  engine.ask('Why does it work?');
  engine.track('Gradient Descent');
}

describe('browser engine — the database as the saved thing (B-S1.1)', () => {
  it('bytes out, bytes in: the reopened library is identical', async () => {
    const first = await PhilomaticEngine.openBrowser({ now: tick() });
    drive(first);
    const before = { all: first.exportAll(), snap: first.snapshot(), graph: first.graph() };
    const bytes = first.exportBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);
    first.close();

    const reborn = await PhilomaticEngine.openBrowser({ data: bytes, now: tick() });
    expect(reborn.exportAll()).toEqual(before.all);
    expect(reborn.snapshot()).toEqual(before.snap);
    expect(reborn.graph()).toEqual(before.graph);
    reborn.close();
  });

  it('the reopened database is LIVE — writes continue against the same ids', async () => {
    // A round-trip that produced a read-only or detached copy would pass the test above and
    // still lose the next thing the learner does.
    const first = await PhilomaticEngine.openBrowser({ now: tick() });
    drive(first);
    const originalId = first.snapshot().sources.find((s) => s.title === 'A Book')!.id;
    const bytes = first.exportBytes();
    first.close(); // read nothing from `first` past here — sql.js reports a closed db as OOM

    const reborn = await PhilomaticEngine.openBrowser({ data: bytes, now: tick() });
    reborn.captureSource({ url: 'https://example.com/b', title: 'B Book' });
    const snap = reborn.snapshot();
    expect(snap.sources.map((s) => s.title).sort()).toEqual(['A Book', 'B Book']);
    // The pre-existing source kept its identity: this is the same database, not a lookalike.
    expect(snap.sources.find((s) => s.title === 'A Book')!.id).toBe(originalId);
    reborn.close();
  });

  it('a second round-trip is stable — saving what you loaded changes nothing', async () => {
    // The loop the app actually runs: open bytes, write, save bytes, open again, forever.
    const first = await PhilomaticEngine.openBrowser({ now: tick() });
    drive(first);
    const once = first.exportBytes();
    first.close();

    const second = await PhilomaticEngine.openBrowser({ data: once, now: tick() });
    const twice = second.exportBytes();
    const third = await PhilomaticEngine.openBrowser({ data: twice, now: tick() });
    expect(third.exportAll()).toEqual(second.exportAll());
    second.close();
    third.close();
  });

  it('the node engine refuses honestly rather than pretending', async () => {
    const node = PhilomaticEngine.open(':memory:');
    expect(() => node.exportBytes()).toThrow(/browser-engine capability/);
    node.close();
  });
});
