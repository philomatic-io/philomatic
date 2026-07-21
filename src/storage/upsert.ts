/**
 * Idempotent bulk upsert — the "Composite Endpoint" (architecture principle #4).
 * Merges by deterministic key so re-importing an overlapping sub-graph never throws a
 * unique-constraint error. The whole payload commits in one transaction, or nothing does.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from './db';
import { concepts, edges, events, learners, questions, snippets, sources, tracks } from './tables';
import type { CanonicalPayload } from '../schema/entities';

/**
 * `now` (epoch-ms) stamps `created_at`/`updated_at` on entity rows: both on first insert,
 * `updated_at` refreshed on merge, `created_at` never overwritten. It is the engine's injected
 * clock, passed explicitly so this stays a pure function of its inputs (principle #5).
 */
export function upsertPayload(db: DB, payload: CanonicalPayload, now: number): void {
  db.transaction((tx) => {
    if (payload.learners.length > 0) {
      tx.insert(learners)
        .values(
          payload.learners.map((l) => ({
            id: l.id,
            displayName: l.displayName,
            profile: l.profile ? JSON.stringify(l.profile) : null,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: learners.id,
          set: {
            // Placeholder never clobbers a real row: desugar/commands seed {displayName:
            // 'default'|<id>} purely for referential integrity, and any RMW touching a
            // track re-triggers that seed — without this guard, publishing a track renamed
            // its creator back to 'default'. (Renaming yourself literally to 'default' or your
            // own id is the deliberate non-feature this buys.)
            displayName: sql`CASE WHEN excluded.display_name = 'default' OR excluded.display_name = learners.id THEN learners.display_name ELSE excluded.display_name END`,
            profile: sql`COALESCE(excluded.profile, learners.profile)`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.tracks.length > 0) {
      tx.insert(tracks)
        .values(
          payload.tracks.map((s) => ({
            id: s.id,
            creatorId: s.creatorId,
            title: s.title,
            goal: s.goal ?? null,
            framework: s.framework ?? null,
            locked: s.locked,
            validationState: s.validationState,
            tags: JSON.stringify(s.tags),
            // 'null' string = the explicit-clear sentinel (only unpublish sends it; the
            // conflict CASE below turns it into a real NULL, so it is never stored).
            published: s.published === null ? 'null' : s.published ? JSON.stringify(s.published) : null,
            origin: s.origin ? JSON.stringify(s.origin) : null,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: tracks.id,
          set: {
            creatorId: sql`excluded.creator_id`,
            title: sql`excluded.title`,
            goal: sql`excluded.goal`,
            framework: sql`excluded.framework`,
            locked: sql`excluded.locked`,
            validationState: sql`excluded.validation_state`,
            tags: sql`excluded.tags`,
            // The publish stamp survives payloads that don't carry it (registry test caught
            // this, 2026-07-18: filing a new source into a published track silently
            // unpublished it). The 'null' sentinel is the explicit clear (unpublish).
            published: sql`CASE WHEN excluded.published = 'null' THEN NULL ELSE COALESCE(excluded.published, published) END`,
            // Lineage is set once at fork time and must survive later re-imports of the same
            // track from other payloads (which won't carry it).
            origin: sql`COALESCE(excluded.origin, origin)`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.concepts.length > 0) {
      tx.insert(concepts)
        .values(
          payload.concepts.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description ?? null,
            aliases: JSON.stringify(c.aliases),
            tags: JSON.stringify(c.tags),
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: concepts.id,
          set: {
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            aliases: sql`excluded.aliases`,
            tags: sql`excluded.tags`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.sources.length > 0) {
      tx.insert(sources)
        .values(
          payload.sources.map((s) => ({
            id: s.id,
            title: s.title,
            author: s.author ?? null,
            directUrl: s.directUrl ?? null,
            bibliographicUrl: s.bibliographicUrl ?? null,
            personalUrl: s.personalUrl ?? null,
            modality: s.modality,
            estimatedDurationMins: s.estimatedDurationMins ?? null,
            status: s.status,
            tags: JSON.stringify(s.tags),
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            title: sql`excluded.title`,
            author: sql`excluded.author`,
            directUrl: sql`excluded.direct_url`,
            bibliographicUrl: sql`excluded.bibliographic_url`,
            personalUrl: sql`excluded.personal_url`,
            modality: sql`excluded.modality`,
            estimatedDurationMins: sql`excluded.estimated_duration_mins`,
            status: sql`excluded.status`,
            tags: sql`excluded.tags`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.snippets.length > 0) {
      tx.insert(snippets)
        .values(
          payload.snippets.map((s) => ({
            id: s.id,
            sourceId: s.sourceId,
            text: s.text,
            anchor: s.anchor ?? null,
            tags: JSON.stringify(s.tags),
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: snippets.id,
          set: {
            sourceId: sql`excluded.source_id`,
            text: sql`excluded.text`,
            anchor: sql`excluded.anchor`,
            tags: sql`excluded.tags`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.questions.length > 0) {
      tx.insert(questions)
        .values(
          payload.questions.map((q) => ({
            id: q.id,
            text: q.text,
            description: q.description ?? null,
            tags: JSON.stringify(q.tags),
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: questions.id,
          set: {
            text: sql`excluded.text`,
            description: sql`excluded.description`,
            tags: sql`excluded.tags`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }

    if (payload.events.length > 0) {
      // Append-only: an event's identity is its whole tuple, so re-recording is a no-op. Never
      // update or delete — the log is immutable (freshness 8a §2.8).
      tx.insert(events)
        .values(
          payload.events.map((ev) => ({
            learnerId: ev.learnerId,
            verb: ev.verb,
            targetType: ev.targetType,
            targetId: ev.targetId,
            occurredAt: ev.occurredAt,
          })),
        )
        .onConflictDoNothing()
        .run();
    }

    if (payload.edges.length > 0) {
      // Edge tags merge by SET-UNION (model v2 D5): tags are multi-valued classifications
      // (#Explains + #Exercises accumulate across re-asserts), so a re-capture must never
      // clobber earlier ones. Union happens here in JS — against the current row inside the
      // same transaction — because SQLite can't merge JSON arrays in an upsert SET clause.
      // Removing a tag is an explicit set-replace via the command layer (supersession), and
      // metadata stays replace-on-write (D6: tags classify; metadata is content).
      const tagKey = (t: { name: string; subtype?: string; degree?: number }): string =>
        `${t.name}|${t.subtype ?? ''}|${t.degree ?? ''}`;
      const existing = tx.select().from(edges).all();
      const currentTags = new Map<string, string>();
      for (const row of existing) {
        currentTags.set(`${row.srcId}|${row.dstId}|${row.edgeType}|${row.trackContextId}`, row.tags);
      }
      // Dedupe the payload itself by edge identity first (a migrated #Seminal INCLUDES and the
      // sugar-emitted plain INCLUDES can share one payload) — two conflicting rows in one INSERT
      // would otherwise let the later row's tags clobber the earlier's.
      const incoming = new Map<string, (typeof payload.edges)[number]>();
      for (const e of payload.edges) {
        const key = `${e.srcId}|${e.dstId}|${e.type}|${e.trackContextId ?? ''}`;
        const prior = incoming.get(key);
        incoming.set(key, prior ? { ...prior, ...e, tags: [...prior.tags, ...e.tags] } : e);
      }
      tx.insert(edges)
        .values(
          [...incoming.entries()].map(([key, e]) => {
            const prior = currentTags.get(key);
            const union = new Map((JSON.parse(prior ?? '[]') as typeof e.tags).map((t) => [tagKey(t), t]));
            for (const t of e.tags) union.set(tagKey(t), t);
            return {
              srcType: e.srcType,
              srcId: e.srcId,
              edgeType: e.type,
              dstType: e.dstType,
              dstId: e.dstId,
              trackContextId: e.trackContextId ?? '',
              metadata: e.metadata ? JSON.stringify(e.metadata) : null,
              tags: JSON.stringify([...union.values()]),
            };
          }),
        )
        .onConflictDoUpdate({
          target: [edges.srcId, edges.dstId, edges.edgeType, edges.trackContextId],
          set: {
            srcType: sql`excluded.src_type`,
            dstType: sql`excluded.dst_type`,
            metadata: sql`excluded.metadata`,
            tags: sql`excluded.tags`,
          },
        })
        .run();
    }
  });
}


/**
 * Un-assert a structural edge (publish-era owner ruling, 2026-07-18): DELETE the row by its
 * full coordinates. Deliberately not retraction — edges have no ids to retract by until the
 * assertion layer mints them; the inverse of un-assertion is simply re-assertion (the UI's
 * undo re-imports the identical edge). Returns whether a row was removed.
 */
export function deleteEdge(
  db: DB,
  e: { srcId: string; type: string; dstId: string; trackContextId?: string },
): boolean {
  const where = and(
    eq(edges.srcId, e.srcId),
    eq(edges.edgeType, e.type),
    eq(edges.dstId, e.dstId),
    eq(edges.trackContextId, e.trackContextId ?? ''),
  );
  // Existence-check-then-delete instead of reading rows-affected: the sql.js driver doesn't
  // report `changes` (always 0), which silently skipped the UNCONSUMED counter-event in the
  // browser engine — an old CONSUMED event then resurrected the edge on export/import replay.
  if (!edgeExists(db, e)) return false;
  db.delete(edges).where(where).run();
  return true;
}

/** Does this exact structural edge exist? (driver-portable — see deleteEdge). */
export function edgeExists(db: DB, e: { srcId: string; type: string; dstId: string; trackContextId?: string }): boolean {
  const hit = db
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(
      and(
        eq(edges.srcId, e.srcId),
        eq(edges.edgeType, e.type),
        eq(edges.dstId, e.dstId),
        eq(edges.trackContextId, e.trackContextId ?? ''),
      ),
    )
    .limit(1)
    .all();
  return hit.length > 0;
}
