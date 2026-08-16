/**
 * A stranger must not be able to erase what only the owner knows.
 *
 * A source's identity is its URL, so anyone naming a URL you already hold writes to YOUR row —
 * and `/ask/<id>/submit` calls `captureSource` directly, so the write happens at SUBMIT time,
 * before any acceptance. Suggest-then-confirm does not protect a field the write already
 * cleared.
 *
 * `captureSource` declared "existing values are never overwritten" and implemented it for
 * title, author and duration. These pin the rest, because the rest is the part that matters:
 * `personalUrl` is a private file path — stripped from publications for exactly that reason, so
 * it can never legitimately arrive in an incoming payload.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhilomaticEngine } from '../src/engine';

const URL_A = 'https://example.com/book';

function ownerLibrary(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(join(mkdtempSync(join(tmpdir(), 'pm-clobber-')), 'db.sqlite'));
  engine.captureSource({ url: URL_A, title: 'Set Theory', author: 'Jech', tags: ['#difficulty:4', '#myShelf'] });
  engine.update({
    ref: URL_A,
    patch: { personalUrl: 'file:///home/me/scans/jech.pdf', bibliographicUrl: 'https://doi.org/10.1/x', estimatedDurationMins: 600 },
  });
  return engine;
}
const only = (engine: PhilomaticEngine): Record<string, unknown> =>
  engine.exportLive().sources[0] as unknown as Record<string, unknown>;
const tagNames = (s: Record<string, unknown>): string[] => ((s.tags ?? []) as { name: string }[]).map((t) => t.name).sort();

describe('re-capturing a URL someone already holds', () => {
  it('keeps the private fields an outside writer could not know', () => {
    const engine = ownerLibrary();
    // Exactly what an ask submission sends: the URL, and a #recommended tag.
    engine.captureSource({ url: URL_A, tags: ['#recommended'] });
    const s = only(engine);
    expect(s.personalUrl).toBe('file:///home/me/scans/jech.pdf');
    expect(s.bibliographicUrl).toBe('https://doi.org/10.1/x');
    expect(s.author).toBe('Jech');
    expect(s.estimatedDurationMins).toBe(600);
    expect(s.title).toBe('Set Theory');
    engine.close();
  });

  it('UNIONS tags rather than replacing them — the owner keeps theirs, the sender adds one', () => {
    const engine = ownerLibrary();
    engine.captureSource({ url: URL_A, tags: ['#recommended'] });
    expect(tagNames(only(engine))).toEqual(['difficulty', 'myShelf', 'recommended']);
    engine.close();
  });

  it('and does not grow them without bound when the same URL is sent again', () => {
    // An ask link is public: the same recommendation can arrive any number of times.
    const engine = ownerLibrary();
    for (let i = 0; i < 5; i++) engine.captureSource({ url: URL_A, tags: ['#recommended'] });
    expect(tagNames(only(engine))).toEqual(['difficulty', 'myShelf', 'recommended']);
    engine.close();
  });

  it('the owner can still CLEAR a field deliberately — this guards capture, not editing', () => {
    // The protection must not become a cage: update() states the full row and stays authoritative.
    const engine = ownerLibrary();
    engine.update({ ref: URL_A, patch: { personalUrl: undefined, tags: ['#difficulty:4'] } });
    const s = only(engine);
    expect(tagNames(s)).toEqual(['difficulty']);
    engine.close();
  });
});
