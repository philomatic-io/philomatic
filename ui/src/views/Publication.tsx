/**
 * The publication page: the PUBLIC face of a published track, served at
 * `/t/<id>` and fed ONLY by `/t/<id>.json` — never `/snapshot` — so the page can't show more
 * than the bundle contains. A clean document layout, not the workbench: header (title, goal,
 * author, license), the reading order (PRECEDES levels computed from the bundle's own edges;
 * co-requisites share a row), each source with its passages and the questions they open.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaretDown, CaretRight, GitBranch, Path } from '@phosphor-icons/react';
import { SnippetText } from '../lib/snippet-md';
import { Icon } from '../components/Icon';
import { outlineFromBundle, trackOutline } from '../lib/outline';
import { TrackMap } from '../components/TrackMap';
import { TrackGraph, type TrackGraphRow } from '../components/TrackGraph';
import { kindLegend, MapLegend, RELATION_LEGEND } from '../components/map-marks';
import { scopeOf } from '../lib/map-scope';
import { QuestionsTab, usePubCommunity } from './PubTabs';
import { ContributeView } from './ContributeView';
import { ContributeIcon } from '../components/ContributeIcon';
import { AccountControl } from '../components/AccountControl';
import type { HostedIdentity } from '../lib/hosted';
import { communityOf, setFollow, type CommunityView } from '../lib/community';

// The bundle's own shapes (canonical payload subset + manifest) — local on purpose: this page
// is a client of the publication contract, not of the workbench's snapshot types.
interface Tag {
  name: string;
  subtype?: string;
  degree?: number;
}
interface PubEdge {
  srcType: string;
  srcId: string;
  type: string;
  dstType: string;
  dstId: string;
  tags: Tag[];
  trackContextId?: string;
}
interface Bundle {
  pubVersion: number;
  publication: { trackId: string; title: string; author?: string; license: string; publishedAt: number; authorKey?: string };
  payload: {
    tracks: { id: string; title: string; goal?: string; framework?: string; tags: Tag[] }[];
    concepts: { id: string; name: string; description?: string; tags: Tag[] }[];
    sources: {
      id: string;
      title: string;
      author?: string;
      directUrl?: string;
      modality: string;
      estimatedDurationMins?: number;
      tags: Tag[];
    }[];
    snippets: { id: string; sourceId: string; text: string; tags: Tag[] }[];
    questions: { id: string; text: string; tags: Tag[] }[];
    edges: PubEdge[];
    /** The hash-covered manifest: every non-core framework whose tags ship here. */
    frameworks?: { name: string; version: number }[];
  };
}

const tagLabel = (t: Tag): string =>
  `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}${t.degree !== undefined ? `:${t.degree}` : ''}`;

/** Kahn layering over the track's own PRECEDES edges — sources sharing a level read together. */
function levels(memberIds: string[], precedes: { src: string; dst: string }[]): string[][] {
  const members = new Set(memberIds);
  const indeg = new Map(memberIds.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of precedes) {
    if (!members.has(e.src) || !members.has(e.dst)) continue;
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
    out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
  }
  const result: string[][] = [];
  let frontier = memberIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const seen = new Set<string>();
  while (frontier.length > 0) {
    result.push(frontier);
    for (const id of frontier) seen.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dst of out.get(id) ?? []) {
        indeg.set(dst, (indeg.get(dst) ?? 0) - 1);
        if ((indeg.get(dst) ?? 0) === 0 && !seen.has(dst)) next.push(dst);
      }
    }
    frontier = next;
  }
  return result;
}

/** A collapsible page section: the heading toggles, expanded by
 *  default — long snippet/question lists fold away without losing the page's shape. */
function Section({ title, icon, aside, children }: { title: string; icon?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <h2
        className="pub-h2-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        {open ? <CaretDown size={13} className="pub-caret" /> : <CaretRight size={13} className="pub-caret" />}
        {icon}
        {title}
        {aside}
      </h2>
      {open && children}
    </section>
  );
}

export function PublicationPage({ trackId, inline }: { trackId?: string; inline?: unknown }) {
  const [bundle, setBundle] = useState<Bundle | undefined>(inline as Bundle | undefined);
  const [error, setError] = useState<string | undefined>();
  // One Track section, three ways to read it: the graph leads because
  // clicking gives detail; the list is the linear read; the map is the shape.
  // The entity the reader last clicked in the tree — the map narrows to it.
  const [focusId, setFocusId] = useState<string | undefined>();
  /** The registry serving this page, when there is one. `/index.json` is the registry's own
   *  contract (`registryVersion`), so probing it is how a page discovers it is being BROWSED
   *  rather than served from the author's server or opened as a downloaded file. */
  const [registry, setRegistry] = useState<string | undefined>();
  const [workbenchHere, setWorkbenchHere] = useState(false);
  const [me, setMe] = useState<HostedIdentity | undefined>();
  const [community, setCommunity_] = useState<CommunityView | undefined>();
  /** The community tabs: the track, and its two mailboxes. */
  const [tab, setTab] = useState<'track' | 'contributions' | 'questions'>('track');
  /** The frozen header's height, published as a CSS variable so the map can pin directly beneath
   *  it. Measured rather than assumed: a long title wraps, and the toolbar wraps on a phone. */
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = headRef.current;
    if (el === null) return;
    const publish = () => document.documentElement.style.setProperty('--pub-head-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!window.location.protocol.startsWith('http')) return; // a file:// export has no origin
    let live = true;
    void fetch('/index.json')
      .then((r) => (r.ok ? r.json() : undefined))
      .then((j: { registryVersion?: number } | undefined) => {
        if (live && j?.registryVersion !== undefined) setRegistry(window.location.host);
      })
      .catch(() => undefined); // not a registry, or offline — the link simply does not appear
    // NOT hostedIdentity(): its base is the workbench mount, and on /t/<id> that would spell
    // /t/<id>/auth/me. The account lives at this ORIGIN's root — registry and instance both
    // answer /auth/me there; a static export's fetch fails and the control stays hidden.
    void fetch('/auth/me', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<HostedIdentity>) : undefined))
      .then((i) => live && i !== undefined && setMe(i))
      .catch(() => undefined);
    // Does this origin also serve a WORKBENCH (/app on the one-origin deploy)? Then Fork can
    // open there instead of downloading a file the person must re-import by hand.
    void fetch('/app/health')
      .then((r) => (r.ok ? r.json() : undefined))
      .then((j: { ok?: boolean } | undefined) => {
        if (live && j?.ok === true) setWorkbenchHere(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (inline !== undefined || trackId === undefined) return; // static export: the bundle came baked in
    fetch(`/t/${encodeURIComponent(trackId)}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Bundle>) : Promise.reject(new Error(r.status === 404 ? 'This track is not published.' : `server error (${r.status})`))))
      .then(setBundle)
      .catch((e: Error) => setError(e.message));
  }, [trackId, inline]);

  const view = useMemo(() => {
    if (!bundle) return undefined;
    let p = bundle.payload;
    const memberSources = new Set(p.sources.map((s) => s.id));
    const readingOrder = levels(
      p.edges
        .filter((e) => e.type === 'INCLUDES' && e.dstType === 'source')
        .map((e) => e.dstId)
        .filter((id) => memberSources.has(id)),
      p.edges.filter((e) => e.type === 'PRECEDES').map((e) => ({ src: e.srcId, dst: e.dstId })),
    );
    const sourceById = new Map(p.sources.map((s) => [s.id, s]));
    const questionById = new Map(p.questions.map((q) => [q.id, q]));
    const snippetsBySource = new Map<string, Bundle['payload']['snippets']>();
    for (const s of p.snippets) snippetsBySource.set(s.sourceId, [...(snippetsBySource.get(s.sourceId) ?? []), s]);
    // A passage's owner is a FIELD in the bundle, not an edge — so the map drew passages with
    // nothing attaching them and the scope rule could not reach one.
    // Synthesised ONCE here, into the payload every consumer reads, rather than twice at the
    // two places that need it.
    p = {
      ...p,
      edges: [
        ...p.edges,
        ...p.snippets.map((sn) => ({ srcId: sn.id, srcType: 'snippet', dstId: sn.sourceId, dstType: 'source', type: 'SNIPPET_OF', tags: [] })),
      ],
    };
    const questionTies = new Map<string, { id: string; word: 'raises' | 'answers'; text: string }[]>();
    for (const e of p.edges) {
      if ((e.type === 'RAISES' || e.type === 'ANSWERS') && e.dstType === 'question') {
        const q = questionById.get(e.dstId);
        if (!q) continue;
        questionTies.set(e.srcId, [
          ...(questionTies.get(e.srcId) ?? []),
          { id: q.id, word: e.type === 'RAISES' ? 'raises' : 'answers', text: q.text },
        ]);
      }
    }
    const conceptName = new Map(p.concepts.map((c) => [c.id, c.name]));
    // Per-source open-question count (matching the workbench's
    // source-row glyphs): RAISES ties — from the source or its snippets — to questions no
    // ANSWERS edge has closed.
    const answeredIds = new Set(p.edges.filter((e) => e.type === 'ANSWERS').map((e) => e.dstId));
    const snippetOwner = new Map(p.snippets.map((sn) => [sn.id, sn.sourceId]));
    const openBySource = new Map<string, number>();
    for (const e of p.edges) {
      if (e.type !== 'RAISES' || answeredIds.has(e.dstId) || !questionById.has(e.dstId)) continue;
      const owner = snippetOwner.get(e.srcId) ?? (sourceById.has(e.srcId) ? e.srcId : undefined);
      if (owner !== undefined) openBySource.set(owner, (openBySource.get(owner) ?? 0) + 1);
    }
    const conceptsBySource = new Map<string, string[]>();
    for (const e of p.edges) {
      if (e.type === 'ABOUT' && e.dstType === 'concept') {
        const name = conceptName.get(e.dstId);
        if (name !== undefined) conceptsBySource.set(e.srcId, [...(conceptsBySource.get(e.srcId) ?? []), name]);
      }
    }
    // ONE derivation for every surface: the page adapts the bundle into the
    // outline contract and renders whatever comes back — grouped or flat. It computes no
    // structure of its own, which is what kept drifting from the workbench.
    const outline = trackOutline(outlineFromBundle({ ...p, memberOrder: readingOrder.flat() }));
    return { p, readingOrder, sourceById, snippetsBySource, questionTies, conceptsBySource, openBySource, outline };
  }, [bundle]);

  // The tabs' shared plumbing: membership + my pending mail (member-gated forms), and the
  // ask page's old question — which concepts have no member reading explaining them. These
  // hooks live ABOVE the loading/error returns (Rules of Hooks) and tolerate an absent bundle.
  const pubCommunity = usePubCommunity(bundle?.publication.trackId ?? '', me?.signedIn === true);
  const hungryConcepts = useMemo(() => {
    if (view === undefined) return new Set<string>();
    const direct = new Set(
      view.p.edges.filter((e) => e.type === 'ABOUT' && e.dstType === 'concept' && view.sourceById.has(e.srcId)).map((e) => e.dstId),
    );
    // Coverage bubbles UP the lattice: a concept whose SUB-concepts have
    // sources is covered through them — "Algebra for Logic" with three Boolean-algebra texts
    // under it is not a gap. children[c] = concepts that list c as a prerequisite; fixpoint
    // because chains can be deep.
    const children = new Map<string, string[]>();
    for (const e of view.p.edges) {
      if (e.type === 'PREREQUISITE_OF' && e.dstType === 'concept') children.set(e.srcId, [...(children.get(e.srcId) ?? []), e.dstId]);
    }
    const covered = new Set(direct);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of view.p.concepts) {
        if (covered.has(c.id)) continue;
        if ((children.get(c.id) ?? []).some((k) => covered.has(k))) {
          covered.add(c.id);
          grew = true;
        }
      }
    }
    // The explicit REQUEST FOR HELP outranks the structural answer both ways: a tagged concept
    // is flagged even when covered (the author is asking for more), and only truly bare,
    // untagged concepts are flagged structurally.
    const tagged = new Set(view.p.concepts.filter((c) => c.tags.some((t) => t.name === 'NeedsSources')).map((c) => c.id));
    return new Set(view.p.concepts.filter((c) => tagged.has(c.id) || !covered.has(c.id)).map((c) => c.id));
  }, [view]);
  // Membership/follow state keys on the RESOLVED id: on registry pages the bundle arrives
  // INLINED and the trackId prop is undefined — gating on the prop is why the follow pill
  // never rendered there (the fixture tested the .json path and
  // missed exactly the production mount).
  useEffect(() => {
    const id = bundle?.publication.trackId;
    if (id === undefined) return;
    let live = true;
    void communityOf(id).then((v) => live && setCommunity_(v));
    return () => {
      live = false;
    };
  }, [bundle]);

  // Answered-ness lives in the EDGES (an ANSWERS edge lands on the question) — the bundle's
  // question rows carry no flag, so both tabs derive it here once.
  const answeredQs = useMemo(
    () => new Set(view === undefined ? [] : view.p.edges.filter((e) => e.type === 'ANSWERS' && e.dstType === 'question').map((e) => e.dstId)),
    [view],
  );
  // What each QUESTION hangs on — the inverse of view.questionTies (which keys by source).
  const tiesOfQuestion = useMemo(() => {
    const out = new Map<string, { label: string }[]>();
    if (view === undefined) return out;
    for (const e of view.p.edges) {
      if ((e.type === 'RAISES' || e.type === 'ANSWERS') && e.dstType === 'question') {
        const label = view.sourceById.get(e.srcId)?.title;
        if (label !== undefined) out.set(e.dstId, [...(out.get(e.dstId) ?? []), { label }]);
      }
    }
    return out;
  }, [view]);



  if (error !== undefined) {
    return (
      <div className="pub">
        <div className="pub-doc">
          <p className="pub-missing">{error}</p>
        </div>
      </div>
    );
  }
  if (!bundle || !view) {
    return (
      <div className="pub">
        <div className="pub-doc">
          <p className="pub-missing">Loading…</p>
        </div>
      </div>
    );
  }

  const { publication } = bundle;
  const track = view.p.tracks[0];
  const date = new Date(publication.publishedAt).toISOString().slice(0, 10);

  // What the reader last clicked in the tree; the map narrows to it using
  // the SAME rule the workbench map uses on double-click. Clicking it again clears.
  const conceptIdByName = new Map(view.p.concepts.map((c) => [c.name, c.id]));
  const scopeIds =
    focusId === undefined
      ? undefined
      : scopeOf(
          focusId,
          view.p.edges.map((e) => ({
            srcId: e.srcId,
            dstId: e.dstId,
            type: e.type,
            tags: (e.tags ?? []).map((t) => `#${t.name}${t.subtype !== undefined ? `:${t.subtype}` : ''}`),
          })),
        );
  const focus = (id: string): void => setFocusId((cur) => (cur === id ? undefined : id));
  /** A concept chip that narrows the map to that concept. */
  const conceptChip = (name: string) => {
    const id = conceptIdByName.get(name);
    return id === undefined ? (
      <span key={name} className="outline-cchip">{name}</span>
    ) : (
      <button key={name} type="button" className={`outline-cchip tapped${focusId === id ? ' on' : ''}`} onClick={() => focus(id)}>
        {name}
      </button>
    );
  };

  /** What an expanded graph box shows: the source card's substance, inline — meta,
   *  the link, its passages, the questions it opens, and the concepts it is about. */
  const sourceDetail = (id: string): ReactNode => {
    const src = view.sourceById.get(id);
    if (!src) return null;
    const concepts = view.conceptsBySource.get(id) ?? [];
    // Author and tags only: the modality word is what the ICON already
    // says, the open link is what clicking the card already does, and questions and passages
    // hang off the source on their own connectors rather than crowding it.
    const meta = [
      ...(src.author !== undefined ? [src.author] : []),
      ...(src.estimatedDurationMins !== undefined ? [`~${src.estimatedDurationMins} min`] : []),
      ...src.tags.map(tagLabel),
    ].join(' · ');
    if (meta === '' && concepts.length === 0) return null;
    return (
      <div className="pub-graph-detail">
        {meta !== '' && <div className="pub-src-meta">{meta}</div>}
        {concepts.length > 0 && <div className="pub-chips">{concepts.map(conceptChip)}</div>}
      </div>
    );
  };

  // A handle, not the text: question and passage labels run to sentences (and sometimes maths),
  // and the chip is one line.
  const focusName = ((): string | undefined => {
    if (focusId === undefined) return undefined;
    const raw =
      view.p.concepts.find((c) => c.id === focusId)?.name ??
      view.p.sources.find((x) => x.id === focusId)?.title ??
      view.p.tracks.find((t) => t.id === focusId)?.title ??
      view.p.questions.find((q) => q.id === focusId)?.text ??
      view.p.snippets.find((x) => x.id === focusId)?.text;
    if (raw === undefined) return undefined;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    return oneLine.length > 46 ? `${oneLine.slice(0, 46)}…` : oneLine;
  })();

  // The TRACK box carries the track itself: its goal, every concept it
  // covers as a chip that narrows the map, and what the track holds in total.
  const trackConceptNames = view.p.edges
    .filter((e) => e.type === 'INCLUDES' && e.dstType === 'concept' && e.srcId === track?.id)
    .flatMap((e) => {
      const c = view.p.concepts.find((x) => x.id === e.dstId);
      return c === undefined ? [] : [c.name];
    });
  const trackDetail: ReactNode = (
    <div className="pub-graph-detail">
      {track?.goal !== undefined && <div className="pub-src-meta">{track.goal}</div>}
      {trackConceptNames.length > 0 && <div className="pub-chips">{trackConceptNames.map(conceptChip)}</div>}
      <div className="pub-chips">
        <span className="rail-count q" title={`${view.p.questions.length} question${view.p.questions.length === 1 ? '' : 's'}`}>
          <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={13} /></span> {view.p.questions.length}
        </span>
        <span className="rail-count s" title={`${view.p.snippets.length} passage${view.p.snippets.length === 1 ? '' : 's'}`}>
          <span style={{ color: 'var(--k-snippet)' }}><Icon name="snippet" size={13} /></span> {view.p.snippets.length}
        </span>
      </div>
    </div>
  );

  const { groups, order: displayOrder, groupOf, numberOf } = view.outline;
  // Questions and passages hang OFF their source; a question raised by a PASSAGE attaches to
  // that passage's source, so nothing is orphaned.
  const attachments: Record<string, { id: string; kind: 'question' | 'snippet'; node: ReactNode }[]> = {};
  for (const [sid, snips] of view.snippetsBySource) {
    for (const sn of snips) {
      (attachments[sid] ??= []).push({ id: sn.id, kind: 'snippet', node: <SnippetText text={sn.text} images="link" /> });
    }
  }
  for (const sid of displayOrder) {
    const snippetIds = new Set((view.snippetsBySource.get(sid) ?? []).map((sn) => sn.id));
    const own = [...(view.questionTies.get(sid) ?? []), ...[...snippetIds].flatMap((snid) => view.questionTies.get(snid) ?? [])];
    for (const [i, tie] of own.entries()) {
      if (tie.word !== 'raises') continue;
      void i;
      (attachments[sid] ??= []).push({ id: tie.id, kind: 'question', node: tie.text });
    }
  }
  const graphRows: TrackGraphRow[] = displayOrder.flatMap((id) => {
    const src = view.sourceById.get(id);
    return src === undefined
      ? []
      : [{
          id,
          title: src.title,
          ...(src.author !== undefined ? { author: src.author } : {}),
          modality: src.modality,
          ...(src.directUrl !== undefined ? { url: src.directUrl } : {}),
        }];
  });

  // Serialized from the PAGE'S OWN loaded bundle (not a URL), so forking works identically on
  // server pages, the registry, and the static single-file export. parse→stringify preserves
  // key order, so the payload hash still verifies. One handler, two buttons (
  // — a fork affordance at the TOP as well as the foot).
  const fork = (): void => {
    // Where this origin serves a workbench (the one-origin deploy), forking IS one click: hand
    // the trackId to the workbench, which imports it and opens it. The
    // download remains the path everywhere else — a static export, someone else's server — and
    // remains what "fork" durably means: the bundle is yours as a file.
    if (workbenchHere) {
      window.location.href = `/app#fork=${encodeURIComponent(publication.trackId)}`;
      return;
    }
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${publication.trackId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const FORK_TITLE = workbenchHere
    ? 'make this track yours — it opens in your workbench, lineage travels with it'
    : "download this track's bundle — import it into your own Philomatic to make it yours (lineage travels with it)";

  return (
    <div className="pub">
      {/* The page's own chrome: what this is, the way back, and the way to
          take it — one bar across the whole page, above everything, frozen with the title. */}
      <div className="pub-frozen" ref={headRef}>
        <div className="pub-toolbar">
          {/* The name of the thing serving the page, in the corner every site puts it (05) — the same mark and wording as the ask page, so a stranger arriving at
              either one lands somewhere that looks like the same place. What KIND of page this
              is now rides on the track badge beside the title, where the title explains it. */}
          {/* The brand IS the way home — the corner mark links to the
              registry when this origin serves one, as every site's logo does; the separate
              "browse the registry" link said the same thing twice. Elsewhere it stays a mark. */}
          {registry !== undefined ? (
            <a className="pub-brand" href="/" title={`browse the other tracks on ${registry}`}>
              <Path size={17} /> Philomatic
            </a>
          ) : (
            <span className="pub-brand"><Path size={17} /> Philomatic</span>
          )}
          <span className="pub-corner">
          {/* FOLLOW: hear when this track moves — an inbox item in
              your workbench. Members follow by default on join; this is the way in for everyone
              else, and the way out for anyone. Signed-in only; the server enforces visibility. */}
          {me?.signedIn === true && community !== undefined && (
            <button
              className={community.following === true ? 'pub-follow on' : 'pub-follow'}
              title={community.following === true ? 'stop hearing about updates to this track' : 'get an inbox item when this track changes'}
              onClick={() => {
                void setFollow(publication.trackId, { follow: community.following !== true })
                  .then((r) => setCommunity_({ ...community, following: r.following }))
                  .catch(() => undefined);
              }}
            >
              {community.following === true ? '✓ Following' : 'Follow'}
            </button>
          )}
          <button className="pub-fork top" title={FORK_TITLE} onClick={fork}>
            <GitBranch size={14} /> Fork
          </button>
          {/* WHO you are, top right, same control as everywhere: sign in —
              returning here — or your initial, linking to the account page. Only where the origin
              answers /auth/me with providers on offer. */}
          {me !== undefined && <span className="pub-me"><AccountControl identity={me} /></span>}
          </span>
        </div>
        <div className="pub-titlebar">
          <h1 className="pub-stucktitle">{publication.title}</h1>
        </div>
        {registry !== undefined && (
          <div className="pub-tabs">
            <button type="button" className={tab === 'track' ? 'pub-tab on' : 'pub-tab'} onClick={() => setTab('track')}>
              <span style={{ color: 'var(--k-track)' }}><Icon name="track" size={14} /></span> Track
            </button>
            <button type="button" className={tab === 'contributions' ? 'pub-tab on' : 'pub-tab'} onClick={() => setTab('contributions')}>
              <span style={{ color: 'var(--k-source)' }}><ContributeIcon size={15} /></span> Contributions
            </button>
            <button type="button" className={tab === 'questions' ? 'pub-tab on' : 'pub-tab'} onClick={() => setTab('questions')}>
              <span style={{ color: 'var(--k-question)' }}><Icon name="question" size={14} /></span> Questions
              {view.p.questions.length > 0 ? ` · ${view.p.questions.length}` : ''}
            </button>
          </div>
        )}
      </div>
      <div className="pub-doc">

        {/* No section heading here: the track IS the page, so a "Track"
            title with a fold control was a wrapper around the whole content. Just the view
            toggle, then the view. */}
        <div className="pub-track" style={tab === 'track' ? undefined : { display: 'none' }}>
          {/* One view: the graph IS the page. The list said the same thing
              with less structure, and a toggle between them was a choice with one answer. */}
          <>
              {/* The map leads the graph: the shape first, then the tree —
                  and the legend leads the map, kinds AND relations, from the shared list. */}
              {/* On a wide enough screen these two halves sit SIDE BY SIDE — the track's
                  description and its map on the left, the reading itself on the right (04). Narrower, they stack in this same order, which is exactly the
                  single-column page: the split is a grid the stylesheet turns on, not a second
                  layout to keep in step. */}
              <div className="pub-aside">
              {/* Description and byline sit directly under the title and SCROLL — they are read
                  once, so freezing them would spend the top of every screen on them (04). The map freezes below them, at the frozen header's height. */}
              {track?.goal !== undefined && <p className="pub-goal">{track.goal}</p>}
              <div className="pub-meta">
                {publication.author !== undefined && <span>by {publication.author}</span>}
                <span>published {date}</span>
                <span className="pub-license">{publication.license}</span>
                {/* The byline reads the MANIFEST, not the track's opt-in field alone —
                    a bundle that ships logic-lenses tags says so. */}
                {(() => {
                  const names = [...new Set([track?.framework ?? 'philomatic-core', ...(view.p.frameworks ?? []).map((f) => f.name)])];
                  return <span>framework{names.length > 1 ? 's' : ''}: {names.join(' + ')}</span>;
                })()}
                {publication.authorKey !== undefined && (
                  <span className="pub-signed" title={publication.authorKey}>
                    ✓ signed · {publication.authorKey.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="pub-mapstick">
                <MapLegend items={[...kindLegend(['track', 'concept', 'source', 'question', 'snippet']), ...RELATION_LEGEND]} />
                <TrackMap payload={view.p} {...(scopeIds !== undefined ? { scopeIds } : {})} />
                {focusId !== undefined && (
                  <div className="pub-mapscope">
                    <span>
                      map narrowed to <strong>{focusName ?? 'this'}</strong>
                    </span>
                    <button type="button" onClick={() => setFocusId(undefined)}>
                      show the whole track
                    </button>
                  </div>
                )}
              </div>
              </div>
              <div className="pub-main">
            <TrackGraph
              trackTitle={publication.title}
              rows={graphRows}
              size="roomy"
              concepts={groups.flatMap((g) => {
                const c = view.p.concepts.find((x) => x.id === g.conceptId);
                return c === undefined ? [] : [c];
              }).map((c) => ({
                id: c.id,
                name: c.name,
                ...(c.description !== undefined ? { description: c.description } : {}),
                // The published REQUEST FOR HELP. It was hardcoded false
                // because nobody had wired it, not because the flag was unwanted — and once the
                // track and contributions pages unify, a registry serving this page has
                // no live engine to ask. The bundle carries it; the page reads it.
                flagged: c.tags.some((t) => t.name === 'NeedsSources'),
                have: new Set(
                  view.p.edges.filter((e) => e.type === 'ABOUT' && e.dstType === 'concept' && e.dstId === c.id).map((e) => e.srcId),
                ).size,
              }))}
              questions={[]}
              edges={view.p.edges}
              renderDetail={(r) => sourceDetail(r.id)}
              groupOf={groupOf}
              attachments={attachments}
              alwaysExpanded
              numberOf={numberOf}
              blocks={view.outline.blocks}
              trackDetail={trackDetail}
              {...(track !== undefined ? { trackId: track.id } : {})}
              {...(focusId !== undefined ? { focusId } : {})}
              onFocus={focus}
            />
              </div>
            </>
        </div>

        {tab === 'contributions' && (
          <ContributeView
            title={publication.title}
            {...(track?.goal !== undefined ? { goal: track.goal } : {})}
            payload={view.p}
            flagged={view.p.concepts
              .filter((c) => hungryConcepts.has(c.id))
              .map((c) => ({ id: c.id, name: c.name, ...(c.description !== undefined ? { description: c.description } : {}), have: 0 }))}
            open={view.p.questions.filter((q) => !answeredQs.has(q.id)).map((q) => ({ id: q.id, text: q.text }))}
            inTrack={view.p.sources.map((s) => ({
              id: s.id,
              title: s.title,
              ...(s.author !== undefined ? { author: s.author } : {}),
              ...(s.modality !== undefined ? { modality: s.modality } : {}),
              ...(s.directUrl !== undefined ? { url: s.directUrl } : {}),
            }))}
            member={pubCommunity.member}
            who={me?.account?.username ?? 'you'}
            pending={pubCommunity.mine}
            send={pubCommunity.send}
          />
        )}
        {tab === 'questions' && (
          <QuestionsTab
            trackId={publication.trackId}
            member={pubCommunity.member}
            mine={pubCommunity.mine}
            send={pubCommunity.send}
            questions={view.p.questions.map((q) => ({ id: q.id, text: q.text, answered: answeredQs.has(q.id) }))}
            ties={(qid) => tiesOfQuestion.get(qid) ?? []}
            about={[
              ...view.p.sources.map((x) => ({ id: x.id, title: x.title, kind: 'source' as const })),
              ...view.p.concepts.map((c) => ({ id: c.id, title: c.name, kind: 'concept' as const })),
            ]}
          />
        )}
        <footer className="pub-foot">
          <span>
            Published with <a href="https://github.com/philomatic-io/philomatic" rel="noreferrer">Philomatic</a> · licensed{' '}
            {publication.license} · fork = download the bundle, then Import it into your own Philomatic
          </span>
        </footer>
      </div>
    </div>
  );
}
