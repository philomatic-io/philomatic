/**
 * The lifecycle SCENARIO HARNESS — one cast, one stage.
 *
 * Every shared-track progression (the classroom, the fork, the decline, the goodbye…) needs
 * the same company: named personas with a session, a provisioned hosted library, and API
 * helpers for the verbs the stories use — plus STATE PROBES over the stores the progressions
 * assert against. Before this file each test hand-rolled those ~30 lines; the harness is also
 * the first Cluster-M dedup win (the copies move up to tier 1: one implementation, imported).
 *
 * Division of labor: pure state transitions assert over HTTP through personas and
 * probes — fast, no browser. Playwright enters only where the assertion is ABOUT the UI
 * surface (the inbox accept, the tabs); `openWorkbench` hands tests a signed-in page and
 * nothing else, so the UI assertions stay in the tests that own them.
 */
import { oneOriginStack, usernameOf, type OneOrigin } from './one-origin';

export type { OneOrigin };
export { oneOriginStack, usernameOf };

// ── The wire shapes the progressions read (structural, minimal) ────────────────────────────

export interface Bundle {
  publication: { trackId: string; title: string; author?: string; contentHash?: string };
  payload: {
    sources: { id: string; title: string }[];
    questions?: { id: string; text: string }[];
    concepts?: { id: string; name: string }[];
  };
}

export interface PullSummary {
  took: number;
  keptYours: number;
  upstreamDeleted: number;
  edgesAdded: number;
}

export interface Contribution {
  kind: string;
  name: string;
  text: string;
  title?: string;
  aboutTitle?: string;
  url?: string;
  author?: string;
}

// ── The cast ───────────────────────────────────────────────────────────────────────────────

export interface Persona {
  /** The sign-in subject ("Alice A"). */
  name: string;
  /** The public handle the fixture claimed ("Alice-A") — what mailboxes attribute to. */
  handle: string;
  /** The pm_session cookie VALUE. */
  cookie: string;

  post(path: string, body?: unknown): Promise<Response>;
  getJson<T>(path: string): Promise<T>;

  /** POST /app/ingest — capture a source into the hosted library. */
  ingest(input: { url?: string; title: string; track?: string }): Promise<Response>;
  /** POST /app/publish — stamp the track published locally. */
  publishLocal(ref: string): Promise<Response>;
  /** GET /app/publication — the track's bundle as this library would ship it. */
  publication(ref: string): Promise<Bundle>;
  /** POST /publish — push a bundle to the registry. Returns the raw Response so refusals
   *  (the stranger's 403) are assertable; use `publishAndPush` for the happy path. */
  push(bundle: unknown): Promise<Response>;
  /** publish + mint bundle + push, asserting the push landed. The classroom opener. */
  publishAndPush(ref: string): Promise<Bundle>;

  /** POST /t/:id/community {invite:'mint'} → the join token. */
  mintInvite(trackId: string): Promise<string>;
  /** POST /t/:id/community — the owner's admin verbs (revoke, eject, unlisted…). */
  community(trackId: string, body: unknown): Promise<Response>;
  /** POST /t/:id/join?c=token. */
  join(trackId: string, token: string): Promise<Response>;
  /** POST /app/registry-fork — fork a registry track into this library. */
  forkRegistry(trackId: string): Promise<Response>;
  /** POST /t/:id/contributions — submit to the track's mailbox. */
  contribute(trackId: string, c: Record<string, unknown>): Promise<Response>;
  /** POST /app/pull → the pull summary. */
  pull(ref: string): Promise<PullSummary>;
  /** POST /app/update. */
  update(ref: string, patch: Record<string, unknown>): Promise<Response>;
  /** POST /app/link. */
  link(edge: Record<string, unknown>): Promise<Response>;
}

function persona(stack: OneOrigin, name: string, cookie: string): Persona {
  const { url } = stack;
  const hdr = { cookie: `pm_session=${cookie}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } as const;
  const post = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method: 'POST', headers: hdr, body: body === undefined ? undefined : JSON.stringify(body) });
  const getJson = async <T>(path: string): Promise<T> => (await fetch(`${url}${path}`, { headers: hdr })).json() as Promise<T>;
  const p: Persona = {
    name,
    handle: usernameOf(name),
    cookie,
    post,
    getJson,
    ingest: (input) => post('/app/ingest', input),
    publishLocal: (ref) => post('/app/publish', { ref }),
    publication: (ref) => getJson<Bundle>(`/app/publication?ref=${encodeURIComponent(ref)}`),
    push: (bundle) => post('/publish', bundle),
    publishAndPush: async (ref) => {
      await post('/app/publish', { ref });
      const bundle = await getJson<Bundle>(`/app/publication?ref=${encodeURIComponent(ref)}`);
      const r = await post('/publish', bundle);
      if (r.status !== 200) throw new Error(`push of “${ref}” refused: ${r.status} ${await r.text()}`);
      return bundle;
    },
    mintInvite: async (trackId) => {
      const minted = (await (await post(`/t/${trackId}/community`, { invite: 'mint' })).json()) as { invite: { link: string } };
      return new URL(minted.invite.link).searchParams.get('c')!;
    },
    community: (trackId, body) => post(`/t/${trackId}/community`, body),
    join: (trackId, token) => post(`/t/${trackId}/join?c=${token}`),
    forkRegistry: (trackId) => post('/app/registry-fork', { trackId }),
    contribute: (trackId, c) => post(`/t/${trackId}/contributions`, c),
    pull: async (ref) => (await (await post('/app/pull', { ref })).json()) as PullSummary,
    update: (ref, patch) => post('/app/update', { ref, patch }),
    link: (edge) => post('/app/link', edge),
  };
  return p;
}

/**
 * Mint the named personas — each signed in and (by default) with a provisioned hosted
 * library. Keys are yours; values are the sign-in subjects (whose slug becomes the handle):
 *
 *   const { prof, alice } = await cast(stack, { prof: 'Prof', alice: 'Alice A' });
 */
export async function cast<K extends string>(
  stack: OneOrigin,
  spec: Record<K, string>,
  opts: { provision?: boolean } = {},
): Promise<Record<K, Persona>> {
  const out = {} as Record<K, Persona>;
  for (const key of Object.keys(spec) as K[]) {
    const name = spec[key];
    const p = persona(stack, name, await stack.signIn(name));
    if (opts.provision !== false) {
      const r = await p.post('/app/account/library');
      if (r.status !== 200) throw new Error(`provisioning ${name}'s library failed: ${r.status}`);
    }
    out[key] = p;
  }
  return out;
}

// ── The probes: the stores progressions assert against ─────────────────────────────────────

/** The persona's graph, as their own API reports it — sources and questions with tags. */
export async function graphOf(p: Persona): Promise<{
  sources: { id: string; title: string; author?: string; estimatedDurationMins?: number; staged?: boolean; tags?: string[] }[];
  questions: { id: string; text: string; staged?: boolean; tags?: string[] }[];
}> {
  const [snap, qs] = await Promise.all([
    p.getJson<{ sources: { id: string; title: string; author?: string; estimatedDurationMins?: number; staged?: boolean; tags?: string[] }[] }>('/app/sources'),
    p.getJson<{ questions: { id: string; text: string; staged?: boolean; tags?: string[] }[] }>('/app/questions'),
  ]);
  return { sources: snap.sources, questions: qs.questions };
}

/** One entity's relations, stringified for contains-assertions over ids. */
export async function relationsOf(p: Persona, id: string): Promise<string> {
  return JSON.stringify(await p.getJson<unknown>(`/app/relations?id=${encodeURIComponent(id)}`));
}

/** The track's pending mailbox, as `reader` (the track owner sees all; a member their own). */
export async function mailboxOf(reader: Persona, trackId: string): Promise<Contribution[]> {
  const r = await reader.getJson<{ contributions: Contribution[] }>(`/t/${trackId}/contributions`);
  return r.contributions;
}

/** What the persona follows (the feed's source of truth). */
export async function followingOf(p: Persona): Promise<{ trackId: string; sawHash?: string }[]> {
  const r = await p.getJson<{ following: { trackId: string; sawHash?: string }[] }>('/account/following');
  return r.following;
}

/**
 * The registry's PUBLIC face for a track — fetched with NO cookie, so the probe itself
 * re-asserts the no-leak wall: whatever it returns is what a stranger sees.
 */
export async function registryEntryOf(
  stack: OneOrigin,
  trackId: string,
): Promise<{ status: number; bundle?: Bundle; meta?: { contentHash?: string } }> {
  const r = await fetch(`${stack.url}/t/${encodeURIComponent(trackId)}.json`);
  if (r.status !== 200) return { status: r.status };
  const m = await fetch(`${stack.url}/t/${encodeURIComponent(trackId)}.json?meta=1`);
  return {
    status: 200,
    bundle: (await r.json()) as Bundle,
    meta: m.status === 200 ? ((await m.json()) as { contentHash?: string }) : undefined,
  };
}

// ── The one browser helper (UI assertions stay in the tests) ───────────────────────────────

/** A signed-in workbench page for the persona — the caller owns the assertions AND the
 *  browser (close it). `path` defaults to the workbench; pass a /t/… page to land there. */
export async function openWorkbench(stack: OneOrigin, p: Persona, path = '/app') {
  const { chromium } = await import('playwright-core');
  const { findChromium } = (await import('./harness')) as unknown as { findChromium?: () => string };
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium?.(),
    headless: true,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'pm_session', value: p.cookie, url: stack.url }]);
  const page = await ctx.newPage();
  await page.goto(`${stack.url}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(path.startsWith('/app') ? '.topbar' : '.pub-toolbar, .pub-tabs', { timeout: 20000 });
  return { browser, page };
}
