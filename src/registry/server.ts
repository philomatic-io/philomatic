/**
 * The track registry (owner plan, 2026-07-18) — the GitHub-of-tracks service for a public
 * domain. NOT a Philomatic server: no engine, no database, no learner data. It accepts the
 * publication bundles local servers already produce, verifies them with the SAME pure checks
 * fork-import runs (src/engine/pub-verify.ts), and serves + indexes them:
 *
 *   POST /publish            bundle JSON → verify hash + signature → store; TOFU per track:
 *                            an update must be signed by the key that first published it.
 *   POST /unpublish          { trackId, signature } — signature over
 *                            `unpublish:<trackId>:<currentContentHash>` by the pinned key.
 *                            Removes from the index (copies already fetched persist — same
 *                            doctrine as local unpublish).
 *   GET  /t/:id(.json)       the track's public page (the built viewer, bundle baked in) /
 *                            the raw bundle (fork = download + import, machinery unchanged).
 *   GET  /index.json | /     the library: every published track (title, author, license,
 *                            source count, times) as JSON / a server-rendered page.
 *
 * Identity is the keypair — no accounts: first publish of a track id pins its author key
 * (exactly the TOFU rule forks use). Storage is plain files under `dir`:
 *   index.json               the registry index (rebuilt-safe: bundles/ is the truth)
 *   bundles/<trackId>.json   latest accepted bundle per track
 *   archive/<contentHash>.json  every version ever accepted (content-addressed, never deleted)
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDetached, verifyPublicationBundle } from '../engine/pub-verify';
import { buildPublicationHtml } from '../cli/export-track';

export interface RegistryEntry {
  trackId: string;
  title: string;
  author?: string;
  license: string;
  authorKey: string;
  contentHash: string;
  publishedAt: number;
  /** Registry-side timestamps: first accepted / last updated. */
  firstSeenAt: number;
  updatedAt: number;
  sources: number;
  concepts: number;
  /** Up to eight concept names — the library page's "what's inside" line. */
  conceptNames: string[];
  questions: number;
}

export interface RegistryOptions {
  /** Storage directory. Default: `.philomatic-registry`. */
  dir?: string;
  host?: string;
  port?: number;
  /** Reject bundles larger than this many bytes. Default 16MB (region-capture images ride inside). */
  maxBundleBytes?: number;
  /** The built viewer used for /t/:id pages. Default: the repo's ui/dist. */
  uiDist?: string;
  /**
   * The built in-browser demo (`pnpm demo:build` → ui/dist-demo), served at /demo. Default:
   * the repo's build if it exists. `false` disables the route.
   */
  demoDist?: string | false;
  now?: () => number;
}

const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const DEMO_DIST = fileURLToPath(new URL('../../ui/dist-demo', import.meta.url));

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
  res.end(html);
}

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) reject(Object.assign(new Error('bundle too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The library page — deliberately dependency-free server-rendered HTML. */
function libraryHtml(entries: RegistryEntry[], demo: boolean): string {
  const rows = entries
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(
      (e) => `<li>
  <a href="/t/${esc(e.trackId)}">${esc(e.title)}</a>
  <span class="meta">${e.author ? `${esc(e.author)} · ` : ''}${e.sources} source${e.sources === 1 ? '' : 's'} · ${e.concepts} concept${e.concepts === 1 ? '' : 's'}${e.questions > 0 ? ` · ${e.questions} open thread${e.questions === 1 ? '' : 's'}` : ''} · ${esc(e.license)} · updated ${new Date(e.updatedAt).toISOString().slice(0, 10)}</span>
  ${(e.conceptNames ?? []).length > 0 ? `<span class="chips">${e.conceptNames.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</span>` : ''}
  <span class="key" title="author key (identity is the keypair)">${esc(e.authorKey.slice(0, 12))}…</span>
</li>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Philomatic track registry</title>
<style>
  body { margin: 0 auto; max-width: 760px; padding: 2rem 1rem; background: #161826; color: #e9e9ed;
         font: 15px/1.6 'Inter', system-ui, sans-serif; }
  h1 { font-weight: 500; font-size: 1.3rem; } h1 span { color: #75798c; font-size: .85rem; margin-left: .6rem; }
  ul { list-style: none; padding: 0; } li { padding: .7rem .2rem; border-bottom: 1px solid #2b2d3a; }
  a { color: #b5abfc; text-decoration: none; font-size: 1.02rem; } a:hover { text-decoration: underline; }
  .meta { display: block; color: #9397ab; font-size: .82rem; }
  .key { color: #595d6c; font-size: .72rem; font-family: ui-monospace, monospace; }
  .chips { display: block; margin-top: .3rem; }
  .chip { display: inline-block; border: 1px solid #3f424d; border-radius: 999px; padding: .04rem .5rem;
          margin: 0 .25rem .25rem 0; font-size: .74rem; color: #8fd0c4; }
  p.empty { color: #9397ab; }
  footer { margin-top: 2rem; color: #75798c; font-size: .8rem; }
</style></head><body>
<h1>Track registry <span>${entries.length} published track${entries.length === 1 ? '' : 's'}</span></h1>
${entries.length === 0 ? '<p class="empty">Nothing published yet. <code>philomatic push &lt;track&gt; --registry &lt;this url&gt;</code></p>' : `<ul>\n${rows}\n</ul>`}
<footer>${demo ? '<p><a href="/demo/">Try the workbench in your browser</a> — the full engine, running locally in the page; nothing you do there leaves your tab.</p>' : ''}Every track is a self-contained publication bundle — <em>fork</em> one by downloading its
JSON (add <code>.json</code> to any track URL) and importing it into your own Philomatic.</footer>
</body></html>`;
}

export function createRegistryServer(opts: RegistryOptions = {}): Server {
  const dir = opts.dir ?? '.philomatic-registry';
  const cap = opts.maxBundleBytes ?? 16_000_000;
  const uiDist = opts.uiDist ?? UI_DIST;
  const demoDist = opts.demoDist === false ? undefined : (opts.demoDist ?? (existsSync(DEMO_DIST) ? DEMO_DIST : undefined));
  const now = opts.now ?? (() => Date.now());
  mkdirSync(join(dir, 'bundles'), { recursive: true });
  mkdirSync(join(dir, 'archive'), { recursive: true });

  const indexPath = join(dir, 'index.json');
  const index: Record<string, RegistryEntry> = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, RegistryEntry>)
    : {};
  const saveIndex = (): void => writeFileSync(indexPath, JSON.stringify(index, null, 2));

  /** /t pages rendered once per contentHash (the viewer inlining is expensive). */
  const pageCache = new Map<string, string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, tracks: Object.keys(index).length });
      return;
    }

    if (method === 'POST' && path === '/publish') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req, cap));
      } catch (e) {
        const status = (e as { status?: number }).status ?? 400;
        sendJson(res, status, { error: status === 413 ? `bundle exceeds ${cap} bytes` : 'body is not JSON' });
        return;
      }
      const v = verifyPublicationBundle(parsed);
      if (!v.ok || v.bundle === undefined) {
        sendJson(res, 400, { error: v.reason ?? 'invalid publication bundle' });
        return;
      }
      const pub = v.bundle.publication;
      // The registry REQUIRES signatures: the keypair is the whole identity model here.
      if (!v.signed || pub.authorKey === undefined) {
        sendJson(res, 400, { error: 'the registry only accepts signed bundles — publish from a Philomatic with an author key (any modern one)' });
        return;
      }
      const prior = index[pub.trackId];
      if (prior && prior.authorKey !== pub.authorKey) {
        sendJson(res, 403, {
          error: `track ${pub.trackId} is pinned to a different author key (${prior.authorKey.slice(0, 12)}…) — the first publisher owns the name`,
        });
        return;
      }
      const payload = v.bundle.payload as Record<string, unknown[]>;
      const entry: RegistryEntry = {
        trackId: pub.trackId,
        title: pub.title,
        ...(pub.author !== undefined ? { author: pub.author } : {}),
        license: pub.license,
        authorKey: pub.authorKey,
        contentHash: pub.contentHash,
        publishedAt: pub.publishedAt,
        firstSeenAt: prior?.firstSeenAt ?? now(),
        updatedAt: now(),
        sources: Array.isArray(payload.sources) ? payload.sources.length : 0,
        concepts: Array.isArray(payload.concepts) ? payload.concepts.length : 0,
        conceptNames: Array.isArray(payload.concepts)
          ? (payload.concepts as { name?: string }[]).map((c) => c.name ?? '').filter((n) => n !== '').slice(0, 8)
          : [],
        questions: Array.isArray(payload.questions) ? payload.questions.length : 0,
      };
      const raw = JSON.stringify(v.bundle);
      writeFileSync(join(dir, 'archive', `${pub.contentHash}.json`), raw);
      writeFileSync(join(dir, 'bundles', `${pub.trackId}.json`), raw);
      index[pub.trackId] = entry;
      saveIndex();
      sendJson(res, 200, { ok: true, trackId: pub.trackId, url: `/t/${pub.trackId}`, updated: prior !== undefined });
      return;
    }

    if (method === 'POST' && path === '/unpublish') {
      let body: { trackId?: string; signature?: string };
      try {
        body = JSON.parse(await readBody(req, 10_000)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'body is not JSON' });
        return;
      }
      const entry = body.trackId !== undefined ? index[body.trackId] : undefined;
      if (!entry) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      const challenge = `unpublish:${entry.trackId}:${entry.contentHash}`;
      if (body.signature === undefined || !verifyDetached(challenge, body.signature, entry.authorKey)) {
        sendJson(res, 403, { error: 'signature must be by the pinned author key over the unpublish challenge' });
        return;
      }
      delete index[entry.trackId];
      saveIndex();
      try {
        unlinkSync(join(dir, 'bundles', `${entry.trackId}.json`));
      } catch {
        /* already gone */
      }
      // The archive keeps every accepted version — copies persist, same doctrine as local.
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && (path === '/' || path === '/index.json')) {
      const entries = Object.values(index);
      if (path === '/index.json') sendJson(res, 200, { registryVersion: 1, tracks: entries });
      else sendHtml(res, 200, libraryHtml(entries, demoDist !== undefined));
      return;
    }

    const t = /^\/t\/([^/]+?)(\.json)?$/.exec(path);
    if (method === 'GET' && t) {
      const [, id, asJson] = t;
      const file = join(dir, 'bundles', `${id}.json`);
      if (!index[id!] || !existsSync(file)) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      const raw = readFileSync(file, 'utf8');
      if (asJson) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(raw);
        return;
      }
      const hash = index[id!]!.contentHash;
      let page = pageCache.get(hash);
      if (page === undefined) {
        try {
          page = buildPublicationHtml(JSON.parse(raw), uiDist);
        } catch {
          // Viewer not built on this host — the bundle is still fully usable as JSON.
          page = `<!doctype html><meta charset="utf-8"><p>Viewer not built on this registry. The track is available as <a href="/t/${esc(id!)}.json">JSON</a> — import it into your own Philomatic to read (and fork) it.</p>`;
        }
        pageCache.set(hash, page);
      }
      sendHtml(res, 200, page);
      return;
    }

    // The zero-install demo — a static build of the workbench running the full engine in the
    // visitor's browser (sql.js). Nothing a visitor does here reaches this server.
    if (method === 'GET' && demoDist !== undefined && (path === '/demo' || path.startsWith('/demo/'))) {
      const rel = path.slice('/demo'.length).replace(/^\/+/, '') || 'demo.html';
      const file = resolve(demoDist, rel);
      if (!file.startsWith(resolve(demoDist) + sep) && file !== resolve(demoDist, 'demo.html')) {
        sendJson(res, 404, { error: 'no such file' });
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        sendJson(res, 404, { error: 'no such file' });
        return;
      }
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream', ...CORS });
      res.end(readFileSync(file));
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${path}` });
  };

  return createServer((req, res) => {
    void handle(req, res).catch((e) => {
      const status = (e as { status?: number }).status ?? 500;
      sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}

/** `tsx src/registry/server.ts [--dir D] [--port N] [--host H] [--demo-dist D|off]` */
function main(): void {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg('--port') ?? process.env.REGISTRY_PORT ?? 4400);
  const host = arg('--host') ?? process.env.REGISTRY_HOST ?? '0.0.0.0';
  const dir = arg('--dir') ?? process.env.REGISTRY_DIR ?? '.philomatic-registry';
  const demoArg = arg('--demo-dist') ?? process.env.REGISTRY_DEMO_DIST;
  const server = createRegistryServer({ dir, port, host, ...(demoArg === 'off' ? { demoDist: false as const } : demoArg ? { demoDist: demoArg } : {}) });
  server.listen(port, host, () => {
    console.log(`philomatic registry listening on http://${host}:${port}  (dir: ${dir})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
