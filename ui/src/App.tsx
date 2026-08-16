/**
 * Philomatic workbench (redesign) — a three-pane library (Browse rail / unified cross-kind
 * list / persistent detail) with a force-directed Map tab, served by the self-hosted ingest
 * server and speaking its HTTP read/write contract through the one EngineClient (the
 * chrome.runtime twin retired with the self-contained shell).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Books, DownloadSimple, Export, GearSix, GraphIcon, PathIcon, Tray } from '@phosphor-icons/react';
import { httpClient, onEngineChange, type EngineClient, type ProposeResult } from './client/transport';
import { createHostedLibrary, hostedIdentity, libraryLabel, markHostIntent, markMigrateIntent, migrateBrowserToHosted, signInHere, takeHostIntent, takeMigrateIntent, type HostedIdentity } from './lib/hosted';
import { AccountControl, SignInModal } from './components/AccountControl';
import { applyFrameworksView } from './lib/framework-registry';
import type { AssembleResult, GraphEnvelope, QuestionView, Snapshot } from './client/types';
import { allConcepts, allTags, buildItems, filterItems, railCounts, type Item, type ItemKind } from './lib/items';
import { Rail } from './views/Rail';
import { ItemList } from './views/ItemList';
import { InboxView } from './views/InboxView';
import { StartPanel } from './views/StartPanel';
import { communityMailCount, onCommunityMailCount, probeCommunityMail } from './views/CommunityInbox';
import { Detail } from './views/detail';
import { DraftForm } from './views/DraftForm';
import { ConceptDetail } from './views/ConceptDetail';
import { MapView } from './views/MapView';
import { Journey } from './views/journey';
import { Resizer } from './components/Resizer';
import { EngineProvider, type Engine } from './engine-context';
import { SettingsPanel } from './views/SettingsPanel';
import { currentBackend, hostedChosen, markHostedChosen, serverBase, serverToken, setBackend } from './lib/backend-pref';

// The browser backend injects an in-browser client + change source before
// rendering; the server backend gets the HTTP transport. One workbench, two engines.
const g = globalThis as { __PM_CLIENT__?: EngineClient; __PM_SUBSCRIBE__?: (cb: () => void) => () => void };
// Resolved on FIRST USE, never at module scope. The in-browser engine publishes its
// client during boot, and this module must not have already decided the answer by then — a
// module-scope `??` did, silently, the moment bundling stopped deferring evaluation across a
// dynamic import. Lazy resolution makes the ordering irrelevant instead of load-bearing.
let resolved: EngineClient | undefined;
const client: EngineClient = new Proxy({} as EngineClient, {
  get(_t, prop) {
    resolved ??= g.__PM_CLIENT__ ?? httpClient(serverBase(), serverToken());
    const v = (resolved as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(resolved) : v;
  },
});
// Same hazard as `client`: decided on first use, not at module load.
// The change feed dials the SAME base as every other call: bare `onEngineChange` opens
// `/changes` at the origin ROOT, which on the one-origin deploy is the registry, not this app.
const subscribeChanges: typeof onEngineChange = (cb) => (g.__PM_SUBSCRIBE__ ?? ((c: () => void) => onEngineChange(c, serverBase())))(cb);
// Which engine is behind this app. The boot published a client iff it chose the
// in-browser engine, so the page itself is the evidence — no second source of truth to drift
// from the one the app is actually talking to.

type Tab = 'Library' | 'Inbox' | 'Journey' | 'Map';

/** `#map=<comma ids>` — the note-embed scope (obsidian /pm-embed-map). */
const parseMapHash = (hash: string): string[] | undefined => {
  const m = /[#&]map=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]!).split(',').filter(Boolean) : undefined;
};
/** `&embed` — chromeless single-view mode for iframes hosted inside other apps. */
const isEmbed = /[#&]embed\b/.test(window.location.hash);
// `#fork=<trackId>` — a public track page handing its track to THIS workbench ("click fork, it loads"). Stashed at boot so the intent survives the storage
// choice or a sign-in round trip, consumed once the engine is usable.
{
  const m = /[#&]fork=([^&]+)/.exec(window.location.hash);
  if (m !== null) {
    try {
      sessionStorage.setItem('pm.forkIntent', decodeURIComponent(m[1]!));
    } catch {
      /* storage denied — the hash simply does nothing */
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}
const clampW = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const storedW = (key: string, fallback: number) => Number(localStorage.getItem(key)) || fallback;

export function App() {
  const [tab, setTab] = useState<Tab>(() => (parseMapHash(window.location.hash) ? 'Map' : 'Library'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mapIdFilter, setMapIdFilter] = useState<string[] | undefined>(() => parseMapHash(window.location.hash));
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [conceptList, setConceptList] = useState<{ id: string; name: string; tracked: boolean; tags: string[]; staged: boolean }[]>([]);
  // The shared projection (debt/read-contract): assemble + graph fetched ONCE per change and
  // threaded down — TrackBody, NextReading, and Journey's lens used to fetch these
  // independently on every epoch (N components × 2 requests per keystroke).
  const [projection, setProjection] = useState<{ asm: AssembleResult; graph: GraphEnvelope } | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** Signed in, but no hosted library — the server answered 409 `needs: provision`. */
  const [identity, setIdentity] = useState<HostedIdentity | undefined>();
  const [creating, setCreating] = useState(false);
  // The public page's fork hand-off: once the engine answers (first snapshot), import the track
  // and open it. One shot — the intent is taken before the async work so a re-render cannot
  // run it twice.
  useEffect(() => {
    if (snapshot === undefined) return;
    let id: string | null = null;
    try {
      id = sessionStorage.getItem('pm.forkIntent');
      if (id !== null) sessionStorage.removeItem('pm.forkIntent');
    } catch {
      return;
    }
    if (id === null) return;
    void client
      .forkRegistryTrack(id)
      .then((r) => {
        const forked = r as { trackId?: string; title?: string };
        notify(`Forked “${forked.title ?? id}” ✓ — it's yours now`);
        if (forked.trackId !== undefined) setSelectedId(forked.trackId);
        setTab('Library');
        void refresh();
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot === undefined]);

  const [kind, setKind] = useState<ItemKind | 'all'>('all');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());
  // Standing tag exclusions ("hide my #reference shelf") — persisted, unlike the include facet.
  const [excludedTags, setExcludedTags] = useState<ReadonlySet<string>>(
    () => new Set(JSON.parse(localStorage.getItem('pm.excludedTags') ?? '[]') as string[]),
  );
  // Kind sub-facets (rail rework): source type / question state.
  const [modality, setModality] = useState('');
  const [qstate, setQstate] = useState<'' | 'open' | 'answered'>('');
  useEffect(() => localStorage.setItem('pm.excludedTags', JSON.stringify([...excludedTags])), [excludedTags]);
  const [selectedConcepts, setSelectedConcepts] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  // The create form for EVERY kind: name-first — Enter saves exactly
  // what was typed. The old create-then-rename draft flow raced (keystrokes before the title
  // editor mounted; refresh churn mid-edit) and left orphan "New track" placeholders.
  const [draftKind, setDraftKind] = useState<'track' | 'source' | 'concept' | 'question' | 'snippet' | undefined>();

  const [toast, setToast] = useState<{ message: string; undoRef?: string } | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Resizable pane widths (persisted); the centre pane flexes between them.
  const [railW, setRailW] = useState(() => storedW('pm.railW', 220));
  /** The detail rail was closed on purpose — not "nothing is selected yet". */
  const [dismissed, setDismissed] = useState(false);
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
      setConceptList(asm.levels.flat().map((c) => ({ id: c.id, name: c.name, tracked: c.following, tags: c.tags ?? [], staged: c.staged })).sort((a, b) => a.name.localeCompare(b.name)));
      setError(undefined);
      bumpEpoch();
    } catch (e) {
      // "There is no library here yet" is not a failure. The server says so in
      // a field rather than in prose, so this reads the field: a signed-in visitor gets an OFFER,
      // and anyone who never asked for hosted storage is never told something went wrong.
      if ((e as { needs?: string }).needs === 'provision') {
        setError(undefined); // no library yet — the storage choice, derived from identity, shows
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Who is here, and is there anything of theirs on this server? Asked once, of our own origin.
  useEffect(() => {
    void hostedIdentity().then(setIdentity);
  }, []);

  // A hosted library actually OPEN in front of a signed-in person settles the storage question
  // durably: a later signed-out visit gets a sign-in prompt, never the chooser again.
  useEffect(() => {
    if (currentBackend() === 'server' && identity?.hosted === true && identity.signedIn === true && snapshot) markHostedChosen();
  }, [identity, snapshot]);

  /** Provision the hosted library and switch onto it — the outcome of choosing "host it". */
  const provisionHere = useCallback(async () => {
    setCreating(true);
    try {
      await createHostedLibrary();
      setBackend('server');
      setIdentity(await hostedIdentity());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  // Coming back from sign-in having chosen "host it": provision now, without asking again. The
  // choice was the consent; a second prompt is the confusion the owner reported.
  useEffect(() => {
    if (identity?.signedIn === true && identity.hasLibrary === false && takeHostIntent()) {
      void provisionHere();
    }
  }, [identity, provisionHere]);

  // Signing in from a storage choice opens the SAME pane the topbar button opens (11) — one sign-in look everywhere, no full-page bounce. The intent marker is
  // already parked, so cancelling must take it back or a LATER unrelated sign-in would
  // silently provision.
  const [signInPane, setSignInPane] = useState(false);
  const closeSignInPane = useCallback(() => {
    takeHostIntent();
    takeMigrateIntent();
    setSignInPane(false);
  }, []);

  // A RETURNING hosted person, signed out: their graph is on the server and they already chose
  // that, so the front screen leads with the sign-in itself — closing it leaves the welcome
  // pane's own button, never the storage chooser.
  const returningHosted = currentBackend() === 'server' && identity?.hosted === true && identity.signedIn === false && hostedChosen();
  useEffect(() => {
    if (returningHosted && !snapshot) setSignInPane(true);
  }, [returningHosted, snapshot]);

  /** "Host it on Philomatic": provision if already signed in, else sign in and provision on return. */
  const chooseHosted = useCallback(() => {
    if (identity?.signedIn === true) void provisionHere();
    else {
      markHostIntent();
      setSignInPane(true);
    }
  }, [identity, provisionHere]);

  /** Copy THIS browser library up to the account, then switch onto it — the explicit migration. */
  const migrateHere = useCallback(async () => {
    setCreating(true);
    try {
      await migrateBrowserToHosted(await client.exportAll());
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }, []);

  /** Settings' "Move this library to Philomatic": migrate if signed in, else sign in and migrate
   *  on return. Distinct from chooseHosted, which provisions an EMPTY library. */
  const moveToHosted = useCallback(() => {
    if (identity?.signedIn === true) void migrateHere();
    else {
      markMigrateIntent();
      setSignInPane(true);
    }
  }, [identity, migrateHere]);

  // Coming back from sign-in having asked to MOVE: copy the browser library up now.
  useEffect(() => {
    if (identity?.signedIn === true && takeMigrateIntent()) void migrateHere();
  }, [identity, migrateHere]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The library's vocabulary: built-ins + the personal framework + installed imports
  // swap into the runtime registry, so every declaration reader (maps, dropdowns, chips)
  // speaks this library's dialect. Failure keeps the baked built-ins — nothing degrades.
  useEffect(() => {
    client
      .frameworks()
      .then(applyFrameworksView)
      .catch(() => {});
  }, [epoch]);

  // Live updates: the server's SSE change feed fires on every successful
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

  // The undo stack: every UI edit pushes its INVERSE; Ctrl+Z pops
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

  // The propose pass: explicit, per-source, server-side. The result's
  // COMPANIONS (track + ordering suggestions) are the proposal record the inbox
  // holds — session state by design, never graph state; accepting one writes the edge through
  // the ordinary link path.
  const [proposals, setProposals] = useState<Record<string, ProposeResult>>({});
  // One LLM job at a time — both passes share the busy slot; `kind` picks the button label.
  const [proposing, setProposing] = useState<{ id: string; kind: 'structure' | 'track' } | undefined>();
  const runPropose = useCallback(
    async (sourceId: string) => {
      setProposing({ id: sourceId, kind: 'structure' });
      try {
        const r = await client.propose({ ref: sourceId });
        const extras = (r.trackSuggestion?.length ?? 0) + (r.orderingSuggestion?.length ?? 0);
        // The record goes to the Inbox whenever it carries anything to read — suggestions OR
        // notes: a partially-failed pass must say which steps died (honesty over silence).
        if (extras > 0 || r.notes.length > 0) setProposals((p) => ({ ...p, [sourceId]: r }));
        await refresh();
        // An empty proposal with notes is a FAILURE report, not a quiet success — say why.
        if (r.staged.length === 0 && extras === 0 && r.notes.length > 0) {
          notify(`Nothing proposed — ${r.notes[0]}`);
        } else {
          notify(
            `Proposed ${r.staged.length} item${r.staged.length === 1 ? '' : 's'} → Inbox` +
              (extras > 0 ? ` · ${extras} suggestion${extras === 1 ? '' : 's'}` : '') +
              (r.notes.length > 0 ? ` · ${r.notes.length} note${r.notes.length === 1 ? '' : 's'}` : ''),
          );
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e));
      } finally {
        setProposing(undefined);
      }
    },
    [refresh, notify],
  );
  const dropCompanion = useCallback((sourceId: string, kind: 'track' | 'ordering', index: number) => {
    setProposals((p) => {
      const r = p[sourceId];
      if (!r) return p;
      const next = { ...r };
      if (kind === 'track') next.trackSuggestion = next.trackSuggestion?.filter((_, i) => i !== index);
      else next.orderingSuggestion = next.orderingSuggestion?.filter((_, i) => i !== index);
      const { [sourceId]: _dropped, ...rest } = p;
      return (next.trackSuggestion?.length ?? 0) + (next.orderingSuggestion?.length ?? 0) > 0
        ? { ...rest, [sourceId]: next }
        : rest;
    });
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


  // '+ New <kind>' dispatch: every kind opens the name-first form in the detail slot.
  const startNew = (k: 'track' | 'source' | 'concept' | 'question' | 'snippet') => {
    setSelectedId(undefined);
    setDraftKind(k);
  };

  const items = useMemo(() => (snapshot ? buildItems(snapshot, questions, conceptList, projection) : []), [snapshot, questions, conceptList, projection]);
  const counts = useMemo(() => railCounts(items), [items]);
  // Community mail counts toward the tray: probed at App level so the
  // inbox fills on ARRIVAL, not on first open. Re-probed with every data refresh.
  const [mailN, setMailN] = useState(communityMailCount());
  useEffect(() => onCommunityMailCount(() => setMailN(communityMailCount())), []);
  useEffect(() => {
    void probeCommunityMail(client);
  }, [epoch]);
  // Facet chips scope to the current kind/backlog/sub-facet:
  // browsing Tracks shows only tags/concepts that appear ON tracks, and so on.
  const facetScope = useMemo(
    () => filterItems(items, { kind, tags: new Set(), concepts: new Set(), query: '', excludedTags, modality, question: qstate }),
    [items, kind, excludedTags, modality, qstate],
  );
  const tags = useMemo(() => {
    const visible = allTags(facetScope);
    // Excluded tags are persisted standing state — the chip must stay in the rail (struck
    // out) even when every item carrying it is hidden or outside the kind facet, or the
    // exclusion becomes un-undoable from where you stand.
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
    () => filterItems(items, { kind, tags: selectedTags, concepts: selectedConcepts, query, excludedTags, modality, question: qstate }),
    [items, kind, selectedTags, selectedConcepts, query, excludedTags, modality, qstate],
  );
  const selected = useMemo(() => items.find((i) => i.id === selectedId), [items, selectedId]);
  // Selecting any item dismisses an open draft form (the detail slot shows the selection).
  useEffect(() => {
    if (selectedId !== undefined) setDraftKind(undefined);
  }, [selectedId]);
  const selectedConceptNode = useMemo(() => conceptList.find((c) => c.id === selectedId), [conceptList, selectedId]);

  // "View in map" focus signal (id + nonce) so the Map re-centres even on the same node.
  const [mapFocus, setMapFocus] = useState<{ id: string; nonce: number } | undefined>();

  // Deep links: `#item=<id>` selects the entity — what an embedded
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
    // Nor after the rail was CLOSED: closing it and having it reopen on the
    // next render is the same as it not closing.
    else if (!selectedId && !draftKind && !dismissed && filtered.length > 0) setSelectedId(filtered[0]!.id);
  }, [snapshot, items, filtered, conceptList, selectedId, draftKind, dismissed]);

  /** Closed AND with nothing to show — the column collapses and the list takes the space, which
   *  is what closing a pinned rail already did. An empty pane saying "select
   *  an item" is the one rail behaviour that had no counterpart anywhere else. Anything that puts
   *  something in the rail — a selection, a draft form — opens it again on the spot. */
  const detailCollapsed = dismissed && selectedId === undefined && draftKind === undefined;

  /** The × on the detail rail closes it, and it STAYS closed until something is chosen again —
   *  see the auto-select above, which otherwise puts the first filtered item straight back. */
  const closeDetail = () => {
    setSelectedId(undefined);
    setDismissed(true);
  };

  // Pinned detail rails: Ctrl/⌘+click on ANY entity navigation
  // pins its detail as an extra rail on the far right — up to four, each closable. The modifier
  // is tracked globally so every surface that calls navigate() pins for free.
  const [pinned, setPinned] = useState<string[]>([]);
  // A just-created entity's rail opens with editing ON (unified create).
  const [editNew, setEditNew] = useState<string | undefined>();
  // Widths are per SLOT (not per entity): a retargeted rail keeps its size, and a new rail
  // opens at the live detail-rail width.
  const [pinW, setPinW] = useState<(number | undefined)[]>([]);
  // A pinned entity that gets removed leaves a rail pointing at nothing — prune it (with its
  // slot width) instead of stranding an empty, uncloseable pane.
  useEffect(() => {
    if (!snapshot) return;
    const exists = (id: string) => items.some((i) => i.id === id) || conceptList.some((c) => c.id === id);
    if (pinned.every(exists)) return;
    const keep = pinned.map(exists);
    setPinned((p) => p.filter((_, i) => keep[i]));
    setPinW((w) => w.filter((_, i) => keep[i]));
  }, [snapshot, items, conceptList, pinned]);
  const ctrlHeld = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') ctrlHeld.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') ctrlHeld.current = false;
    };
    const clear = () => {
      ctrlHeld.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);
  const navigate = (id: string) => {
    setDismissed(false); // choosing something is how a closed rail comes back
    if (ctrlHeld.current) {
      setPinned((p) => (p.includes(id) ? p : [...p, id].slice(-4)));
      return;
    }
    setSelectedId(id);
  };
  const viewInMap = (id: string) => {
    setSelectedId(id);
    // The Map now SCOPES to the jumped-to entity and everything under it,
    // so the browse facet has to come off with it: arriving from the Tracks list with
    // kind='track' still applied would hide every member and leave a single dot behind.
    setKind('all');
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

  // TWO different files, and conflating them loses work:
  //   share  — the LIVE world (what you see; removed items stay out). For giving someone a copy.
  //   backup — EVERYTHING, including the retraction history a faithful restore needs.
  // The UI used to offer only the first, while settings called it a backup. On a server the full
  // one was still reachable by curl or the CLI; in the browser there is no server and no CLI, so
  // the only file a learner could get was the one that cannot fully restore them.
  const exportData = async (mode: 'share' | 'backup' = 'share') => {
    try {
      const payload = mode === 'backup' ? await client.exportAll() : await client.exportLive();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `philomatic-${mode}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (mode === 'backup') {
        // Remembered so settings can say when — the in-browser backend has no server-side copy
        // to fall back on, so "when did I last have one?" is a question worth being able to ask.
        try {
          localStorage.setItem('pm.lastBackup', new Date().toISOString());
        } catch {
          /* a browser refusing this loses only the reminder, not the backup */
        }
      }
      notify(
        mode === 'backup'
          ? 'Backup downloaded — everything, including removed items, so a restore is faithful'
          : 'Copy downloaded — your live library, with removed items left out',
      );
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

  // The engine seam (maintainability plan phase 1): provided ONCE here instead of drilled
  // through every view's props. Views take it with useEngine(); writes go through useAction().
  const engine: Engine = useMemo(() => ({ client, refresh, notify, pushUndo, epoch }), [refresh, notify, pushUndo, epoch]);

  // Chromeless embed (an iframe inside Obsidian, /pm-embed-map): just the Map, scoped to the
  // note's referenced ids. All hooks above have run — this is a render fork, not a hook fork.
  if (isEmbed) {
    return (
      <EngineProvider value={engine}>
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
      </EngineProvider>
    );
  }

  const hostName = (identity?.registry ?? '').replace(/^https?:\/\//, '') || 'Philomatic';
  // The storage choice shows on a HOSTED origin with no library to display and nothing being set
  // up — a first visit signed out, or signed in but not yet provisioned, both land here. On a
  // self-hosted single-tenant server (hosted:false) it never shows: that library is just there.
  // A returning hosted person gets the sign-in gate instead — their answer is remembered.
  const showSignInGate = returningHosted && !snapshot && !creating;
  const showStorageChoice = currentBackend() === 'server' && identity?.hosted === true && !snapshot && !creating && !showSignInGate;

  return (
    <EngineProvider value={engine}>
    <div className="app">
      <header className="topbar">
        <span className="brand">
          Library
          {snapshot && <span className="brand-sub">{counts.all} items</span>}
        </span>
        {/* WHICH library, always visible. The single strongest defence against
            working in the wrong one or believing a switch lost your work: it can never be a
            surprise if the chrome always names it. `browser` reads muted; a hosted one names the
            host. */}
        {(() => {
          const lib = libraryLabel(currentBackend(), identity);
          return (
            <>
              <button
                type="button"
                className={currentBackend() === 'browser' ? 'lib-badge local' : 'lib-badge hosted'}
                title={`${lib.title} — click to change where your data lives`}
                onClick={() => setSettingsOpen(true)}
              >
                {currentBackend() === 'browser' ? '◐ ' : '● '}
                {lib.text}
              </button>
            </>
          );
        })()}
        <span className="tabs">
          <button className={tab === 'Library' ? 'tab active' : 'tab'} onClick={() => setTab('Library')}>
            <Books size={15} /> Library
          </button>
          {/* The Inbox is a top tab between Library and Journey (moved up
              from the Browse rail). The tray FILLS when anything waits: staged items plus
              community mail, the same sum the rail row showed. */}
          <button
            className={tab === 'Inbox' ? 'tab active' : 'tab'}
            onClick={() => setTab('Inbox')}
            title="everything pending your validation"
          >
            <Tray size={15} weight={counts.staged + mailN > 0 ? 'fill' : 'regular'} /> Inbox
            {counts.staged + mailN > 0 && <span className="tab-count">{counts.staged + mailN}</span>}
          </button>
          <button className={tab === 'Journey' ? 'tab active' : 'tab'} onClick={() => setTab('Journey')}>
            <PathIcon size={15} /> Journey
          </button>
          <button className={tab === 'Map' ? 'tab active' : 'tab'} onClick={() => setTab('Map')}>
            <GraphIcon size={15} /> Map
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
        {/* Share only. Backing up is a maintenance action taken rarely, and it lives in
            Settings beside the storage facts that explain why you would want one (02) — a second door here only crowded the toolbar. */}
        <button className="ghost-btn" onClick={() => void exportData('share')} title="download a copy to give someone — your live library, without removed items">
          <Export size={15} /> Share
        </button>
        <button className="ghost-btn" onClick={() => setSettingsOpen(true)} title="settings — where your work lives, and how it is protected">
          <GearSix size={15} /> Settings
        </button>
        {identity !== undefined && <AccountControl identity={identity} />}
      </header>

      {settingsOpen && (
        <SettingsPanel
          backend={currentBackend()}
          identity={identity}
          onSignIn={signInHere}
          onMoveToHosted={moveToHosted}
          onBackup={() => void exportData('backup')}
          onImport={() => importRef.current?.click()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Hosted, signed in, and nothing of yours is stored here — an OFFER, not an error
. Nobody should be able to mistake the in-browser engine for the
          hosted one and find out later that a server kept a copy, so this is the only way a
          library on philomatic.io ever comes into being. */}
      {/* THE storage decision comes BEFORE login. On a hosted origin with no
          library to show, we ask where the graph should LIVE — this browser, or Philomatic —
          rather than assuming hosting and nagging to sign in. Choosing "browser" needs no
          account at all; choosing "host" signs you in (if needed) and provisions. A person can
          therefore live in the browser and sign in later purely to publish, never pushed to
          host. The badge always names where they are, so nothing about this is a surprise. */}
      {showStorageChoice && (
        <div className="host-offer storage-choice" role="status">
          <h2>Where should your learning graph live?</h2>
          <p className="storage-reversible">You can change this at any time.</p>
          <div className="storage-options">
            <button className="storage-option" onClick={() => { setBackend('browser'); location.reload(); }}>
              <strong>Keep it in this browser</strong>
              <span>Everything stays on this computer. You manage your own backups, and your work does not move
                between devices.</span>
            </button>
            <button className="storage-option primary" onClick={chooseHosted}>
              <strong>Host it on {hostName}</strong>
              <span>Your graph lives on the Philomatic server — it survives clearing your browser, and you can
                reach it from any device.</span>
            </button>
          </div>
        </div>
      )}

      {/* The returning hosted person, signed out: lead with the sign-in, not the chooser — the
          storage question was answered the first time. The escape below keeps the browser
          engine reachable without an account, so nobody is ever locked behind a login. */}
      {showSignInGate && (
        <div className="host-offer storage-choice" role="status">
          <h2>Welcome back</h2>
          <p className="storage-reversible">Your learning graph lives on {hostName}. Sign in to open it.</p>
          <div className="storage-options">
            <button className="storage-option primary" onClick={() => setSignInPane(true)}>
              <strong>Sign in</strong>
              <span>Use the same account as before — your graph is exactly where you left it.</span>
            </button>
          </div>
          <p className="storage-reversible">
            <button className="link-btn" onClick={() => { setBackend('browser'); location.reload(); }}>
              Use the in-browser library on this computer instead
            </button>
          </p>
        </div>
      )}

      {/* Signing in for a storage choice: the same pane as the topbar's Sign in (11). The parked host/migrate intent finishes the job on return. */}
      {signInPane && identity !== undefined && <SignInModal identity={identity} onClose={closeSignInPane} />}

      {/* Provisioning after "host it" — a brief, honest state, never an error. */}
      {creating && (
        <p className="hint" style={{ padding: '1rem' }}>Setting up your library on {hostName}…</p>
      )}

      {/* A 401 on a hosted server you have not chosen yet is the EXPECTED state, not a fault: the
          choice above says what to do, and a red banner beside it would read as a breakage. */}
      {error && !showStorageChoice && !showSignInGate && (
        <p className="error" role="alert">
          {/* Name the actual fix. "Is the server running?" is the wrong question when the
              server answered and rejected us for a missing token. */}
          Can’t reach the engine: {error}.{' '}
          {/token/i.test(error ?? '')
            ? 'That server wants an access token — add it in Settings → Access token.'
            : 'Is the server running, and is the address in Settings right?'}
        </p>
      )}

      {!snapshot && !error && !showStorageChoice && !showSignInGate && !creating && (
        <p className="hint" style={{ padding: '1rem' }}>Loading…</p>
      )}

      {snapshot && tab === 'Journey' && (
        <Journey
          projection={projection}
          snapshot={snapshot}
          questions={questions}
          concepts={conceptList}
          onOpenInLibrary={(id) => {
            setSelectedId(id);
            setTab('Library');
          }}
        />
      )}

      {snapshot && tab !== 'Journey' && (
        <div
          className="workbench"
          style={{
            '--rail-w': `${railW}px`,
            '--detail-w': `${detailW}px`,
            // One expression for every case: rail · resizer · centre, then
            // the detail column WHEN THERE IS ONE, then a column per pinned rail. A closed detail
            // rail gives its width back to the list, exactly as closing a pinned one does.
            gridTemplateColumns: [
              `${railW}px`,
              '6px',
              'minmax(0, 1fr)',
              ...(detailCollapsed ? [] : ['6px', `${detailW}px`]),
              ...pinned.map((_, i) => `6px ${pinW[i] ?? detailW}px`),
            ].join(' '),
          } as React.CSSProperties}
        >
          <Rail
            counts={counts}
            tags={tags}
            concepts={concepts}
            kind={kind}
            selectedTags={selectedTags}
            excludedTags={excludedTags}
            selectedConcepts={selectedConcepts}
            onKind={(k) => {
              setModality('');
              setQstate('');
              setKind(k);
              // Picking a kind while the Inbox is open returns to the library view.
              setTab((t) => (t === 'Inbox' ? 'Library' : t));
            }}
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

          {/* Capture-first empty state: an EMPTY library leads with capture + fork,
              never a bare "Nothing matches." A SPARSE one keeps the same two doors as a strip
              above the list until it fills. */}
          {tab === 'Library' && counts.all === 0 ? (
            <StartPanel onCaptured={(id) => setSelectedId(id)} onCreate={(kind) => startNew(kind)} />
          ) : tab === 'Library' ? (
            <ItemList
              items={filtered}
              total={counts.all}
              filterNote={filterNote}
              selectedId={selectedId}
              onSelect={(i: Item) => navigate(i.id)}
              // One '+ New <kind>' button for the current kind. The 'all'
              // view shows none — a New button there has no single kind to mint.
              newActions={(kind === 'track' || kind === 'source' || kind === 'concept' || kind === 'question' || kind === 'snippet'
                ? [{ kind, onClick: () => startNew(kind) }]
                : [])}
              /* No capture strip over the list: the empty state introduces
                 the product, and after that "+ New source" is the same act — DraftForm calls
                 captureSource too. A strip that vanished at three items was also the only way to
                 capture in-app, so the feature quietly stopped existing in any real library. */
            />
          ) : tab === 'Inbox' ? (
            <InboxView
              items={items.filter((i) => i.staged === true)}
              selectedId={selectedId}
              onSelect={(i: Item) => navigate(i.id)}
              companions={Object.entries(proposals).map(([sid, r]) => ({
                sourceId: sid,
                sourceTitle: snapshot.sources.find((s) => s.id === sid)?.title ?? sid,
                result: r,
              }))}
              onDropCompanion={dropCompanion}
              onOpen={navigate}
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

          {!detailCollapsed && <Resizer onResize={(dx) => setDetailW((w) => clampW(w - dx, 280, 680))} />}

          {detailCollapsed ? null : selectedConceptNode ? (
            <ConceptDetail
              concept={selectedConceptNode}
              concepts={conceptList}
              snapshot={snapshot}
              questions={questions}
              editNew={editNew}
              onNavigate={navigate}
              onViewInMap={viewInMap}
              onClose={closeDetail}
            />
          ) : selected ? (
            <Detail
              projection={projection}
              item={selected}
              snapshot={snapshot}
              questions={questions}
              concepts={conceptList}
              onNavigate={navigate}
              onViewInMap={viewInMap}
              editNew={editNew}
              onPropose={runPropose}
              proposing={proposing}
              onClose={closeDetail}
            />
          ) : draftKind ? (
            <DraftForm
              kind={draftKind}
              snapshot={snapshot}
              onCreated={(id) => {
                pushUndo(`create ${draftKind}`, () => client.remove(id));
                setDraftKind(undefined);
                setSelectedId(id);
                setEditNew(id);
              }}
              onCancel={() => setDraftKind(undefined)}
            />
          ) : (
            <div className="pane detail">
              <p className="hint">Select an item to see its details and connections.</p>
            </div>
          )}

          {snapshot &&
            pinned.map((pid, idx) => {
              const conceptNode = conceptList.find((c) => c.id === pid);
              const it = items.find((i) => i.id === pid);
              // Navigation WITHIN a pinned rail: a plain click retargets
              // THIS rail; Ctrl/⌘+click still stacks a new one (the global navigate branch).
              const closeRail = () => {
                setPinned((p) => p.filter((_, j) => j !== idx));
                setPinW((w) => w.filter((_, j) => j !== idx));
              };
              const navInRail = (id: string) => {
                if (ctrlHeld.current) {
                  navigate(id);
                  return;
                }
                setPinned((p) => (p.includes(id) ? p : p.map((x, j) => (j === idx ? id : x))));
              };
              return (
                <div key={pid} style={{ display: 'contents' }}>
                  <Resizer onResize={(dx) => setPinW((w) => { const next = [...w]; next[idx] = clampW((next[idx] ?? detailW) - dx, 260, 720); return next; })} />
                  <div className="pinned-rail">
                    {conceptNode ? (
                      <ConceptDetail concept={conceptNode} concepts={conceptList} snapshot={snapshot} questions={questions} onNavigate={navInRail} onViewInMap={viewInMap} onClose={closeRail} />
                    ) : it ? (
                      <Detail projection={projection} item={it} snapshot={snapshot} questions={questions} concepts={conceptList} onNavigate={navInRail} onViewInMap={viewInMap} onClose={closeRail} onPropose={runPropose} proposing={proposing} />
                    ) : (
                      // The auto-prune above normally removes this rail within a frame; the ×
                      // stays as the belt-and-braces exit.
                      <div className="pane detail">
                        <div className="detail-top">
                          <span style={{ flex: 1 }} />
                          <button className="pinned-x" title="close this rail" onClick={closeRail}>
                            ×
                          </button>
                        </div>
                        <p className="hint">This entity is gone.</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
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
    </EngineProvider>
  );
}
