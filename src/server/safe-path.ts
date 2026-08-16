/**
 * The second lock on every request-influenced file path.
 *
 * Each call site already validates its component (an accountId regex, a content-hash shape, a
 * name allowlist). `safeChild` is the uniform lock BEHIND those: it resolves the join and
 * refuses any result that escapes `dir`, so a `../` that slips past a future route's validation
 * lands outside the data directory and throws here instead of reading or writing a stranger's
 * file. Defence in depth — the point is that a new call site inherits containment for free
 * rather than having to remember it.
 *
 * `src/registry` imports this from `src/server` (the permitted direction across the lock line).
 */
import { resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  /** 400, not 500: a traversal is a bad request, not a server fault — and the message names
   *  only the caller's own input, never the server's directory layout. */
  readonly status = 400;
  constructor(name: string) {
    super(`illegal path segment: ${name}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Join `segments` under `dir` and assert the result stays inside `dir`. Throws
 * `PathEscapeError` on any traversal (`..`, absolute segment, encoded escape that decoded
 * upstream). Returns the absolute, contained path.
 */
export function safeChild(dir: string, ...segments: string[]): string {
  const base = resolve(dir);
  const full = resolve(base, ...segments);
  if (full !== base && !full.startsWith(base + sep)) throw new PathEscapeError(segments.join('/'));
  return full;
}
