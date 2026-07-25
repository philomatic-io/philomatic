/**
 * The transport-agnostic engine client (plan §2.1) — the ONE seam between components and a host.
 * Two implementations are planned: this HTTP client against the local ingest server, and a
 * `chrome.runtime` message client for the self-contained extension (§2.7). Components never call
 * `fetch` directly; swapping the host is swapping this object.
 *
 * WATCH-ITEM (§2.1, verbatim budget): this abstraction exists only to support two hosts. It stays
 * ~5 functions. If it ever grows caching, retry logic, or state, it has become a *layer* — the
 * right response is not to maintain it but to pick one host and delete it.
 */
import {
  READ_VERSION,
  type AssembleResult,
  type EditResult,
  type GraphEnvelope,
  type QuestionsEnvelope,
  type RelationsEnvelope,
  type RemovedEnvelope,
  type Snapshot,
  type TimelineEnvelope,
} from './types';

export interface EngineClient {
  getSnapshot(): Promise<Snapshot>;
  getAssemble(track?: string): Promise<AssembleResult>;
  /** Record the learner's ASKS on an existing question (S3's "ask" action). */
  ask(question: string): Promise<void>;
  /** Record the learner's ANSWERED on an existing question (S3's "mark answered" action). */
  markAnswered(question: string): Promise<void>;
  /** Mark a source consumed (`ref` = source id/URL/title). Add-only. */
  consume(ref: string): Promise<void>;
  unconsume(ref: string): Promise<void>;
  /** Follow a concept (`ref` = concept id or name). Add-only. */
  track(ref: string): Promise<void>;
  /** Capture a source by URL (creates it / files it into a track / raises questions). */
  captureSource(input: Record<string, unknown>): Promise<unknown>;
  /** Capture a snippet (by url or sourceId), optionally raising questions. */
  captureSnippet(input: Record<string, unknown>): Promise<unknown>;
  /** The edit primitives (S5): `ref` is a typed id, URL, or name/title/text — engine resolves. */
  remove(ref: string): Promise<EditResult>;
  restore(ref: string): Promise<EditResult>;
  /** Field-level supersession — identity fields are rejected by the engine with the reason. */
  update(ref: string, patch: Record<string, unknown>): Promise<EditResult>;
  /** The publish acts (publish plan P2; DATA_GOVERNANCE 2) — explicit, license-stamping writes. */
  publish(ref: string, license?: string): Promise<EditResult>;
  unpublish(ref: string): Promise<EditResult>;
  pushToRegistry(ref: string, registry: string): Promise<{ ok: boolean; updated: boolean; url: string }>;
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
  /** The whole canonical payload — the tester's backup and feedback channel (M8). */
  exportAll(): Promise<unknown>;
  /** The LIVE payload (retractions folded away) — what Share downloads: match what you see. */
  exportLive(): Promise<unknown>;
  /** Load sugared or canonical JSON (desugar → validate → idempotent upsert). */
  importPayload(payload: unknown): Promise<void>;
}

/** The HTTP host: the local ingest server's routes, same-origin (dev proxies them; see vite.config). */
export function httpClient(base = ''): EngineClient {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, body === undefined
      ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json as { error?: string }).error ?? `${res.status} on ${path}`;
      throw new Error(msg);
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
    captureSource: (input) => request('/ingest', input),
    captureSnippet: (input) => request('/snippet', input),
    remove: (ref) => request<EditResult>('/remove', { ref }),
    restore: (ref) => request<EditResult>('/restore', { ref }),
    update: (ref, patch) => request<EditResult>('/update', { ref, patch }),
    publish: (ref, license) => request<EditResult>('/publish', { ref, ...(license !== undefined && license !== '' ? { license } : {}) }),
    unpublish: (ref) => request<EditResult>('/unpublish', { ref }),
    pushToRegistry: (ref, registry) => request<{ ok: boolean; updated: boolean; url: string }>('/push', { ref, registry }),
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
  };
}

/**
 * Subscribe to the server's change feed (self-serve plan T3): GET /changes is an SSE stream
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
