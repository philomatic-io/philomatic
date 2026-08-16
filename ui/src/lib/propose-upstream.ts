/**
 * Propose my changes: the pull-request half of the fork lifecycle.
 *
 * A member who forked a track and built on it sends their ADDITIONS back — as mailbox
 * contributions, one per item, attributed, waiting on the owner's accept. Never a push: the
 * registry's entry stays the owner's, and the owner's inbox remains the merge tool (the same
 * doctrine as every contribution — nothing enters a graph but by its owner's act).
 *
 * The diff is fork-vs-UPSTREAM-CURRENT (not vs base): propose only what upstream lacks NOW —
 * additions already accepted, or arriving from someone else, drop out by themselves. Additive
 * by construction: edits and deletions are not proposed, only new members and new
 * questions, each anchored to something upstream already has.
 *
 * ONE implementation for both engines: everything here reads through the EngineClient
 * (exportAll) and the origin registry's public routes — there is no per-host logic to drift.
 */
import type { EngineClient } from '../client/transport';

interface CanonAll {
  tracks: { id: string; title: string; origin?: { trackId: string; url?: string; contentHash: string } }[];
  sources: { id: string; title: string; author?: string; modality?: string; directUrl?: string }[];
  snippets: { id: string; sourceId: string }[];
  questions: { id: string; text: string }[];
  edges: { srcId: string; dstId: string; srcType: string; dstType: string; type: string }[];
}
interface UpstreamPayload {
  sources: { id: string; title: string }[];
  concepts: { id: string; name: string }[];
  questions: { id: string; text: string }[];
}

export interface ProposedItem {
  kind: 'question' | 'source';
  text: string;
  title?: string;
  author?: string;
  modality?: string;
  url?: string;
  aboutId?: string;
  aboutTitle?: string;
  answersId?: string;
}

/** The pure diff: what my fork ADDS that upstream lacks, shaped as mailbox items. */
export function forkAdditions(all: CanonAll, trackId: string, upstream: UpstreamPayload): { items: ProposedItem[]; skipped: number } {
  const upSources = new Set(upstream.sources.map((s) => s.id));
  const upConcepts = new Map(upstream.concepts.map((c) => [c.id, c.name]));
  const upQuestions = new Set(upstream.questions.map((q) => q.id));
  const items: ProposedItem[] = [];
  let skipped = 0;

  // New member SOURCES: INCLUDES'd by my fork, unknown upstream. Ties travel only when their
  // far end exists upstream — the owner's accept must be able to land them.
  const myMembers = all.edges.filter((e) => e.type === 'INCLUDES' && e.srcId === trackId && e.dstType === 'source').map((e) => e.dstId);
  for (const id of myMembers) {
    if (upSources.has(id)) continue;
    const src = all.sources.find((s) => s.id === id);
    if (src === undefined) continue;
    const aboutConcept = all.edges.find((e) => e.type === 'ABOUT' && e.srcId === id && e.dstType === 'concept' && upConcepts.has(e.dstId));
    const answers = all.edges.find((e) => e.type === 'ANSWERS' && e.srcId === id && e.dstType === 'question' && upQuestions.has(e.dstId));
    items.push({
      kind: 'source',
      text: src.title,
      title: src.title,
      ...(src.author !== undefined ? { author: src.author } : {}),
      ...(src.modality !== undefined ? { modality: src.modality } : {}),
      ...(src.directUrl !== undefined ? { url: src.directUrl } : {}),
      ...(aboutConcept !== undefined ? { aboutId: aboutConcept.dstId, aboutTitle: upConcepts.get(aboutConcept.dstId)! } : {}),
      ...(answers !== undefined ? { answersId: answers.dstId } : {}),
    });
  }

  // New QUESTIONS, anchored to something upstream has (a base source RAISES it, or it is ABOUT
  // an upstream concept). A question hanging only on MY new material has no anchor the owner's
  // graph can resolve yet — counted skipped, honestly, rather than sent dangling.
  const myNewSourceIds = new Set(myMembers.filter((id) => !upSources.has(id)));
  // A RAISES edge names a source OR a snippet — a snippet stands for its owning source here.
  const snippetOwner = new Map(all.snippets.map((sn) => [sn.id, sn.sourceId]));
  const raiserSource = (e: { srcId: string; srcType: string }): string | undefined =>
    e.srcType === 'source' ? e.srcId : e.srcType === 'snippet' ? snippetOwner.get(e.srcId) : undefined;
  for (const q of all.questions) {
    if (upQuestions.has(q.id)) continue;
    const raises = all.edges.filter((e) => e.type === 'RAISES' && e.dstId === q.id);
    if (raises.length === 0 && !all.edges.some((e) => e.dstId === q.id && e.type === 'ANSWERS')) continue;
    const upRaiser = raises.map(raiserSource).find((id) => id !== undefined && upSources.has(id));
    const about = all.edges.find((e) => e.type === 'ABOUT' && e.srcId === q.id && e.dstType === 'concept' && upConcepts.has(e.dstId));
    if (upRaiser !== undefined) {
      const srcTitle = upstream.sources.find((s) => s.id === upRaiser)?.title ?? '';
      items.push({ kind: 'question', text: q.text, aboutId: upRaiser, aboutTitle: srcTitle });
    } else if (about !== undefined) {
      items.push({ kind: 'question', text: q.text, aboutId: about.dstId, aboutTitle: upConcepts.get(about.dstId)! });
    } else if (raises.map(raiserSource).some((id) => id !== undefined && myNewSourceIds.has(id))) {
      skipped++;
    }
  }
  return { items, skipped };
}

/** The whole gesture: diff against upstream-current, drop what I already have pending, send. */
export async function proposeUpstream(
  client: EngineClient,
  trackRef: string,
): Promise<{ sent: number; alreadyPending: number; skipped: number; nothing: boolean }> {
  const all = (await client.exportAll()) as CanonAll;
  const track = all.tracks.find((t) => t.id === trackRef || t.title === trackRef);
  const origin = track?.origin;
  if (track === undefined || origin?.url === undefined) throw new Error('this track is not a fork of a registry track — nothing to propose to');
  if (!origin.url.startsWith(window.location.origin + '/')) {
    throw new Error(`this fork came from ${origin.url} — open your workbench on that Philomatic to propose there`);
  }
  const upRes = await fetch(`${origin.url}.json`, { headers: { accept: 'application/json' } });
  if (!upRes.ok) throw new Error('the registry no longer serves the track this was forked from');
  const upstream = ((await upRes.json()) as { payload: UpstreamPayload; publication: { trackId: string } });

  const { items, skipped } = forkAdditions(all, track.id, upstream.payload);
  // What I already have waiting drops out — proposing twice must not double the mail.
  const mineRes = await fetch(`/t/${encodeURIComponent(upstream.publication.trackId)}/contributions`, { headers: { accept: 'application/json' } });
  const mine = mineRes.ok ? ((await mineRes.json()) as { contributions: { title?: string; text: string; url?: string }[] }).contributions : [];
  const pendingKeys = new Set(mine.map((m) => m.url ?? m.title ?? m.text));
  const fresh = items.filter((i) => !pendingKeys.has(i.url ?? i.title ?? i.text));

  let sent = 0;
  for (const item of fresh) {
    const r = await fetch(`/t/${encodeURIComponent(upstream.publication.trackId)}/contributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (!r.ok) {
      const err = ((await r.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(err ?? `the registry refused it (${r.status})${sent > 0 ? ` — ${sent} sent before it` : ''}`);
    }
    sent++;
  }
  return { sent, alreadyPending: items.length - fresh.length, skipped, nothing: items.length === 0 && skipped === 0 };
}
