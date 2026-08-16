/**
 * The published track's community tabs: Track | Contributions |
 * Questions. The old single "contribute" rail split in two, each wearing the retired ask page's
 * layout language — and unlike the 24-hour ask links it replaces, everything here is the
 * store-and-forward model: submissions wait in the registry mailbox, attributed, until the
 * owner accepts them into their library. Nothing joins the track live.
 *
 * Visibility: the tabs show to EVERYONE — hungry concepts and open questions
 * are part of the track's public face, and the tab itself advertises the community — but
 * submitting needs membership; non-members see a join hint where the form would be.
 */
import { useEffect, useState } from 'react';
import { PaperPlaneTilt } from '@phosphor-icons/react';
import { communityOf } from '../lib/community';
import { PickerBox } from './detail/PickerBox';

interface Mine {
  id: string;
  kind: 'question' | 'source';
  text: string;
  title?: string;
  author?: string;
  modality?: string;
  aboutId?: string;
  aboutTitle?: string;
  answersId?: string;
  url?: string;
}

/** Membership + my pending mail — the plumbing both tabs share. */
export function usePubCommunity(trackId: string, signedIn: boolean) {
  const [member, setMember] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const refreshMine = () =>
    void fetch(`/t/${encodeURIComponent(trackId)}/contributions`, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { contributions: [] }))
      .then((j: { contributions: Mine[] }) => setMine(j.contributions))
      .catch(() => {});
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void communityOf(trackId).then((v) => {
      if (!live) return;
      if (v?.member === true || v?.owner === true) {
        setMember(true);
        refreshMine();
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, signedIn]);
  const send = async (body: Record<string, unknown>): Promise<string | undefined> => {
    const r = await fetch(`/t/${encodeURIComponent(trackId)}/contributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return (((await r.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${r.status})`);
    refreshMine();
    return undefined;
  };
  return { member, mine, send };
}

const JoinHint = () => (
  <p className="pubt-join">
    <strong>Join this track to contribute.</strong> Membership comes by invite — ask whoever runs this track for their
    invite link, then what you send lands in their inbox under your name.
  </p>
);

const Pending = ({ mine, kind }: { mine: Mine[]; kind: 'question' | 'source' }) => {
  const rows = mine.filter((m) => m.kind === kind);
  if (rows.length === 0) return null;
  return (
    <div className="pubc-mine">
      <span className="pub-src-meta">Waiting on the owner:</span>
      <ul>
        {rows.map((m) => (
          <li key={m.id}>
            {m.text}
            {m.aboutTitle !== undefined && <em> — {kind === 'source' ? 'for' : 'on'} {m.aboutTitle}</em>}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Questions: the track's open questions in public, and a member's way to add one — anchored. */
export function QuestionsTab({
  trackId,
  member,
  mine,
  send,
  questions,
  ties,
  about,
}: {
  trackId: string;
  member: boolean;
  mine: Mine[];
  send: (body: Record<string, unknown>) => Promise<string | undefined>;
  questions: { id: string; text: string; answered?: boolean }[];
  /** What each question hangs on, prettified by the page's own view model. */
  ties: (qid: string) => { label: string }[];
  about: { id: string; title: string; kind: 'source' | 'concept' }[];
}) {
  const [text, setText] = useState('');
  const [anchor, setAnchor] = useState('');
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const open = questions.filter((q) => q.answered !== true);
  const answered = questions.filter((q) => q.answered === true);
  // TWO pickers, one per kind — the library's palette look, single-choice:
  // a question anchors to ONE thing, so choosing in one clears the other.
  const sources = about.filter((a) => a.kind === 'source');
  const concepts = about.filter((a) => a.kind === 'concept');
  const chosenAnchor = about.find((a) => a.id === anchor);
  const doSend = () => {
    const chosen = chosenAnchor;
    if (chosen === undefined) return;
    setBusy(true);
    setNote(undefined);
    void send({ kind: 'question', text: text.trim(), aboutId: chosen.id, aboutTitle: chosen.title })
      .then((err) => {
        if (err !== undefined) setNote(err);
        else {
          setText('');
          setNote('Sent — the track owner will see it in their inbox.');
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="pubt" data-track={trackId}>
      {open.length === 0 && answered.length === 0 && <p className="pub-src-meta">No questions on this track yet.</p>}
      {open.length > 0 && (
        <div className="pubt-qs">
          <h3 className="pubt-h">Open questions · {open.length}</h3>
          <ul>
            {open.map((q) => (
              <li key={q.id}>
                <span className="pubt-qtext">? {q.text}</span>
                {ties(q.id).length > 0 && <span className="pub-src-meta"> — on {ties(q.id).map((t) => t.label).join(', ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {answered.length > 0 && (
        <div className="pubt-qs answered">
          <h3 className="pubt-h">Answered · {answered.length}</h3>
          <ul>
            {answered.map((q) => (
              <li key={q.id}>
                <span className="pubt-qtext">✓ {q.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {member ? (
        <>
          <div className="pubt-form">
            <textarea className="pubc-text" value={text} placeholder="What are you stuck on, or curious about?" onChange={(e) => setText(e.target.value)} />
            {/* A question names its anchor — a question tied to
                material is a better question, and an unanchored one has no home in the graph.
                Two pickers, the library's own palette: a reading OR a
                concept — single choice, so picking in one clears the other. */}
            <div className="pubc-row pubt-anchors">
              {sources.length > 0 && (
                <PickerBox
                  single
                  options={sources.map((a) => ({ id: a.id, label: a.title, icon: 'source:text' as const }))}
                  placeholder="on a reading…"
                  variant="source"
                  value={chosenAnchor?.kind === 'source' ? chosenAnchor.title : undefined}
                  onPick={(ids) => setAnchor(ids[0] ?? '')}
                />
              )}
              {concepts.length > 0 && (
                <PickerBox
                  single
                  options={concepts.map((a) => ({ id: a.id, label: a.title, icon: 'concept' as const }))}
                  placeholder="on a concept…"
                  variant="concept"
                  value={chosenAnchor?.kind === 'concept' ? chosenAnchor.title : undefined}
                  onPick={(ids) => setAnchor(ids[0] ?? '')}
                />
              )}
              <button type="button" className="pubc-send" disabled={busy || text.trim() === '' || anchor === ''} onClick={doSend}>
                <PaperPlaneTilt size={14} /> Send
              </button>
            </div>
          </div>
          {note !== undefined && <p className="pubc-note">{note}</p>}
          <Pending mine={mine} kind="question" />
        </>
      ) : (
        <JoinHint />
      )}
    </div>
  );
}
