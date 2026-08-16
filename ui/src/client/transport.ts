/**
 * The transport-agnostic engine client (plan) — the ONE seam between components and a host.
 * Two implementations are planned: this HTTP client against the local ingest server, and a
 * `chrome.runtime` message client for the self-contained extension. Components never call
 * `fetch` directly; swapping the host is swapping this object.
 *
 * WATCH-ITEM (, verbatim budget): this abstraction exists only to support two hosts. It stays
 * ~5 functions. If it ever grows caching, retry logic, or state, it has become a *layer* — the
 * right response is not to maintain it but to pick one host and delete it.
 */
import { pushBundleSameOrigin } from './registry-push';
import {
  READ_VERSION,
  type AssembleResult,
  type EditResult,
  type FrameworkFile,
  type FrameworksView,
  type ViewOverrides,
  type GraphEnvelope,
  type QuestionsEnvelope,
  type RelationsEnvelope,
  type RemovedEnvelope,
  type Snapshot,
  type TimelineEnvelope,
} from './types';

/** What POST /propose answers: what got staged, plus the accept-time companions
 *  that live in this proposal record and NEVER in the graph. */
export interface ProposeResult {
  ok: boolean;
  staged: string[];
  skipped: number;
  trackSuggestion?: { trackId: string; title: string; reason: string }[];
  orderingSuggestion?: { beforeId: string; before: string; afterId: string; after: string; reason: string }[];
  notes: string[];
}

/** A community track from the configured registry. */
export interface RegistryTrack {
  trackId: string;
  title: string;
  goal?: string;
  author?: string;
  sources: number;
  concepts: number;
  conceptNames?: string[];
  featured?: boolean;
  updatedAt: number;
}

/** A bundled example track, for fork-first onboarding. */
export interface ExampleMeta {
  name: string;
  title: string;
  goal?: string;
  sources: number;
  concepts: number;
}

/** What POST /propose-track answers. */
export interface ProposeTrackResult {
  ok: boolean;
  trackId: string;
  trackTitle: string;
  staged: string[];
  skipped: number;
  notes: string[];
}

export interface EngineClient {
  getSnapshot(): Promise<Snapshot>;
  getAssemble(track?: string): Promise<AssembleResult>;
  /** Record the learner's ASKS on an existing question (the "ask" action). */
  ask(question: string): Promise<void>;
  /** Record the learner's ANSWERED on an existing question (the "mark answered" action). */
  markAnswered(question: string): Promise<void>;
  /** Mark a source consumed (`ref` = source id/URL/title). Add-only. */
  consume(ref: string): Promise<void>;
  unconsume(ref: string): Promise<void>;
  /** Follow a concept (`ref` = concept id or name). Add-only. */
  track(ref: string): Promise<void>;
  /** The staged lifecycle: stage parks/proposes ANY entity;
   *  accept/reject are the two verdicts; unstage is the plain reversal, no verdict. */
  stage(ref: string): Promise<void>;
  unstage(ref: string): Promise<void>;
  accept(ref: string): Promise<void>;
  reject(ref: string): Promise<void>;
  /** The propose pass: server-side LLM chain for one source. 503s when
   *  the host has no LLM configured — surface the message, it explains itself. */
  propose(input: { ref: string; config?: Record<string, boolean>; scopeTrack?: string }): Promise<ProposeResult>;
  /** The survey→track pass: drafts a whole STAGED track from one survey source —
   *  accepting the track is the explicit INCLUDES gesture. */
  proposeTrack(input: { ref: string; config?: Record<string, unknown> }): Promise<ProposeTrackResult>;
  /** Capture a source by URL (creates it / files it into a track / raises questions). */
  captureSource(input: Record<string, unknown>): Promise<unknown>;
  /** Capture a snippet (by url or sourceId), optionally raising questions. */
  captureSnippet(input: Record<string, unknown>): Promise<unknown>;
  /** The edit primitives: `ref` is a typed id, URL, or name/title/text — engine resolves. */
  remove(ref: string): Promise<EditResult>;
  restore(ref: string): Promise<EditResult>;
  /** Field-level supersession — identity fields are rejected by the engine with the reason. */
  update(ref: string, patch: Record<string, unknown>): Promise<EditResult>;
  /** The publish acts — explicit, license-stamping writes. */
  publish(ref: string, license?: string, as?: string): Promise<EditResult>;
  unpublish(ref: string): Promise<EditResult>;
  pushToRegistry(ref: string, registry: string): Promise<{ ok: boolean; updated: boolean; url: string }>;
  /** The local publication's contentHash, or undefined if not published — the sync-state probe. */
  /** The local publication's PUBLISHED identity + hash — trackId differs from the local id when
   *  the track is published AS its own version (fork identity). */
  publicationMeta(ref: string): Promise<{ contentHash: string; trackId: string; title: string } | undefined>;
  /** Pull upstream changes into a fork: additive, base-aware; returns the summary. */
  pullFork(ref: string): Promise<{ took: number; keptYours: number; upstreamDeleted: number; edgesAdded: number; trackId: string }>;
  /** Un-assert a structural edge by full coordinates (interim deletion; undo = re-import). */
  /** Assert a structural edge — the ONE tie-writing seam (engine.link; inverse of unlink). */
  link(edge: { srcType: string; srcId: string; type: string; dstType: string; dstId: string; tags?: unknown[]; trackContextId?: string }): Promise<{ created: boolean }>;
  unlink(edge: { srcId: string; type: string; dstId: string; trackContextId?: string }): Promise<{ changed: boolean }>;
  getRemoved(): Promise<RemovedEnvelope>;
  getTimeline(): Promise<TimelineEnvelope>;
  getQuestions(): Promise<QuestionsEnvelope>;
  /** The typed edges touching an entity (workbench detail "Connections"). */
  getRelations(id: string): Promise<RelationsEnvelope>;
  /** The whole knowledge graph (the Map tab). */
  getGraph(): Promise<GraphEnvelope>;
  /** The whole canonical payload — the tester's backup and feedback channel. */
  exportAll(): Promise<unknown>;
  /** The LIVE payload (retractions folded away) — what Share downloads: match what you see. */
  exportLive(): Promise<unknown>;
  /** Load sugared or canonical JSON (desugar → validate → idempotent upsert). */
  importPayload(payload: unknown): Promise<void>;
  /** The library's vocabulary: built-ins + the personal framework + installed imports. */
  frameworks(): Promise<FrameworksView>;
  /** Save the personal working framework — the editor's one write. Built-in names refuse. */
  saveMyFramework(def: FrameworkFile): Promise<void>;
  /** Install a framework that arrived from elsewhere; same name replaces (an update). */
  installFramework(def: FrameworkFile): Promise<void>;
  /** Remove an installed framework — its tags stay on any edges and render generic. */
  removeFramework(name: string): Promise<void>;
  /** Save the library's local view overrides — restyle/hide others' declarations. */
  saveViewOverrides(overrides: ViewOverrides): Promise<void>;
  /** Turn optional built-in frameworks on/off — core is always ambient. */
  setEnabledBuiltins(names: readonly string[]): Promise<void>;
  /** Switch installed frameworks off/on — the list names the DISABLED ones. */
  setDisabledInstalled(names: readonly string[]): Promise<void>;
  /** The bundled example tracks: list, then fork one by importing it. */
  listExamples(): Promise<ExampleMeta[]>;
  getExample(name: string): Promise<unknown>;
  /** The community registry: undefined when this server has none configured. */
  getRegistry(): Promise<{ registry: string; tracks: RegistryTrack[] } | undefined>;
  /** Fork a registry track into this library — lineage + archived parent ride the existing
   *  fork-import path server-side. */
  forkRegistryTrack(trackId: string): Promise<{ forked: boolean; title?: string; trackId?: string }>;
}

/**
 * The HTTP host: a Philomatic server's routes. `base` empty means same-origin, which is right
 * when the server serves the app; a hosted workbench pointed at a machine of your own passes
 * its address. `token` is sent when that server was
 * started with `INGEST_TOKEN` — it guards writes.
 */
export function httpClient(base = '', token = ''): EngineClient {
  const auth: Record<string, string> = token === '' ? {} : { 'X-Ingest-Token': token };
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, body === undefined
      ? { headers: auth }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = json as { error?: string; needs?: string };
      const msg = body.error ?? `${res.status} on ${path}`;
      // Carry the STATUS and the server's own machine-readable `needs` alongside the sentence.
      // A caller that must distinguish "no library yet" from "cannot reach the engine" should
      // not be matching on prose.
      const err = Object.assign(new Error(msg), {
        status: res.status,
        ...(typeof body.needs === 'string' ? { needs: body.needs } : {}),
      });
      throw err;
    }
    return json as T;
  }

  function checkVersion<T extends { version: number }>(envelope: T): T {
    if (envelope.version !== READ_VERSION) {
      throw new Error(`read contract v${envelope.version}; this UI speaks v${READ_VERSION} — rebuild the UI`);
    }
    return envelope;
  }

  return {
    getSnapshot: async () => checkVersion(await request<Snapshot>('/snapshot')),
    getAssemble: async (track) =>
      checkVersion(await request<AssembleResult>(`/assemble${track ? `?track=${encodeURIComponent(track)}` : ''}`)),
    ask: async (question) => { await request('/ask', { question }); },
    markAnswered: async (question) => { await request('/answer', { question }); },
    consume: async (ref) => { await request('/consume', { ref }); },
    unconsume: async (ref) => { await request('/unconsume', { ref }); },
    track: async (ref) => { await request('/track', { ref }); },
    stage: async (ref) => { await request('/stage', { ref }); },
    unstage: async (ref) => { await request('/unstage', { ref }); },
    accept: async (ref) => { await request('/accept', { ref }); },
    reject: async (ref) => { await request('/reject', { ref }); },
    propose: (input) => request<ProposeResult>('/propose', input),
    proposeTrack: (input) => request<ProposeTrackResult>('/propose-track', input),
    captureSource: (input) => request('/ingest', input),
    captureSnippet: (input) => request('/snippet', input),
    remove: (ref) => request<EditResult>('/remove', { ref }),
    restore: (ref) => request<EditResult>('/restore', { ref }),
    update: (ref, patch) => request<EditResult>('/update', { ref, patch }),
    publish: (ref, license, as) =>
      request<EditResult>('/publish', { ref, ...(license !== undefined && license !== '' ? { license } : {}), ...(as !== undefined && as !== '' ? { as } : {}) }),
    unpublish: (ref) => request<EditResult>('/unpublish', { ref }),
    // Publishing belongs to a USER, and a hosted instance is not one: its outbound POST
    // carries no session, so the registry answers 401 "publishing needs an account" even though
    // the person at the keyboard is signed in.
    //
    // So when the registry IS this page's origin — the one-origin deploy — publish from the
    // BROWSER: read the bundle from this instance, POST it to the registry same-origin, and the
    // session cookie goes with it. Any other registry stays a server-side push, which is the
    // self-hoster's path and carries REGISTRY_TOKEN.
    publicationMeta: async (ref) => {
      try {
        return await request<{ contentHash: string; trackId: string; title: string }>(`/publication?ref=${encodeURIComponent(ref)}&meta=1`);
      } catch {
        return undefined;
      }
    },
    pushToRegistry: async (ref, registry) => {
      const target = registry.replace(/\/+$/, '');
      if (target !== window.location.origin) {
        return request<{ ok: boolean; updated: boolean; url: string }>('/push', { ref, registry });
      }
      // The PRIVATE bundle read — /t/<id>.json is public and, on a hosted instance, 302s to the
      // registry before this track exists there; /publication is authenticated and never
      // redirects.
      return pushBundleSameOrigin(target, await request<unknown>(`/publication?ref=${encodeURIComponent(ref)}`));
    },
    link: (edge) => request<{ created: boolean }>('/link', edge),
    unlink: (edge) => request<{ changed: boolean }>('/unlink', edge),
    getRemoved: async () => checkVersion(await request<RemovedEnvelope>('/removed')),
    getTimeline: async () => checkVersion(await request<TimelineEnvelope>('/timeline')),
    getQuestions: async () => checkVersion(await request<QuestionsEnvelope>('/questions')),
    getRelations: async (id) => checkVersion(await request<RelationsEnvelope>(`/relations?id=${encodeURIComponent(id)}`)),
    getGraph: async () => checkVersion(await request<GraphEnvelope>('/graph')),
    exportAll: () => request('/export'),
    exportLive: () => request('/export?live=1'),
    importPayload: async (payload) => {
      await request('/import', payload);
    },
    frameworks: async () => {
      const r = await request<{ builtin: FrameworkFile[]; mine?: FrameworkFile; installed: FrameworkFile[]; viewOverrides?: ViewOverrides; enabledBuiltins?: string[]; disabledInstalled?: string[] }>('/framework');
      return {
        builtin: r.builtin,
        ...(r.mine !== undefined ? { mine: r.mine } : {}),
        installed: r.installed,
        ...(r.viewOverrides !== undefined ? { viewOverrides: r.viewOverrides } : {}),
        enabledBuiltins: r.enabledBuiltins ?? [],
        disabledInstalled: r.disabledInstalled ?? [],
      };
    },
    saveMyFramework: async (def) => {
      await request('/framework/mine', def);
    },
    installFramework: async (def) => {
      await request('/framework/install', def);
    },
    removeFramework: async (name) => {
      await request('/framework/uninstall', { name });
    },
    saveViewOverrides: async (overrides) => {
      await request('/framework/view', overrides);
    },
    setEnabledBuiltins: async (names) => {
      await request('/framework/enabled', { names });
    },
    setDisabledInstalled: async (names) => {
      await request('/framework/disabled-installed', { names });
    },
    listExamples: async () => (await request<{ examples: ExampleMeta[] }>('/examples')).examples,
    getExample: (name) => request(`/examples?name=${encodeURIComponent(name)}`),
    getRegistry: async () => {
      // 204 (no registry configured) parses to {} — the undefined signal.
      const r = await request<{ registry?: string; tracks?: RegistryTrack[] }>('/registry');
      return typeof r.registry === 'string' ? { registry: r.registry, tracks: r.tracks ?? [] } : undefined;
    },
    forkRegistryTrack: (trackId) => request('/registry-fork', { trackId }),
    pullFork: (ref) => request('/pull', { ref }),
  };
}

/**
 * Subscribe to the server's change feed: GET /changes is an SSE stream
 * that emits after every successful write — any client's capture (the popup, the context menu,
 * another tab) shows up here. The event carries no data; subscribers refetch through the read
 * contract. EventSource reconnects on its own (the server's `retry:` hint), which is the whole
 * fallback story. Returns the unsubscribe. Deliberately NOT on EngineClient — it is a signal,
 * not a read, and the client object stays within its watch-item budget.
 */
export function onEngineChange(cb: () => void, base = ''): () => void {
  const es = new EventSource(base + '/changes');
  es.onmessage = () => cb();
  return () => es.close();
}
