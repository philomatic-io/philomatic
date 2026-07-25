#!/usr/bin/env node
/**
 * ONE-TIME MIGRATION (2026-07-23): make a track's derived reading explicit.
 *
 * Until now the track views auto-pulled sources into a track: include a concept, and every
 * source in the library ABOUT that concept (or anything downstream of it) appeared as the
 * track's reading. That violates the membership invariant of record — "a source belongs to a
 * track only if it has an INCLUDES edge someone deliberately created" — and does not survive
 * corpus growth: add a book about Fairness next month and it silently joins every track that
 * mentions Fairness.
 *
 * The fix scopes a concept group to the track's own members. Run this FIRST, or that change
 * would appear to gut your tracks. It writes an INCLUDES edge for every source a track
 * currently displays, so the view is identical afterwards — the implicit simply becomes
 * explicit, and you can prune with × from there.
 *
 * It implements the OLD derivation itself, so it is correct whenever you run it.
 *
 *   node scripts/promote-derived-sources.mjs            # dry run — prints, writes nothing
 *   node scripts/promote-derived-sources.mjs --apply    # write the INCLUDES edges
 *   node scripts/promote-derived-sources.mjs --apply --db path/to.sqlite
 */
import { PhilomaticEngine } from '../src/engine/index.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const db = dbIdx >= 0 ? args[dbIdx + 1] : '.philomatic/philomatic.sqlite';

const engine = PhilomaticEngine.open(db);
const snap = engine.snapshot();
const graph = engine.graph();

const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
const includes = graph.edges.filter((e) => e.type === 'INCLUDES');
const about = graph.edges.filter((e) => e.type === 'ABOUT');
const prereqs = graph.edges.filter((e) => e.type === 'PREREQUISITE_OF');

/** The OLD rule: a track's concept family is its included concepts plus everything downstream
 *  of them, and its derived reading is every source ABOUT anything in that family. */
function derivedFor(trackId) {
  const family = new Set(
    includes.filter((e) => e.srcId === trackId && kindOf.get(e.dstId) === 'concept').map((e) => e.dstId),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of prereqs) {
      if (family.has(e.srcId) && !family.has(e.dstId)) {
        family.add(e.dstId);
        grew = true;
      }
    }
  }
  return new Set(about.filter((e) => family.has(e.dstId)).map((e) => e.srcId));
}

const edges = [];
let total = 0;
for (const track of snap.tracks) {
  const members = new Set(track.sourceIds);
  const promote = [...derivedFor(track.id)].filter((id) => !members.has(id) && kindOf.get(id) === 'source');
  if (promote.length === 0) {
    console.log(`  ${track.title} — nothing to promote (${members.size} members)`);
    continue;
  }
  total += promote.length;
  console.log(`  ${track.title} — ${members.size} members + ${promote.length} to promote:`);
  for (const id of promote) console.log(`      ${labelOf.get(id) ?? id}`);
  edges.push(
    ...promote.map((id) => ({ srcType: 'track', srcId: track.id, type: 'INCLUDES', dstType: 'source', dstId: id })),
  );
}

if (total === 0) {
  console.log('\nNothing to migrate — every displayed source is already an explicit member.');
} else if (!apply) {
  console.log(`\n${total} INCLUDES edges would be written. Re-run with --apply to write them.`);
} else {
  engine.importPayload({ version: 2, edges });
  console.log(`\nWrote ${total} INCLUDES edges. Membership is now explicit; prune with × from the track view.`);
}
