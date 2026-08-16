/**
 * The in-browser EngineClient — a first-class backend implementing the same interface the
 * HTTP transport implements, mapped straight onto a `PhilomaticEngine.openBrowser` instance
 * running in this tab. Every interaction is REAL engine behavior; the blast radius is one
 * browser. Writes persist through the injected `persist` callback (IndexedDB, via
 * boot/local-backend)
 * and fire the change listeners the workbench's live-update path subscribes to.
 *
 * Publishing and registry pushes are unavailable for REASONS, not by policy: the promise is
 * "nothing you do here leaves this tab."
 */
import { READ_VERSION } from './types';
import type { EngineClient, ExampleMeta, RegistryTrack } from './transport';
import { unavailable, type Capability } from '../lib/capabilities';
import { pushBundleSameOrigin } from './registry-push';
import { FRAMEWORKS } from '../generated/framework';
import type {
  AssembleResult,
  EditResult,
  FrameworkFile,
  GraphEnvelope,
  ViewOverrides,
  QuestionsEnvelope,
  RelationsEnvelope,
  RemovedEnvelope,
  Snapshot,
  TimelineEnvelope,
} from './types';

/** The engine facade surface the local client needs (structural — avoids importing node types). */
export interface LocalEngine {
  snapshot(): unknown;
  assemble(trackRef?: string): unknown;
  ask(ref: string): void;
  answer(ref: string): void;
  consume(ref: string): void;
  unconsume(ref: string): { changed: boolean };
  track(ref: string): void;
  stage(ref: string): unknown;
  unstage(ref: string): { changed: boolean };
  accept(ref: string): { changed: boolean };
  reject(ref: string): { changed: boolean };
  captureSource(input: unknown): unknown;
  captureSnippet(input: unknown): unknown;
  remove(input: { ref: string }): unknown;
  restore(input: { ref: string }): unknown;
  update(input: { ref: string; patch: Record<string, unknown> }): unknown;
  link(edge: unknown): { created: boolean };
  unlink(edge: unknown): { changed: boolean };
  removed(): unknown;
  timeline(): unknown;
  questions(): unknown;
  relations(id: string): unknown;
  graph(): unknown;
  exportAll(): unknown;
  exportLive(): unknown;
  importPayload(payload: unknown): unknown;
  importPublication(input: unknown, opts?: { originUrl?: string }): { trackId: string; title: string };
  pullPublication(current: unknown, base?: unknown): { took: number; keptYours: number; upstreamDeleted: number; edgesAdded: number; trackId: string };
  publish(input: unknown): unknown;
  unpublish(input: unknown): unknown;
  publication(ref: string, opts?: { frameworks?: unknown[] }): unknown;
}

/**
 * A GET that returns `undefined` for anything that is not a clean 200.
 *
 * A static export, a `file://` page, or a server with no registry configured all answer nothing
 * useful, and the caller's job is to fall back rather than to explain a 404.
 */
const getJson = async <T>(url: string): Promise<T | undefined> => {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return undefined;
    return (await r.json()) as T;
  } catch {
    return undefined;
  }
};

/**
 * Which registry this page's Philomatic reads, and what is on it.
 *
 * The in-browser engine used to refuse this outright, on the grounds that a tab may not fetch
 * other sites. That is true of other sites and false of the two addresses that matter here:
 *
 *   /registry    the server that SERVED this page, answering about the registry it is configured
 *                with. Same-origin, and exactly the arrangement the old refusal described — "your
 *                own Philomatic fetches them for you" — which was already true and still refused.
 *   /index.json  the origin IS a registry, which is how the hosted workbench is served.
 *
 * Neither is a URL from data: one is this page's own origin, the other is what this page's own
 * server says it is configured with. The engine still reaches nothing it was not pointed at.
 */
const resolveRegistry = async (): Promise<{ registry: string; tracks: RegistryTrack[] } | undefined> => {
  const proxied = await getJson<{ registry?: string; tracks?: RegistryTrack[] }>('/registry');
  if (proxied !== undefined && typeof proxied.registry === 'string') {
    return { registry: proxied.registry, tracks: proxied.tracks ?? [] };
  }
  const own = await getJson<{ tracks?: RegistryTrack[] }>('/index.json');
  return own === undefined ? undefined : { registry: window.location.origin, tracks: own.tracks ?? [] };
};

// The refusals read from the SAME rule the UI explains itself with (lib/capabilities) — two
// wordings would drift, and the drift would show up as a button promising what the engine then
// refuses. These fire only when something is called anyway; the UI should have said so first.
const blocked = (cap: Capability): Error => new Error(unavailable(cap, 'browser')!);

/** Where the browser host keeps its framework document. Injected so the client stays
 *  host-agnostic: the workbench wires IndexedDB (lib/browser-store), tests wire memory. */
export interface FrameworkDocStore {
  load(): Promise<{ mine?: unknown; installed: unknown[] } | undefined>;
  save(doc: { mine?: unknown; installed: unknown[] }): Promise<void>;
}

const memoryFrameworkStore = (): FrameworkDocStore => {
  let doc: { mine?: unknown; installed: unknown[] } | undefined;
  return {
    load: async () => doc,
    save: async (d) => {
      doc = d;
    },
  };
};

/** The structural checks the server's zod schema performs — the browser host must refuse the
 *  same inputs or the two hosts drift (the contract suite pins this). */
function assertFrameworkFile(def: unknown): asserts def is FrameworkFile {
  const d = def as Partial<FrameworkFile> | null;
  if (d === null || typeof d !== 'object') throw new Error('not a framework file');
  if (typeof d.framework !== 'string' || d.framework.length === 0) throw new Error('a framework needs a name');
  if (typeof d.version !== 'number' || !Number.isInteger(d.version)) throw new Error('a framework needs an integer version');
  if (!Array.isArray(d.edgeTags)) throw new Error('edgeTags must be a list');
  for (const t of d.edgeTags as unknown[]) {
    const tag = t as { name?: unknown; on?: { type?: unknown }; direction?: unknown };
    if (typeof tag.name !== 'string' || tag.name.length === 0) throw new Error('every edge tag needs a name');
    if (typeof tag.on?.type !== 'string') throw new Error('every edge tag needs an `on.type`');
    if (tag.direction !== 'directed' && tag.direction !== 'symmetric') throw new Error('direction must be directed or symmetric');
  }
}

/** The zod defaults the server host applies — the browser host must store the SAME canonical
 *  shape or the two libraries drift (caught by the contract suite on its first run). */
const normalizeFrameworkFile = (def: FrameworkFile): FrameworkFile => ({
  ...def,
  edgeTags: def.edgeTags ?? [],
  entityTags: def.entityTags ?? [],
  metadataFields: def.metadataFields ?? [],
});

export function localClient(
  engine: LocalEngine,
  persist: () => void,
  frameworkStore: FrameworkDocStore = memoryFrameworkStore(),
): EngineClient & { subscribe: (cb: () => void) => () => void } {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    persist();
    for (const cb of listeners) cb();
  };

  /** A bundle's carried definitions INSTALL on import — verified against
   *  the hash-covered manifest, same-name replaces; parity with the server's installBundleDefs. */
  const installBundleDefs = async (bundle: unknown): Promise<void> => {
    const b = bundle as { payload?: { frameworks?: { name: string; version: number }[] }; frameworkDefs?: FrameworkFile[] };
    const manifest = b.payload?.frameworks ?? [];
    const defs = Array.isArray(b.frameworkDefs) ? b.frameworkDefs : [];
    if (defs.length === 0) return;
    const doc = (await frameworkStore.load()) ?? { installed: [] };
    let installed = doc.installed as FrameworkFile[];
    for (const def of defs) {
      try {
        assertFrameworkFile(def);
      } catch {
        continue;
      }
      if (!manifest.some((m) => m.name === def.framework && m.version === def.version)) continue;
      if ((FRAMEWORKS as readonly { framework: string }[]).some((f) => f.framework === def.framework)) continue;
      installed = [...installed.filter((f) => f.framework !== def.framework), normalizeFrameworkFile(def)];
    }
    await frameworkStore.save({ ...doc, installed });
  };

  /** The library's own frameworks, for the publication projection (parity with the server's
   *  storeFrameworks — minted/installed tags must survive publish on BOTH hosts). */
  const fwList = async (): Promise<FrameworkFile[]> => {
    const d = (await frameworkStore.load()) ?? { installed: [] };
    return [...((d.mine !== undefined ? [d.mine] : []) as FrameworkFile[]), ...(d.installed as FrameworkFile[])];
  };
  /** Wrap a write: run it, persist, notify — synchronous engine, async interface. */
  const write = async <T>(fn: () => T): Promise<T> => {
    const out = fn();
    changed();
    return out;
  };

  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: async () => engine.snapshot() as Snapshot,
    getAssemble: async (track) => engine.assemble(track) as AssembleResult,
    ask: (q) => write(() => engine.ask(q)),
    markAnswered: (q) => write(() => engine.answer(q)),
    consume: (ref) => write(() => engine.consume(ref)),
    unconsume: (ref) => write(() => void engine.unconsume(ref)),
    track: (ref) => write(() => engine.track(ref)),
    stage: (ref) => write(() => void engine.stage(ref)),
    unstage: (ref) => write(() => void engine.unstage(ref)),
    accept: (ref) => write(() => void engine.accept(ref)),
    reject: (ref) => write(() => void engine.reject(ref)),
    propose: async () => {
      throw blocked('suggest');
    },
    proposeTrack: async () => {
      throw blocked('suggest');
    },
    captureSource: (input) => write(() => engine.captureSource(input)),
    captureSnippet: (input) => write(() => engine.captureSnippet(input)),
    remove: (ref) => write(() => engine.remove({ ref }) as EditResult),
    restore: (ref) => write(() => engine.restore({ ref }) as EditResult),
    update: (ref, patch) => write(() => engine.update({ ref, patch }) as EditResult),
    /**
     * Publishing from the tab.
     *
     * Two objections used to make this impossible, and both are gone:
     *
     *   - a browser engine has no file, so its signing key is EPHEMERAL — under the old rule the
     *     registry pinned a track's name to the first publisher's key, so you could publish once
     *     and never update. Ownership is the ACCOUNT now: a new track is claimed by the
     *     account, and an owned one checks the account, so the key stops mattering.
     *   - the push was cross-origin, which is why a SERVER did it. On the one-origin deploy the
     *     registry is this page's own origin, so the POST is same-origin and the session cookie
     *     goes with it. No token, no server.
     *
     * Publish still MINTS locally (the bundle is signed here, and stays verifiable as a file);
     * only the push needs an account.
     */
    publish: (ref, license, as) =>
      write(() => engine.publish({ ref, ...(license !== undefined && license !== '' ? { license } : {}), ...(as !== undefined && as !== '' ? { as } : {}) }) as EditResult),
    unpublish: (ref) => write(() => engine.unpublish({ ref }) as EditResult),
    publicationMeta: async (ref) => {
      const bundle = engine.publication(ref, { frameworks: await fwList() });
      if (bundle === null || bundle === undefined) return undefined;
      const pub = (bundle as { publication: { contentHash: string; trackId: string; title: string } }).publication;
      return { contentHash: pub.contentHash, trackId: pub.trackId, title: pub.title };
    },
    pushToRegistry: async (ref) => {
      const reg = await resolveRegistry();
      if (reg === undefined) throw blocked('publish');
      // Same-origin only. Anywhere else the session cookie is not sent, the write is refused as
      // cross-site, and pretending otherwise would fail confusingly rather than plainly.
      if (reg.registry !== window.location.origin) {
        throw new Error(`this page is not served by ${reg.registry}, so it cannot publish there — publish from a Philomatic that is`);
      }
      return pushBundleSameOrigin(reg.registry, engine.publication(ref, { frameworks: await fwList() }));
    },
    link: (edge) => write(() => engine.link(edge)),
    unlink: (edge) => write(() => engine.unlink(edge)),
    getRemoved: async () => ({ version: READ_VERSION, removed: engine.removed() }) as RemovedEnvelope,
    getTimeline: async () => ({ version: READ_VERSION, timeline: engine.timeline() }) as TimelineEnvelope,
    getQuestions: async () => ({ version: READ_VERSION, questions: engine.questions() }) as QuestionsEnvelope,
    getRelations: async (id) => ({ version: READ_VERSION, relations: engine.relations(id) }) as RelationsEnvelope,
    getGraph: async () => ({ version: READ_VERSION, ...(engine.graph() as object) }) as GraphEnvelope,
    exportAll: async () => engine.exportAll(),
    exportLive: async () => engine.exportLive(),
    importPayload: async (payload) => {
      const isBundle = typeof payload === 'object' && payload !== null && 'pubVersion' in payload;
      await write(() => {
        // The same sniff the server's /import route performs: a publication
        // bundle imports as a FORK — lineage recorded, arrives unpublished. Without this, the
        // browser engine rejected a fork download with a bare Zod version error while the HTTP
        // path accepted it (the exact Principle-9 drift class).
        if (isBundle) {
          engine.importPublication(payload, {});
          return;
        }
        engine.importPayload(payload);
      });
      if (isBundle) await installBundleDefs(payload);
    },
    // The examples come from whoever served this page — the workbench's own server reads them off
    // disk, and so does a registry serving the workbench. Same URL either way.
    listExamples: async () => (await getJson<{ examples: ExampleMeta[] }>('/examples'))?.examples ?? [],
    getExample: async (name) => {
      const payload = await getJson<Record<string, unknown>>(`/examples?name=${encodeURIComponent(name)}`);
      if (payload === undefined) throw blocked('examples');
      return payload;
    },
    getRegistry: resolveRegistry,
    // The bundle is fetched HERE and imported HERE (the server's /registry-fork imports into the
    // server's own library, which is the wrong library when the engine is in this tab). It is the
    // same importPublication call, so lineage and the archived parent come for free — a real fork,
    // not a copy of the visible fields. A published bundle is public and the registry sends
    // permissive CORS on it, so this is a read the registry has explicitly opened.
    pullFork: async (ref) => {
      const track = (engine.exportAll() as { tracks: { id: string; title: string; origin?: { url?: string; contentHash: string } }[] }).tracks.find(
        (t) => t.id === ref || t.title === ref,
      );
      const origin = track?.origin;
      if (track === undefined || origin?.url === undefined) throw new Error('this track is not a fork of a registry track — nothing to pull from');
      const current = await getJson<unknown>(`${origin.url}.json`);
      if (current === undefined) throw new Error(`the registry no longer serves ${origin.url}`);
      // The BASE — the version this fork last saw — from the registry archive; absent (an old
      // registry, a purged archive) the pull degrades to pure addition and says so.
      const base = await getJson<unknown>(`${origin.url}.json?version=${origin.contentHash}`);
      const pulled = await write(() => engine.pullPublication(current, base));
      await installBundleDefs(current);
      return pulled;
    },
    forkRegistryTrack: async (trackId) => {
      const reg = await resolveRegistry();
      if (reg === undefined) throw blocked('registry');
      const url = `${reg.registry}/t/${encodeURIComponent(trackId)}.json`;
      const bundle = await getJson<unknown>(url);
      if (bundle === undefined) throw new Error(`the registry at ${reg.registry} has no track "${trackId}"`);
      const forked = await write(() => engine.importPublication(bundle, { originUrl: url.replace(/\.json$/, '') }));
      await installBundleDefs(bundle);
      return { forked: true, ...forked };
    },

    // ── The framework store: built-ins from the bake, mine + installed from the
    // injected document store. Same refusals as the server route, or the hosts drift.
    frameworks: async () => {
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      const builtin = FRAMEWORKS as unknown as FrameworkFile[];
      const mine = doc.mine as FrameworkFile | undefined;
      const installed = (doc.installed ?? []) as FrameworkFile[];
      const viewOverrides = (doc as { viewOverrides?: ViewOverrides }).viewOverrides;
      const enabledBuiltins = ((doc as { enabledBuiltins?: string[] }).enabledBuiltins ?? []) as readonly string[];
      const disabledInstalled = ((doc as { disabledInstalled?: string[] }).disabledInstalled ?? []) as readonly string[];
      return { builtin, ...(mine !== undefined ? { mine } : {}), installed, ...(viewOverrides !== undefined ? { viewOverrides } : {}), enabledBuiltins, disabledInstalled };
    },
    saveMyFramework: async (def) => {
      assertFrameworkFile(def);
      if ((FRAMEWORKS as readonly { framework: string }[]).some((f) => f.framework === def.framework)) {
        throw new Error(`"${def.framework}" is a built-in framework name — pick your own`);
      }
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      await frameworkStore.save({ ...doc, mine: normalizeFrameworkFile(def) });
    },
    installFramework: async (def) => {
      assertFrameworkFile(def);
      if ((FRAMEWORKS as readonly { framework: string }[]).some((f) => f.framework === def.framework)) {
        throw new Error(`"${def.framework}" is a built-in framework name — nothing to install`);
      }
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      const installed = [...(doc.installed as FrameworkFile[]).filter((f) => f.framework !== def.framework), normalizeFrameworkFile(def)];
      await frameworkStore.save({ ...doc, installed });
    },
    removeFramework: async (name) => {
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      await frameworkStore.save({ ...doc, installed: (doc.installed as FrameworkFile[]).filter((f) => f.framework !== name) });
    },
    saveViewOverrides: async (overrides) => {
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      await frameworkStore.save({ ...doc, viewOverrides: { tags: overrides.tags ?? {}, types: overrides.types ?? {} } } as { mine?: unknown; installed: unknown[] });
    },
    setEnabledBuiltins: async (names) => {
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      await frameworkStore.save({ ...doc, enabledBuiltins: [...names] } as { mine?: unknown; installed: unknown[] });
    },
    setDisabledInstalled: async (names) => {
      const doc = (await frameworkStore.load()) ?? { installed: [] };
      await frameworkStore.save({ ...doc, disabledInstalled: [...names] } as { mine?: unknown; installed: unknown[] });
    },
  };
}
