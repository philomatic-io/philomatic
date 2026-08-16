/**
 * The browser sibling of `openDb` — sql.js (SQLite compiled to WASM,
 * synchronous, in-memory) wrapped in Drizzle over the SAME DDL and schema as the node opener.
 *
 * Two persistence models, both supported here:
 *   - PAYLOAD — hydrate a fresh in-memory DB via `importPayload()` (idempotent upsert makes
 *     replay safe) and persist `exportAll()` after writes. What the extension host does with
 *     `chrome.storage.local`. Loading is a REBUILD, so it costs the size of the library on every
 *     open, and `created_at`/`updated_at` re-stamp (the canonical graph is timestamp-free, so
 *     nothing canonical is affected).
 *   - BYTES — `snapshot()` hands out the database file itself, and `data` opens one that was
 *     handed out earlier. Loading is an open, not a rebuild. This is what the workbench's
 *     durable local storage uses; the payload model stays for the extension, which has no room
 *     for a multi-megabyte blob.
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
  /** An existing database file, from a previous `snapshot()`. Absent → a fresh empty DB. */
  data?: Uint8Array;
}

/** Async because sql.js initializes its WASM module; everything after open is synchronous. */
export async function openBrowserDb(
  opts: OpenBrowserDbOptions = {},
): Promise<{ db: DB; sqlite: SqliteConn; snapshot: () => Uint8Array }> {
  const config: Record<string, unknown> = {};
  if (opts.locateFile) config.locateFile = opts.locateFile;
  if (opts.wasmBinary) config.wasmBinary = opts.wasmBinary;
  const SQL = await initSqlJs(config as Parameters<typeof initSqlJs>[0]);
  // Opening EXISTING bytes still runs the DDL: every statement is CREATE ... IF NOT EXISTS, so
  // it is a no-op on a current database and brings an older one up to the present schema —
  // the same thing `openDb` does for a file it did not create.
  const sqlite = opts.data !== undefined ? new SQL.Database(opts.data) : new SQL.Database();
  sqlite.run('PRAGMA foreign_keys = ON;');
  sqlite.run(DDL);
  const db = drizzle(sqlite, { schema });
  // The driver's own serializer, kept behind the seam: nothing outside this file learns that
  // the browser database is sql.js (lock-line rule 4).
  return { db, sqlite, snapshot: () => sqlite.export() };
}
