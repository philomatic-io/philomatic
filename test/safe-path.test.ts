/**
 * `safeChild` — the containment backstop behind every request-influenced file path. A `..`,
 * an absolute segment, or an encoded escape that decoded upstream must land OUTSIDE the base
 * and throw, never resolve to a sibling directory's file.
 */
import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import { safeChild, PathEscapeError } from '../src/server/safe-path';

const BASE = resolve('/var/lib/philomatic/registry');

describe('safeChild', () => {
  it('joins an ordinary segment under the base', () => {
    expect(safeChild(BASE, 'bundles', 'syl_logic.json')).toBe(`${BASE}${sep}bundles${sep}syl_logic.json`);
  });

  it('allows the base directory itself (no segments)', () => {
    expect(safeChild(BASE)).toBe(BASE);
  });

  it.each([
    ['parent traversal', '../secrets.json'],
    ['deep traversal', '../../etc/passwd'],
    ['traversal mid-path', 'bundles/../../accounts.json'],
    ['absolute segment', '/etc/passwd'],
    ['decoded escape', '..' + sep + '..' + sep + 'accounts.json'],
  ])('refuses %s', (_label, evil) => {
    expect(() => safeChild(BASE, evil)).toThrow(PathEscapeError);
  });

  it('the error is a 400 and names only the caller input, never the base directory', () => {
    try {
      safeChild(BASE, '../../etc/passwd');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PathEscapeError);
      expect((e as PathEscapeError).status).toBe(400);
      expect((e as Error).message).not.toContain(BASE); // no server-layout leak
    }
  });

  it('a prefix sibling does not count as contained (…/registry vs …/registry-evil)', () => {
    // `startsWith(base)` alone would wrongly admit a sibling whose name extends the base.
    expect(() => safeChild(BASE, '..', 'registry-evil', 'x.json')).toThrow(PathEscapeError);
  });
});
