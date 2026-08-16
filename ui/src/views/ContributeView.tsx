/**
 * The Contributions tab — the ask page, verbatim ("it should look exactly
 * like the ask page"). This IS AskPage's layout on the same workbench components: hero with
 * stats, the two-column body (graph/map · recommendations · concept-wanted cards · open
 * questions | contribute rail), the same classes, the same css (askx.css, restored).
 *
 * Only the DELIVERY differs, deliberately: the ask's 24h capability links, votes, and
 * anonymous names are retired — submissions go to the community mailbox, attributed to the
 * signed-in member, waiting on the owner. Your own pending items still join the map and the
 * lists live, exactly as recommendations did on the ask page; they are drawn from the mailbox
 * instead of an ephemeral sidecar.
 */
import { useDismiss } from '../lib/use-dismiss';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, PaperPlaneTilt, PlusCircle } from '@phosphor-icons/react';
import { TrackMap, type TrackMapPayload } from '../components/TrackMap';
import { TrackGraph } from '../components/TrackGraph';
import { MapLegend } from '../components/map-marks';
import { trackOutline } from '../lib/outline';
import { Icon, type IconName } from '../components/Icon';
import type { Modality } from '../client/types';
import './askx.css';

interface SourceRow {
  id: string;
  title: string;
  author?: string;
  modality?: string;
  url?: string;
  fresh?: { who: string };
  rec?: boolean;
}

export interface PendingRec {
  id: string;
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

const MODALITIES: { id: Modality; label: string }[] = [
  { id: 'text', label: 'text' },
  { id: 'video', label: 'video' },
  { id: 'audio', label: 'audio' },
  { id: 'interactive', label: 'exercise' },
];

const amazonSlugTitle = (url: string): string | undefined => {
  const m = /amazon\.[a-z.]+\/([A-Za-z0-9-]{8,})\/dp\//.exec(url);
  return m ? m[1]!.replace(/-/g, ' ') : undefined;
};

function AskPicker({
  options,
  value,
  placeholder,
  icon,
  onPick,
}: {
  options: { id: string; label: string }[];
  value: string;
  placeholder: string;
  icon: IconName;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useDismiss(boxRef, open, () => setOpen(false));
  const current = options.find((o) => o.id === value);
  return (
    <div className="picker-box" ref={boxRef}>
      <button type="button" className="picker-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="picker-placeholder">{current?.label ?? placeholder}</span>
        <span className="picker-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="picker-list">
          <div className="picker-options">
            <button type="button" className={value === '' ? 'palette-item selected' : 'palette-item'} onClick={() => { onPick(''); setOpen(false); }}>
              <span className="palette-check">{value === '' ? '✓' : ''}</span> — none —
            </button>
            {options.map((o) => (
              <button type="button" key={o.id} className={value === o.id ? 'palette-item selected' : 'palette-item'} onClick={() => { onPick(o.id); setOpen(false); }}>
                <span className="palette-check">{value === o.id ? '✓' : ''}</span>
                <span style={{ color: icon === 'concept' ? 'var(--k-concept)' : 'var(--k-question)' }}><Icon name={icon} size={13} /></span>{' '}
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ContributeView({
  title,
  goal,
  payload: basePayload,
  flagged,
  open: openQuestions,
  inTrack,
  member,
  who,
  pending,
  send,
}: {
  title: string;
  goal?: string;
  payload: TrackMapPayload;
  /** Concepts that need sources (no member reading explains them). */
  flagged: { id: string; name: string; description?: string; have: number }[];
  open: { id: string; text: string }[];
  inTrack: SourceRow[];
  member: boolean;
  /** The signed-in account's display name — the byline on your own pending items. */
  who: string;
  /** My mailbox items still waiting on the owner (kind source). */
  pending: PendingRec[];
  send: (body: Record<string, unknown>) => Promise<string | undefined>;
}) {
  // My pending recommendations join the page exactly as the ask page's did — rows, map accent,
  // counts — sourced from the mailbox instead of the ask sidecar.
  const recRows = useMemo(
    (): SourceRow[] =>
      pending
        .filter((m) => m.kind === 'source')
        .map((m) => ({
          id: `rec_${m.id}`,
          title: m.title ?? m.text,
          ...(m.author !== undefined ? { author: m.author } : {}),
          modality: m.modality ?? 'text',
          ...(m.url !== undefined ? { url: m.url } : {}),
          rec: true,
          fresh: { who },
        })),
    [pending, who],
  );
  const recTies = useMemo(
    () =>
      pending
        .filter((m) => m.kind === 'source')
        .flatMap((m) => [
          ...(m.aboutId !== undefined ? [{ srcId: `rec_${m.id}`, dstId: m.aboutId, srcType: 'source', dstType: 'concept', type: 'ABOUT', tags: [] }] : []),
          ...(m.answersId !== undefined ? [{ srcId: `rec_${m.id}`, dstId: m.answersId, srcType: 'source', dstType: 'question', type: 'ANSWERS', tags: [] }] : []),
        ]),
    [pending],
  );
  const payload = useMemo(
    (): TrackMapPayload => ({
      ...basePayload,
      sources: [...basePayload.sources, ...recRows.map((r) => ({ id: r.id, title: r.title }))],
      edges: [...basePayload.edges, ...recTies] as TrackMapPayload['edges'],
    }),
    [basePayload, recRows, recTies],
  );
  const rows = useMemo(() => [...inTrack, ...recRows], [inTrack, recRows]);
  const recIds = useMemo(() => new Set(recRows.map((r) => r.id)), [recRows]);
  const have = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(flagged.map((c) => [c.id, c.have]));
    for (const t of recTies) if (t.type === 'ABOUT' && counts[t.dstId] !== undefined) counts[t.dstId] = (counts[t.dstId] ?? 0) + 1;
    return counts;
  }, [flagged, recTies]);
  const answers = useMemo(() => {
    const out: Record<string, { title: string; by: string }[]> = {};
    for (const m of pending.filter((x) => x.kind === 'source' && x.answersId !== undefined)) {
      out[m.answersId!] = [...(out[m.answersId!] ?? []), { title: m.title ?? m.text, by: who }];
    }
    return out;
  }, [pending, who]);

  const [view, setView] = useState<'graph' | 'map'>('graph');
  const [dTitle, setDTitle] = useState('');
  const [dAuthor, setDAuthor] = useState('');
  const [dUrl, setDUrl] = useState('');
  const [dModality, setDModality] = useState<Modality>('text');
  const [dConcept, setDConcept] = useState('');
  const [dQuestion, setDQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | undefined>();
  const railRef = useRef<HTMLElement>(null);

  const outline = useMemo(
    () =>
      trackOutline({
        trackId: payload.tracks[0]?.id ?? '',
        concepts: payload.concepts.map((c) => ({ id: c.id, name: c.name, tags: [] })),
        sources: payload.sources.map((s) => ({
          id: s.id,
          title: s.title,
          about: payload.edges
            .filter((e) => e.type === 'ABOUT' && e.srcId === s.id && e.dstType === 'concept')
            .map((e) => payload.concepts.find((c) => c.id === e.dstId)?.name)
            .filter((n): n is string => n !== undefined),
        })),
        edges: payload.edges.map((e) => ({
          srcId: e.srcId,
          dstId: e.dstId,
          type: e.type,
          tags: (e.tags ?? []).map((t) => `#${(t as { name: string }).name}`),
        })),
        memberOrder: rows.map((r) => r.id),
      }),
    [payload, rows],
  );

  const graphRows = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const placed = new Set(outline.order);
    return [
      ...outline.order.flatMap((id) => {
        const r = byId.get(id);
        return r === undefined ? [] : [r];
      }),
      ...rows.filter((r) => !placed.has(r.id)),
    ];
  }, [outline, rows]);

  const graphConcepts = useMemo(() => {
    const shape = (c: { id: string; name: string }) => {
      const isFlagged = flagged.find((x) => x.id === c.id) !== undefined;
      return {
        id: c.id,
        name: c.name,
        flagged: isFlagged,
        have: isFlagged
          ? (have[c.id] ?? 0)
          : new Set(payload.edges.filter((e) => e.type === 'ABOUT' && e.dstId === c.id && e.srcType === 'source').map((e) => e.srcId)).size,
      };
    };
    const grouped = new Set<string>();
    const ordered = outline.groups.flatMap((g) => {
      const c = payload.concepts.find((x) => x.id === g.conceptId);
      if (c === undefined) return [];
      grouped.add(c.id);
      return [shape(c)];
    });
    return [...ordered, ...payload.concepts.filter((c) => !grouped.has(c.id)).map(shape)];
  }, [outline, payload, flagged, have]);

  const recommendations = rows.filter((r) => r.rec === true);
  const conceptNames = (sourceId: string): string[] =>
    payload.edges
      .filter((e) => e.type === 'ABOUT' && e.srcId === sourceId && e.dstType === 'concept')
      .flatMap((e) => {
        const c = payload.concepts.find((x) => x.id === e.dstId);
        return c === undefined ? [] : [c.name];
      });
  const questionTies = (qid: string): { kind: 'concept' | 'source'; label: string }[] => [
    ...payload.edges
      .filter((e) => e.type === 'ABOUT' && e.srcId === qid && e.dstType === 'concept')
      .flatMap((e) => {
        const c = payload.concepts.find((x) => x.id === e.dstId);
        return c === undefined ? [] : [{ kind: 'concept' as const, label: c.name }];
      }),
    ...payload.edges
      .filter((e) => e.type === 'RAISES' && e.dstId === qid && e.srcType === 'source')
      .flatMap((e) => {
        const src = payload.sources.find((x) => x.id === e.srcId);
        return src === undefined ? [] : [{ kind: 'source' as const, label: src.title }];
      }),
  ];
  const chips = (names: string[]) =>
    names.length === 0 ? null : (
      <div className="agraph-chips">
        {names.map((n) => (
          <span key={n} className="outline-cchip">
            {n}
          </span>
        ))}
      </div>
    );
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const conceptsOpen = flagged.filter((c) => (have[c.id] ?? 0) === 0).length || flagged.length;

  const submit = async (): Promise<void> => {
    const t = dTitle.trim();
    const u = dUrl.trim();
    if (t === '' && u === '') {
      setMsg({ text: 'Give me a title or a link.', ok: false });
      return;
    }
    setSending(true);
    setMsg(undefined);
    const concept = payload.concepts.find((c) => c.id === dConcept);
    const err = await send({
      kind: 'source',
      text: t !== '' ? t : u,
      title: t !== '' ? t : u,
      ...(dAuthor.trim() !== '' ? { author: dAuthor.trim() } : {}),
      modality: dModality,
      ...(u !== '' ? { url: u } : {}),
      ...(concept !== undefined ? { aboutId: concept.id, aboutTitle: concept.name } : {}),
      ...(dQuestion !== '' ? { answersId: dQuestion } : {}),
    });
    setSending(false);
    if (err !== undefined) {
      setMsg({ text: err, ok: false });
      return;
    }
    setMsg({ text: 'Sent — it lands in the owner’s inbox for review. Watch it join the map.', ok: true });
    setDTitle('');
    setDAuthor('');
    setDUrl('');
  };

  return (
    <div className="askx askx-embedded">
      {/* stats only — the page title and goal already sit above the tabs. */}
      <div className="askx-hero askx-hero-stats">
        <div className="askx-stats">
          <div><span className="askx-stat-n">{rows.length}</span><span className="askx-stat-l">sources</span></div>
          <div><span className="askx-stat-n">{conceptsOpen}</span><span className="askx-stat-l">concepts open</span></div>
          <div><span className="askx-stat-n">{openQuestions.length}</span><span className="askx-stat-l">questions open</span></div>
          <div><span className="askx-stat-n">{recommendations.length}</span><span className="askx-stat-l">pending</span></div>
        </div>
      </div>

      <div className="askx-grid">
        {/* left: the graph / map */}
        <div className="askx-main askx-col-left">
          {payload.concepts.length + payload.sources.length >= 2 && (
            <section className="askx-section">
              <div className="askx-sec-head">
                <h5>Track</h5>
                <span className="askx-viewtoggle">
                  <button type="button" className={view === 'graph' ? 'on' : ''} onClick={() => setView('graph')}>graph</button>
                  <button type="button" className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>map</button>
                </span>
                <span className="askx-sec-note">your recommendations join it</span>
              </div>
              {view === 'graph' && (
                <TrackGraph
                  trackTitle={title}
                  rows={graphRows}
                  concepts={graphConcepts}
                  questions={[]}
                  edges={payload.edges}
                  groupOf={outline.groupOf}
                  numberOf={outline.numberOf}
                  blocks={outline.blocks}
                  // Sources are flat rows — their details live on the Track
                  // tab — but CONCEPTS fold, open by default, so the sources inside them show
                  // and a long track can still be collapsed to its shape.
                  alwaysExpanded
                  expandSources={false}
                />
              )}
              {view === 'map' && (
                <>
                  <TrackMap payload={payload} flaggedIds={new Set(flagged.map((c) => c.id))} accentIds={recIds} />
                  <MapLegend
                    items={[
                      { swatch: 'node', kind: 'concept', color: 'var(--k-concept)', label: 'concept' },
                      { swatch: 'node', kind: 'source', color: 'var(--k-source)', label: 'source in the track' },
                      { swatch: 'node', kind: 'source', color: 'var(--k-source)', label: 'recommendation', dashed: true, title: 'a recommended source — pending the owner’s review' },
                      { swatch: 'node', kind: 'concept', color: 'var(--k-concept)', label: 'needs sources', dashed: true, title: 'a concept still waiting for sources' },
                    ]}
                  />
                </>
              )}
            </section>
          )}
        </div>

        {/* middle: what there is to DO */}
        <div className="askx-main askx-col-mid">
          <section className="askx-section">
            <div className="askx-sec-head">
              <h5>Recommendations</h5>
              <span className="askx-sec-note">{recommendations.length === 0 ? 'none yet' : 'pending the owner’s review'}</span>
            </div>
            {recommendations.length === 0 ? (
              <p className="askx-empty">Nothing recommended yet — yours would be the first.</p>
            ) : (
              <div className="askx-rows">
                {recommendations.map((s) => (
                  <div key={s.id} className={`askx-src${s.fresh ? ' fresh' : ''}`}>
                    <span className="askx-src-n rec-dot" title="a recommendation — pending the owner's review" />
                    <span className="askx-src-icon"><Icon name={`source:${(s.modality ?? 'text') as Modality}`} size={16} /></span>
                    <div className="askx-src-body">
                      <div className="askx-src-title">
                        {s.url !== undefined ? (
                          <a href={s.url} target="_blank" rel="noreferrer" title="open source">{s.title}</a>
                        ) : (
                          s.title
                        )}
                      </div>
                      <div className="askx-src-meta">
                        <span>{[s.modality ?? 'text', ...(s.author !== undefined ? [s.author] : [])].join(' · ')}</span>
                        <span className="askx-tag-accent">{s.fresh !== undefined ? `added by ${s.fresh.who}` : 'recommendation'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {flagged.length > 0 && (
            <section className="askx-section">
              <div className="askx-sec-head">
                <h5>Concepts that need sources</h5>
                <span className="askx-sec-note">pick one when you contribute</span>
              </div>
              <div className="askx-cards">
                {flagged.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`askx-card${dConcept === c.id ? ' on' : ''}`}
                    onClick={() => setDConcept((cur) => (cur === c.id ? '' : c.id))}
                  >
                    <span className="askx-card-head">
                      <Icon name="concept" size={15} />
                      <span className="askx-card-name">{c.name}</span>
                      <span className={`askx-count${(have[c.id] ?? 0) === 0 ? ' none' : ''}`}>
                        {(have[c.id] ?? 0) === 0 ? 'none yet' : `${have[c.id]} source${have[c.id] === 1 ? '' : 's'}`}
                      </span>
                    </span>
                    {c.description !== undefined && <span className="askx-card-want">{c.description}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}

          {openQuestions.length > 0 && (
            <section className="askx-section">
              <div className="askx-sec-head">
                <h5>Open questions</h5>
                <span className="askx-sec-note">answer one with a source</span>
              </div>
              <div className="askx-rows">
                {openQuestions.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    className={`askx-q${dQuestion === q.id ? ' on' : ''}`}
                    onClick={() => setDQuestion((cur) => (cur === q.id ? '' : q.id))}
                  >
                    <span className="askx-q-mark"><Icon name="question" size={14} /></span>
                    <span className="askx-q-body">
                      <span className="askx-q-title">{q.text}</span>
                      {questionTies(q.id).length > 0 && (
                        <span className="askx-q-tie">
                          {questionTies(q.id).map((t) => (
                            <span key={`${t.kind}:${t.label}`} className={`askx-q-tie-item ${t.kind}`}>
                              <Icon name={t.kind} size={11} /> {t.label}
                            </span>
                          ))}
                        </span>
                      )}
                      {(answers[q.id] ?? []).map((a, i) => (
                        <span key={i} className="askx-answer">
                          <CheckCircle size={12} /> <span className="askx-answer-t">{a.title}</span>
                          <span className="askx-answer-by">via {a.by}</span>
                        </span>
                      ))}
                      {(answers[q.id] ?? []).length === 0 && <span className="askx-q-age">unanswered</span>}
                    </span>
                    <span className="askx-tag-outline">answer this</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* contribute rail */}
        <aside className="askx-rail" ref={railRef}>
          <div className="askx-rail-head">
            <PlusCircle size={16} />
            <h6>Contribute a source</h6>
          </div>

          {member ? (
            <>
              <label className="askx-field">
                Title
                <input className="pm-input" placeholder="a book, video, article, course…" value={dTitle} onChange={(e) => setDTitle(e.target.value)} />
              </label>
              <label className="askx-field">
                Author
                <input className="pm-input" placeholder="author or creator" value={dAuthor} onChange={(e) => setDAuthor(e.target.value)} />
              </label>
              <div className="askx-two">
                <label className="askx-field">
                  URL
                  <input
                    className="pm-input"
                    type="url"
                    placeholder="https://…"
                    value={dUrl}
                    onChange={(e) => {
                      setDUrl(e.target.value);
                      const t = amazonSlugTitle(e.target.value.trim());
                      if (t !== undefined && dTitle.trim() === '') setDTitle(t);
                    }}
                  />
                </label>
                <label className="askx-field">
                  Modality
                  <select className="pm-input" value={dModality} onChange={(e) => setDModality(e.target.value as Modality)}>
                    {MODALITIES.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {(flagged.length > 0 || openQuestions.length > 0) && (
                <div className="askx-field">
                  {flagged.length > 0 && (
                    <>
                      <span className="askx-target-label concept">Concept</span>
                      <AskPicker
                        options={flagged.map((c) => ({ id: c.id, label: c.name }))}
                        value={dConcept}
                        placeholder="pick a concept it helps with…"
                        icon="concept"
                        onPick={setDConcept}
                      />
                    </>
                  )}
                  {openQuestions.length > 0 && (
                    <>
                      <span className="askx-target-label question">Question</span>
                      <AskPicker
                        options={openQuestions.map((q) => ({ id: q.id, label: clip(q.text, 60) }))}
                        value={dQuestion}
                        placeholder="pick a question it answers…"
                        icon="question"
                        onPick={setDQuestion}
                      />
                    </>
                  )}
                </div>
              )}

              <button className="pm-btn askx-submit" disabled={sending || (dTitle.trim() === '' && dUrl.trim() === '')} onClick={() => void submit()}>
                <PaperPlaneTilt size={14} /> Add to track
              </button>
              {msg && <span className={msg.ok ? 'askx-done' : 'askx-fail'}>{msg.text}</span>}
            </>
          ) : (
            <p className="pubt-join">
              <strong>Join this track to contribute.</strong> Membership comes by invite — ask whoever runs this track
              for their invite link, then what you send lands in their inbox under your name.
            </p>
          )}

          <footer className="askx-foot">
            Recommendations land in the track owner's <em>inbox</em> for review — nothing enters their library without
            their say-so. Powered by <a href="https://github.com/philomatic-io/philomatic">Philomatic</a>.
          </footer>
        </aside>
      </div>
    </div>
  );
}
