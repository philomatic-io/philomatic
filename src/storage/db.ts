/**
 * Database access. SQLite via better-sqlite3, wrapped in
 * Drizzle for dialect-agnosticism (architecture principle #3). The DDL is shared with the
 * browser sibling (`db-browser.ts`, sql.js) via `./ddl` — one schema, two drivers, and this
 * directory is the seam's only home (lock-line rule 4).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// The `-multiple-ciphers` build is API-identical to better-sqlite3 with SQLCipher compiled
// in. Keyless opens behave byte-for-byte like the stock driver; encryption engages only
// when a future caller issues `pragma key` — the at-rest seam, kept warm before it is used.
import Database from 'better-sqlite3-multiple-ciphers';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './tables';
import { DDL } from './ddl';

/** The raw connection the engine owns; a driver only needs to be closable. */
export interface SqliteConn {
  close(): void;
}
/** Any synchronous SQLite driver wrapped in Drizzle over our schema — better-sqlite3 (node)
 *  or sql.js (browser). The one handle shape both openers return (principle #3). */
export type DB = BaseSQLiteDatabase<'sync', unknown, typeof schema>;

/**
 * Add `created_at` / `updated_at` to entity tables created before those columns existed
 * (CREATE TABLE IF NOT EXISTS skips existing tables). A hand-rolled, idempotent micro-migration —
 * real drizzle-kit migrations arrive once the model stops churning. Existing rows
 * keep NULL (their creation time is unknowable); new writes stamp both. NOTE: the FK clauses in
 * the DDL likewise apply only to freshly created databases — SQLite cannot add FKs via ALTER.
 */
function ensureTimestampColumns(sqlite: Database.Database): void {
  const tables = ['learners', 'syllabi', 'concepts', 'sources', 'snippets', 'questions'];
  for (const table of tables) {
    const cols = new Set(
      (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name),
    );
    for (const col of ['created_at', 'updated_at']) {
      if (!cols.has(col)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
    }
  }
  // Publishing: syllabi gain the published stamp and the fork-lineage origin (JSON).
  const sylCols = new Set((sqlite.pragma('table_info(syllabi)') as { name: string }[]).map((c) => c.name));
  if (!sylCols.has('published')) sqlite.exec('ALTER TABLE syllabi ADD COLUMN published TEXT');
  if (!sylCols.has('origin')) sqlite.exec('ALTER TABLE syllabi ADD COLUMN origin TEXT');
}

/**
 * Open the node database. `key` (a raw 32-byte DEK) turns on SQLCipher encryption at rest:
 * the cipher is pinned explicitly so reads and writes always agree, and the key is applied as
 * a raw key (`x'…'`, no passphrase KDF) BEFORE any other statement — the order SQLCipher
 * requires. Keyless opens behave exactly as an unencrypted better-sqlite3 database.
 */
export function openDb(path = ':memory:', key?: Buffer): { db: DB; sqlite: SqliteConn } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  if (key !== undefined) {
    if (key.length !== 32) throw new Error('database key must be 32 bytes');
    sqlite.pragma("cipher='sqlcipher'");
    sqlite.pragma(`key="x'${key.toString('hex')}'"`);
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  ensureTimestampColumns(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Encrypt an existing PLAINTEXT database in place with `key`: `pragma rekey` rewrites every page
 * encrypted (data preserved). For the plaintext→encrypted migration only — a database that is
 * already encrypted cannot be rekeyed without its current key and must be skipped by the caller.
 */
export function rekeyDb(dbPath: string, key: Buffer): void {
  if (key.length !== 32) throw new Error('database key must be 32 bytes');
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("cipher='sqlcipher'");
    sqlite.pragma(`rekey="x'${key.toString('hex')}'"`);
  } finally {
    sqlite.close();
  }
}
