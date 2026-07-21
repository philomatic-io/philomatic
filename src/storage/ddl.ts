/**
 * The one schema DDL (DATA_MODEL.md §1), shared by both drivers of the dialect seam:
 * `db.ts` (better-sqlite3, node) and `db-browser.ts` (sql.js WASM, browser — alpha UI plan §2.7).
 * Applied programmatically (CREATE TABLE IF NOT EXISTS) to keep tests hermetic on in-memory DBs;
 * drizzle-kit migration files arrive once the model stops churning (ROADMAP §2.6).
 */
export const DDL = `
  CREATE TABLE IF NOT EXISTS learners (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    profile TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS syllabi (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT,
    framework TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    validation_state TEXT NOT NULL DEFAULT 'PENDING',
    tags TEXT NOT NULL DEFAULT '[]',
    published TEXT,
    origin TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (creator_id) REFERENCES learners(id)
  );
  CREATE TABLE IF NOT EXISTS concepts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    aliases TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    direct_url TEXT,
    bibliographic_url TEXT,
    personal_url TEXT,
    modality TEXT NOT NULL,
    estimated_duration_mins INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    text TEXT NOT NULL,
    anchor TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (source_id) REFERENCES sources(id)
  );
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    description TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    learner_id TEXT NOT NULL,
    verb TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    PRIMARY KEY (learner_id, verb, target_id, occurred_at),
    FOREIGN KEY (learner_id) REFERENCES learners(id)
  );
  CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
  CREATE TABLE IF NOT EXISTS edges (
    src_type TEXT NOT NULL,
    src_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    dst_type TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    syllabus_context_id TEXT NOT NULL DEFAULT '',
    metadata TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (src_id, dst_id, edge_type, syllabus_context_id)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
  CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
`;
