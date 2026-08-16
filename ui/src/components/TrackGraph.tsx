/**
 * TrackGraph — the
 * GraphView-style tree for the public pages, sibling to TrackMap: the track
 * box on a left spine, sources branching off in reading order, each question jutting under the
 * source that raised it, recommendations riding the same spine in dashed purple. Unlike the
 * map, CLICKING PROVIDES DETAILS: a box expands inline — author, modality, the link, and the
 * vote control for recommendations.
 *
 * Deliberately a fresh prop-driven component rather than the workbench GraphView: that one is
 * a whole-library client of the read contract (snapshot + assemble); this one draws whatever
 * payload it is handed — the ask page's island, a publication bundle. The visual language (spine, elbows, boxes, question stubs) is the shared
 * vocabulary; the kind colors come from the tokens like everywhere else.
 *
 * Two host-supplied optionals keep it shared rather than forked: the VOTE controls (the ask
 * page has them; a finished publication has nothing to vote on) and `renderDetail`, the slot
 * that fills an expanded box — the ask page shows meta + link + vote, the publication page
 * shows the whole source card. The component owns the tree; the host owns what's inside a box.
 */
import { useState, type ReactNode } from 'react';
import { ArrowFatUp, CaretDown, CaretRight, LinkSimple } from '@phosphor-icons/react';
import { Icon } from '../components/Icon';
import type { Modality } from '../client/types';

export interface TrackGraphRow {
  id: string;
  title: string;
  author?: string;
  modality?: string;
  url?: string;
  rec?: boolean;
  fresh?: { who: string };
}

export function TrackGraph({
  trackTitle,
  rows,
  concepts,
  questions,
  edges,
  votes,
  myVotes,
  onVote,
  renderDetail,
  groupOf,
  attachments,
  alwaysExpanded = false,
  expandSources = true,
  blocks,
  size = 'compact',
  trackDetail,
  trackId,
  focusId,
  onFocus,
  numberOf,
}: {
  trackTitle: string;
  rows: TrackGraphRow[];
  /** Member concepts — the tree groups sources under the concept they're tied to (the
   *  library's concept-anchored view); flagged ones draw dashed, still-hungry. */
  concepts: { id: string; name: string; description?: string; flagged: boolean; have: number }[];
  questions: { id: string; text: string }[];
  edges: readonly { srcId: string; dstId: string; type: string }[];
  /** Ask page only — a finished publication has nothing to vote on. */
  votes?: Record<string, number>;
  myVotes?: ReadonlySet<string>;
  onVote?: (recId: string) => void;
  /** Fills an expanded box. Absent → the built-in meta line. */
  renderDetail?: (row: TrackGraphRow) => ReactNode;
  /** sourceId → conceptId, from `trackOutline`. Absent → the tree renders FLAT; the component
   *  never guesses a grouping of its own. */
  groupOf?: Record<string, string>;
  /** The page in order, from `trackOutline().blocks` — categories in prerequisite order with the
   *  uncategorized members between them, each where its number puts it.
   *  Absent → categories first, then whatever is left, which is what this drew before. */
  blocks?: readonly { conceptId?: string; sourceIds: string[] }[];
  /** Detail is shown for every box and clicking a source OPENS it — the
   *  publication page's reading mode. The ask page keeps click-to-toggle. */
  alwaysExpanded?: boolean;
  /** false → SOURCE boxes are flat rows (no caret, no detail); CONCEPTS keep their fold —
   *  collapsing a concept is how the Contributions tab stays scannable. */
  expandSources?: boolean;
  /** sourceId → cards that hang OFF that source on their own connector, the way a source hangs
   *  off its concept: its questions and its passages. Present → the
   *  component stops placing questions itself and draws exactly these. */
  attachments?: Record<string, { id: string; kind: 'question' | 'snippet'; node: ReactNode }[]>;
  /** Bigger boxes and roomier spacing (the publication page's Track view). */
  size?: 'compact' | 'roomy';
  /** Fills the TRACK box — the goal, the concepts it covers, its counts.
   *  With it the track reads as an entity like the rest, not a title bar. */
  trackDetail?: ReactNode;
  trackId?: string;
  /** The entity the host is showing elsewhere (the map). Draws as selected. */
  focusId?: string;
  /** Present → clicking a BOX selects that entity rather than expanding it. Expansion moves
   *  entirely to the caret, so the two gestures stop competing. */
  onFocus?: (id: string) => void;
  /** sourceId → its place in the AUTHORED reading order (lib/outline). Absent for a member no
   *  ordering edge touches, which then shows an empty gutter rather than a made-up position.
   *  Without this the component numbered by ROW INDEX — the display sequence — which put a
   *  grouped source first even when the author's chain started elsewhere. */
  numberOf?: Record<string, number>;
}) {
  // Every entity collapses what is UNDER it: its own detail and its
  // children. One toggled set; `open` is the default state flipped by an explicit click, so a
  // reading surface starts expanded and the ask page starts compact with the same mechanism.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const isOpen = (id: string): boolean => (alwaysExpanded ? !toggled.has(id) : toggled.has(id));
  const flip = (id: string): void =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Concept anchoring: each source hangs under its FIRST tied concept (concept order); the
  // rest stay on the spine. Reading-order numbers stick to members regardless of grouping.
  // The component NEVER derives grouping. Handed none, it renders flat — an
  // honest "nobody told me", where the old fallback invented groups the workbench would not
  // show. `lib/outline.ts` is the one place that answers this question.
  const tiedTo = new Map<string, string>();
  for (const [sid, cid] of Object.entries(groupOf ?? {})) if (byId.has(sid)) tiedTo.set(sid, cid);
  // Numbering comes from the outline or not at all. The fallback here
  // numbered rows 1..n by their position in the array, which is a SECOND answer to "what number
  // is this?" — and it disagreed with `numberRows` exactly when it mattered, on a track whose
  // reading order is not the order the rows arrived in. An unordered track shows no numbers,
  // which is the honest answer rather than a sequence that means nothing.
  const memberNumber = new Map(Object.entries(numberOf ?? {}));

  // A question resides under its concept counterpart(s) — ABOUT ties; about several, shown
  // under each. Tie-less questions fall back to the source
  // that raised them; fully unplaced ones gather at the spine's tail. Stubs stay PLAIN — no
  // answered-by chips (the simplification that survived the round-trip).
  const raisedBy = new Map<string, string>();
  const conceptIds = new Set(concepts.map((c) => c.id));
  const qConcepts = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === 'RAISES' && byId.has(e.srcId)) raisedBy.set(e.dstId, e.srcId);
    if (e.type === 'ABOUT' && conceptIds.has(e.dstId) && questions.some((q) => q.id === e.srcId)) {
      qConcepts.set(e.srcId, [...(qConcepts.get(e.srcId) ?? []), e.dstId]);
    }
  }
  const questionsOfConcept = (conceptId: string) => questions.filter((q) => (qConcepts.get(q.id) ?? []).includes(conceptId));

  // Only a concept that HOLDS something gets a box on the spine.
  // Eighteen empty boxes down the page say "eighteen things to scroll past" when they mean "the
  // track also covers these" — and that sentence is already a row of chips inside the track box,
  // which is where this page's other surface puts it. A box is a container; an empty container
  // is not information.
  const hasContents = (id: string): boolean => rows.some((r) => tiedTo.get(r.id) === id) || questionsOfConcept(id).length > 0;
  const boxed = concepts.filter((c) => hasContents(c.id));
  const hasCategories = (blocks ?? []).some((b) => b.conceptId !== undefined);
  const questionsOf = (sourceId: string) => questions.filter((q) => !qConcepts.has(q.id) && raisedBy.get(q.id) === sourceId);
  const orphanQuestions = questions.filter((q) => !qConcepts.has(q.id) && (!raisedBy.has(q.id) || !byId.has(raisedBy.get(q.id)!)));

  const questionStub = (q: { id: string; text: string }) => (
    <div key={q.id} className="agraph-q">
      <span className="agraph-q-icon"><Icon name="question" size={13} /></span>
      <span className="agraph-q-text">{q.text}</span>
    </div>
  );

  /** The caret is the ONLY thing that expands — a box click selects. */
  const caret = (id: string, open = isOpen(id)) => (
    <button
      type="button"
      className="agraph-caret"
      title={open ? 'collapse' : 'expand'}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        flip(id);
      }}
    >
      {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
    </button>
  );

  const box = (r: TrackGraphRow) => {
    const open = expandSources && isOpen(r.id);
    const activate = (e?: { target: unknown }): void => {
      // A nested link or button owns its own click (the open-link icon, the caret, the vote).
      if (e !== undefined && (e.target as Element | null)?.closest?.('a,button') != null) return;
      if (onFocus !== undefined) onFocus(r.id);
      else flip(r.id);
    };
    return (
      <div key={r.id} className={`agraph-branch${r.rec === true ? ' rec' : ''}`}>
        <div
          className={`agraph-box${r.rec === true ? ' rec' : ''}${open ? ' open' : ''}${r.fresh ? ' fresh' : ''}${focusId === r.id ? ' focus' : ''}`}
          role="button"
          tabIndex={0}
          onClick={(e) => activate(e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          }}
        >
          <span className="agraph-box-head">
            {memberNumber.has(r.id) && <span className="agraph-n">{memberNumber.get(r.id)}</span>}
            <span className="agraph-box-icon"><Icon name={`source:${(r.modality ?? 'text') as Modality}`} size={14} /></span>
            <span className="agraph-box-title">{r.title}</span>
            {r.rec === true && <span className="agraph-rec-tag">{r.fresh ? `by ${r.fresh.who}` : 'rec'}</span>}
            {r.url !== undefined && (
              <a
                className="agraph-open"
                href={r.url}
                target="_blank"
                rel="noreferrer"
                title="open this source"
                onClick={(e) => e.stopPropagation()}
              >
                <LinkSimple size={13} />
              </a>
            )}
            {expandSources && caret(r.id)}
          </span>
          {open && (
            <span
              className="agraph-box-detail"
              onClick={(e) => {
                // Only the compact (ask-page) tree treats the detail as inert; where a click
                // SELECTS, the whole box has to be clickable.
                if (!alwaysExpanded && onFocus === undefined) e.stopPropagation();
              }}
            >
              {/* No modality word and no second link: the icon beside the
                  title already says what kind of thing this is, and the head carries the link —
                  every box was offering the same URL twice. */}
              {renderDetail !== undefined
                ? renderDetail(r)
                : r.author !== undefined && <span className="agraph-meta">{r.author}</span>}
              {r.rec === true && onVote !== undefined && (
                <button type="button" className={`askx-vote${myVotes?.has(r.id) === true ? ' on' : ''}`} onClick={() => onVote(r.id)}>
                  <ArrowFatUp size={12} weight={myVotes?.has(r.id) === true ? 'fill' : 'regular'} /> {votes?.[r.id] ?? 0}
                </button>
              )}
            </span>
          )}
        </div>
        {!open ? null : attachments === undefined
          ? questionsOf(r.id).map(questionStub)
          : (attachments[r.id] ?? []).length > 0 && (
              <div className="agraph-spine nested atts">
                {(attachments[r.id] ?? []).map((a) => (
                  // Questions and passages are entities too: they showed on
                  // the map but could not be clicked, so the one thing you could see you could
                  // not select. Same gesture as a box — click selects, it never expands.
                  <div
                    key={a.id}
                    className={`agraph-q agraph-att ${a.kind}${focusId === a.id ? ' focus' : ''}`}
                    {...(onFocus !== undefined
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          onClick: (e: React.MouseEvent) => {
                            if ((e.target as Element | null)?.closest?.('a,button') != null) return;
                            onFocus(a.id);
                          },
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onFocus(a.id);
                            }
                          },
                        }
                      : {})}
                  >
                    <span className="agraph-q-icon">
                      <Icon name={a.kind} size={13} />
                    </span>
                    <span className="agraph-q-text">{a.node}</span>
                  </div>
                ))}
              </div>
            )}
      </div>
    );
  };

  return (
    <div className={size === 'roomy' ? 'agraph roomy' : 'agraph'}>
      <div
        className={`agraph-track${trackDetail !== undefined ? ' box' : ''}${focusId !== undefined && focusId === trackId ? ' focus' : ''}`}
        {...(trackId !== undefined && onFocus !== undefined
          ? {
              role: 'button',
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => {
                if ((e.target as Element | null)?.closest?.('a,button') != null) return;
                onFocus(trackId);
              },
            }
          : {})}
      >
        <span className="agraph-track-head">
          <span className="agraph-track-icon"><Icon name="track" size={15} /></span>
          <span className="agraph-track-title">{trackTitle}</span>
          {trackDetail !== undefined && trackId !== undefined && caret(trackId)}
        </span>
        {trackDetail !== undefined && trackId !== undefined && isOpen(trackId) && (
          <span className="agraph-track-detail">{trackDetail}</span>
        )}
      </div>
      <div className="agraph-spine">
        {boxed.map((c) => {
          const nested = rows.filter((r) => tiedTo.get(r.id) === c.id);
          const open = isOpen(c.id);
          return (
            <div key={c.id} className={`agraph-branch concept${c.flagged ? ' needs' : ''}`}>
              <div
                className={`agraph-box concept${c.flagged ? ' needs' : ''}${open ? ' open' : ''}${focusId === c.id ? ' focus' : ''}`}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if ((e.target as Element | null)?.closest?.('a,button') != null) return;
                  if (onFocus !== undefined) onFocus(c.id);
                  else flip(c.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (onFocus !== undefined) onFocus(c.id);
                    else flip(c.id);
                  }
                }}
              >
                <span className="agraph-box-head">
                  <span className="agraph-cpt-icon"><Icon name="concept" size={14} /></span>
                  <span className="agraph-box-title">{c.name}</span>
                  {c.flagged && <span className="agraph-needs-tag">needs sources</span>}
                  {caret(c.id, open)}
                </span>
                {/* No source/question counts on a concept — the group's
                    contents are right there underneath it. */}
                {/* The detail must NOT swallow the click: a box click
                    selects, and a concept is expanded by default, so stopping propagation here
                    made most of a concept box dead to the gesture. */}
                {open && c.description !== undefined && (
                  <span className="agraph-box-detail">
                    <span className="agraph-meta">{c.description}</span>
                  </span>
                )}
              </div>
              {open && (nested.length > 0 || questionsOfConcept(c.id).length > 0) && (
                <div className="agraph-spine nested">
                  {nested.map(box)}
                  {questionsOfConcept(c.id).map(questionStub)}
                </div>
              )}
            </div>
          );
        })}
        {rows.filter((r) => !tiedTo.has(r.id)).map(box)}
        {orphanQuestions.map(questionStub)}
      </div>
    </div>
  );
}
