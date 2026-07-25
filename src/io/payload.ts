/**
 * Export the store back out as a canonical payload (DATA_MODEL.md §1). Proves the
 * portable-serialization contract Phase-2 sync depends on: what goes in comes back out (up to
 * ordering, which is normalized here for deterministic diffs).
 */
import type { DB } from '../storage/db';
import {
  concepts as conceptsTable,
  edges as edgesTable,
  events as eventsTable,
  learners as learnersTable,
  questions as questionsTable,
  snippets as snippetsTable,
  sources as sourcesTable,
  tracks as tracksTable,
} from '../storage/tables';
import {
  CanonicalPayloadSchema,
  type CanonicalPayload,
  type EdgeType,
  type EntityKind,
  type EventVerb,
  type Modality,
  type SourceStatus,
  type TypedTag,
} from '../schema/entities';

export function exportAll(db: DB): CanonicalPayload {
  // Validate on the way out — the store should never be able to emit a non-canonical shape.
  return CanonicalPayloadSchema.parse(buildExport(db));
}

/**
 * The same export WITHOUT the outbound validation, tagged `version: 1` — the raw read the
 * live-DB v2 migration needs (src/engine migrateDbV2): a pre-v2 store contains edge rows the
 * v2 schema rejects, so it can only leave through this door, straight into the v1→v2 shim.
 */
export function exportRawForMigration(db: DB): Record<string, unknown> {
  return { ...buildExport(db), version: 1 };
}

function buildExport(db: DB): Record<string, unknown> {
  const learnerRows = db.select().from(learnersTable).all();
  const trackRows = db.select().from(tracksTable).all();
  const conceptRows = db.select().from(conceptsTable).all();
  const sourceRows = db.select().from(sourcesTable).all();
  const snippetRows = db.select().from(snippetsTable).all();
  const questionRows = db.select().from(questionsTable).all();
  const eventRows = db.select().from(eventsTable).all();
  const edgeRows = db.select().from(edgesTable).all();

  const payload = {
    version: 2 as const,
    learners: learnerRows
      .map((r) => ({
        id: r.id,
        displayName: r.displayName,
        ...(r.profile ? { profile: JSON.parse(r.profile) as Record<string, unknown> } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tracks: trackRows
      .map((r) => ({
        id: r.id,
        creatorId: r.creatorId,
        title: r.title,
        goal: r.goal ?? undefined,
        framework: r.framework ?? undefined,
        locked: r.locked,
        validationState: r.validationState as 'PENDING' | 'VALID' | 'INVALID',
        tags: JSON.parse(r.tags) as TypedTag[],
        ...(r.published ? { published: JSON.parse(r.published) as { at: number; license: string } } : {}),
        ...(r.origin ? { origin: JSON.parse(r.origin) as { trackId: string; publishedAt: number; contentHash: string; url?: string; authorKey?: string } } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    concepts: conceptRows
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? undefined,
        aliases: JSON.parse(r.aliases) as string[],
        tags: JSON.parse(r.tags) as TypedTag[],
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sources: sourceRows
      .map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author ?? undefined,
        directUrl: r.directUrl ?? undefined,
        bibliographicUrl: r.bibliographicUrl ?? undefined,
        personalUrl: r.personalUrl ?? undefined,
        modality: r.modality as Modality,
        estimatedDurationMins: r.estimatedDurationMins ?? undefined,
        status: r.status as SourceStatus,
        tags: JSON.parse(r.tags) as TypedTag[],
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    snippets: snippetRows
      .map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        text: r.text,
        anchor: r.anchor ?? undefined,
        tags: JSON.parse(r.tags) as TypedTag[],
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    questions: questionRows
      .map((r) => ({
        id: r.id,
        text: r.text,
        description: r.description ?? undefined,
        tags: JSON.parse(r.tags) as TypedTag[],
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    events: eventRows
      .map((r) => ({
        learnerId: r.learnerId,
        verb: r.verb as EventVerb,
        targetType: r.targetType as EntityKind,
        targetId: r.targetId,
        occurredAt: r.occurredAt,
      }))
      .sort(
        (a, b) =>
          a.occurredAt - b.occurredAt ||
          `${a.learnerId}|${a.verb}|${a.targetId}`.localeCompare(`${b.learnerId}|${b.verb}|${b.targetId}`),
      ),
    edges: edgeRows
      .map((r) => ({
        srcType: r.srcType as EntityKind,
        srcId: r.srcId,
        type: r.edgeType as EdgeType,
        dstType: r.dstType as EntityKind,
        dstId: r.dstId,
        ...(r.trackContextId ? { trackContextId: r.trackContextId } : {}),
        ...(r.metadata ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
        tags: JSON.parse(r.tags) as TypedTag[],
      }))
      .sort((a, b) =>
        `${a.srcId}|${a.dstId}|${a.type}|${a.trackContextId ?? ''}`.localeCompare(
          `${b.srcId}|${b.dstId}|${b.type}|${b.trackContextId ?? ''}`,
        ),
      ),
  };

  return payload;
}
