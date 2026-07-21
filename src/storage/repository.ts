/**
 * Read helpers over the store. `loadExistingGraph` gives the parser the persisted context it
 * needs so referential integrity and cycle detection can span both the incoming payload and
 * what is already stored.
 */
import { eq } from 'drizzle-orm';
import type { DB } from './db';
import { concepts, edges, learners, questions, snippets, sources, tracks } from './tables';
import type { ExistingGraph } from '../parser/validate';

export function loadExistingGraph(db: DB): ExistingGraph {
  const conceptIds = db.select({ id: concepts.id }).from(concepts).all();
  const sourceIds = db.select({ id: sources.id }).from(sources).all();
  const snippetIds = db.select({ id: snippets.id }).from(snippets).all();
  const questionIds = db.select({ id: questions.id }).from(questions).all();
  const learnerIds = db.select({ id: learners.id }).from(learners).all();
  const trackIds = db.select({ id: tracks.id }).from(tracks).all();
  const nodeIds = new Set<string>(
    [...conceptIds, ...sourceIds, ...snippetIds, ...questionIds, ...learnerIds, ...trackIds].map(
      (r) => r.id,
    ),
  );

  const prereqEdges = db
    .select({ src: edges.srcId, dst: edges.dstId })
    .from(edges)
    .where(eq(edges.edgeType, 'PREREQUISITE_OF'))
    .all();

  const precedesEdges = db
    .select({ src: edges.srcId, dst: edges.dstId, context: edges.trackContextId })
    .from(edges)
    .where(eq(edges.edgeType, 'PRECEDES'))
    .all();

  const includes = db
    .select({ trackId: edges.srcId, memberId: edges.dstId })
    .from(edges)
    .where(eq(edges.edgeType, 'INCLUDES'))
    .all();

  return { nodeIds, prereqEdges, precedesEdges, includes };
}
