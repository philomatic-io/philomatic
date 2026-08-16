/**
 * Ingest service — a localhost HTTP
 * *transport* over the engine. It parses/authorizes requests and formats responses; ALL write
 * logic lives behind the facade (`engine.captureSource` / `engine.captureSnippet`), which owns id
 * derivation, validation, edge-building, and safe upsert. The write contract is the engine's
 * versioned capture schema (`src/engine/capture.ts`), not this file.
 *
 *   WRITE  POST /ingest   → engine.captureSource(body [+ adapter-resolved facts])
 *          POST /snippet  → engine.captureSnippet(body)
 *          POST /ask | /answer → the behavioral verbs on an existing question (`{question}`) —
 *                          the UI's "ask" / "mark answered" actions
 *          POST /remove | /restore | /update → the edit primitives (DATA_MODEL.md) — retraction/
 *                          supersession semantics live entirely behind the facade
 *   READ   GET /snapshot  → engine.snapshot() — the whole versioned envelope the React viewer
 *                          consumes (src/engine/read.ts — nothing computed here)
 *          GET /tracks | /sources | /snippets → the same views as per-collection slices
 *                          (kept for older clients: the extension's option/view fetches)
 *          GET /assemble[?track=ref] → engine.assemble() — the journey projection
 *          GET /removed  → the trash-bin projection (engine.removed())
 *          GET / + /assets/* → serves the built React viewer —
 *                          static files only, with a build-pointer page when unbuilt. The old
 *                          browser/view.html retired with the React viewer (git history has it).
 *          GET /health   → { ok: true }
 *
 * CORS-enabled (the bookmarklet's fetch runs in the visited page's origin); optional shared
 * `X-Ingest-Token` guards writes when `INGEST_TOKEN` is configured.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LEARNER, FRAMEWORKS, loadFrameworkDoc, parseFrameworkFile, PhilomaticEngine, READ_VERSION, saveFrameworkDoc, sourceId, ViewOverridesSchema } from '../engine';
import { cachedVerifier, EnginePool, hostedTenants, originAllowed, presentedToken, registryVerifier, sessionVerifier, singleTenant, type TenantResolver } from './tenancy';
import { envKek, resolveDEK, type Kek } from './keys';
import { safeFetch } from './safe-fetch';
import { callerKey, RateLimiter } from './rate-limit';
import { loadConfig, type ServerConfig } from './config';
import { UsageLedger, usagePath } from './usage';
import { applyResolvers, normalizeText } from './adapters';
import { llmConfig } from './llm';
import { DEFAULT_PROPOSE, propose, type ConceptCandidate, type ProposeConfig } from './propose';
import { DEFAULT_PROPOSE_TRACK, proposeTrack, type ProposeTrackConfig } from './propose-track';
import { amazonAdapter } from './amazon-adapter';
import { escHtml, publicShellHtml } from './public-shell';
// The bundled example tracks: read from disk, so they stay maintained
// where they live and cost the UI bundle nothing. Shared with the registry, which serves them to
// browser-mode workbenches it hosts.
import { exampleList, readExample } from './examples';
import { SECURITY_HEADERS } from './csp';
import { withPriorSourceFields } from '../engine/prior-fields';

/** A handler error carrying an HTTP status; caught at the boundary and rendered as JSON. */
export class IngestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

// The view shapes live in the engine's read contract (src/engine/read.ts); re-exported here only
// for transport-level consumers already importing them from this module.
export type { SnippetView, SourceView, TrackView } from '../engine';

/**
 * The viewer is the built React app — still a pure client of the
 * JSON read contract, served as static files on `GET /` + `/assets/*`. Files are read fresh per
 * request (a rebuild shows on refresh, no server restart). Serving is allow-listed to
 * `index.html` and `assets/` — no directory walking, no other paths.
 */
const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  // The in-browser engine's SQLite (this server can host it). Without the exact type
  // the browser refuses to STREAM-compile it and silently falls back to the slow path.
  '.wasm': 'application/wasm',
};


const UNBUILT_HTML = `<!doctype html><meta charset="utf-8">
<p>The viewer is not built yet. Run <code>pnpm ui:build</code>, then reload — this server serves
<code>ui/dist</code> here. (The old static <code>browser/view.html</code> retired with the React
viewer; git history has it.)</p>`;

function serveUi(res: ServerResponse, urlPath: string, dist: string): void {
  const rel = urlPath === '/' || urlPath === '/index.html' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = resolve(dist, rel);
  const indexFile = join(dist, 'index.html');
  if (file !== indexFile && !file.startsWith(join(dist, 'assets') + sep)) {
    sendJson(res, 404, { error: `no route: GET ${urlPath}` });
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream', ...CORS_HEADERS, ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    if (file === indexFile) sendHtml(res, 200, UNBUILT_HTML);
    else sendJson(res, 404, { error: `not found: ${urlPath}` });
  }
}

export interface ServerOptions {
  /** SQLite file shared with the CLI. Defaults to `INGEST_DB` env or `.philomatic/philomatic.sqlite`. */
  db?: string;
  /**
   * Hosting (the hosting design). Absent → single-tenant: one database, today's
   * optional token, unchanged. `dataDir` + `registry` together turn on hosting, where a
   * personal access token resolves to that account's own file. `tenants` overrides both, for
   * tests and for a deployment that resolves differently.
   */
  dataDir?: string;
  /** Pre-loaded settings; omitted, they come from the config file and the environment. */
  config?: ServerConfig;
  tenants?: TenantResolver;
  /** The key-encryption key for at-rest encryption. Omitted → `PHILOMATIC_KEK` from the env
   *  (and, in production, the KMS adapter). Tests inject one directly. */
  kek?: Kek;
  pool?: { cap?: number; idleMs?: number };
  /** Loopback host to bind. Default: 127.0.0.1 (local-first;). */
  host?: string;
  port?: number;
  /** If set, writes require a matching `X-Ingest-Token` header. Default: `INGEST_TOKEN` env. */
  token?: string;
  /** This instance's learner id (tenancy prep): writes land under it and reads scope to it
   *  unless a request says otherwise. Default: `INGEST_LEARNER` env, else the seeded single
   *  tenant (and reads fold all learners, as before per-learner tenancy). */
  learner?: string;
  /** Injected clock, forwarded to the engine (tests pin time). */
  now?: () => number;
  /** Directory of built viewer assets served at `GET /`. Default: `ui/dist` (tests inject one). */
  uiDist?: string;
  /** The community track registry this instance browses/forks from. Default:
   *  `REGISTRY_URL` env; unset = the community section simply doesn't exist. */
  registry?: string;
  /** Mount prefix — see `ServerConfig.basePath`. Default: config/env. */
  basePath?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token',
  'Access-Control-Max-Age': '86400',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS, ...SECURITY_HEADERS });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // 8MB: region-capture snippets carry data-URI PNGs (a 1600px crop can pass 1MB alone).
      if (size > 8_000_000) reject(new IngestError(413, 'body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Build the ingest HTTP server over an engine opened on `db`. The caller owns the returned
 * server's lifecycle (`.listen`, `.close`); the engine is closed when the server closes.
 */
export function createIngestServer(opts: ServerOptions = {}): Server {
  const dbPath = opts.db ?? process.env.INGEST_DB ?? '.philomatic/philomatic.sqlite';
  const token = opts.token ?? process.env.INGEST_TOKEN;
  const now = opts.now ?? (() => Date.now());
  const uiDist = opts.uiDist ?? UI_DIST;
  // One place an operator's settings come from: a config file, overridden by the environment
  // (config.ts). Secrets are NOT in it, deliberately.
  const config = opts.config ?? loadConfig();
  const instanceLearner = opts.learner ?? process.env.INGEST_LEARNER;
  const registryUrl = (opts.registry ?? process.env.REGISTRY_URL)?.trim().replace(/\/$/, '');

  // A pre-v2 store migrates at boot (backup kept beside it) — otherwise every read would fail
  // schema validation against the v2 model. Deterministic rebuild, no-op when already v2.
  const migration = PhilomaticEngine.migrateDbV2(dbPath);
  if (migration.migrated) {
    console.log(`model v2: migrated ${dbPath} (your v1 store is kept at ${migration.backupPath})`);
  }
  // ── whose library? (the hosting design) ────────────────────────────────
  //
  // The engine is no longer opened once for the process: it is resolved PER REQUEST, from the
  // credential, at the transport boundary — the tenancy commitment requires exactly this.
  // Single-tenant mode resolves every request to the same file, so a laptop sees exactly what it
  // saw before; hosting mode resolves each account to its own.
  const pool = new EnginePool(opts.pool ?? { cap: config.poolCap, idleMs: config.poolIdleMs });
  // Hosting is ON when a data directory and a registry are both configured — a place to put
  // libraries, and something that can say whose they are. Either alone is not enough, and
  // neither is the default, so a laptop stays single-tenant without opting out of anything.
  const dataDir = opts.dataDir ?? config.dataDir;
  // Configured HALFWAY is a refusal, not a fallback. Falling back to single-tenant here would
  // serve one person's library to everyone who asks, with no credential, and look perfectly
  // healthy doing it — the operator asked for hosting and got the opposite in silence. That is
  // exactly what once happened: this read `opts.registry` rather than the RESOLVED
  // `registryUrl`, so a REGISTRY_URL in the environment left hosting off and INGEST_DB pointed
  // at the owner's own library.
  //
  // INGEST_DATA_DIR alone turns hosting on. REGISTRY_URL does NOT: it already means "the registry
  // this workbench browses for community tracks", which a single-tenant server may
  // perfectly well have. Reading it as a hosting signal broke exactly that case.
  const hosting = dataDir !== undefined;
  if (hosting && (registryUrl === undefined || registryUrl === '')) {
    throw new Error(
      'hosting needs a registry to say whose libraries these are: set REGISTRY_URL alongside INGEST_DATA_DIR, or unset INGEST_DATA_DIR for single-tenant.',
    );
  }
  if (hosting) {
    // 0700 on the directory is what actually protects the libraries: SQLite creates its file,
    // -wal and -shm with the process umask, so gating the way IN is simpler and harder to get
    // wrong than chasing three files per account. Done here rather than in the resolver, which
    // decides paths and touches no disk — and after the refusal above, so a misconfigured server
    // leaves nothing behind.
    // …and chmod it, because `recursive: true` makes mkdirSync a NO-OP on a directory that
    // already exists, mode and all. Without this the tightening applies to new deployments and
    // silently skips every upgraded one — which is the deployment that already has libraries in
    // it to protect (found on the owner's box: 0755 after the fix landed).
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
  }
  // Encryption at rest for hosted libraries. A configured KEK means every library is minted
  // encrypted (its DEK wrapped beside it); no KEK means plaintext. On a HOSTED server that is a
  // refusal, not a fallback: multi-tenant plaintext is a mistake nobody notices until it
  // matters, so an operator must either configure a key or say `PHILOMATIC_ALLOW_PLAINTEXT=1`
  // out loud. Single-tenant (one person, their own machine) stays plaintext by default.
  const kek = opts.kek ?? envKek();
  if (hosting && kek === undefined && process.env.PHILOMATIC_ALLOW_PLAINTEXT !== '1') {
    throw new Error(
      'hosting stores other people’s libraries: set PHILOMATIC_KEK (or PHILOMATIC_KMS_KEY) to encrypt them at rest, or set PHILOMATIC_ALLOW_PLAINTEXT=1 to accept plaintext deliberately.',
    );
  }
  /** The raw DEK for a tenant's library, or undefined when encryption is off. Called only on a
   *  pool open (never on a cache hit), so the unwrap cost is per library-open, not per request. */
  const keyFor = (tenant: { keyPath?: string }) => () => (tenant.keyPath !== undefined && kek !== undefined ? resolveDEK(tenant.keyPath, kek) : undefined);
  // Capture and the propose chain ask this server to fetch a URL somebody typed. On a hosted
  // instance that somebody is a stranger, so the fetch is guarded: no loopback, no private
  // range, no link-local, and every redirect re-checked (safe-fetch.ts). Single-tenant is left
  // alone deliberately — fetching from your own network on your own machine is a legitimate
  // thing to do, and forbidding it protects nobody.
  const outboundFetch = hosting ? safeFetch() : undefined;
  /**
   * How this server proves who it is when it PUSHES.
   *
   * A registry that offers sign-in requires an account to publish, and a server has no session —
   * so it carries an account's access token. Absent is fine and common: a registry with no
   * sign-in configured takes the key rule, and pushing to one needs nothing.
   */
  const registryAuth = (target: string): Record<string, string> =>
    // ONLY to the registry the credential belongs to. `/push` lets a self-hoster name their
    // target — that is the point of the command — so an unconditional header would mail this
    // server's account token to whatever address a caller typed. Same reasoning as the hosted
    // instance refusing a tenant-chosen target, one layer in.
    config.registryToken !== undefined && registryUrl !== undefined && target === registryUrl.replace(/\/$/, '')
      ? { authorization: `Bearer ${config.registryToken}` }
      : {};
  const verifyTtlMs = config.tokenVerifyTtlMs;
  // Rate limits on a HOSTED instance (hardening). Only where the cost is real and
  // borne by the operator rather than the caller: a fetch of somebody else's website, and an LLM
  // pass somebody else pays for. Ordinary reads and writes are left alone — a limit on /snapshot
  // would throttle normal use to defend against nothing the tenant seam does not already stop.
  const limiter = hosting ? new RateLimiter() : undefined;
  const trustProxy = config.trustProxy;
  // The operator's LLM bill, metered per account and per calendar month (usage.ts). Only hosted:
  // on your own machine the budget is your own credit card and you already know about it.
  const usage = hosting && dataDir !== undefined ? new UsageLedger(usagePath(dataDir)) : undefined;
  /**
   * Spend one LLM pass against this tenant's monthly allowance; true when they are out.
   *
   * 402 rather than 429: this is not "too fast, try again shortly" but "this costs the operator
   * money and you have had your share". Telling someone to retry when retrying cannot work is
   * the more annoying lie.
   */
  const overBudget = (res: ServerResponse, accountId: string): boolean => {
    const refusal = usage?.spendOne(accountId, config.llmCallsPerMonth);
    if (refusal === undefined) return false;
    res.writeHead(402, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: refusal }));
    return true;
  };

  /** Spend one against this tenant's budget; answers true when they should be told to wait. */
  const limitedExpensive = (req: IncomingMessage, res: ServerResponse, accountId: string): boolean => {
    if (limiter === undefined) return false;
    const wait = limiter.take(`expensive:${callerKey(req, { accountId, trustProxy })}`, { capacity: 6, perSecond: 0.05 });
    if (wait === 0) return false;
    res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: `too many requests — try again in ${wait}s` }));
    return true;
  };
  const resolver: TenantResolver =
    opts.tenants ??
    (hosting
      ? hostedTenants({
          dataDir,
          // The TTL is the revocation delay, so it is CONFIG rather than a constant:
          // an operator can tighten it on a busy instance without touching code, at the price of
          // more traffic to the registry. 0 means ask every time — correct, and the round trip
          // per request the cache exists to avoid.
          verify: cachedVerifier(registryVerifier(registryUrl!), { ttlMs: verifyTtlMs }),
          // Sessions, asked about the same way and cached the same way. The
          // host holds no SESSION_SECRET: one question to the registry answers signature AND
          // revocation, and the signing key stays in one process.
          verifySession: cachedVerifier(sessionVerifier(registryUrl!), { ttlMs: verifyTtlMs }),
          encrypted: kek !== undefined,
        })
      : singleTenant(dbPath));

  // ── The session→learner seam ──────────────────────────────────────────────────────────────
  // ONE place resolves "who is acting": an explicit learnerId in the body, a ?learner= query,
  // then the instance's configured learner. Real authentication (passkeys/OIDC)
  // replaces the front of this chain later; the engine stays tenancy-free throughout.
  const queryLearner = (req: IncomingMessage): string | undefined =>
    new URL(req.url ?? '/', 'http://localhost').searchParams.get('learner') ?? undefined;
  const writeLearner = (req: IncomingMessage, body: Record<string, unknown>): string => {
    const explicit = typeof body.learnerId === 'string' ? body.learnerId.trim() : '';
    return explicit || queryLearner(req) || instanceLearner || DEFAULT_LEARNER;
  };
  /** For reads `undefined` means the all-learners fold (the legacy single-tenant view). */
  const readLearner = (req: IncomingMessage): string | undefined => queryLearner(req) ?? instanceLearner;

  // ── Live change feed ─────────────────────────────────────────────────────────────────────────
  // GET /changes holds an SSE stream per client; every successful write broadcasts one event.
  // The payload is just a sequence number — clients refetch through the read contract, so the
  // feed carries no data shape of its own (nothing to version).
  const sseClients = new Set<ServerResponse>();
  let changeSeq = 0;
  const dropClient = (client: ServerResponse): void => {
    sseClients.delete(client);
    client.destroy();
  };
  const broadcastChange = (): void => {
    changeSeq++;
    for (const client of sseClients) {
      try {
        client.write(`data: {"seq":${changeSeq}}\n\n`);
      } catch {
        dropClient(client);
      }
    }
  };
  // Heartbeat: a stream stuck in a dead intermediary (the dev
  // container's VSCode port forward) is invisible without traffic — zombie connections pile up
  // against the browser's per-host limit until every request queues forever. The comment line
  // is invisible to EventSource; a failed write is how we LEARN a client is gone.
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': hb\n\n');
      } catch {
        dropClient(client);
      }
    }
  }, 25_000);
  heartbeat.unref();

  // Close libraries nobody has touched lately. Without a sweeper the pool only ever
  // grows: it evicts opportunistically when opening a NEW library, so a server that reaches its
  // working set and then goes quiet would hold every file open until it restarted.
  const sweeper = setInterval(() => pool.evictIdle(), 60_000);
  sweeper.unref();

  const basePath = opts.basePath ?? config.basePath;
  const server = createServer((req, res) => {
    // ── the mount prefix ─────────────────────────────────────────────────
    // On the one-origin deploy the registry owns `/` and this server answers under `/app`:
    // requests arrive prefixed, and stripping it HERE means every route below keeps its name.
    // A bare (unprefixed) path still routes — behind the proxy only prefixed traffic reaches
    // this process, and everywhere else (loopback, tests, self-hosted at the root) the prefix
    // simply never appears. `/app` exactly (no slash) is the app itself.
    if (basePath !== '' && req.url !== undefined && (req.url === basePath || req.url.startsWith(`${basePath}/`) || req.url.startsWith(`${basePath}?`))) {
      const stripped = req.url.slice(basePath.length);
      req.url = stripped === '' || stripped.startsWith('?') ? `/${stripped}` : stripped;
    }
    void resolveAndHandle(req, res)
      .then(() => {
        // Every write route is a POST; a 2xx POST means the graph changed (idempotent no-ops
        // included — an extra client refetch is harmless, a missed one is not).
        if (req.method === 'POST' && res.statusCode < 300) broadcastChange();
      })
      .catch((err) => {
        // Transport errors carry their own status; capture-validation and everything else → 400
        // with the message (never leak a stack). CaptureError is the engine's input-validation type.
        if (err instanceof IngestError) sendJson(res, err.status, { error: err.message });
        else sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      });
  });

  /**
   * The transport's own routes: preflight, health, the framework declarations, and the built app
   * itself. None reads or writes a graph, so none needs to know whose it would be.
   *
   * Returns true when it has answered.
   */
  function withoutLibrary(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }
    // Who am I, asked of the workbench's OWN origin. The SPA must not have to
    // know the registry's address to ask whether it is signed in — and on the one-origin deploy
    // it genuinely is the same site. Public on purpose: the answer for a signed-out visitor is
    // "no", which is exactly what the page needs in order to offer a way in.
    if (method === 'GET' && path === '/auth/me') {
      if (!hosting) {
        // A single-tenant server has no accounts and never will. Saying so plainly beats
        // a 404 the client has to interpret.
        sendJson(res, 200, { hosted: false, signedIn: false, providers: [] });
        return true;
      }
      void (async () => {
        let upstream: { signedIn?: boolean; account?: unknown; providers?: unknown; needsUsername?: boolean } = {};
        try {
          const r = await fetch(`${registryUrl}/auth/me`, {
            headers: { ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}) },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) upstream = (await r.json()) as typeof upstream;
        } catch {
          /* the registry is unreachable — answer "signed out" rather than fail the page */
        }
        // Whether a LIBRARY exists is ours to answer, and it is the question the start surface
        // actually turns into an offer.
        const tenant = upstream.signedIn === true ? await resolver.resolve(req) : undefined;
        sendJson(res, 200, {
          hosted: true,
          signedIn: upstream.signedIn === true,
          ...(upstream.account !== undefined ? { account: upstream.account } : {}),
          ...(upstream.needsUsername !== undefined ? { needsUsername: upstream.needsUsername } : {}),
          providers: upstream.providers ?? [],
          hasLibrary: tenant?.provisioned === true,
          registry: registryUrl,
        });
      })();
      return true;
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === 'GET' && path !== undefined && (path === '/' || path === '/index.html' || path.startsWith('/assets/'))) {
      serveUi(res, path, uiDist);
      return true;
    }
    // On a hosted instance a public page lives at the registry. Answering here keeps a
    // link already in the wild working for someone who has no credential and never will.
    if (hosting && method === 'GET' && path !== undefined && path.startsWith('/t/')) {
      const rest = decodeURIComponent(path.slice('/t/'.length));
      res.writeHead(302, { Location: `${registryUrl}/t/${encodeURIComponent(rest)}`, ...CORS_HEADERS });
      res.end();
      return true;
    }
    return false;
  }

  /**
   * Decide whose library this is, then run the request against it and only it. A request that
   * names no library it may touch is a 401 — the same answer for an unknown token, a revoked
   * one and a missing header, because telling them apart tells an attacker which they got right.
   */
  async function resolveAndHandle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Routes that never touch a library are answered BEFORE any credential is looked at, and
    // without opening a database.
    //
    // Otherwise a hosted server cannot be opened in a browser at all: the first request is
    // GET / for the app's own HTML, with no token — because the token lives in the app's
    // settings, which cannot load because the app cannot load. Gating the app on a credential
    // the app is supposed to collect is a door locked from the inside.
    if (withoutLibrary(req, res)) return;
    const tenant = await resolver.resolve(req);
    if (tenant === undefined) {
      // The BUILT-IN declarations stay public even where no library is in reach (they are
      // baked, secret-free data public consumers render with) — a resolved tenant instead
      // gets the merged answer with the library's own vocabulary (in `handle`).
      if ((req.method ?? 'GET') === 'GET' && (req.url ?? '/').split('?')[0] === '/framework') {
        sendJson(res, 200, { frameworks: FRAMEWORKS, builtin: FRAMEWORKS, installed: [] });
        return;
      }
      throw new IngestError(401, 'invalid or missing credentials');
    }

    // ── CSRF ────────────────────────────────────────────────────────────────
    // Ambient authority arrives WITH cookie auth: a bearer token cannot be supplied by someone
    // else's page, but a cookie is attached by the browser whether or not the page meant it, and
    // SameSite=Lax still permits a top-level POST. So a cookie-authenticated WRITE must prove it
    // came from us. A token-authenticated one is exempt — a token is pasted on purpose.
    if (!sameOriginWrite(req)) throw new IngestError(403, 'cross-site write refused');
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];

    // ── provisioning ─────────────────────────────────────────────────────
    // Signing in does NOT create a library. Someone using the in-browser engine must never find
    // that a server quietly kept a copy of their reading, so storage here is an explicit act.
    if (!tenant.provisioned) {
      if (method === 'POST' && path === '/account/library') {
        // The act itself. Opening the database is what creates the file — the same call every
        // other request makes, so there is no second creation path to keep in step.
        await pool.withEngine(tenant.dbPath, () => undefined, keyFor(tenant));
        sendJson(res, 200, { created: true, accountId: tenant.accountId });
        return;
      }
      // Not an error the caller can fix by retrying, and not a 404: the account is real and the
      // library is one deliberate POST away. The body says which.
      sendJson(res, 409, {
        error: 'no hosted library for this account yet',
        needs: 'provision',
        hint: 'POST /account/library to create one — nothing is stored here until you do',
      });
      return;
    }
    if (method === 'POST' && path === '/account/library') {
      sendJson(res, 200, { created: false, accountId: tenant.accountId });
      return;
    }
    // DELETE the whole hosted library (a hosted user has no
    // shell, so `philomatic reset` is out of reach). Cookie-authed, so the same-origin CSRF check
    // above already applies. Close the engine first — the file cannot be removed while the pool
    // holds it open — then unlink it and its SQLite sidecars. The account becomes UNPROVISIONED,
    // so the next visit lands on the storage choice, exactly as a first-time account does.
    if (method === 'POST' && path === '/account/library/delete') {
      pool.drop(tenant.dbPath);
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(`${tenant.dbPath}${suffix}`);
        } catch {
          /* already gone */
        }
      }
      // The wrapped DEK goes too: with the library gone its key is meaningless, and leaving it
      // would strand a key file the next provision would then refuse to overwrite.
      if (tenant.keyPath !== undefined) {
        try {
          rmSync(tenant.keyPath);
        } catch {
          /* already gone (or plaintext library — no key file) */
        }
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    return pool.withEngine(tenant.dbPath, (engine) => handle(req, res, engine, tenant.accountId, tenant.dbPath), keyFor(tenant));
  }

  /**
   * Is this write allowed to be ambient?
   *
   * True for every read, for every token-authenticated request, and for a write whose `Origin`
   * is this server's own. A browser attaches `Origin` to cross-site writes without exception, so
   * its ABSENCE on a non-browser client is not a gap — curl and the CLI carry a token instead,
   * and take the exemption above. `Sec-Fetch-Site` is checked first where the browser sends it,
   * because it states the relationship directly rather than by string comparison.
   */
  function sameOriginWrite(req: IncomingMessage): boolean {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    if (presentedToken(req) !== undefined) return true; // deliberate credential, not ambient
    return originAllowed(req);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, engine: PhilomaticEngine, accountId: string, tenantDb: string): Promise<void> {
    // The library's own frameworks ride every publication read:
    // without them the projection's allowlist knows only the baked set and silently strips
    // minted/installed tags at publish.
    const storeFrameworks = () => {
      const doc = loadFrameworkDoc(tenantDb);
      return [...(doc.mine !== undefined ? [doc.mine] : []), ...doc.installed];
    };
    // A bundle's carried definitions INSTALL on import: each def must match
    // a hash-covered manifest entry by name+version, or it is skipped — the manifest is the
    // integrity anchor. Same-name install replaces (an update).
    const installBundleDefs = (bundle: unknown): void => {
      const b = bundle as { payload?: { frameworks?: { name: string; version: number }[] }; frameworkDefs?: unknown[] };
      const manifest = b.payload?.frameworks ?? [];
      const defs = Array.isArray(b.frameworkDefs) ? b.frameworkDefs : [];
      if (defs.length === 0) return;
      const doc = loadFrameworkDoc(tenantDb);
      let installed = doc.installed;
      for (const raw of defs) {
        let def;
        try {
          def = parseFrameworkFile(raw);
        } catch {
          continue;
        }
        if (!manifest.some((m) => m.name === def.framework && m.version === def.version)) continue;
        if (FRAMEWORKS.some((f) => f.framework === def.framework)) continue;
        installed = [...installed.filter((f) => f.framework !== def.framework), def];
      }
      saveFrameworkDoc(tenantDb, { ...doc, installed });
    };
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];


    // The SSE change feed: held open until the client disconnects; `retry:` doubles as the
    // reconnect hint and the header flush. EventSource's built-in retry is the fallback story.
    if (method === 'GET' && path === '/changes') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS_HEADERS,
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      res.on('error', () => sseClients.delete(res));
      return;
    }


    // The PUBLIC publication routes: a published track's
    // bundle and its rendered page. Deliberately NOT token-guarded — the token guards writes and
    // these are reads of deliberately-published material; everything unpublished 404s. The page
    // route serves the viewer's index.html and the app reads /t/<id> off location.pathname.
    if (method === 'GET' && path !== undefined && path.startsWith('/t/')) {
      const rest = decodeURIComponent(path.slice('/t/'.length));
      if (method === 'GET' && rest.endsWith('.json')) {
        const bundle = engine.publication(rest.slice(0, -'.json'.length), { frameworks: storeFrameworks() });
        if (!bundle) throw new IngestError(404, 'no such publication');
        sendJson(res, 200, bundle);
        return;
      }
      if (!engine.publication(rest, { frameworks: storeFrameworks() })) throw new IngestError(404, 'no such publication');
      serveUi(res, '/', uiDist);
      return;
    }

    // Author identity: the instance's author public key — domain anchoring for signed publications.
    if (method === 'GET' && path === '/author') {
      sendJson(res, 200, { authorKey: engine.authorPublicKey() });
      return;
    }

    // Assert a structural edge (the inverse of unlink; see engine.link). A write.
    // The propose pass: the EXPLICIT "suggest structure" action.
    // Runs the LLM chain for one source, imports the proposal as ONE sugared payload, stages
    // every proposed entity, links the #RefersTo ties, and returns the summary (incl. the
    // accept-time track suggestion — never graph state). 503 when the LLM layer is disabled
    // (LLM_BASE_URL/LLM_MODEL unset — the local-first privacy default).
    /** The two LLM propose routes' shared opening: rate/budget gates, token, config, ref →
     *  learner + snapshot + resolved source. Returns
     *  undefined when a gate already wrote the response. */
    const proposeSetup = async () => {
      if (limitedExpensive(req, res, accountId)) return undefined;
      if (overBudget(res, accountId)) return undefined;
      requireToken(req, token);
      const cfg = llmConfig();
      if (!cfg) throw new IngestError(503, 'LLM is not configured (set LLM_BASE_URL and LLM_MODEL)');
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      if (!ref) throw new IngestError(400, 'ref (string) is required');
      const learnerId = writeLearner(req, body);
      const snapshotNow = engine.snapshot(learnerId);
      const src = snapshotNow.sources.find((x) => x.id === ref || x.url === ref || x.title === ref);
      if (!src) throw new IngestError(404, `no source matches "${ref}"`);
      return { cfg, body, learnerId, snapshotNow, src };
    };

    if (method === 'POST' && path === '/propose') {
      // An LLM pass on somebody else's budget, and a fetch of somebody else's website.
      const setup = await proposeSetup();
      if (setup === undefined) return;
      const { cfg, body, learnerId, snapshotNow, src } = setup;
      const config: ProposeConfig = { ...DEFAULT_PROPOSE, ...(asObject(body.config ?? {}) as Partial<ProposeConfig>) };
      // Resolution scope: a track ref narrows the concept candidates AND doubles as
      // the track context (skipping the suggestion step).
      const store = engine.exportAll();
      const scopeTrack = typeof body.scopeTrack === 'string' && body.scopeTrack.trim() !== ''
        ? snapshotNow.tracks.find((t) => t.id === body.scopeTrack || t.title === body.scopeTrack)
        : undefined;
      const scopedConceptIds = scopeTrack
        ? new Set(store.edges.filter((e) => e.type === 'INCLUDES' && e.srcId === scopeTrack.id && e.dstId.startsWith('cpt_')).map((e) => e.dstId))
        : undefined;
      const aboutTitlesOf = (cid: string): string[] =>
        store.edges
          .filter((e) => e.type === 'ABOUT' && e.dstId === cid && e.srcType === 'source')
          .map((e) => snapshotNow.sources.find((x) => x.id === e.srcId)?.title)
          .filter((t): t is string => t !== undefined)
          .slice(0, 3);
      const concepts: ConceptCandidate[] = store.concepts
        .filter((c) => scopedConceptIds === undefined || scopedConceptIds.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), aboutTitles: aboutTitlesOf(c.id) }));
      // Interrogative probes already on this source: `#probe:<word>` snippets the learner
      // tapped while reading. They condition the questions step — one drafted question per
      // probe, in the shape that was tapped.
      const probes = snapshotNow.snippets
        .filter((sn) => sn.sourceId === src.id)
        .flatMap((sn) => {
          const tag = sn.tags.find((t) => t.startsWith('#probe:'));
          return tag === undefined ? [] : [{ word: tag.slice('#probe:'.length), text: sn.text }];
        });
      const result = await propose(
        {
          source: { id: src.id, title: src.title, ...(src.url ? { url: src.url } : {}) },
          config: { ...config, trackSuggestion: config.trackSuggestion && scopeTrack === undefined },
          concepts,
          tracks: snapshotNow.tracks.map((t) => ({ id: t.id, title: t.title, ...(t.goal ? { goal: t.goal } : {}) })),
          ...(probes.length > 0 ? { probes } : {}),
        },
        { llm: cfg, ...(outboundFetch !== undefined ? { fetchPage: outboundFetch } : {}) },
      );
      engine.importPayload(withPriorSourceFields(engine.exportAll(), result.payload));
      const staged: string[] = [];
      for (const r of result.stageRefs) {
        try {
          staged.push(engine.stage(r, { learnerId }).targetId);
        } catch {
          /* an unresolvable ref (rare dedup collision) is skipped, reported below */
        }
      }
      const after = engine.snapshot(learnerId);
      for (const tie of result.refersTo) {
        const to = after.sources.find((x) => x.title === tie.toTitle);
        if (to) engine.link({ srcType: 'source', srcId: tie.fromSourceId, type: 'LINK', dstType: 'source', dstId: to.id, tags: [{ name: 'RefersTo' }] });
      }
      sendJson(res, 200, {
        ok: true,
        staged,
        skipped: result.stageRefs.length - staged.length,
        ...(result.trackSuggestion ? { trackSuggestion: result.trackSuggestion } : {}),
        ...(result.orderingSuggestion ? { orderingSuggestion: result.orderingSuggestion } : {}),
        notes: result.notes,
      });
      return;
    }

    // The survey→track pass: drafts a WHOLE staged track from one survey
    // source — accepting the track is the explicit INCLUDES gesture.
    // Never touches an existing track: a title collision mints a suffixed draft title.
    if (method === 'POST' && path === '/propose-track') {
      const setup = await proposeSetup();
      if (setup === undefined) return;
      const { cfg, body, learnerId, snapshotNow, src } = setup;
      const taken = new Set(snapshotNow.tracks.map((t) => t.title.toLowerCase()));
      let trackTitle = src.title;
      for (let n = 2; taken.has(trackTitle.toLowerCase()); n += 1) {
        trackTitle = n === 2 ? `${src.title} (survey draft)` : `${src.title} (survey draft ${n - 1})`;
      }
      const config: ProposeTrackConfig = { ...DEFAULT_PROPOSE_TRACK, ...(asObject(body.config ?? {}) as Partial<ProposeTrackConfig>) };
      const result = await proposeTrack(
        { source: { id: src.id, title: src.title, ...(src.url ? { url: src.url } : {}) }, trackTitle, config },
        { llm: cfg, ...(outboundFetch !== undefined ? { fetchPage: outboundFetch } : {}) },
      );
      engine.importPayload(withPriorSourceFields(engine.exportAll(), result.payload));
      const staged: string[] = [];
      for (const r of result.stageRefs) {
        try {
          staged.push(engine.stage(r, { learnerId }).targetId);
        } catch {
          /* an unresolvable ref (rare dedup collision) is skipped, reported below */
        }
      }
      sendJson(res, 200, {
        ok: true,
        trackId: result.trackRef,
        trackTitle,
        staged,
        skipped: result.stageRefs.length - staged.length,
        notes: result.notes,
      });
      return;
    }

    if (method === 'POST' && path === '/link') {
      requireToken(req, token);
      sendJson(res, 200, engine.link(asObject(parseBody(await readBody(req)))));
      return;
    }

    // Un-assert a structural edge (interim physical deletion; see engine.unlink). A write.
    if (method === 'POST' && path === '/unlink') {
      requireToken(req, token);
      sendJson(res, 200, engine.unlink(asObject(parseBody(await readBody(req)))));
      return;
    }

    // The publish acts: explicit, token-guarded like every write.
    if (method === 'POST' && (path === '/publish' || path === '/unpublish')) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const result = path === '/publish' ? engine.publish(body) : engine.unpublish(body);
      // On a hosted instance, publishing has to reach the registry or it produces a track marked
      // public whose page 404s — the page lives there, so Publish must follow it. On a
      // single-tenant instance nothing changes: your own server serves /t/<id> and pushing stays
      // the separate, deliberate act it has always been.
      if (hosting && path === '/publish') {
        // WHOSE credential reaches the registry ("the registry refused
        // it (401)" on every hosted publish). A publication belongs to a USER, and a
        // hosted instance is not one — it has no REGISTRY_TOKEN, so pushing under registryAuth
        // sent nothing and the registry rightly refused. The caller's own credential is the one
        // that can work:
        //   token-authed (CLI) — the bearer IS a registry account token (that is what tenancy
        //     verifies it against), so forward exactly what the caller sent;
        //   cookie-authed (the workbench) — a session cannot be forwarded server-side without
        //     making this instance a confused deputy, so DON'T push here: mark the result and the
        //     browser pushes same-origin itself, where the cookie applies.
        const auth = req.headers.authorization;
        const direct = req.headers['x-ingest-token'];
        const callerBearer =
          typeof auth === 'string' && auth.startsWith('Bearer ') ? auth : typeof direct === 'string' && direct !== '' ? `Bearer ${direct}` : undefined;
        if (callerBearer === undefined) {
          sendJson(res, 200, { ...result, needsRegistryPush: true });
          return;
        }
        const ref = typeof (body as { ref?: unknown }).ref === 'string' ? ((body as { ref: string }).ref).trim() : '';
        const bundle = ref === '' ? undefined : engine.publication(ref, { frameworks: storeFrameworks() });
        if (bundle === undefined) throw new IngestError(400, 'published, but the bundle could not be read back to publish it');
        try {
          const r = await fetch(`${registryUrl}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: callerBearer },
            body: JSON.stringify(bundle),
            signal: AbortSignal.timeout(10_000),
          });
          const out = (await r.json().catch(() => ({}))) as { error?: string; url?: string };
          if (!r.ok) throw new IngestError(502, `the registry refused it (${r.status}): ${out.error ?? 'unknown error'}`);
          sendJson(res, 200, { ...result, registryUrl: `${registryUrl}${out.url ?? ''}` });
          return;
        } catch (e) {
          if (e instanceof IngestError) throw e;
          // Deliberately NOT rolled back: the track is marked published with the license and date
          // the author chose, and retrying is one more press. Unpublishing here would throw that
          // away to hide a network blip.
          throw new IngestError(502, `marked published, but could not reach the registry to distribute it — try again: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      sendJson(res, 200, result);
      return;
    }

    // The whole snapshot envelope in one round trip — what the React viewer's transport client
    // reads (the per-collection routes below stay for older clients).
    // Fork-first onboarding: the bundled example tracks. A read like
    // /snapshot — no token, no writes. `?name=` returns the payload the UI forks by importing.
    // The community registry, through this server: the registry URL is deployment
    // config, and fork-import validation + origin stamping stay in one place. 204 when no
    // registry is configured — the UI's community section simply doesn't exist then.
    // ── The framework store's READ: two tiers in one route. The BUILT-IN declarations
    // stay public (baked, secret-free data public consumers render with — the standing
    // /framework contract); the library's OWN vocabulary (mine + installed) is the learner's
    // and answers only past the token.
    if (method === 'GET' && path === '/framework') {
      try {
        requireToken(req, token);
      } catch {
        sendJson(res, 200, { frameworks: FRAMEWORKS, builtin: FRAMEWORKS, installed: [] });
        return;
      }
      const doc = loadFrameworkDoc(tenantDb);
      sendJson(res, 200, {
        frameworks: [...FRAMEWORKS, ...(doc.mine !== undefined ? [doc.mine] : []), ...doc.installed],
        builtin: FRAMEWORKS,
        ...(doc.mine !== undefined ? { mine: doc.mine } : {}),
        installed: doc.installed,
        ...(doc.viewOverrides !== undefined ? { viewOverrides: doc.viewOverrides } : {}),
        enabledBuiltins: doc.enabledBuiltins ?? [],
        disabledInstalled: doc.disabledInstalled ?? [],
      });
      return;
    }
    if ((method === 'PUT' || method === 'POST') && path === '/framework/enabled') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === 'string')) {
        throw new IngestError(400, 'names (string[]) is required');
      }
      const doc = loadFrameworkDoc(tenantDb);
      saveFrameworkDoc(tenantDb, { ...doc, enabledBuiltins: body.names as string[] });
      sendJson(res, 200, { saved: true });
      return;
    }
    if ((method === 'PUT' || method === 'POST') && path === '/framework/disabled-installed') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === 'string')) {
        throw new IngestError(400, 'names (string[]) is required');
      }
      const doc = loadFrameworkDoc(tenantDb);
      saveFrameworkDoc(tenantDb, { ...doc, disabledInstalled: body.names as string[] });
      sendJson(res, 200, { saved: true });
      return;
    }

    // ── The token gate ───────────────────────────────────────────────
    // When a token is configured it guards READS as well as writes. It used to guard writes
    // only, so a token-protected server still handed its entire library to any GET — which is
    // not what someone who sets a token means by "protect this server". Everything deliberately
    // public has already returned above: /health, /framework (its public tier), the UI files,
    // /t/<id> published bundles. Anything past this point is the learner's own.
    requireToken(req, token);

    if (method === 'GET' && path === '/registry') {
      if (registryUrl === undefined || registryUrl === '') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      let upstream: Response;
      try {
        upstream = await fetch(`${registryUrl}/index.json`, { signal: AbortSignal.timeout(8000) });
      } catch {
        throw new IngestError(502, `can't reach the registry at ${registryUrl}`);
      }
      if (!upstream.ok) throw new IngestError(502, `registry answered ${upstream.status}`);
      const body = (await upstream.json()) as { tracks?: unknown[] };
      sendJson(res, 200, { registry: registryUrl, tracks: body.tracks ?? [] });
      return;
    }

    // Fork a registry track into THIS library — the same importPublication path the manual
    // download-and-import flow uses, so lineage + the archived parent come for free.
    // PULL upstream into a fork: fetch current + base from the fork's RECORDED origin,
    // then the engine's additive three-way. On a HOSTED instance the origin must live on the
    // configured registry — origin URLs enter via imports, so an unrestricted fetch here would
    // be an egress probe two steps removed (same reasoning as /push refusing tenant targets).
    if (method === 'POST' && path === '/pull') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      if (!ref) throw new IngestError(400, 'ref (string) is required');
      const track = engine.exportAll().tracks.find((t) => t.id === ref || t.title === ref);
      const origin = track?.origin;
      if (track === undefined || origin?.url === undefined) throw new IngestError(400, 'this track is not a fork of a registry track — nothing to pull from');
      if (hosting && (registryUrl === undefined || !origin.url.startsWith(registryUrl.replace(/\/$/, '') + '/'))) {
        throw new IngestError(403, 'a hosted instance pulls only from its own registry');
      }
      const get = async (u: string): Promise<unknown> => {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
          return r.ok ? await r.json() : undefined;
        } catch {
          return undefined;
        }
      };
      const current = await get(`${origin.url}.json`);
      if (current === undefined) throw new IngestError(502, `the registry no longer serves ${origin.url}`);
      const base = await get(`${origin.url}.json?version=${origin.contentHash}`);
      const pulled = engine.pullPublication(current, base);
      installBundleDefs(current);
      sendJson(res, 200, pulled);
      return;
    }

    if (method === 'POST' && path === '/registry-fork') {
      requireToken(req, token);
      if (registryUrl === undefined || registryUrl === '') throw new IngestError(400, 'no registry configured (set REGISTRY_URL)');
      const body = asObject(parseBody(await readBody(req)));
      const trackId = typeof body.trackId === 'string' ? body.trackId.trim() : '';
      if (!trackId) throw new IngestError(400, 'trackId (string) is required');
      let upstream: Response;
      try {
        upstream = await fetch(`${registryUrl}/t/${encodeURIComponent(trackId)}.json`, { signal: AbortSignal.timeout(15000) });
      } catch {
        throw new IngestError(502, `can't reach the registry at ${registryUrl}`);
      }
      if (upstream.status === 404) throw new IngestError(404, `no track "${trackId}" on the registry`);
      if (!upstream.ok) throw new IngestError(502, `registry answered ${upstream.status}`);
      const bundle = await upstream.json();
      const forked = engine.importPublication(bundle, { originUrl: `${registryUrl}/t/${trackId}` });
      installBundleDefs(bundle);
      sendJson(res, 200, { forked: true, ...forked });
      return;
    }

    if (method === 'GET' && path === '/examples') {
      const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name');
      if (name === null) {
        sendJson(res, 200, { examples: exampleList() });
        return;
      }
      const found = readExample(name);
      if (found === undefined) throw new IngestError(404, `no example named "${name}"`);
      sendJson(res, 200, found.payload);
      return;
    }

    if (method === 'GET' && path === '/snapshot') {
      sendJson(res, 200, engine.snapshot(readLearner(req)));
      return;
    }

    if ((method === 'PUT' || method === 'POST') && path === '/framework/mine') {
      requireToken(req, token);
      const def = parseFrameworkFile(parseBody(await readBody(req)));
      if (FRAMEWORKS.some((f) => f.framework === def.framework)) {
        throw new IngestError(400, `"${def.framework}" is a built-in framework name — pick your own`);
      }
      const doc = loadFrameworkDoc(tenantDb);
      saveFrameworkDoc(tenantDb, { ...doc, mine: def });
      sendJson(res, 200, { saved: true, framework: def.framework });
      return;
    }
    if ((method === 'PUT' || method === 'POST') && path === '/framework/view') {
      requireToken(req, token);
      const overrides = ViewOverridesSchema.parse(parseBody(await readBody(req)));
      const doc = loadFrameworkDoc(tenantDb);
      saveFrameworkDoc(tenantDb, { ...doc, viewOverrides: overrides });
      sendJson(res, 200, { saved: true });
      return;
    }
    if (method === 'POST' && path === '/framework/uninstall') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') throw new IngestError(400, 'name (string) is required');
      const doc = loadFrameworkDoc(tenantDb);
      saveFrameworkDoc(tenantDb, { ...doc, installed: doc.installed.filter((f) => f.framework !== name) });
      sendJson(res, 200, { removed: true });
      return;
    }
    if (method === 'POST' && path === '/framework/install') {
      requireToken(req, token);
      const def = parseFrameworkFile(parseBody(await readBody(req)));
      if (FRAMEWORKS.some((f) => f.framework === def.framework)) {
        throw new IngestError(400, `"${def.framework}" is a built-in framework name — nothing to install`);
      }
      const doc = loadFrameworkDoc(tenantDb);
      // Re-installing a name replaces it — an updated dependency arrives as the same name.
      const installed = [...doc.installed.filter((f) => f.framework !== def.framework), def];
      saveFrameworkDoc(tenantDb, { ...doc, installed });
      sendJson(res, 200, { installed: true, framework: def.framework });
      return;
    }

    // MY publication bundle — the PRIVATE read. The
    // public route for a bundle is /t/<id>.json, but a hosted instance 302s all of /t/*
    // to the registry BEFORE credentials — right for strangers holding a share link, wrong for
    // the owner reading their own bundle to publish it (the redirect lands on a registry that
    // does not have the track yet, whose 404 is the "no such track" the owner saw). This route
    // sits with the other authenticated reads, under tenancy, and never redirects.
    if (method === 'GET' && path === '/publication') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const ref = q.get('ref') ?? '';
      const bundle = ref === '' ? undefined : engine.publication(ref, { frameworks: storeFrameworks() });
      if (bundle === undefined || bundle === null) throw new IngestError(404, 'track is not published — publish it first');
      if (q.get('meta') !== null) {
        const pub = (bundle as { publication: { contentHash: string; trackId: string; title: string } }).publication;
        sendJson(res, 200, { contentHash: pub.contentHash, trackId: pub.trackId, title: pub.title });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (method === 'GET' && path === '/tracks') {
      const s = engine.snapshot(readLearner(req));
      sendJson(res, 200, { version: s.version, tracks: s.tracks });
      return;
    }

    if (method === 'GET' && path === '/sources') {
      const s = engine.snapshot(readLearner(req));
      sendJson(res, 200, { version: s.version, sources: s.sources });
      return;
    }

    if (method === 'GET' && path === '/snippets') {
      const s = engine.snapshot(readLearner(req));
      sendJson(res, 200, { version: s.version, snippets: s.snippets });
      return;
    }

    // The journey projection: the engine's assemble() as JSON, optionally scoped
    // to a track (`?track=<title or syl_ id>` — the engine resolves the ref). Thin.
    if (method === 'GET' && path === '/assemble') {
      const track = new URL(req.url ?? '/', 'http://localhost').searchParams.get('track') ?? undefined;
      sendJson(res, 200, { version: READ_VERSION, ...engine.assemble(track, readLearner(req) ?? DEFAULT_LEARNER) });
      return;
    }

    if (method === 'POST' && path === '/ingest') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      // Write-time enrichment: matching adapters resolve durable facts before the upsert; the
      // engine folds them fill-empty on every capture (re-capture = retry). A client may send
      // its own weak `resolved` hints (the popup's unedited tab title — browser-derived, not
      // learner-typed) — server adapters outrank them, both sit below anything the user typed.
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      const clientResolved = asObject(body.resolved ?? {});
      const serverResolved = await applyResolvers(url, { now });
      const resolved = {
        ...clientResolved,
        ...Object.fromEntries(Object.entries(serverResolved).filter(([, v]) => v !== undefined)),
      };
      sendJson(res, 200, engine.captureSource({ ...body, resolved, learnerId: writeLearner(req, body) }));
      return;
    }

    if (method === 'POST' && path === '/snippet') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      // Text resolvers run BEFORE capture — text participates in snippet identity, so
      // normalization must shape the id, not chase it (adapters doctrine, write-time).
      const text = typeof body.text === 'string' ? normalizeText(typeof body.url === 'string' ? body.url : '', body.text) : body.text;
      sendJson(res, 200, engine.captureSnippet({ ...body, text, learnerId: writeLearner(req, body) }));
      return;
    }

    // Restore-from-backup / bulk load: the engine's write gate accepts SUGARED or canonical
    // JSON (desugar → validate → idempotent upsert), so re-importing an exported payload merges
    // cleanly. Symmetric to GET /export. Validation errors surface as 400 at the boundary.
    if (method === 'POST' && path === '/import') {
      requireToken(req, token);
      const raw = parseBody(await readBody(req));
      // A publication bundle imports as a FORK: lineage + archived parent.
      if (typeof raw === 'object' && raw !== null && 'pubVersion' in raw) {
        const originUrl = new URL(req.url ?? '/', 'http://localhost').searchParams.get('origin') ?? undefined;
        const forkedIn = engine.importPublication(raw, originUrl !== undefined ? { originUrl } : {});
        installBundleDefs(raw);
        sendJson(res, 200, { forked: true, ...forkedIn });
        return;
      }
      engine.importPayload(raw);
      sendJson(res, 200, { imported: true });
      return;
    }

    // The behavioral verbs the UI's question actions post: the question must already exist
    // (a snippet RAISES it); the engine's resolver throws "author it first" otherwise → 400.
    if (method === 'POST' && (path === '/ask' || path === '/answer')) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question) throw new IngestError(400, 'question (string) is required');
      if (path === '/ask') engine.ask(question, { learnerId: writeLearner(req, body) });
      else engine.answer(question, { learnerId: writeLearner(req, body) });
      sendJson(res, 200, { ok: true });
      return;
    }

    // Progress verbs (workbench Journey): mark a source consumed / un-consumed / follow a
    // concept. `ref` is a typed id, URL, or name — resolved behind the facade. UNCONSUMED is
    // the first un-verb.
    // Behavioral verbs + the staged lifecycle: stage parks/proposes ANY
    // entity; accept/reject are the two VERDICTS; unstage is the plain reversal.
    if (
      method === 'POST' &&
      (path === '/consume' || path === '/unconsume' || path === '/track' ||
        path === '/stage' || path === '/unstage' || path === '/accept' || path === '/reject')
    ) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      if (!ref) throw new IngestError(400, 'ref (string) is required');
      const opts = { learnerId: writeLearner(req, body) };
      if (path === '/consume') engine.consume(ref, opts);
      else if (path === '/unconsume') engine.unconsume(ref, opts);
      else if (path === '/stage') engine.stage(ref, opts);
      else if (path === '/unstage') engine.unstage(ref, opts);
      else if (path === '/accept') engine.accept(ref, opts);
      else if (path === '/reject') engine.reject(ref, opts);
      else engine.track(ref, opts);
      sendJson(res, 200, { ok: true });
      return;
    }

    // The edit primitives (DATA_MODEL.md): token-guarded like the other writes; thin transport —
    // ref resolution, liveness, and identity-field policy all live behind the facade.
    if (method === 'POST' && (path === '/remove' || path === '/restore' || path === '/update')) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const edit = { ...body, learnerId: writeLearner(req, body) };
      const result =
        path === '/remove' ? engine.remove(edit) : path === '/restore' ? engine.restore(edit) : engine.update(edit);
      sendJson(res, 200, result);
      return;
    }

    if (method === 'GET' && path === '/removed') {
      sendJson(res, 200, { version: READ_VERSION, removed: engine.removed() });
      return;
    }

    // The whole canonical payload — the backup/feedback channel: a tester downloads this
    // and shares it; import on any instance reproduces the graph, retraction history included.
    // Push a published track's bundle TO a registry: the server
    // does the outbound POST so the workbench never needs cross-origin writes. Explicit,
    // owner-initiated distribution — the only route that ever contacts a non-adapter host.
    if (method === 'POST' && path === '/push') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      const registry = typeof body.registry === 'string' ? body.registry.trim().replace(/\/$/, '') : '';
      if (!ref || !registry) throw new IngestError(400, 'ref and registry (strings) are required');
      // On a hosted instance the target is NOT the caller's to choose. This route
      // makes the server POST wherever it is told, and it is reachable by every tenant — so it
      // is an egress channel and a probe of the network the server sits in, with the status
      // handed back. A hosted instance has exactly one registry; a self-hoster keeps
      // choosing, because pushing to whichever commons you like from your own machine is the
      // point of the command.
      if (hosting && registry !== registryUrl) {
        throw new IngestError(403, `this server publishes to ${registryUrl} — it will not push elsewhere on request`);
      }
      const bundle = engine.publication(ref, { frameworks: storeFrameworks() });
      if (!bundle) throw new IngestError(400, 'track is not published — publish it first');
      let r: Response;
      try {
        r = await fetch(`${registry}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...registryAuth(registry) },
          body: JSON.stringify(bundle),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        throw new IngestError(502, `could not reach the registry: ${e instanceof Error ? e.message : String(e)}`);
      }
      const out = (await r.json().catch(() => ({}))) as { error?: string; url?: string; updated?: boolean };
      if (r.status === 401 && config.registryToken === undefined) {
        // The account-ownership policy lands here for a self-hoster, so the message says the fix
        // rather than reporting someone else's status code.
        throw new IngestError(401, `${registry} requires an account to publish — sign in there, mint an access token on your account page, and set REGISTRY_TOKEN on this server`);
      }
      if (!r.ok) throw new IngestError(502, `registry refused (${r.status}): ${out.error ?? 'unknown error'}`);
      sendJson(res, 200, { ok: true, updated: out.updated === true, url: `${registry}${out.url ?? ''}` });
      return;
    }

    if (method === 'GET' && path === '/export') {
      // ?live=1 → the share shape (retractions folded away); bare → the full backup.
      const live = new URL(req.url ?? '/', 'http://localhost').searchParams.get('live');
      sendJson(res, 200, live !== null ? engine.exportLive() : engine.exportAll());
      return;
    }

    // The engagement feed and the question-provenance view (alpha feedback round 1) — thin.
    if (method === 'GET' && path === '/timeline') {
      sendJson(res, 200, { version: READ_VERSION, timeline: engine.timeline(readLearner(req)) });
      return;
    }

    if (method === 'GET' && path === '/questions') {
      sendJson(res, 200, { version: READ_VERSION, questions: engine.questions(readLearner(req)) });
      return;
    }

    // Per-entity typed relations (workbench "Connections"): ?id=<entity id>. Thin.
    if (method === 'GET' && path === '/relations') {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '';
      if (!id) throw new IngestError(400, 'id query param is required');
      sendJson(res, 200, { version: READ_VERSION, relations: engine.relations(id) });
      return;
    }

    // The whole knowledge graph as nodes + structural edges (the Map tab). Thin.
    if (method === 'GET' && path === '/graph') {
      sendJson(res, 200, { version: READ_VERSION, ...engine.graph() });
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${path}` });
  }

  // A comment ping defeats idle proxy/socket timeouts without waking EventSource handlers.
  const pingTimer = setInterval(() => {
    for (const client of sseClients) client.write(': ping\n\n');
  }, 25_000);
  pingTimer.unref?.();

  // node's close() waits for open connections — end the held SSE streams first, or a server
  // with a connected viewer would never finish closing (tests close() in afterEach).
  const realClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    clearInterval(pingTimer);
    for (const client of sseClients) client.end();
    sseClients.clear();
    return realClose(cb);
  }) as typeof server.close;

  server.on('close', () => {
    clearInterval(sweeper);
    pool.closeAll();
  });
  return server;
}

function requireToken(req: IncomingMessage, token: string | undefined): void {
  if (!token) return; // no token configured → open loopback loop
  const got = req.headers['x-ingest-token'];
  // Constant-time compare: a short-circuiting !== leaks match-prefix length through timing.
  const a = Buffer.from(typeof got === 'string' ? got : '');
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new IngestError(401, 'invalid or missing X-Ingest-Token');
  }
}

function parseBody(raw: string): unknown {
  if (!raw.trim()) throw new IngestError(400, 'empty body');
  try {
    return JSON.parse(raw);
  } catch {
    throw new IngestError(400, 'body is not valid JSON');
  }
}

/** Narrow a parsed body to an object so it can be spread; the engine validates the shape. */
function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}


/** `tsx src/server/ingest.ts [--db path] [--port n] [--host h] [--token t] [--learner id]` */
function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(flag('--port') ?? process.env.INGEST_PORT ?? 4321);
  const host = flag('--host') ?? '127.0.0.1';
  const db = flag('--db');
  const token = flag('--token');
  const learner = flag('--learner');

  // Secure by default. The default bind is loopback, where an open API is
  // fine — nothing off this machine can reach it. `--host 0.0.0.0` silently changed that: the
  // same unauthenticated read/write API, offered to the whole network, with no warning and no
  // different behaviour. Exposing it is now a decision that has to be made out loud.
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const exposed = !loopback.has(host);
  if (exposed && (token ?? process.env.INGEST_TOKEN) === undefined && !argv.includes('--insecure')) {
    console.error(
      `philomatic: refusing to bind ${host} without a token.\n` +
        `  Binding anything other than loopback puts your library on the network, where\n` +
        `  everything that can reach port ${port} could read it — and write to it.\n\n` +
        `  Either:  --token <secret>   (also set it in Settings → Access token)\n` +
        `  or:      --insecure         (you have decided the network is trusted)\n`,
    );
    process.exitCode = 1;
    return;
  }
  const server = createIngestServer({ db, host, port, token, learner });
  server.listen(port, host, () => {
    const dbLabel = db ?? process.env.INGEST_DB ?? '.philomatic/philomatic.sqlite';
    console.log(`philomatic ingest listening on http://${host}:${port}  (db: ${dbLabel})`);
    if (token ?? process.env.INGEST_TOKEN) console.log('  X-Ingest-Token required (reads and writes)');
    else if (exposed) console.log(`  ⚠ open to the network on ${host} — no token: anyone who can reach this port has full access`);
    const who = learner ?? process.env.INGEST_LEARNER;
    if (who) console.log(`  acting as learner ${who}`);
  });
}

// Run as a script (tsx/node), but stay importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) main();

export { withPriorSourceFields }; // re-exported: the regression tests import it from here
