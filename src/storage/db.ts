/**
 * Database access (DATA_MODEL.md §1). SQLite via better-sqlite3, wrapped in
 * Drizzle for dialect-agnosticism (architecture principle #3). The DDL is shared with the
 * browser sibling (`db-browser.ts`, sql.js) via `./ddl` — one schema, two drivers, and this
 * directory is the seam's only home (lock-line rule 4).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
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
 * real drizzle-kit migrations arrive once the model stops churning (ROADMAP §2.6). Existing rows
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
  // Publish plan P2/P4: syllabi gain the published stamp and the fork-lineage origin (JSON).
  const sylCols = new Set((sqlite.pragma('table_info(syllabi)') as { name: string }[]).map((c) => c.name));
  if (!sylCols.has('published')) sqlite.exec('ALTER TABLE syllabi ADD COLUMN published TEXT');
  if (!sylCols.has('origin')) sqlite.exec('ALTER TABLE syllabi ADD COLUMN origin TEXT');
}

export function openDb(path = ':memory:'): { db: DB; sqlite: SqliteConn } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  ensureTimestampColumns(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
