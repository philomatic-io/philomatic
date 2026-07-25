/**
 * The browser sibling of `openDb` (alpha UI plan §2.7) — sql.js (SQLite compiled to WASM,
 * synchronous, in-memory) wrapped in Drizzle over the SAME DDL and schema as the node opener.
 *
 * Persistence is the payload, not the file: a host hydrates a fresh in-memory DB via
 * `importPayload()` (idempotent upsert makes replay safe) and persists `exportAll()` after
 * writes — `chrome.storage.local` in the extension host. Known limitation (plan §2.7, resolved):
 * `created_at`/`updated_at` metadata re-stamps on every rebuild; the canonical graph is
 * timestamp-free, so nothing canonical is affected.
 *
 * The dialect seam keeps exactly one home: this file and `db.ts` are the only modules that may
 * import a driver (lock-line rule 4, test/lockline.test.ts).
 */
import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import * as schema from './tables';
import { DDL } from './ddl';
import type { DB, SqliteConn } from './db';

export interface OpenBrowserDbOptions {
  /** Resolve `sql-wasm.wasm` by URL/path — node resolves it from the package on its own. */
  locateFile?: (file: string) => string;
  /** Pre-fetched wasm bytes. REQUIRED in MV3 service workers: emscripten's own loader falls
   *  back to XMLHttpRequest, which does not exist in a worker — the host fetches
   *  `chrome.runtime.getURL('sql-wasm.wasm')` itself and hands the bytes over. */
  wasmBinary?: ArrayBuffer;
}

/** Async because sql.js initializes its WASM module; everything after open is synchronous. */
export async function openBrowserDb(opts: OpenBrowserDbOptions = {}): Promise<{ db: DB; sqlite: SqliteConn }> {
  const config: Record<string, unknown> = {};
  if (opts.locateFile) config.locateFile = opts.locateFile;
  if (opts.wasmBinary) config.wasmBinary = opts.wasmBinary;
  const SQL = await initSqlJs(config as Parameters<typeof initSqlJs>[0]);
  const sqlite = new SQL.Database();
  sqlite.run('PRAGMA foreign_keys = ON;');
  sqlite.run(DDL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
