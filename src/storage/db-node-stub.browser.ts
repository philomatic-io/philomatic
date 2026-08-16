/**
 * Build-time stand-in for `./db` in BROWSER bundles only (aliased in
 * `ui/vite.extension.config.ts`): the node driver (better-sqlite3, node:fs) must never enter an
 * extension bundle. The type re-exports are erased at build; calling the node opener in a
 * browser is a bug by definition. Never imported in node — the alias exists only in the
 * `build:extension` composition (a build output, not an architecture change).
 */
export type { DB, SqliteConn } from './db';

export function openDb(): never {
  throw new Error('openDb (better-sqlite3) is not available in the browser build — use PhilomaticEngine.openBrowser');
}

// Re-exported through the engine facade for the server-tier migration; never reachable in a
// browser bundle (encryption at rest is a hosted-server concern), but the export must exist so
// the facade resolves against this stub.
export function rekeyDb(): never {
  throw new Error('rekeyDb (SQLCipher) is not available in the browser build');
}
