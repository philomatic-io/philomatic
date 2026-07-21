/**
 * Drizzle table definitions (DATA_MODEL.md §1). Per-entity node tables plus one
 * universal edge table. JSON-bearing columns (aliases, tags, metadata) are stored as TEXT
 * and (de)serialized at the repository boundary.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const learners = sqliteTable('learners', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  profile: text('profile'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

// PHYSICAL NAME FROZEN (track rename, 2026-07-18): the table stays `syllabi` on disk — like
// the `syl_` id prefix, a historical artifact — so existing stores need no migration. The
// entity is a Track everywhere above this layer.
export const tracks = sqliteTable('syllabi', {
  id: text('id').primaryKey(),
  creatorId: text('creator_id').notNull(),
  title: text('title').notNull(),
  goal: text('goal'),
  framework: text('framework'),
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  validationState: text('validation_state').notNull().default('PENDING'),
  tags: text('tags').notNull().default('[]'),
  published: text('published'), // JSON {at, license} — set only by the publish command
  origin: text('origin'), // JSON {trackId, publishedAt, contentHash, url?} — fork lineage (P4)
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  aliases: text('aliases').notNull().default('[]'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author'),
  directUrl: text('direct_url'),
  bibliographicUrl: text('bibliographic_url'),
  personalUrl: text('personal_url'),
  modality: text('modality').notNull(),
  estimatedDurationMins: integer('estimated_duration_mins'),
  status: text('status').notNull().default('active'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

export const snippets = sqliteTable('snippets', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull(),
  text: text('text').notNull(),
  anchor: text('anchor'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

export const questions = sqliteTable('questions', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  description: text('description'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

/**
 * Append-only behavioral event log (freshness 8a). Immutable: rows are only inserted (never
 * updated/deleted), and identity is the whole tuple so re-recording the same event is a no-op.
 */
export const events = sqliteTable(
  'events',
  {
    learnerId: text('learner_id').notNull(),
    verb: text('verb').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    occurredAt: integer('occurred_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.learnerId, t.verb, t.targetId, t.occurredAt] }),
  }),
);

/**
 * Universal typed-edge table; identity is the
 * (src_id, dst_id, edge_type, syllabus_context_id — frozen physical name) tuple. The context column ('' for global
 * edges) lets a track-scoped ordering (PRECEDES) coexist per track (slice5 §2.4).
 */
export const edges = sqliteTable(
  'edges',
  {
    srcType: text('src_type').notNull(),
    srcId: text('src_id').notNull(),
    edgeType: text('edge_type').notNull(),
    dstType: text('dst_type').notNull(),
    dstId: text('dst_id').notNull(),
    trackContextId: text('syllabus_context_id').notNull().default(''),
    metadata: text('metadata'),
    tags: text('tags').notNull().default('[]'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.srcId, t.dstId, t.edgeType, t.trackContextId] }),
  }),
);
