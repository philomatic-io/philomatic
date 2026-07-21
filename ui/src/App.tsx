/**
 * Philomatic workbench (redesign) — a three-pane library (Browse rail / unified cross-kind
 * list / persistent detail) with a force-directed Map tab, served by the self-hosted ingest
 * server and speaking its HTTP read/write contract through the one EngineClient (the
 * chrome.runtime twin retired with the self-contained shell — self-serve plan T2).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Books, DownloadSimple, Export, GitBranch, GraphIcon, GithubLogo, PathIcon } from '@phosphor-icons/react';
import { httpClient, onEngineChange, type EngineClient } from './client/transport';
import type { AssembleResult, GraphEnvelope, QuestionView, Snapshot } from './client/types';
import { allConcepts, allTags, buildItems, filterItems, railCounts, type Item, type ItemKind } from './lib/items';
import { Rail } from './views/Rail';
import { ItemList } from './views/ItemList';
import { Detail } from './views/Detail';
import { DraftForm } from './views/DraftForm';
import { ConceptDetail } from './views/ConceptDetail';
import { MapView } from './views/MapView';
import { GraphView } from './views/GraphView';
import { Journey } from './views/Journey';
import { Resizer } from './components/Resizer';

// Demo mode (2026-07-19): the demo entry injects an in-browser client + change source before
// rendering; the normal entry gets the HTTP transport. One workbench, two engines.
const g = globalThis as { __PM_CLIENT__?: EngineClient; __PM_SUBSCRIBE__?: (cb: () => void) => () => void; __PM_DEMO__?: boolean };
const client: EngineClient = g.__PM_CLIENT__ ?? httpClient();
const subscribeChanges = g.__PM_SUBSCRIBE__ ?? onEngineChange;
const IS_DEMO = g.__PM_DEMO__ === true;
type Tab = 'Library' | 'Journey' | 'Map' | 'Graph';

/** `#map=<comma ids>` — the note-embed scope (obsidian /pm-embed-map). */
const parseMapHash = (hash: string): string[] | undefined => {
  const m = /[#&]map=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]!).split(',').filter(Boolean) : undefined;
};
/** `&embed` — chromeless single-view mode for iframes hosted inside other apps. */
const isEmbed = /[#&]embed\b/.test(window.location.hash);
const clampW = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const storedW = (key: string, fallback: number) => Number(localStorage.getItem(key)) || fallback;

export function App() {
  const [tab, setTab] = useState<Tab>(() => (parseMapHash(window.location.hash) ? 'Map' : 'Library'));
  const [mapIdFilter, setMapIdFilter] = useState<string[] | undefined>(() => parseMapHash(window.location.hash));
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [conceptList, setConceptList] = useState<{ id: string; name: string; tracked: boolean; tags: string[] }[]>([]);
  // The shared projection (debt/read-contract): assemble + graph fetched ONCE per change and
  // threaded down — TrackBody, NextReading, and Journey's lens used to fetch these
  // independently on every epoch (N components × 2 requests per keystroke).
  const [projection, setProjection] = useState<{ asm: AssembleResult; graph: GraphEnvelope } | undefined>();
  const [error, setError] = useState<string | undefined>();

  const [kind, setKind] = useState<ItemKind | 'all'>('all');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());
  // Standing tag exclusions ("hide my #reference shelf") — persisted, unlike the include facet.
  const [excludedTags, setExcludedTags] = useState<ReadonlySet<string>>(
    () => new Set(JSON.parse(localStorage.getItem('pm.excludedTags') ?? '[]') as string[]),
  );
  // Read-state filter (owner rework, 2026-07-18): all / unread / read — derived, session-local.
  const [readState, setReadState] = useState<'all' | 'unread' | 'read'>('all');
  // Kind sub-facets (rail rework, 2026-07-18): source type / question state.
  const [modality, setModality] = useState('');
  const [qstate, setQstate] = useState<'' | 'open' | 'answered'>('');
  useEffect(() => localStorage.setItem('pm.excludedTags', JSON.stringify([...excludedTags])), [excludedTags]);
  const [selectedConcepts, setSelectedConcepts] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  // A freshly created entity: the detail opens its title editor for immediate naming.
  const [justCreatedId, setJustCreatedId] = useState<string | undefined>();
  // A create FORM for identity-named kinds (concept/question/snippet) — their name/text can't
  // be renamed after creation, so they're typed in a draft form rather than created-then-named.
  const [draftKind, setDraftKind] = useState<'concept' | 'question' | 'snippet' | undefined>();

  const [toast, setToast] = useState<{ message: string; undoRef?: string } | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Resizable pane widths (persisted); the centre pane flexes between them.
  const [railW, setRailW] = useState(() => storedW('pm.railW', 220));
  const [detailW, setDetailW] = useState(() => storedW('pm.detailW', 380));
  useEffect(() => localStorage.setItem('pm.railW', String(railW)), [railW]);
  useEffect(() => localStorage.setItem('pm.detailW', String(detailW)), [detailW]);

  // Data epoch: bumped on every successful refresh so views that fetch their own projections
  // (Map's graph, the details' relations) know to refetch — snapshot/questions props don't
  // cover those.
  const [epoch, bumpEpoch] = useReducer((n: number) => n + 1, 0);

  const refresh = useCallback(async () => {
    try {
      const [snap, qs, asm, graph] = await Promise.all([client.getSnapshot(), client.getQuestions(), client.getAssemble(), client.getGraph()]);
      setSnapshot(snap);
      setQuestions(qs.questions);
      setProjection({ asm, graph });
      // Every concept + whether the learner follows it (assemble's `following`) — for Journey's
      // tracked-concepts header. Global assemble includes all concepts.
      setConceptList(asm.levels.flat().map((c) => ({ id: c.id, name: c.name, tracked: c.following, tags: c.tags ?? [] })).sort((a, b) => a.name.localeCompare(b.name)));
      setError(undefined);
      bumpEpoch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates (self-serve plan T3): the server's SSE change feed fires on every successful
  // write — a popup or context-menu capture (or another tab) refreshes every view. Debounced:
  // one popup save is several writes (source, snippet, ask).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeChanges(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [refresh]);

  // The undo stack (owner request, 2026-07-18): every UI edit pushes its INVERSE; Ctrl+Z pops
  // and runs it. Client-side and session-local by design — the engine's own history primitives
  // (retraction, re-assertion) are the inverses, so undo is just "do the opposite op".
  const undoStack = useRef<{ label: string; invert: () => Promise<unknown> }[]>([]);
  const pushUndo = useCallback((label: string, invert: () => Promise<unknown>) => {
    undoStack.current.push({ label, invert });
    if (undoStack.current.length > 50) undoStack.current.shift();
  }, []);

  const notify = useCallback((message: string, undoRef?: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, undoRef });
    toastTimer.current = setTimeout(() => setToast(undefined), undoRef ? 8000 : 3000);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      const top = undoStack.current.pop();
      if (!top) {
        notify('Nothing to undo');
        return;
      }
      void top
        .invert()
        .then(() => refresh())
        .then(() => notify(`Undid: ${top.label}`))
        .catch((err) => notify(err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undo = async (ref: string) => {
    try {
      await client.restore(ref);
      await refresh();
      notify('Restored ✓');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // Create-in-detail (owner request, 2026-07-20): mint a placeholder entity, select it, and
  // flag it so the detail opens its title editor with the placeholder selected.
  const DRAFT_LABEL: Record<'track' | 'source', string> = { track: 'New track', source: 'New source' };
  const createDraft = async (k: 'track' | 'source') => {
    // An EXPLICIT unique id (owner bug): a title-derived id ('New track' → syl_new-track)
    // upserts onto ANY existing entity of that name — including a RETRACTED one hidden from
    // the live snapshot — so the create silently no-ops. A random draft id can't collide;
    // renaming mints the proper slug id. The title is also uniquified for display clarity.
    const rand = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const id = k === 'track' ? `syl_draft-${rand}` : `src_draft-${rand}`;
    const taken = new Set((k === 'track' ? snapshot?.tracks : snapshot?.sources)?.map((x) => x.title) ?? []);
    let title = DRAFT_LABEL[k];
    for (let n = 2; taken.has(title); n++) title = `${DRAFT_LABEL[k]} ${n}`;
    try {
      if (k === 'track') await client.importPayload({ version: 2, tracks: [{ id, title }] });
      else await client.importPayload({ version: 2, sources: [{ id, title, modality: 'text' }] });
      await refresh();
      setSelectedId(id);
      setJustCreatedId(id);
      pushUndo(`create ${k} “${title}”`, () => client.remove(id));
      notify(`Created ${k} “${title}”`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // '+ New <kind>' dispatch: mutable-name kinds (track/source) create-then-name a blank entity
  // in the detail; identity-named kinds (concept/question/snippet) open a form there instead,
  // since their name/text IS their id and can't be renamed after creation (owner req 2026-07-20).
  const startNew = (k: 'concept' | 'track' | 'source' | 'question' | 'snippet') => {
    if (k === 'track' || k === 'source') void createDraft(k);
    else {
      setSelectedId(undefined);
      setDraftKind(k);
    }
  };

  const items = useMemo(() => (snapshot ? buildItems(snapshot, questions, conceptList) : []), [snapshot, questions, conceptList]);
  const counts = useMemo(() => railCounts(items), [items]);
  // Facet chips scope to the current kind/backlog/sub-facet (owner request, 2026-07-18):
  // browsing Tracks shows only tags/concepts that appear ON tracks, and so on.
  const facetScope = useMemo(
    () => filterItems(items, { kind, tags: new Set(), concepts: new Set(), query: '', excludedTags, readState, modality, question: qstate }),
    [items, kind, excludedTags, readState, modality, qstate],
  );
  const tags = useMemo(() => {
    const visible = allTags(facetScope);
    // Excluded tags are persisted standing state — the chip must stay in the rail (struck
    // out) even when every item carrying it is hidden or outside the kind facet, or the
    // exclusion becomes un-undoable from where you stand (owner report, 2026-07-19).
    const missing = [...excludedTags].filter((t) => !visible.includes(t)).sort();
    return [...visible, ...missing];
  }, [facetScope, excludedTags]);
  const concepts = useMemo(() => allConcepts(facetScope), [facetScope]);
  const modalityCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of items) if (i.kind === 'source' && i.modality) c[i.modality] = (c[i.modality] ?? 0) + 1;
    return c;
  }, [items]);
  const questionCounts = useMemo(() => {
    let open = 0, answered = 0;
    for (const i of items) if (i.kind === 'question') (i.answered ? answered++ : open++);
    return { open, answered };
  }, [items]);
  const filtered = useMemo(
    () => filterItems(items, { kind, tags: selectedTags, concepts: selectedConcepts, query, excludedTags, readState, modality, question: qstate }),
    [items, kind, selectedTags, selectedConcepts, query, excludedTags, readState, modality, qstate],
  );
  const selected = useMemo(() => items.find((i) => i.id === selectedId), [items, selectedId]);
  useEffect(() => {
    if (justCreatedId !== undefined && selectedId !== justCreatedId) setJustCreatedId(undefined);
  }, [selectedId, justCreatedId]);
  // Selecting any item dismisses an open draft form (the detail slot shows the selection).
  useEffect(() => {
    if (selectedId !== undefined) setDraftKind(undefined);
  }, [selectedId]);
  const selectedConceptNode = useMemo(() => conceptList.find((c) => c.id === selectedId), [conceptList, selectedId]);

  // "View in map" focus signal (id + nonce) so the Map re-centres even on the same node.
  const [mapFocus, setMapFocus] = useState<{ id: string; nonce: number } | undefined>();

  // Deep links (obsidian plan OB-S2): `#item=<id>` selects the entity — what an embedded
  // `pm:` chip in a note links to. Read-only: applied on load and on hash changes; the detail
  // pane renders any selectable kind (concepts included) on whatever tab is active.
  useEffect(() => {
    const applyHash = (): void => {
      const match = /[#&]item=([^&]+)/.exec(window.location.hash);
      if (match) setSelectedId(decodeURIComponent(match[1]!));
      const ids = parseMapHash(window.location.hash);
      setMapIdFilter(ids);
      if (ids) setTab('Map');
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // Keep a selection alive: default to the first filtered item; clear only if it's neither an
  // item NOR a concept node (concepts are selectable from the Map even though they aren't listed).
  // Never judge before data arrives — a deep-linked selection must survive the loading gap.
  useEffect(() => {
    if (!snapshot) return;
    const valid = selectedId && (items.some((i) => i.id === selectedId) || conceptList.some((c) => c.id === selectedId));
    if (selectedId && !valid) setSelectedId(undefined);
    // Don't auto-select while a draft form is open — startNew clears selectedId on purpose so
    // the detail slot shows the form; grabbing the first filtered item here would clobber it.
    else if (!selectedId && !draftKind && filtered.length > 0) setSelectedId(filtered[0]!.id);
  }, [snapshot, items, filtered, conceptList, selectedId, draftKind]);

  const navigate = (id: string) => setSelectedId(id);
  const viewInMap = (id: string) => {
    setSelectedId(id);
    setMapFocus({ id, nonce: Date.now() });
    setTab('Map');
  };

  const toggleIn = (set: ReadonlySet<string>, v: string): Set<string> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  // Tag chips cycle: off → include → EXCLUDE (standing, persisted) → off.
  const toggleTag = (t: string) => {
    if (selectedTags.has(t)) {
      setSelectedTags(toggleIn(selectedTags, t));
      setExcludedTags(new Set([...excludedTags, t]));
    } else if (excludedTags.has(t)) {
      setExcludedTags(new Set([...excludedTags].filter((x) => x !== t)));
    } else {
      setSelectedTags(toggleIn(selectedTags, t));
    }
  };
  const toggleConcept = (c: string) => setSelectedConcepts(toggleIn(selectedConcepts, c));

  // Share = the LIVE world (what you see — removed items stay out). The full backup, WITH the
  // retraction history a restore needs, stays at GET /export (curl / the CLI's export).
  const exportData = async () => {
    try {
      const payload = await client.exportLive();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `philomatic-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify('Exported your live library — removed items stay out (GET /export is the full backup)');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const importRef = useRef<HTMLInputElement>(null);
  const importData = async (file: File) => {
    try {
      const payload: unknown = JSON.parse(await file.text());
      await client.importPayload(payload); // sugared or canonical — the engine desugars + merges
      await refresh();
      notify('Imported ✓ — merged into your library');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const filterNote = [
    selectedConcepts.size > 0 ? `about ${[...selectedConcepts].join(', ')}` : '',
    selectedTags.size > 0 ? `tagged ${[...selectedTags].join(', ')}` : '',
    excludedTags.size > 0 ? `hiding ${[...excludedTags].join(', ')}` : '',
    query ? `“${query}”` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // Chromeless embed (an iframe inside Obsidian, /pm-embed-map): just the Map, scoped to the
  // note's referenced ids. All hooks above have run — this is a render fork, not a hook fork.
  if (isEmbed) {
    return (
      <div className="app embed" style={{ height: '100vh', display: 'flex' }}>
        <MapView
          client={client}
          epoch={epoch}
          idFilter={mapIdFilter ?? []}
          selectedTags={selectedTags}
          selectedConcepts={selectedConcepts}
          selectedId={selectedId}
          focus={mapFocus}
          onSelect={navigate}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {IS_DEMO && (
        <div className="demo-banner">
          <strong>Demo</strong>&nbsp;— everything you do here stays in this browser (it's the real engine, running locally).
          <button
            className="link-btn demo-reset"
            onClick={() => {
              localStorage.removeItem('pm.demo');
              location.reload();
            }}
          >
            Reset demo
          </button>
          <button
            className="link-btn demo-reset"
            title="start from an empty library (demo only — your own instance is never touched)"
            onClick={() => {
              localStorage.setItem('pm.demo', JSON.stringify({ version: 2 }));
              location.reload();
            }}
          >
            Clear library
          </button>
          <a href="https://github.com/philomatic-io/philomatic" rel="noreferrer">Run your own →</a>
        </div>
      )}
      <header className="topbar">
        <span className="brand">
          Library
          {snapshot && <span className="brand-sub">{counts.all} items · runs entirely in your browser</span>}
        </span>
        <span className="tabs">
          <button className={tab === 'Library' ? 'tab active' : 'tab'} onClick={() => setTab('Library')}>
            <Books size={15} /> Library
          </button>
          <button className={tab === 'Journey' ? 'tab active' : 'tab'} onClick={() => setTab('Journey')}>
            <PathIcon size={15} /> Journey
          </button>
          <button className={tab === 'Map' ? 'tab active' : 'tab'} onClick={() => setTab('Map')}>
            <GraphIcon size={15} /> Map
          </button>
          <button className={tab === 'Graph' ? 'tab active' : 'tab'} onClick={() => setTab('Graph')}>
            <GitBranch size={15} /> Graph
          </button>
        </span>
        <input className="search" placeholder="Search everything…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importData(file);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
        <button className="ghost-btn" onClick={() => importRef.current?.click()} title="load a Philomatic export or sugared JSON">
          <DownloadSimple size={15} /> Import
        </button>
        <button className="ghost-btn" onClick={() => void exportData()} title="download your whole graph as JSON">
          <Export size={15} /> Share
        </button>
        <a
          className="ghost-btn gh-link"
          href="https://github.com/philomatic-io/philomatic"
          target="_blank"
          rel="noreferrer"
          title="Philomatic on GitHub"
        >
          <GithubLogo size={15} weight="fill" /> GitHub
        </a>
      </header>

      {error && (
        <p className="error" role="alert">
          Can’t reach the engine: {error}. Is the local server running (pnpm serve)?
        </p>
      )}

      {!snapshot && !error && <p className="hint" style={{ padding: '1rem' }}>Loading…</p>}

      {snapshot && tab === 'Journey' && (
        <Journey
          projection={projection}
          snapshot={snapshot}
          questions={questions}
          concepts={conceptList}
          client={client}
          refresh={refresh}
          notify={(m) => notify(m)}
          onOpenInLibrary={(id) => {
            setSelectedId(id);
            setTab('Library');
          }}
        />
      )}

      {snapshot && tab !== 'Journey' && (
        <div
          className="workbench"
          style={{ '--rail-w': `${railW}px`, '--detail-w': `${detailW}px` } as React.CSSProperties}
        >
          <Rail
            counts={counts}
            tags={tags}
            concepts={concepts}
            kind={kind}
            readState={readState}
            selectedTags={selectedTags}
            excludedTags={excludedTags}
            selectedConcepts={selectedConcepts}
            onKind={(k) => {
              setModality('');
              setQstate('');
              setKind(k);
            }}
            onReadState={setReadState}
            modality={modality}
            modalityCounts={modalityCounts}
            onModality={setModality}
            qstate={qstate}
            questionCounts={questionCounts}
            onQstate={setQstate}
            onToggleTag={toggleTag}
            onToggleConcept={toggleConcept}
          />
          <Resizer onResize={(dx) => setRailW((w) => clampW(w + dx, 150, 420))} />

          {tab === 'Library' ? (
            <ItemList
              items={filtered}
              total={counts.all}
              filterNote={filterNote}
              selectedId={selectedId}
              onSelect={(i: Item) => setSelectedId(i.id)}
              // One '+ New <kind>' button for the current kind (owner req 2026-07-20). The 'all'
              // view shows none — a New button there has no single kind to mint (owner req 2026-07-21).
              newActions={(kind === 'track' || kind === 'source' || kind === 'concept' || kind === 'question' || kind === 'snippet'
                ? [{ kind, onClick: () => startNew(kind) }]
                : [])}
            />
          ) : tab === 'Graph' ? (
            <GraphView
              snapshot={snapshot}
              questions={questions}
              projection={projection}
              client={client}
              selectedTags={selectedTags}
              selectedConcepts={selectedConcepts}
              query={query}
              selectedId={selectedId}
              onSelect={navigate}
            />
          ) : (
            <MapView
              client={client}
              epoch={epoch}
              idFilter={mapIdFilter}
              kind={kind === 'all' ? 'all' : kind}
              selectedTags={selectedTags}
              excludedTags={excludedTags}
              selectedConcepts={selectedConcepts}
              selectedId={selectedId}
              focus={mapFocus}
              onSelect={navigate}
            />
          )}

          <Resizer onResize={(dx) => setDetailW((w) => clampW(w - dx, 280, 680))} />

          {selectedConceptNode ? (
            <ConceptDetail
              concept={selectedConceptNode}
              concepts={conceptList}
              snapshot={snapshot}
              client={client}
              epoch={epoch}
              refresh={refresh}
              notify={notify}
              pushUndo={pushUndo}
              onNavigate={navigate}
              onViewInMap={viewInMap}
            />
          ) : selected ? (
            <Detail
              projection={projection}
              justCreated={selectedId === justCreatedId}
              item={selected}
              snapshot={snapshot}
              questions={questions}
              concepts={conceptList}
              pushUndo={pushUndo}
              client={client}
              epoch={epoch}
              refresh={refresh}
              onNavigate={navigate}
              onViewInMap={viewInMap}
              notify={notify}
            />
          ) : draftKind ? (
            <DraftForm
              kind={draftKind}
              client={client}
              snapshot={snapshot}
              refresh={refresh}
              notify={notify}
              onCreated={(id) => {
                pushUndo(`create ${draftKind}`, () => client.remove(id));
                setDraftKind(undefined);
                setSelectedId(id);
              }}
              onCancel={() => setDraftKind(undefined)}
            />
          ) : (
            <div className="pane detail">
              <p className="hint">Select an item to see its details and connections.</p>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undoRef && (
            <button className="link" onClick={() => void undo(toast.undoRef!)}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
