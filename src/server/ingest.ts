/**
 * Ingest service (browser plan §2, §3; ARCHITECTURE.md §5) — a localhost HTTP
 * *transport* over the engine. It parses/authorizes requests and formats responses; ALL write
 * logic lives behind the facade (`engine.captureSource` / `engine.captureSnippet`), which owns id
 * derivation, validation, edge-building, and safe upsert. The write contract is the engine's
 * versioned capture schema (`src/engine/capture.ts`), not this file.
 *
 *   WRITE  POST /ingest   → engine.captureSource(body [+ adapter-resolved facts])
 *          POST /snippet  → engine.captureSnippet(body)
 *          POST /ask | /answer → the behavioral verbs on an existing question (`{question}`) —
 *                          the UI's S3 "ask" / "mark answered" actions
 *          POST /remove | /restore | /update → the edit primitives (DATA_MODEL.md §6) — retraction/
 *                          supersession semantics live entirely behind the facade
 *   READ   GET /snapshot  → engine.snapshot() — the whole versioned envelope the React viewer
 *                          consumes (src/engine/read.ts — nothing computed here)
 *          GET /tracks | /sources | /snippets → the same views as per-collection slices
 *                          (kept for older clients: the extension's option/view fetches)
 *          GET /assemble[?track=ref] → engine.assemble() — the journey projection (alpha UI S4)
 *          GET /removed  → the trash-bin projection (engine.removed())
 *          GET / + /assets/* → serves the built React viewer (`ui/dist`; alpha UI plan §2.1) —
 *                          static files only, with a build-pointer page when unbuilt. The old
 *                          browser/view.html retired with the React viewer (git history has it).
 *          GET /health   → { ok: true }
 *
 * CORS-enabled (the bookmarklet's fetch runs in the visited page's origin); optional shared
 * `X-Ingest-Token` guards writes when `INGEST_TOKEN` is configured.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LEARNER, FRAMEWORKS, PhilomaticEngine, READ_VERSION } from '../engine';
import { applyResolvers, normalizeSnippetText } from './adapters';

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
 * The viewer is the built React app (`ui/`, alpha UI plan §2.1) — still a pure client of the
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
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream', ...CORS_HEADERS });
    res.end(body);
  } catch {
    if (file === indexFile) sendHtml(res, 200, UNBUILT_HTML);
    else sendJson(res, 404, { error: `not found: ${urlPath}` });
  }
}

export interface ServerOptions {
  /** SQLite file shared with the CLI. Defaults to `INGEST_DB` env or `.philomatic/philomatic.sqlite`. */
  db?: string;
  /** Loopback host to bind. Default: 127.0.0.1 (local-first; §2.5). */
  host?: string;
  port?: number;
  /** If set, writes require a matching `X-Ingest-Token` header (§2.7). Default: `INGEST_TOKEN` env. */
  token?: string;
  /** This instance's learner id (T4 tenancy prep): writes land under it and reads scope to it
   *  unless a request says otherwise. Default: `INGEST_LEARNER` env, else the seeded single
   *  tenant (and reads fold all learners, the pre-T4 behavior). */
  learner?: string;
  /** Injected clock, forwarded to the engine (tests pin time). */
  now?: () => number;
  /** Directory of built viewer assets served at `GET /`. Default: `ui/dist` (tests inject one). */
  uiDist?: string;
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
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
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
  const instanceLearner = opts.learner ?? process.env.INGEST_LEARNER;
  // A pre-v2 store migrates at boot (backup kept beside it) — otherwise every read would fail
  // schema validation against the v2 model. Deterministic rebuild, no-op when already v2.
  const migration = PhilomaticEngine.migrateDbV2(dbPath);
  if (migration.migrated) {
    console.log(`model v2: migrated ${dbPath} (your v1 store is kept at ${migration.backupPath})`);
  }
  const engine = PhilomaticEngine.open(dbPath, opts.now ? { now: opts.now } : {});

  // ── The session→learner seam (self-serve plan T4) ─────────────────────────────────────────
  // ONE place resolves "who is acting": an explicit learnerId in the body, a ?learner= query,
  // then the instance's configured learner. Real authentication (passkeys/OIDC — ROADMAP §2.1)
  // replaces the front of this chain later; the engine stays tenancy-free throughout.
  const queryLearner = (req: IncomingMessage): string | undefined =>
    new URL(req.url ?? '/', 'http://localhost').searchParams.get('learner') ?? undefined;
  const writeLearner = (req: IncomingMessage, body: Record<string, unknown>): string => {
    const explicit = typeof body.learnerId === 'string' ? body.learnerId.trim() : '';
    return explicit || queryLearner(req) || instanceLearner || DEFAULT_LEARNER;
  };
  /** For reads `undefined` means the all-learners fold (the pre-T4 single-tenant view). */
  const readLearner = (req: IncomingMessage): string | undefined => queryLearner(req) ?? instanceLearner;

  // ── Live change feed (self-serve plan T3) ────────────────────────────────────────────────────
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
  // Heartbeat (owner outage, 2026-07-18): a stream stuck in a dead intermediary (the dev
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

  const server = createServer((req, res) => {
    void handle(req, res)
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // The installed framework declarations (core first) — tag vocabularies and metadata
    // vocabularies a client renders. Data, not contract: each file carries its own version.
    if (method === 'GET' && path === '/framework') {
      sendJson(res, 200, { frameworks: FRAMEWORKS });
      return;
    }

    // The SSE change feed (T3): held open until the client disconnects; `retry:` doubles as the
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

    if (method === 'GET' && path !== undefined && (path === '/' || path === '/index.html' || path.startsWith('/assets/'))) {
      serveUi(res, path, uiDist);
      return;
    }

    // The PUBLIC publication routes (publish plan P3; DATA_GOVERNANCE §3): a published track's
    // bundle and its rendered page. Deliberately NOT token-guarded — the token guards writes and
    // these are reads of deliberately-published material; everything unpublished 404s. The page
    // route serves the viewer's index.html and the app reads /t/<id> off location.pathname.
    if (method === 'GET' && path !== undefined && path.startsWith('/t/')) {
      const rest = decodeURIComponent(path.slice('/t/'.length));
      if (method === 'GET' && rest.endsWith('.json')) {
        const bundle = engine.publication(rest.slice(0, -'.json'.length));
        if (!bundle) throw new IngestError(404, 'no such publication');
        sendJson(res, 200, bundle);
        return;
      }
      if (!engine.publication(rest)) throw new IngestError(404, 'no such publication');
      serveUi(res, '/', uiDist);
      return;
    }

    // D3: the instance's author public key — domain anchoring for signed publications.
    if (method === 'GET' && path === '/author') {
      sendJson(res, 200, { authorKey: engine.authorPublicKey() });
      return;
    }

    // Assert a structural edge (the inverse of unlink; see engine.link). A write.
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

    // The publish acts (publish plan P2): explicit, token-guarded like every write.
    if (method === 'POST' && (path === '/publish' || path === '/unpublish')) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      sendJson(res, 200, path === '/publish' ? engine.publish(body) : engine.unpublish(body));
      return;
    }

    // The whole snapshot envelope in one round trip — what the React viewer's transport client
    // reads (the per-collection routes below stay for older clients).
    if (method === 'GET' && path === '/snapshot') {
      sendJson(res, 200, engine.snapshot(readLearner(req)));
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

    // The journey projection (alpha UI S4): the engine's assemble() as JSON, optionally scoped
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
      const text = typeof body.text === 'string' ? normalizeSnippetText(typeof body.url === 'string' ? body.url : '', body.text) : body.text;
      sendJson(res, 200, engine.captureSnippet({ ...body, text, learnerId: writeLearner(req, body) }));
      return;
    }

    // Restore-from-backup / bulk load: the engine's write gate accepts SUGARED or canonical
    // JSON (desugar → validate → idempotent upsert), so re-importing an exported payload merges
    // cleanly. Symmetric to GET /export. Validation errors surface as 400 at the boundary.
    if (method === 'POST' && path === '/import') {
      requireToken(req, token);
      const raw = parseBody(await readBody(req));
      // A publication bundle imports as a FORK (publish plan P4): lineage + archived parent.
      if (typeof raw === 'object' && raw !== null && 'pubVersion' in raw) {
        const originUrl = new URL(req.url ?? '/', 'http://localhost').searchParams.get('origin') ?? undefined;
        sendJson(res, 200, { forked: true, ...engine.importPublication(raw, originUrl !== undefined ? { originUrl } : {}) });
        return;
      }
      engine.importPayload(raw);
      sendJson(res, 200, { imported: true });
      return;
    }

    // The behavioral verbs the UI's question actions post (S3): the question must already exist
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
    // the first un-verb (owner ruling, 2026-07-18).
    if (method === 'POST' && (path === '/consume' || path === '/unconsume' || path === '/track')) {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      if (!ref) throw new IngestError(400, 'ref (string) is required');
      if (path === '/consume') engine.consume(ref, { learnerId: writeLearner(req, body) });
      else if (path === '/unconsume') engine.unconsume(ref, { learnerId: writeLearner(req, body) });
      else engine.track(ref, { learnerId: writeLearner(req, body) });
      sendJson(res, 200, { ok: true });
      return;
    }

    // The edit primitives (DATA_MODEL.md §6): token-guarded like the other writes; thin transport —
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

    // The whole canonical payload — the backup/feedback channel (M8): a tester downloads this
    // and shares it; import on any instance reproduces the graph, retraction history included.
    // Push a published track's bundle TO a registry (track registry, 2026-07-18): the server
    // does the outbound POST so the workbench never needs cross-origin writes. Explicit,
    // owner-initiated distribution — the only route that ever contacts a non-adapter host.
    if (method === 'POST' && path === '/push') {
      requireToken(req, token);
      const body = asObject(parseBody(await readBody(req)));
      const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
      const registry = typeof body.registry === 'string' ? body.registry.trim().replace(/\/$/, '') : '';
      if (!ref || !registry) throw new IngestError(400, 'ref and registry (strings) are required');
      const bundle = engine.publication(ref);
      if (!bundle) throw new IngestError(400, 'track is not published — publish it first');
      let r: Response;
      try {
        r = await fetch(`${registry}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bundle),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        throw new IngestError(502, `could not reach the registry: ${e instanceof Error ? e.message : String(e)}`);
      }
      const out = (await r.json().catch(() => ({}))) as { error?: string; url?: string; updated?: boolean };
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

  server.on('close', () => engine.close());
  return server;
}

function requireToken(req: IncomingMessage, token: string | undefined): void {
  if (!token) return; // no token configured → open loopback loop (§2.7)
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
  const server = createIngestServer({ db, host, port, token, learner });
  server.listen(port, host, () => {
    const dbLabel = db ?? process.env.INGEST_DB ?? '.philomatic/philomatic.sqlite';
    console.log(`philomatic ingest listening on http://${host}:${port}  (db: ${dbLabel})`);
    if (token ?? process.env.INGEST_TOKEN) console.log('  X-Ingest-Token required');
    const who = learner ?? process.env.INGEST_LEARNER;
    if (who) console.log(`  acting as learner ${who}`);
  });
}

// Run as a script (tsx/node), but stay importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
