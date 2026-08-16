/**
 * Community mail in the workbench inbox — the classroom's first half, as the OWNER
 * sees it. Contributions wait at the registry, attributed; this section lists them for
 * every published track this library owns, and turns ACCEPT into ordinary engine writes:
 *
 *   question — imported + tied RAISES to the source it was asked on (the DraftForm recipe),
 *   source   — captured into the track, so it lands as a staged member like any capture.
 *
 * Both carry the contributor as a `#from:<name>` tag observation — attribution is data on the
 * entity, not a parallel ledger. Decline resolves the mail without touching the graph. Either
 * way the registry's record is stamped, never erased.
 *
 * Renders nothing unless this origin's registry has mail for tracks owned here — the fetches
 * themselves are the gate, same as the community box (server-answered, never assumed).
 */
import { useEffect, useState } from 'react';
import { useEngine } from '../engine-context';
import { followingFeed, setFollow, type ContributionRecord } from '../lib/community';
import { contribTag } from '../lib/contrib-id';

interface Mail extends ContributionRecord {
  trackId: string;
  trackTitle: string;
}

interface Moved {
  trackId: string;
  title: string;
  contentHash: string;
  /** The local fork to pull into, when one exists — decides whether the row offers Pull. */
  localId?: string;
}

/** The pending-mail count, shared with the RAIL (the tray must fill and
 *  count community mail too, before the inbox is ever opened). A tiny store: App's probe and
 *  this component both write it; the rail subscribes. */
let mailCount = 0;
const countListeners = new Set<() => void>();
export function communityMailCount(): number {
  return mailCount;
}
export function onCommunityMailCount(cb: () => void): () => void {
  countListeners.add(cb);
  return () => countListeners.delete(cb);
}
function setMailCount(n: number): void {
  if (n === mailCount) return;
  mailCount = n;
  for (const cb of countListeners) cb();
}

/** Count the waiting mail WITHOUT rendering the inbox — App calls this on refresh. */
export async function probeCommunityMail(client: {
  getSnapshot(): Promise<{ tracks: { id: string; published?: unknown; origin?: { trackId: string } }[] }>;
}): Promise<void> {
  try {
    const snap = await client.getSnapshot();
    let mail = 0;
    for (const t of snap.tracks.filter((x) => x.published !== undefined)) {
      const r = await fetch(`/t/${encodeURIComponent(t.id)}/contributions`, { headers: { accept: 'application/json' } }).catch(() => undefined);
      if (r === undefined || !r.ok) continue;
      mail += ((await r.json()) as { contributions: unknown[] }).contributions.length;
    }
    const feed = await followingFeed();
    mail += feed.filter((f) => f.sawHash !== f.contentHash).length;
    setMailCount(mail);
  } catch {
    /* signed out / no registry — zero stands */
  }
}

export function CommunityInbox() {
  const { client, notify, refresh } = useEngine();
  const [mail, setMail] = useState<Mail[]>([]);
  const [moved, setMoved] = useState<Moved[]>([]);
  const [busy, setBusy] = useState<string | undefined>();

  const load = async () => {
    try {
      const snap = await client.getSnapshot();
      const published = snap.tracks.filter((t) => t.published !== undefined);
      const all: Mail[] = [];
      for (const t of published) {
        const r = await fetch(`/t/${encodeURIComponent(t.id)}/contributions`, { headers: { accept: 'application/json' } }).catch(() => undefined);
        if (r === undefined || !r.ok) continue;
        const { contributions } = (await r.json()) as { contributions: ContributionRecord[] };
        all.push(...contributions.map((c) => ({ ...c, trackId: t.id, trackTitle: t.title })));
      }
      setMail(all.sort((a, b) => b.at - a.at));
      // FOLLOWED tracks that moved past what this account last saw:
      // the registry keeps the cursor; a local fork of the track upgrades "view" into "pull".
      const feed = (await followingFeed()).filter((f) => f.sawHash !== f.contentHash);
      const forks = new Map(snap.tracks.filter((t) => t.origin !== undefined).map((t) => [t.origin!.trackId, t.id]));
      setMoved(feed.map((f) => ({ trackId: f.trackId, title: f.title, contentHash: f.contentHash, localId: forks.get(f.trackId) })));
      setMailCount(all.length + feed.length);
    } catch {
      /* no registry here, or signed out — the section simply stays empty */
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mail.length === 0 && moved.length === 0) return null;

  /** Acknowledge a version — the row leaves until the track moves again. */
  const seen = async (m: Moved) => {
    setBusy(m.trackId);
    try {
      await setFollow(m.trackId, { saw: m.contentHash });
      setMoved((cur) => cur.filter((x) => x.trackId !== m.trackId));
      setMailCount(Math.max(0, mailCount - 1));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const pullMoved = async (m: Moved) => {
    setBusy(m.trackId);
    try {
      const r = await client.pullFork(m.localId!);
      notify(`Pulled “${m.title}” ✓ — took ${r.took}${r.keptYours > 0 ? `, kept ${r.keptYours} of yours` : ''}${r.upstreamDeleted > 0 ? `, upstream removed ${r.upstreamDeleted} (kept here)` : ''}`);
      await setFollow(m.trackId, { saw: m.contentHash });
      setMoved((cur) => cur.filter((x) => x.trackId !== m.trackId));
      setMailCount(Math.max(0, mailCount - 1));
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const resolve = async (m: Mail, action: 'accepted' | 'declined') => {
    setBusy(m.id);
    try {
      if (action === 'accepted') {
        // Attribution + the deterministic claim id ( reservation): #from names
        // the contributor; #contrib addresses the CLAIM — hash of {kind, value, assertedBy} —
        // dormant until the assertion layer, which migrates instead of excavating.
        const from = [
          `#from:${m.name}`,
          contribTag({ kind: m.kind, value: m.kind === 'question' ? m.text : (m.url ?? m.title ?? m.text), assertedBy: m.name }),
        ];
        if (m.kind === 'question') {
          // The DraftForm recipe: author the question, record the ask, then tie it to what it
          // was asked ON — RAISES from a source, ABOUT to a concept (
          // the concept tie was dropped on the floor). Ids match because the contributor's
          // bundle came from this graph's own publication.
          await client.importPayload({ version: 2, questions: [{ text: m.text, tags: from }] });
          await client.ask(m.text);
          const q = (await client.getQuestions()).questions.find((x) => x.text === m.text);
          if (q !== undefined) {
            const anchor = m.aboutId;
            if (anchor !== undefined) {
              if (anchor.startsWith('src_')) await client.link({ srcType: 'source', srcId: anchor, type: 'RAISES', dstType: 'question', dstId: q.id }).catch(() => {});
              else if (anchor.startsWith('con_')) await client.link({ srcType: 'question', srcId: q.id, type: 'ABOUT', dstType: 'concept', dstId: anchor }).catch(() => {});
            }
            // Accepting the contribution IS the review ("it feels like
            // I am accepting twice"): the entity lands ACCEPTED, not re-staged into the ordinary
            // validation inbox for a second decision.
            await client.accept(q.id).catch(() => {});
          }
        } else {
          // A recommended source: captured INTO the track with everything the rail collected —
          // title, author, modality — the recommender riding as a tag; then its ties: ABOUT the
          // concept it helps with, ANSWERS the question it was offered for (the ask-page port).
          const made = (await client.captureSource({
            ...(m.url !== undefined ? { url: m.url } : {}),
            ...(m.title !== undefined ? { title: m.title } : m.url === undefined ? { title: m.text.slice(0, 200) } : {}),
            ...(m.author !== undefined ? { author: m.author } : {}),
            ...(m.modality !== undefined ? { modality: m.modality } : {}),
            track: m.trackTitle,
            tags: from,
          })) as { sourceId?: string };
          if (made.sourceId !== undefined) {
            if (m.aboutId !== undefined && m.aboutId.startsWith('con_')) {
              await client.link({ srcType: 'source', srcId: made.sourceId, type: 'ABOUT', dstType: 'concept', dstId: m.aboutId }).catch(() => {});
            }
            if (m.answersId !== undefined) {
              await client.link({ srcType: 'source', srcId: made.sourceId, type: 'ANSWERS', dstType: 'question', dstId: m.answersId }).catch(() => {});
            }
            // One decision: the owner's Accept here IS the validation — land it accepted, not
            // staged again ("accepting twice").
            await client.accept(made.sourceId).catch(() => {});
          }
        }
      }
      const r = await fetch(`/t/${encodeURIComponent(m.trackId)}/contributions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolve: m.id, action }),
      });
      if (!r.ok) throw new Error(`the registry did not record it (${r.status})`);
      setMail((cur) => cur.filter((x) => x.id !== m.id));
      // WHERE it landed matters: a question tied to a reading shows
      // up on the track through that reading; a track-level question has nothing to hang on —
      // the model ties questions to sources and concepts, never to a track directly — so it
      // lives in Library → Questions, and saying so here is what keeps it from reading as lost.
      notify(
        action !== 'accepted'
          ? 'Declined'
          : m.kind === 'source'
            ? `Accepted — added to “${m.trackTitle}”, from ${m.name} ✓`
            : m.aboutId !== undefined && m.aboutId.startsWith('src_')
              ? `Accepted — on its reading, from ${m.name} ✓`
              : `Accepted — in Library → Questions (it names no reading, so it hangs on none), from ${m.name} ✓`,
      );
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="community-mail">
      {moved.length > 0 && (
        <>
          <div className="inbox-section-title">Tracks you follow</div>
          {moved.map((m) => (
            <div key={m.trackId} className="cmail-row">
              <div className="cmail-body">
                <span className="cmail-kind">↻</span>
                <span className="cmail-text">
                  <strong>{m.title}</strong> has a new version
                </span>
              </div>
              <div className="cmail-meta">
                <a href={`/t/${encodeURIComponent(m.trackId)}`} target="_blank" rel="noreferrer">
                  view the track ↗
                </a>
                <span className="cmail-actions">
                  {m.localId !== undefined && (
                    <button className="pm-btn" disabled={busy === m.trackId} onClick={() => void pullMoved(m)}>
                      Pull
                    </button>
                  )}
                  <button className="pm-btn" disabled={busy === m.trackId} onClick={() => void seen(m)}>
                    Mark seen
                  </button>
                </span>
              </div>
            </div>
          ))}
        </>
      )}
      {mail.length > 0 && <div className="inbox-section-title">From your community</div>}
      {mail.map((m) => (
        <div key={m.id} className="cmail-row">
          <div className="cmail-body">
            <span className="cmail-kind">{m.kind === 'question' ? '?' : '+'}</span>
            <span className="cmail-text">
              {m.title ?? m.text}
              {m.url !== undefined && (
                <>
                  {' '}
                  <a href={m.url} target="_blank" rel="noreferrer" className="cmail-url">
                    {m.url}
                  </a>
                </>
              )}
            </span>
          </div>
          <div className="cmail-meta">
            <span>
              {m.name} · {m.trackTitle}
              {m.aboutTitle !== undefined ? <> · on “{m.aboutTitle}”</> : <> · on the track as a whole</>}
            </span>
            <span className="cmail-actions">
              <button className="pm-btn" disabled={busy === m.id} onClick={() => void resolve(m, 'accepted')}>
                Accept
              </button>
              <button className="pm-btn" disabled={busy === m.id} onClick={() => void resolve(m, 'declined')}>
                Decline
              </button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
