/**
 * The track registry — the GitHub-of-tracks service for a public
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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyDetached, verifyPublicationBundle } from '../engine/pub-verify';
import { FrameworkFileSchema } from '../framework';
import { AccountStore, accountsPath, clearSessionCookie, readCookie, readSessionCookie, sessionCookie, sessionRevoked, signSession, verifySession, type Account } from './accounts';
import { newPkce, newState, providersFromEnv, type OAuthProvider } from './oauth';
import { accountPageHtml, authPageHtml, formField, signInControl } from './account-page';
import { bearerToken, TokenStore, tokensPath } from './tokens';
import { originAllowed } from '../server/tenancy';
import { safeChild } from '../server/safe-path';
import { envKek, type Kek } from '../server/keys';
import { registryDEK, readPrivateJson, writePrivateJson } from './registry-crypto';
import { callerKey, RateLimiter } from '../server/rate-limit';
import { buildPublicationHtml } from '../cli/export-track';
import { slugify } from '../schema/ids';
import { brandLabel, escHtml as esc, publicShellHtml } from '../server/public-shell';
import { exampleList, readExample } from '../server/examples';
import { cspForInlinePage, SECURITY_HEADERS } from '../server/csp';

export interface RegistryEntry {
  trackId: string;
  title: string;
  author?: string;
  /**
   * The ACCOUNT that owns this name. Absent on tracks published before accounts
   * existed, and on registries that offer no sign-in — both keep the `authorKey` pin, which is
   * what an owned track no longer needs.
   */
  ownerAccountId?: string;
  /** The track's goal line — the one field a chooser needs that counts can't give. */
  goal?: string;
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
  // ── community ─────────────────────────────────────────
  /** Everything about the PEOPLE on this track, as ONE durable object — split from the
   *  bundle-derived fields above so a republish carries it forward structurally
   *  (`{...derived, community}`) instead of by field checklist: the follow suite once caught a
   *  new version dissolving members, invite, visibility and followers, and a checklist regrows
   *  that bug with every field added. Never served publicly — projections strip this ONE key. */
  community?: CommunityState;
}

/** The durable community state riding a RegistryEntry — the half a republish must never touch. */
export interface CommunityState {
  /** OFF the public index when true; still reachable by `/t/<id>` and the join link. A plain
   *  publish leaves this absent (listed); a community defaults it true. */
  unlisted?: boolean;
  /** Contributors — the owner (`ownerAccountId`) is the implicit owner and is not listed here. */
  members?: CommunityMember[];
  /** The one active shared join link. A 128-bit capability — NEVER served on a public route. */
  invite?: { token: string; createdAt: number; expiresAt?: number };
  /** FOLLOWERS: accounts watching this track, each with the version
   *  they last acknowledged — the inbox cursor. Never served publicly. */
  followers?: { accountId: string; sawHash: string }[];
}

export interface CommunityMember {
  accountId: string;
  role: 'contributor';
  joinedAt: number;
}

/** One piece of community mail: a question or a recommended source, waiting on the owner. */
// Deliberate twin of ContributionRecord in ui/src/lib/community.ts — the mailbox wire shape,
// mirrored because the lock line forbids a shared module across src/ and ui/.
export interface ContributionRecord {
  id: string;
  kind: 'question' | 'source';
  text: string;
  title?: string;
  author?: string;
  modality?: string;
  /** kind 'source': the open question this reading ANSWERS (the ask-page tie). */
  answersId?: string;
  answersText?: string;
  /** The track entity it hangs on, as the CONTRIBUTOR saw it (id + title from the bundle). */
  aboutId?: string;
  aboutTitle?: string;
  /** kind 'source': the recommended URL. */
  url?: string;
  accountId: string;
  name: string;
  at: number;
  resolved?: { action: 'accepted' | 'declined'; at: number };
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
  /** The intro slideshow (docs/slides/index.html), served at /intro. Default: the repo's
   *  copy if it exists. `false` disables the route. */
  introHtml?: string | false;
  now?: () => number;
  /** Set when a proxy in front sets `X-Forwarded-For` — see `callerKey` for why it is not a guess. */
  trustProxy?: boolean;
  /**
   * Sign-in providers. Default: whatever config offers — unset credentials mean sign-in
   * is simply not offered. Tests inject a fake, which is the point of the seam: a real
   * provider needs credentials, a real redirect and a real person clicking.
   */
  providers?: OAuthProvider[];
  /** HMAC secret for session cookies. Default `SESSION_SECRET`; absent disables sign-in. */
  sessionSecret?: string;
  /** Key-encryption key for at-rest encryption of the registry's private state. Omitted →
   *  `PHILOMATIC_KEK` from the env (and, in production, the KMS adapter). Tests inject one. */
  kek?: Kek;
  /**
   * The public origin this registry is reached at, e.g. `https://philomatic.io` — the OAuth
   * redirect URI is built from it and must match what the provider has registered. Default
   * `PUBLIC_URL`. `http://` origins send the session cookie without `Secure`, which is for
   * loopback development only.
   */
  publicUrl?: string;
}

const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const INTRO_HTML = fileURLToPath(new URL('../../docs/slides/index.html', import.meta.url));

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
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...CORS, ...SECURITY_HEADERS });
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

/** The library page — a server-rendered SHELL: the sorted track
 *  list as static HTML (crawlers and noscript readers see every track) plus a data
 *  island the public bundle (assets/public.js) mounts over with live search + concept facets.
 *  Sorting stays server-side (featured in the operator's order, then recency); the
 *  live body only filters. */
function libraryHtml(
  entries: (RegistryEntry & { featured?: boolean })[],
  featuredOrder: string[],
  intro: boolean,
  viewer: { account: Account | undefined; providers: { id: string; label: string }[] } = { account: undefined, providers: [] },
  /** accountId to what we should call them. A key prefix is not an identity anyone recognises. */
  ownerName: (id: string) => string | undefined = () => undefined,
): string {
  const rank = new Map(featuredOrder.map((id, i) => [id, i]));
  const sorted = entries
    .slice()
    .sort((a, b) => (rank.get(a.trackId) ?? 1e9) - (rank.get(b.trackId) ?? 1e9) || b.updatedAt - a.updatedAt);
  const row = (e: RegistryEntry & { featured?: boolean }): string => `<li>
  <a href="/t/${esc(e.trackId)}">${e.featured === true ? '★ ' : ''}${esc(e.title)}</a>
  ${e.goal !== undefined ? `<span class="goal">${esc(e.goal)}</span>` : ''}
  <span class="meta">${e.author ? `${esc(e.author)} · ` : ''}${e.sources} source${e.sources === 1 ? '' : 's'} · ${e.concepts} concept${e.concepts === 1 ? '' : 's'}${e.questions > 0 ? ` · ${e.questions} open thread${e.questions === 1 ? '' : 's'}` : ''} · ${esc(e.license)} · updated ${new Date(e.updatedAt).toISOString().slice(0, 10)}</span>
  ${(e.conceptNames ?? []).length > 0 ? `<span class="chips">${e.conceptNames.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</span>` : ''}
  ${
    e.ownerAccountId !== undefined && ownerName(e.ownerAccountId) !== undefined
      ? `<span class="owner" title="the account that owns this track">${esc(ownerName(e.ownerAccountId)!)}</span>`
      : `<span class="key" title="author key — this track predates accounts, so possession of the key is still its deed">${esc(e.authorKey.slice(0, 12))}…</span>`
  }
</li>`;
  const footer = `<footer>${intro ? `<p><a href="/intro">New here? The two-minute tour.</a></p>` : ''}Every track is a self-contained publication bundle — <em>fork</em> one by downloading its
JSON (add <code>.json</code> to any track URL) and importing it into your own Philomatic.</footer>`;
  return publicShellHtml({
    title: 'Philomatic track registry',
    // OUTSIDE #root: the registry app replaces everything inside it on hydration, so a control
    // the app knows nothing about would flash and disappear.
    aboveRoot: `<div class="reg-authbar">${brandLabel()}${signInControl(viewer.account, viewer.providers)}</div>`,
    essentials: `<div class="reg-page">
<h1>Track registry <span>${sorted.length} published track${sorted.length === 1 ? '' : 's'}</span></h1>
${sorted.length === 0 ? '<p class="reg-empty">Nothing published yet. <code>philomatic push &lt;track&gt; --registry &lt;this url&gt;</code></p>' : `<ul class="reg-tracks">\n${sorted.map(row).join('\n')}\n</ul>`}
${footer}
</div>`,
    islandId: 'registry-data',
    islandData: { entries: sorted, intro },
  });
}

export function createRegistryServer(opts: RegistryOptions = {}): Server {
  const dir = opts.dir ?? '.philomatic-registry';
  const cap = opts.maxBundleBytes ?? 16_000_000;
  const uiDist = opts.uiDist ?? UI_DIST;
  const introHtml = opts.introHtml === false ? undefined : (opts.introHtml ?? (existsSync(INTRO_HTML) ? INTRO_HTML : undefined));
  const now = opts.now ?? (() => Date.now());
  // ── accounts ─────────────────────────────────────────────────────────────────────
  const providers = opts.providers ?? providersFromEnv();
  const sessionSecret = opts.sessionSecret ?? process.env.SESSION_SECRET;
  const publicUrl = (opts.publicUrl ?? process.env.PUBLIC_URL ?? '').trim().replace(/\/$/, '');
  // Rate limits (hardening). Sign-in is the expensive one: each completed callback
  // is a token exchange with the provider, so an unlimited callback route spends the provider's
  // patience and this server's outbound budget on whoever asks. Minting is limited because a
  // token is a durable credential and nobody needs forty.
  const limiter = new RateLimiter();
  const trustProxy = (opts.trustProxy ?? process.env.TRUST_PROXY) === true || process.env.TRUST_PROXY === '1';
  /** Spend one; answers true when the caller should be told to wait. */
  const limited = (req: IncomingMessage, res: ServerResponse, kind: 'signin' | 'mint' | 'contribute', accountId?: string): boolean => {
    const bucket = kind === 'signin' ? { capacity: 10, perSecond: 0.2 } : kind === 'contribute' ? { capacity: 20, perSecond: 0.1 } : { capacity: 5, perSecond: 0.05 };
    const wait = limiter.take(`${kind}:${callerKey(req, { ...(accountId !== undefined ? { accountId } : {}), trustProxy })}`, bucket);
    if (wait === 0) return false;
    res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: `too many requests — try again in ${wait}s` }));
    return true;
  };
  const startedAt = new Date().toISOString();
  // Sign-in needs all three: someone to vouch, a secret to sign with, and an address to come
  // back to. Missing any one, the routes 404 and no button is shown — the feature is absent
  // rather than half-present.
  const signInReady = providers.length > 0 && sessionSecret !== undefined && sessionSecret !== '' && publicUrl !== '';
  // Encryption at rest for the registry's PRIVATE state (accounts, tokens, the index's community
  // secrets, the mailbox). A registry that offers sign-in holds people's emails and invite
  // tokens, so — like a hosted instance — it refuses to run plaintext unless told to out loud.
  // A pure public-bundle registry (no sign-in) has no PII and needs no key. Resolved before the
  // stores, which take the DEK.
  const kek = opts.kek ?? envKek();
  if (signInReady && kek === undefined && process.env.PHILOMATIC_ALLOW_PLAINTEXT !== '1') {
    throw new Error(
      'a sign-in registry holds accounts, tokens, and invite links: set PHILOMATIC_KEK (or PHILOMATIC_KMS_KEY) to encrypt them at rest, or set PHILOMATIC_ALLOW_PLAINTEXT=1 to accept plaintext deliberately.',
    );
  }
  const dek = registryDEK(dir, kek);
  const accounts = new AccountStore(accountsPath(dir), dek);
  /** The only name that reaches other people: the chosen handle, never the provider's real
   *  name or email. Falls back to a stable stub. */
  const publicName = (a: Account | undefined): string => a?.username ?? (a !== undefined ? `member-${a.id.slice(4, 10)}` : 'someone');
  const tokens = new TokenStore(tokensPath(dir), dek);
  const cookieSecure = publicUrl.startsWith('https://');
  const redirectUriFor = (id: string) => `${publicUrl}/auth/${id}/callback`;
  /** The signed-in account for a request, or undefined. */
  const sessionAccount = (req: IncomingMessage): Account | undefined => {
    if (!signInReady) return undefined;
    const cookie = readSessionCookie(req.headers.cookie);
    const id = cookie === undefined ? undefined : verifySession(cookie, sessionSecret!, now());
    if (id === undefined || cookie === undefined) return undefined;
    const account = accounts.get(id);
    // A session issued before this account signed out everywhere is over, however valid its
    // signature (hardening).
    return account !== undefined && !sessionRevoked(cookie, account) ? account : undefined;
  };
  /**
   * The account behind a request, by SESSION or by personal access token. A browser has
   * a cookie; a program has a bearer token. Both name the same account, and everything that
   * cares about ownership asks this rather than either one.
   */
  /** The tracks an account owns, newest first — the account page's "your tracks". */
  const ownedTracks = (accountId: string) =>
    Object.values(index)
      .filter((e) => e.ownerAccountId === accountId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((e) => ({ trackId: e.trackId, title: e.title, ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}) }));

  /** Tracks this account CONTRIBUTES to — the other half of "your tracks". */
  const memberTracks = (accountId: string) =>
    Object.values(index)
      .filter((e) => (e.community?.members ?? []).some((m) => m.accountId === accountId))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((e) => ({ trackId: e.trackId, title: e.title, ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}) }));

  /** Remove a published track: index, bundle file. The ARCHIVE is kept — every accepted version
   *  persists, the same doctrine as a local library's retraction trail. */
  const withdraw = (entry: RegistryEntry): void => {
    delete index[entry.trackId];
    saveIndex();
    try {
      unlinkSync(safeChild(dir, 'bundles', `${entry.trackId}.json`));
    } catch {
      /* already gone */
    }
  };

  const requestAccount = (req: IncomingMessage): Account | undefined => {
    const bySession = sessionAccount(req);
    if (bySession !== undefined) return bySession;
    const id = tokens.verify(bearerToken(req.headers.authorization), now);
    return id === undefined ? undefined : accounts.get(id);
  };
  mkdirSync(join(dir, 'bundles'), { recursive: true });
  mkdirSync(join(dir, 'archive'), { recursive: true });

  // ── REGISTERED FRAMEWORKS: register is to frameworks what publish is to tracks.
  // One personal framework per account, its PUBLIC NAME the account's username (so ownership
  // disputes cannot exist); each register mints an IMMUTABLE numbered version file; latest
  // resolves by name, exact versions resolve forever (a bundle citing v2 must find v2), and
  // withdraw hides a framework from LATEST resolution without breaking exact citations.
  mkdirSync(join(dir, 'frameworks'), { recursive: true });
  // The framework index maps names to owner accounts — private (it carries account ids), and
  // held in memory + saved on change, so encrypting the file is one decrypt at boot, one encrypt
  // per change. The published framework DEFS (frameworks/<name>@v*.json) stay plaintext (public).
  const fwIndexPath = join(dir, 'frameworks.json');
  const fwIndex: Record<string, { ownerAccountId: string; versions: number[]; withdrawn?: boolean; updatedAt: number }> =
    existsSync(fwIndexPath) ? readPrivateJson<typeof fwIndex>(fwIndexPath, dek) : {};
  const saveFwIndex = (): void => writePrivateJson(fwIndexPath, fwIndex, dek);
  const FW_NAME = /^[a-zA-Z0-9-]{1,64}$/; // username charset — and the path-traversal wall

  // The index carries community INVITE TOKENS and follower cursors inside each entry (the public
  // projection strips them; the file holds them), so it is private and encrypted at rest.
  const indexPath = join(dir, 'index.json');
  const index: Record<string, RegistryEntry> = existsSync(indexPath) ? readPrivateJson<Record<string, RegistryEntry>>(indexPath, dek) : {};
  // One-time lift (community split): entries written before the split carry the
  // community fields FLAT on the entry — move them under `community` so every reader/writer
  // sees one shape. Saved back on the next saveIndex like any other mutation.
  for (const e of Object.values(index) as (RegistryEntry & Partial<CommunityState>)[]) {
    if (e.community !== undefined) continue;
    const lifted: CommunityState = {
      ...(e.unlisted !== undefined ? { unlisted: e.unlisted } : {}),
      ...(e.members !== undefined ? { members: e.members } : {}),
      ...(e.invite !== undefined ? { invite: e.invite } : {}),
      ...(e.followers !== undefined ? { followers: e.followers } : {}),
    };
    delete e.unlisted;
    delete e.members;
    delete e.invite;
    delete e.followers;
    if (Object.keys(lifted).length > 0) e.community = lifted;
  }
  const saveIndex = (): void => writePrivateJson(indexPath, index, dek);

  /** The goal off a bundle's payload (its first track — a publication carries exactly one). */
  const goalOf = (bundle: unknown): string | undefined => {
    const tracks = (bundle as { payload?: { tracks?: { goal?: string }[] } }).payload?.tracks;
    const g = tracks?.[0]?.goal;
    return typeof g === 'string' && g.trim() !== '' ? g : undefined;
  };

  // Lazy backfill: entries written before `goal` existed get it from their bundle
  // file at boot — bundles/ is the truth, the index is rebuild-safe by doctrine.
  let backfilled = false;
  for (const entry of Object.values(index)) {
    if (entry.goal !== undefined) continue;
    try {
      const g = goalOf(JSON.parse(readFileSync(safeChild(dir, 'bundles', `${entry.trackId}.json`), 'utf8')));
      if (g !== undefined) {
        entry.goal = g;
        backfilled = true;
      }
    } catch {
      /* bundle unreadable — the entry just stays goal-less */
    }
  }
  if (backfilled) saveIndex();

  /** Operator curation: an ordered trackId list the operator edits by hand. Read per
   *  request — it's tiny, and edits show without a restart. */
  const featuredIds = (): string[] => {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'featured.json'), 'utf8'));
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };

  /** /t pages rendered once per contentHash (the viewer inlining is expensive). */
  const pageCache = new Map<string, string>();
  /** Its CSP, computed with it — the inlined script's hashes (see cspForInlinePage). */
  const pageCspCache = new Map<string, string>();

  /**
   * May this write proceed on ambient authority? See the call site for why this exists.
   *
   * A browser attaches `Origin` to every cross-site write without exception, so its ABSENCE is
   * not a gap: that is a non-browser client, which carries a token and takes the exemption above
   * it. `Sec-Fetch-Site` is preferred where sent, because it states the relationship directly
   * instead of by string comparison.
   */
  const sameSiteWrite = (req: IncomingMessage): boolean => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    if (bearerToken(req.headers.authorization) !== undefined) return true; // deliberate, not ambient
    return originAllowed(req);
  };

  /**
   * Where to send someone AFTER they sign in. A workbench sends
   * `?next=/app`; without this the callback always dropped them on the registry root, stranding
   * them away from where they started.
   *
   * Guarded against open redirect: a same-origin RELATIVE path only. `//host` and `/\host` are
   * how an attacker smuggles an absolute destination through a leading slash, so both are refused
   * back to the safe default. Anything not starting with a single `/` is not ours to honour.
   */
  const safeNext = (raw: string | null | undefined): string => {
    if (raw === null || raw === undefined || raw === '') return '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
    return raw;
  };
  const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');
  const unb64 = (v: string): string => {
    try {
      return Buffer.from(v, 'base64url').toString('utf8');
    } catch {
      return '/';
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // ── CSRF on cookie-authenticated writes ────────
    //
    // This became reachable the day publishing started requiring an account. Before that an
    // anonymous push already worked, so a cross-site POST bought an attacker nothing; now a
    // malicious page can make a signed-in browser publish an attacker-crafted bundle AS THEM —
    // and they can sign it with their own keypair, since only the ACCOUNT is checked.
    //
    // The same rule the host uses: a TOKEN is pasted on purpose and is exempt (the CLI and
    // self-hosted servers are unaffected); a cookie rides along by itself and must prove the
    // request came from us. Reads are untouched — the whole registry is meant to be readable.
    if (!sameSiteWrite(req)) {
      sendJson(res, 403, { error: 'cross-site write refused' });
      return;
    }

    // ── sign-in ──────────────────────────────────────────────────────────────────
    //
    // Three routes and no more: go ask a provider, come back, forget me. The state parameter is
    // the CSRF defence for the round trip — it is minted here, parked in a short-lived cookie,
    // and must come back identical, or the callback is somebody else's.
    if (method === 'POST' && path === '/auth/signout') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': clearSessionCookie(cookieSecure), ...CORS });
      res.end();
      return;
    }
    /**
     * Who the caller is — by session OR by bearer token. Answers for a signed-out visitor too:
     * absence is a fact, not an error.
     *
     * The bearer half is what a HOST asks (the hosting design). The host may
     * not read this registry's token store directly — the lock line keeps `src/server` out of
     * `src/registry`, and a registry and a host may sit on different boxes anyway — so
     * "whose token is this?" is a question asked over HTTP, and this is where it is answered.
     */
    if (method === 'GET' && path === '/auth/me') {
      const account = requestAccount(req);
      sendJson(res, 200, {
        signedIn: account !== undefined,
        // Never the provider subject: it is the join key to that provider's directory and no
        // page needs it. `needsUsername` gates the first-run "pick a handle" step: signed in
        // but no public name chosen yet.
        ...(account !== undefined ? { account: { id: account.id, name: account.name, email: account.email, ...(account.username !== undefined ? { username: account.username } : {}) } } : {}),
        ...(account !== undefined ? { needsUsername: account.username === undefined } : {}),
        providers: signInReady ? providers.map((p) => ({ id: p.id, label: p.label })) : [],
      });
      return;
    }

    // Two doors to the same act. Already signed in, neither is a page you
    // want — you want your account.
    if (method === 'GET' && (path === '/signin' || path === '/signup')) {
      if (sessionAccount(req) !== undefined) {
        res.writeHead(302, { Location: '/account', ...CORS });
        res.end();
        return;
      }
      sendHtml(res, 200, authPageHtml({
        mode: path === '/signup' ? 'signup' : 'signin',
        providers: signInReady ? providers.map((p) => ({ id: p.id, label: p.label })) : [],
        next: safeNext(new URL(req.url ?? '/', 'http://x').searchParams.get('next')),
      }));
      return;
    }

    // The pages a person needs to hold an account. Everything below already
    // worked; without these a beta user had to type /auth/google into the address bar and paste
    // a fetch() into the console.
    // Every /account surface enters here, because they all need the same thing: a session, or a
    // redirect to sign in. `tracks/<id>/unpublish` belongs to the family — a route
    // added to the block below without being added HERE simply never runs, which is how the
    // first draft of "withdraw from your account page" 404'd.
    const accountRoute = /^\/account(?:\/signout-all|\/tracks\/[^/]+\/unpublish|\/tokens(?:\/([a-z0-9_]+)\/revoke)?)?$/.exec(path);
    if (accountRoute !== null) {
      const account = sessionAccount(req);
      if (account === undefined) {
        // Not an error: you are simply not signed in yet, and the way in is the page you came
        // from. Anything else strands someone whose session merely expired.
        res.writeHead(302, { Location: '/', ...CORS });
        res.end();
        return;
      }
      if (method === 'GET' && path === '/account') {
        sendHtml(res, 200, accountPageHtml({ account, tokens: tokens.list(account.id), tracks: ownedTracks(account.id), memberOf: memberTracks(account.id) }));
        return;
      }
      if (method === 'POST' && path === '/account/tokens') {
        if (limited(req, res, 'mint', account.id)) return;
        const label = formField(await readBody(req, 4096), 'label');
        const minted = tokens.mint(account.id, label, now);
        // Rendered by the POST itself rather than carried through a redirect: a secret in a URL
        // lands in browser history, in server logs, and in whatever proxy sits between.
        sendHtml(res, 200, accountPageHtml({
          tracks: ownedTracks(account.id),
          account,
          tokens: tokens.list(account.id),
          justMinted: { secret: minted.secret, label: minted.token.label },
        }));
        return;
      }
      // Withdraw from the account page. The account is the deed, so there is
      // no key challenge here — that path stays for a still-unowned track, whose only proof IS
      // the key. A form post, so it works with no JavaScript on the page.
      const ownUnpublish = /^\/account\/tracks\/([^/]+)\/unpublish$/.exec(path);
      if (method === 'POST' && ownUnpublish !== null) {
        const entry = index[ownUnpublish[1]!];
        if (entry === undefined || entry.ownerAccountId !== account.id) {
          sendJson(res, 404, { error: 'no such track on this account' });
          return;
        }
        withdraw(entry);
        res.writeHead(302, { Location: '/account', ...CORS });
        res.end();
        return;
      }
      if (method === 'POST' && path === '/account/signout-all') {
        accounts.signOutEverywhere(account.id, now);
        // This browser's cookie is cleared too: signing out everywhere that does not include
        // where you are standing would be a strange promise to make.
        res.writeHead(302, { Location: '/', 'Set-Cookie': clearSessionCookie(cookieSecure), ...CORS });
        res.end();
        return;
      }
      if (method === 'POST' && accountRoute[1] !== undefined) {
        tokens.revoke(account.id, accountRoute[1], now);
        res.writeHead(302, { Location: '/account', ...CORS });
        res.end();
        return;
      }
      sendJson(res, 405, { error: `${method} not allowed on ${path}` });
      return;
    }

    // Personal access tokens: a program's credential, minted from a browser session.
    // Minting requires a SESSION specifically, not `requestAccount` — a token that can mint
    // more tokens is a token that cannot really be revoked.
    const tokenRoute = /^\/auth\/tokens(?:\/([a-z0-9_]+))?$/.exec(path);
    if (tokenRoute !== null) {
      const account = sessionAccount(req);
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in to manage access tokens' });
        return;
      }
      if (method === 'GET' && tokenRoute[1] === undefined) {
        sendJson(res, 200, { tokens: tokens.list(account.id) });
        return;
      }
      if (method === 'POST' && tokenRoute[1] === undefined) {
        if (limited(req, res, 'mint', account.id)) return;
        // A label is a convenience, not a requirement: an empty or absent body mints a token
        // called "workbench" rather than refusing.
        let label = '';
        try {
          const raw = (await readBody(req, 4096)).trim();
          if (raw !== '') {
            const body = JSON.parse(raw) as { label?: unknown };
            if (typeof body.label === 'string') label = body.label;
          }
        } catch {
          sendJson(res, 400, { error: 'body must be JSON' });
          return;
        }
        const minted = tokens.mint(account.id, label, now);
        // The one and only time the secret exists outside the caller's hands.
        sendJson(res, 201, { token: minted.token, secret: minted.secret, shownOnce: true });
        return;
      }
      if (method === 'DELETE' && tokenRoute[1] !== undefined) {
        // Scoped to this account inside `revoke`: an id is public, so revoking by id alone would
        // let anyone who has seen one disable somebody else's token.
        sendJson(res, 200, { revoked: tokens.revoke(account.id, tokenRoute[1], now) });
        return;
      }
      sendJson(res, 405, { error: `${method} not allowed on ${path}` });
      return;
    }

    // Reserved names above; anything else under /auth is a provider id.
    const signIn = /^\/auth\/([a-z0-9-]+)(\/callback)?$/.exec(path);
    if (method === 'GET' && signIn !== null && signInReady) {
      if (limited(req, res, 'signin')) return;
      const provider = providers.find((p) => p.id === signIn[1]);
      if (provider === undefined) {
        sendJson(res, 404, { error: `no sign-in provider "${signIn[1]}"` });
        return;
      }
      const redirectUri = redirectUriFor(provider.id);
      if (signIn[2] === undefined) {
        const state = newState();
        const { verifier, challenge, nonce } = newPkce();
        const next = safeNext(new URL(req.url ?? '/', 'http://x').searchParams.get('next'));
        res.writeHead(302, {
          Location: provider.authorizeUrl({ state, redirectUri, challenge, nonce }),
          // Five minutes: long enough to sign in, short enough that an abandoned attempt does
          // not leave a usable state lying in the browser.
          // State, PKCE verifier and nonce ride home together in one HttpOnly cookie. The
          // verifier must never leave this browser-and-server pair — that is what makes an
          // intercepted authorization code unusable to whoever caught it.
          // A real return path rides home as a fourth field — base64url so it carries no dot to
          // confuse the split, re-guarded on the way out. Omitted for the common no-next case, so
          // that cookie is byte-for-byte what it always was.
          'Set-Cookie': `pm_oauth_state=${state}.${verifier}.${nonce}${next === '/' ? '' : `.${b64(next)}`}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=300${cookieSecure ? '; Secure' : ''}`,
          ...CORS,
        });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const parked = readCookie(req.headers.cookie, 'pm_oauth_state')?.split('.');
      const [expected, verifier, nonce, nextB64] = parked ?? [];
      if (code === null || state === null || expected === undefined || verifier === undefined || nonce === undefined || state !== expected) {
        // One message for every way this can fail. Telling a caller WHICH check failed tells an
        // attacker which half of the round trip they got right.
        sendJson(res, 400, { error: 'sign-in could not be completed — start again' });
        return;
      }
      let account: Account;
      try {
        account = accounts.upsert(await provider.exchange({ code, redirectUri, verifier, nonce }), now);
      } catch {
        sendJson(res, 502, { error: `${provider.label} did not complete the sign-in` });
        return;
      }
      // The username is chosen ONCE, inside the sign-up round trip: a brand
      // new account detours through /welcome before landing where it was headed — no post-hoc
      // modal ambushing people mid-page. An account that has its handle sails straight through.
      const dest = safeNext(nextB64 !== undefined ? unb64(nextB64) : '/');
      res.writeHead(302, {
        Location: account.username === undefined ? `/welcome?next=${encodeURIComponent(dest)}` : dest,
        'Set-Cookie': [
          sessionCookie(signSession(account.id, sessionSecret!, now()), { secure: cookieSecure }),
          `pm_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0${cookieSecure ? '; Secure' : ''}`,
        ],
        ...CORS,
      });
      res.end();
      return;
    }
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, tracks: Object.keys(index).length });
      return;
    }

    // ── Framework registration ─────────────────────────────────────────────────────
    if (method === 'POST' && path === '/frameworks') {
      const account = requestAccount(req);
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in to register a framework' });
        return;
      }
      if (account.username === undefined) {
        sendJson(res, 409, { error: 'choose a username first — your framework is named after it', needs: 'username' });
        return;
      }
      let def: ReturnType<typeof FrameworkFileSchema.parse>;
      try {
        def = FrameworkFileSchema.parse(JSON.parse(await readBody(req, cap)));
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'not a framework file' });
        return;
      }
      const name = account.username;
      const entry = fwIndex[name] ?? { ownerAccountId: account.id, versions: [], updatedAt: now() };
      if (entry.ownerAccountId !== account.id) {
        sendJson(res, 403, { error: 'that framework name belongs to another account' });
        return;
      }
      const version = (entry.versions[entry.versions.length - 1] ?? 0) + 1;
      const stamped = { ...def, framework: name, version };
      writeFileSync(safeChild(dir, 'frameworks', `${name}@v${version}.json`), JSON.stringify(stamped, null, 2));
      entry.versions = [...entry.versions, version];
      delete entry.withdrawn; // re-registering un-withdraws — the owner is speaking again
      entry.updatedAt = now();
      fwIndex[name] = entry;
      saveFwIndex();
      sendJson(res, 200, { registered: true, name, version });
      return;
    }
    // Withdraw from LATEST resolution; exact versions stay resolvable (immutability promise).
    if (method === 'POST' && path === '/frameworks/withdraw') {
      const account = requestAccount(req);
      const entry = account?.username !== undefined ? fwIndex[account.username] : undefined;
      if (account === undefined || entry === undefined || entry.ownerAccountId !== account.id) {
        sendJson(res, account === undefined ? 401 : 404, { error: 'no registered framework to withdraw' });
        return;
      }
      entry.withdrawn = true;
      entry.updatedAt = now();
      saveFwIndex();
      sendJson(res, 200, { withdrawn: true });
      return;
    }
    // Resolve: /frameworks/<name>.json = latest (404 when withdrawn or unregistered);
    //          /frameworks/<name>@v<N>.json = that exact immutable version, forever.
    if (method === 'GET' && path !== undefined && path.startsWith('/frameworks/') && path.endsWith('.json')) {
      const ref = decodeURIComponent(path.slice('/frameworks/'.length, -'.json'.length));
      const m = /^(.+?)(?:@v(\d+))?$/.exec(ref);
      const name = m?.[1] ?? '';
      if (!FW_NAME.test(name)) {
        sendJson(res, 404, { error: 'no such framework' });
        return;
      }
      const entry = fwIndex[name];
      const exact = m?.[2] !== undefined ? Number(m[2]) : undefined;
      const version = exact ?? (entry !== undefined && entry.withdrawn !== true ? entry.versions[entry.versions.length - 1] : undefined);
      const file = version !== undefined && entry?.versions.includes(version) ? safeChild(dir, 'frameworks', `${name}@v${version}.json`) : undefined;
      if (file === undefined || !existsSync(file)) {
        sendJson(res, 404, { error: 'no such framework' });
        return;
      }
      sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')));
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
      // The trackId is the on-disk filename for the bundle and its archive. It is always a
      // `syl_`-prefixed slug when minted, but it arrives inside a signed payload the author
      // controls — so pin the shape here (the clean refusal) before it reaches any path join
      // (the `safeChild` containment backstop). A signature over a hostile id is still hostile.
      if (!/^syl_[a-z0-9-]+$/.test(pub.trackId)) {
        sendJson(res, 400, { error: 'malformed trackId' });
        return;
      }
      const prior = index[pub.trackId];
      // ── who owns this name? ────────────────────────────────────────────────
      //
      // Ownership is moving from a device KEY to an ACCOUNT, because possession of a file is a
      // terrible deed: lose the laptop and nobody — including the author — can ever update or
      // withdraw the track. But the change cannot strand what is already published, so the
      // existing proof buys the new one: publish an unowned track with the key it is pinned to,
      // while signed in, and it becomes yours. No claim form, no operator, no flag day.
      //
      //   owned      → must be that account. The key no longer matters; that is the point.
      //   unowned    → the key rule, exactly as before, and an authenticated push CLAIMS it.
      //   no sign-in → the key rule and nothing else. A self-hosted registry with no accounts
      //                configured must keep working unchanged.
      const claimant = signInReady ? requestAccount(req)?.id : undefined;
      // A registry that OFFERS accounts requires one to publish. The commons
      // is a place people put their names on things: anonymous pushes leave a track nobody can
      // update or withdraw, and no one to answer for it. This is not the same as the ask-link
      // rule — a stranger recommending a source is a guest of one track's owner, while
      // publishing puts something in front of everybody.
      //
      // A registry with NO sign-in configured is unaffected and keeps the key rule: a
      // self-hosted registry must not need accounts it was never given a way to create.
      if (signInReady && claimant === undefined) {
        sendJson(res, 401, {
          error: 'publishing needs an account — sign in on this registry, then publish with an access token from your account page',
        });
        return;
      }
      if (prior?.ownerAccountId !== undefined) {
        if (claimant !== prior.ownerAccountId) {
          sendJson(res, 403, {
            error:
              claimant === undefined
                ? `track ${pub.trackId} belongs to an account — sign in and publish with an access token`
                : `track ${pub.trackId} belongs to someone else`,
          });
          return;
        }
      } else if (prior && prior.authorKey !== pub.authorKey) {
        sendJson(res, 403, {
          error: `track ${pub.trackId} is pinned to a different author key (${prior.authorKey.slice(0, 12)}…) — the first publisher owns the name`,
        });
        return;
      }
      // Framework identity rides the PUSH: each carried definition is stamped
      // with the pusher's USERNAME as author — attribution minted by the credential, never
      // self-asserted — and best-effort ARCHIVED under its name for later discovery. Archiving
      // never blocks a publish: a name owned by another account simply isn't archived (the
      // defs still travel in the bundle, which is what forks actually read).
      {
        const pusher = signInReady ? requestAccount(req) : undefined;
        const defs = (v.bundle as { frameworkDefs?: { framework: string; version: number; author?: string }[] }).frameworkDefs;
        if (Array.isArray(defs) && pusher?.username !== undefined) {
          for (const def of defs) {
            def.author = pusher.username;
            const fe = fwIndex[def.framework] ?? { ownerAccountId: pusher.id, versions: [], updatedAt: now() };
            if (fe.ownerAccountId !== pusher.id || !FW_NAME.test(def.framework)) continue;
            if (!fe.versions.includes(def.version)) {
              writeFileSync(safeChild(dir, 'frameworks', `${def.framework}@v${def.version}.json`), JSON.stringify(def, null, 2));
              fe.versions = [...fe.versions, def.version].sort((a, b) => a - b);
            }
            delete fe.withdrawn;
            fe.updatedAt = now();
            fwIndex[def.framework] = fe;
          }
          saveFwIndex();
        }
      }
      const payload = v.bundle.payload as Record<string, unknown[]>;
      const entry: RegistryEntry = {
        trackId: pub.trackId,
        title: pub.title,
        ...(pub.author !== undefined ? { author: pub.author } : {}),
        ...(goalOf(v.bundle) !== undefined ? { goal: goalOf(v.bundle) } : {}),
        license: pub.license,
        authorKey: pub.authorKey,
        contentHash: pub.contentHash,
        publishedAt: pub.publishedAt,
        // Claimed on this push, or carried forward. Never dropped: a later anonymous push
        // cannot un-own a track, it is simply refused above.
        ...(claimant !== undefined || prior?.ownerAccountId !== undefined
          ? { ownerAccountId: claimant ?? prior!.ownerAccountId! }
          : {}),
        // COMMUNITY state survives a republish (caught by the follow suite: a new
        // version wiped members, the invite, visibility, and every follower — a professor's
        // weekly update would have dissolved the class). Since the structural split it rides as
        // ONE object — `{...derived, community}` by construction, not by field checklist, so a
        // future community field cannot be forgotten here. The one deliberate touch inside it:
        // a follower who IS the pusher has obviously seen what they just pushed (
        // question) — their cursor advances; everyone else's stays put.
        ...(prior?.community !== undefined
          ? {
              community: {
                ...prior.community,
                ...(prior.community.followers !== undefined
                  ? { followers: prior.community.followers.map((f) => (f.accountId === claimant ? { ...f, sawHash: pub.contentHash } : f)) }
                  : {}),
              },
            }
          : {}),
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
      writeFileSync(safeChild(dir, 'archive', `${pub.contentHash}.json`), raw);
      writeFileSync(safeChild(dir, 'bundles', `${pub.trackId}.json`), raw);
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
      // Withdrawing follows publishing: once a track belongs to an account, its owner
      // takes it down — and can, from any machine, which is the whole reason for the change. A
      // still-unowned track keeps the key challenge.
      if (entry.ownerAccountId !== undefined) {
        const who = signInReady ? requestAccount(req)?.id : undefined;
        if (who !== entry.ownerAccountId) {
          sendJson(res, 403, { error: `track ${entry.trackId} belongs to an account — sign in as its owner to withdraw it` });
          return;
        }
      } else {
        const challenge = `unpublish:${entry.trackId}:${entry.contentHash}`;
        if (body.signature === undefined || !verifyDetached(challenge, body.signature, entry.authorKey)) {
          sendJson(res, 403, { error: 'signature must be by the pinned author key over the unpublish challenge' });
          return;
        }
      }
      withdraw(entry);
      // The archive keeps every accepted version — copies persist, same doctrine as local.
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── community: sharing settings on a published track ────────────────────────────────
    //
    // Membership lives on the ENTRY: the owner is `ownerAccountId`, contributors are
    // `members`, and one shared, revocable `invite` link onboards a class. The token is a 128-bit
    // capability and is served ONLY to the owner — never on the public index (see the projection).
    const community = /^\/t\/([^/]+)\/community$/.exec(path);
    if (community !== null && (method === 'GET' || method === 'POST')) {
      const entry = index[community[1]!];
      if (entry === undefined) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      const account = sessionAccount(req);
      const isOwner = account !== undefined && entry.ownerAccountId === account.id;

      const ownerView = () => {
        // PUBLIC_URL is always set wherever an owner can exist: sign-in itself requires it
        // (signInReady), so there is no signed-in owner on a registry without one.
        const cx = entry.community;
        const link = cx?.invite !== undefined && publicUrl !== '' ? `${publicUrl}/t/${entry.trackId}/join?c=${cx.invite.token}` : undefined;
        return {
          owner: true,
          unlisted: cx?.unlisted === true,
          invite:
            cx?.invite !== undefined
              ? { link, createdAt: cx.invite.createdAt, ...(cx.invite.expiresAt !== undefined ? { expiresAt: cx.invite.expiresAt } : {}) }
              : null,
          members: (cx?.members ?? []).map((m) => {
            const a = accounts.get(m.accountId);
            return { accountId: m.accountId, name: publicName(a), role: m.role, joinedAt: m.joinedAt };
          }),
        };
      };

      if (method === 'GET') {
        if (isOwner) {
          sendJson(res, 200, ownerView());
          return;
        }
        // A member learns only that they belong; a stranger learns nothing — not the member list,
        // not the invite, not even that the track is unlisted.
        const member = account !== undefined && (entry.community?.members ?? []).some((m) => m.accountId === account.id);
        const following = account !== undefined && (entry.community?.followers ?? []).some((f) => f.accountId === account.id);
        sendJson(res, 200, { owner: false, member, following });
        return;
      }

      // POST — owner only, and cookie-authed, so the same-origin CSRF check above already applies.
      if (!isOwner) {
        sendJson(res, 403, { error: 'only the track owner can change its sharing' });
        return;
      }
      let body: { unlisted?: boolean; invite?: 'mint' | 'revoke'; removeMember?: string };
      try {
        body = JSON.parse(await readBody(req, 4096)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'body is not JSON' });
        return;
      }
      const c = (entry.community ??= {});
      if (typeof body.unlisted === 'boolean') c.unlisted = body.unlisted;
      // EJECT a member: revoking the invite only stops NEW joins — the
      // owner also needs to remove someone already in. Their follow of the track goes with the
      // membership; their past contributions stay in the mailbox, attributed, as history.
      if (typeof body.removeMember === 'string') {
        c.members = (c.members ?? []).filter((m) => m.accountId !== body.removeMember);
        c.followers = (c.followers ?? []).filter((f) => f.accountId !== body.removeMember);
      }
      if (body.invite === 'mint') {
        // Minting REPLACES any prior link — one active invite, and the old capability dies. A
        // community defaults to unlisted the first time it is shared, unless already set.
        c.invite = { token: randomBytes(16).toString('hex'), createdAt: now() };
        if (c.unlisted === undefined) c.unlisted = true;
      }
      if (body.invite === 'revoke') delete c.invite;
      saveIndex();
      sendJson(res, 200, ownerView());
      return;
    }

    // ── join a community by its shared link ────────────────────────────────────────────
    //
    // `/t/<id>/join?c=<token>`: a page that turns an anonymous visitor into a signed-in
    // contributor. GET renders the page (and prompts sign-in if needed, returning here); POST
    // redeems. The token is compared in constant time and must match the ONE active invite.
    const joinRoute = /^\/t\/([^/]+)\/join$/.exec(path);
    if (joinRoute !== null && (method === 'GET' || method === 'POST')) {
      const entry = index[joinRoute[1]!];
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const token = url.searchParams.get('c') ?? '';
      const invite = entry?.community?.invite;
      const validInvite = invite !== undefined && token.length === invite.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(invite.token));
      const notExpired = invite?.expiresAt === undefined || invite.expiresAt > now();
      const account = sessionAccount(req);

      if (method === 'POST') {
        if (entry === undefined || !validInvite || !notExpired) {
          sendJson(res, 410, { error: 'this invite link is not valid — ask for a fresh one' });
          return;
        }
        if (account === undefined) {
          sendJson(res, 401, { error: 'sign in to join' });
          return;
        }
        // Idempotent, and the owner is already the owner — neither becomes a duplicate contributor.
        const jc = (entry.community ??= {});
        if (account.id !== entry.ownerAccountId && !(jc.members ?? []).some((m) => m.accountId === account.id)) {
          jc.members = [...(jc.members ?? []), { accountId: account.id, role: 'contributor', joinedAt: now() }];
          // Members FOLLOW by default — joining a class means
          // wanting to hear when it moves. The toggle on the track page undoes it.
          if (!(jc.followers ?? []).some((f) => f.accountId === account.id)) {
            jc.followers = [...(jc.followers ?? []), { accountId: account.id, sawHash: entry.contentHash }];
          }
          saveIndex();
        }
        // A browser FORM lands on the track it just joined (a JSON
        // screen is not a destination); programmatic callers keep the JSON answer.
        if ((req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(303, { Location: `/t/${entry.trackId}`, ...CORS });
          res.end();
          return;
        }
        sendJson(res, 200, { joined: true, trackId: entry.trackId, url: `/t/${entry.trackId}` });
        return;
      }

      // GET — the page. A bad or expired link says so plainly; a good one names the track and,
      // if signed out, sends you to sign in and back.
      const title = entry?.title ?? 'a track';
      const backHere = `/t/${joinRoute[1]}/join?c=${encodeURIComponent(token)}`;
      const body =
        entry === undefined || !validInvite || !notExpired
          ? `<div class="reg-authpage"><h1>This invite link is not valid</h1><p class="reg-hint">It may have been revoked or replaced. Ask whoever shared it for a fresh one.</p><p class="reg-hint"><a href="/">← the registry</a></p></div>`
          : account === undefined
            ? `<div class="reg-authpage"><h1>Join “${esc(title)}”</h1><p class="reg-hint">You have been invited to contribute to this track. Sign in to join.</p><a class="reg-provider" href="/signin?next=${esc(encodeURIComponent(backHere))}"><span>Sign in to join</span></a></div>`
            : `<div class="reg-authpage"><h1>Join “${esc(title)}”</h1><p class="reg-hint">Signed in as ${esc(account.name ?? account.email ?? 'your account')}. Join as a contributor — you will be able to recommend sources and ask questions on this track.</p><form method="post" action="${esc(backHere)}"><button class="reg-provider" type="submit"><span>Join this track</span></button></form></div>`;
      sendHtml(res, 200, publicShellHtml({ title: `Join ${title}`, essentials: body }));
      return;
    }

    // ── follow: hear when a track moves ─────────────────────────────
    //
    // Any signed-in account may follow any track it can SEE (a listed one, or one it is a member
    // of); members follow by default on join. The follower record carries `sawHash` — the
    // version last acknowledged — which is the inbox cursor: /account/following answers "what
    // moved since you looked", and marking seen advances it. Store-and-forward, like the
    // mailbox: the registry never reaches into a graph.
    const follow = /^\/t\/([^/]+)\/follow$/.exec(path);
    if (follow !== null && method === 'POST') {
      const entry = index[follow[1]!];
      const account = sessionAccount(req);
      if (entry === undefined) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in to follow' });
        return;
      }
      const fc = (entry.community ??= {});
      const member = entry.ownerAccountId === account.id || (fc.members ?? []).some((m) => m.accountId === account.id);
      if (fc.unlisted === true && !member) {
        sendJson(res, 403, { error: 'join this track to follow it' });
        return;
      }
      let body: { follow?: boolean; saw?: string };
      try {
        body = JSON.parse(await readBody(req, 4096)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'body is not JSON' });
        return;
      }
      const rest = (fc.followers ?? []).filter((f) => f.accountId !== account.id);
      if (body.follow === false) fc.followers = rest;
      else if (body.follow === true) fc.followers = [...rest, { accountId: account.id, sawHash: entry.contentHash }];
      else if (typeof body.saw === 'string') {
        const mine = (fc.followers ?? []).find((f) => f.accountId === account.id);
        if (mine !== undefined) mine.sawHash = body.saw;
      }
      saveIndex();
      sendJson(res, 200, { following: (fc.followers ?? []).some((f) => f.accountId === account.id) });
      return;
    }

    // What moved since you looked — the follower's feed, newest first.
    // The sign-up detour: a fresh account picks its PUBLIC handle here,
    // then continues to wherever it was going. Already-handled accounts are waved through.
    if (method === 'GET' && path === '/welcome') {
      const account = sessionAccount(req);
      const dest = safeNext(new URL(req.url ?? '/', 'http://x').searchParams.get('next'));
      if (account === undefined) {
        res.writeHead(302, { Location: '/', ...CORS });
        res.end();
        return;
      }
      if (account.username !== undefined) {
        res.writeHead(302, { Location: dest, ...CORS });
        res.end();
        return;
      }
      sendHtml(res, 200, publicShellHtml({
        title: 'Choose a username — Philomatic',
        essentials: `<div class="reg-authpage">
<h1>Choose a username</h1>
<p class="reg-hint">The only name other people see — on tracks you contribute to and anything you publish. Your real name stays private to your own account.</p>
<form class="reg-welcome" method="post" action="/account/username">
  <input type="hidden" name="next" value="${esc(dest)}" />
  <input name="username" placeholder="letters, digits, single hyphens" minlength="3" maxlength="32" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" title="3–32 characters: letters and digits joined by single hyphens" autofocus required />
  <button class="reg-provider" type="submit"><span>Continue</span></button>
</form>
<p class="reg-hint">3–32 characters — letters and digits, joined by single hyphens.</p>
</div>`,
      }));
      return;
    }

    // Set the public handle: chosen in the sign-up detour, editable on /account.
    // Cookie-authed, so the global same-site guard covers it. 3–24 chars, letters/digits/-/_ ,
    // unique case-insensitively.
    if (method === 'POST' && path === '/account/username') {
      const account = sessionAccount(req);
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in first' });
        return;
      }
      const raw = await readBody(req, 1024);
      // The account page and /welcome post FORMS; the API path posts JSON. Accept either.
      const ctype = req.headers['content-type'] ?? '';
      const isJson = ctype.includes('application/json');
      const username = (isJson ? ((JSON.parse(raw || '{}') as { username?: string }).username ?? '') : formField(raw, 'username')).trim();
      const formNext = isJson ? '' : formField(raw, 'next');
      const wantsHtml = (req.headers.accept ?? '').includes('text/html') || !isJson;
      const backTo = formNext !== '' ? `/welcome?next=${encodeURIComponent(safeNext(formNext))}` : '/account';
      const onward = formNext !== '' ? safeNext(formNext) : '/account';
      // 3–32 chars, alphanumeric runs joined by SINGLE hyphens — no spaces or underscores, no
      // leading/trailing hyphen, no consecutive hyphens. Kept identical
      // in AccountControl (client) by comment: the lock line forbids one shared module across
      // src/ and ui/, so this is a duplication to watch.
      if (!(username.length >= 3 && username.length <= 32 && /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(username))) {
        if (wantsHtml) { res.writeHead(303, { Location: backTo, ...CORS }); res.end(); return; }
        sendJson(res, 400, { error: '3–32 characters: letters and digits joined by single hyphens — no spaces, underscores, or leading/trailing/double hyphens' });
        return;
      }
      if (!accounts.setUsername(account.id, username)) {
        if (wantsHtml) { res.writeHead(303, { Location: backTo, ...CORS }); res.end(); return; }
        sendJson(res, 409, { error: 'that username is taken' });
        return;
      }
      if (wantsHtml) { res.writeHead(303, { Location: onward, ...CORS }); res.end(); return; }
      sendJson(res, 200, { username });
      return;
    }

    if (method === 'GET' && path === '/account/following') {
      const account = sessionAccount(req);
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in first' });
        return;
      }
      const rows = Object.values(index)
        .map((e) => {
          const mine = (e.community?.followers ?? []).find((f) => f.accountId === account.id);
          return mine === undefined
            ? undefined
            : { trackId: e.trackId, title: e.title, contentHash: e.contentHash, sawHash: mine.sawHash, updatedAt: e.updatedAt };
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      sendJson(res, 200, { following: rows });
      return;
    }

    // ── contributions: the classroom's mailbox ─────────────────────────────────────────
    //
    // A member sends a QUESTION (tied to a source/concept of the track) or RECOMMENDS a source;
    // it waits here, attributed to the account, until the owner accepts it into their library or
    // declines it. The registry stores and relays — it never touches the owner's graph. One JSON
    // file per track, owner-read, member-write, both cookie-authed (the global CSRF guard and the
    // contribute rate bucket apply).
    const contrib = /^\/t\/([^/]+)\/contributions?$/.exec(path);
    if (contrib !== null && (method === 'GET' || method === 'POST')) {
      const entry = index[contrib[1]!];
      if (entry === undefined) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      const account = sessionAccount(req);
      if (account === undefined) {
        sendJson(res, 401, { error: 'sign in first' });
        return;
      }
      const isOwner = entry.ownerAccountId === account.id;
      // The mailbox carries contributor identity and unpublished content — private, so encrypted
      // at rest like the rest of the registry's PII.
      const file = safeChild(dir, 'contributions', `${entry.trackId}.json`);
      const load = (): ContributionRecord[] => {
        try {
          return readPrivateJson<ContributionRecord[]>(file, dek);
        } catch {
          return [];
        }
      };
      const save = (all: ContributionRecord[]) => writePrivateJson(file, all, dek);

      if (method === 'GET') {
        // The owner reads the pending mail; a member sees only their own (so "did it send?" has
        // an answer that is not somebody else's mailbox).
        const all = load().filter((c) => c.resolved === undefined);
        sendJson(res, 200, { contributions: isOwner ? all : all.filter((c) => c.accountId === account.id) });
        return;
      }

      // POST /t/<id>/contributions/…: the path decides which act; both live under one regex so
      // the accountRoute-style listing mistake (a route added but not matched) cannot recur here.
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req, 16_384)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'body is not JSON' });
        return;
      }

      if (typeof body.resolve === 'string') {
        // Owner only: accept/decline stamps the record rather than deleting it — the mailbox is
        // also the audit trail of what was offered.
        if (!isOwner) {
          sendJson(res, 403, { error: 'only the track owner resolves contributions' });
          return;
        }
        const action = body.action === 'accepted' ? 'accepted' : 'declined';
        const all = load();
        const hit = all.find((c) => c.id === body.resolve && c.resolved === undefined);
        if (hit === undefined) {
          sendJson(res, 404, { error: 'no such pending contribution' });
          return;
        }
        hit.resolved = { action, at: now() };
        save(all);
        sendJson(res, 200, { ok: true });
        return;
      }

      // A new contribution: members and the owner may send; strangers may not.
      const member = isOwner || (entry.community?.members ?? []).some((m) => m.accountId === account.id);
      if (!member) {
        sendJson(res, 403, { error: 'join this track to contribute — ask its owner for an invite link' });
        return;
      }
      if (limited(req, res, 'contribute', account.id)) return;
      const kind = body.kind === 'question' || body.kind === 'source' ? body.kind : undefined;
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (kind === undefined || text === '') {
        sendJson(res, 400, { error: 'kind ("question" | "source") and text are required' });
        return;
      }
      const str = (k: string, cap: number): Record<string, string> =>
        typeof body[k] === 'string' && body[k] !== '' ? { [k]: (body[k] as string).slice(0, cap) } : {};
      const rec: ContributionRecord = {
        id: `ctb_${randomBytes(8).toString('hex')}`,
        kind,
        text,
        // The richer source fields the contribute rail sends (ask-page port): the
        // owner's accept can then mint a proper source and its ANSWERS tie.
        ...str('title', 300),
        ...str('author', 200),
        ...str('modality', 40),
        ...str('answersId', 200),
        ...str('answersText', 500),
        // What it hangs on — a source/concept OF THIS TRACK, by id and display title. Free-form
        // strings, capped; the owner's side resolves them against their own graph on accept.
        ...(typeof body.aboutId === 'string' && body.aboutId !== '' ? { aboutId: body.aboutId.slice(0, 200) } : {}),
        ...(typeof body.aboutTitle === 'string' && body.aboutTitle !== '' ? { aboutTitle: body.aboutTitle.slice(0, 300) } : {}),
        ...(kind === 'source' && typeof body.url === 'string' && body.url !== '' ? { url: body.url.slice(0, 2000) } : {}),
        accountId: account.id,
        name: publicName(account),
        at: now(),
      };
      const all = load();
      all.push(rec);
      save(all);
      sendJson(res, 200, { sent: true, id: rec.id });
      return;
    }

    // The example tracks, on the SAME urls the ingest server answers. A workbench in browser
    // mode runs the engine in the tab and has no filesystem to read them from — but it may
    // always fetch the origin that served it, and that origin is here. Same reader as the
    // ingest server's, so the two can never offer different examples.
    if (method === 'GET' && path === '/examples') {
      const name = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('name');
      if (name === null) {
        sendJson(res, 200, { examples: exampleList() });
        return;
      }
      const found = readExample(name);
      if (found === undefined) {
        sendJson(res, 404, { error: `no example named "${name}"` });
        return;
      }
      sendJson(res, 200, found.payload);
      return;
    }

    // Which process am I talking to? (three "regressions" were stale
    // processes — tsx does not hot-reload.) startedAt answers "did my restart take" at a glance.
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, startedAt });
      return;
    }

    if (method === 'GET' && (path === '/' || path === '/index.json')) {
      const featured = featuredIds();
      // Hide UNLISTED tracks, and strip community secrets from every entry that remains. A token
      // in the public index is a token leaked to the world — this projection is the wall.
      const entries = Object.values(index)
        .filter((e) => e.community?.unlisted !== true)
        .map(({ community: _c, ...pub }) => ({ ...pub, ...(featured.includes(pub.trackId) ? { featured: true } : {}) }));
      if (path === '/index.json') sendJson(res, 200, { registryVersion: 1, tracks: entries });
      else
        sendHtml(
          res,
          200,
          libraryHtml(
            entries,
            featured,
            introHtml !== undefined,
            {
              account: sessionAccount(req),
              providers: signInReady ? providers.map((p) => ({ id: p.id, label: p.label })) : [],
            },
            (id) => {
              const a = accounts.get(id);
              return a === undefined ? undefined : publicName(a);
            },
          ),
        );
      return;
    }

    const t = /^\/t\/([^/]+?)(\.json)?$/.exec(path);
    if (method === 'GET' && t) {
      const [, ref, asJson] = t;
      // Friendly URLs: exact trackId → `syl_<ref>` → unique slug(title) match. An
      // ambiguous slug LISTS the candidates — suggest, never silently pick (invariant
      // applied to routing).
      let id = ref!;
      if (!index[id] && index[`syl_${ref!}`]) id = `syl_${ref!}`;
      if (!index[id]) {
        const bySlug = Object.values(index).filter((e) => e.community?.unlisted !== true && slugify(e.title) === ref);
        if (bySlug.length === 1) id = bySlug[0]!.trackId;
        else if (bySlug.length > 1) {
          sendJson(res, 300, {
            error: `"${ref}" names ${bySlug.length} tracks — pick by id`,
            candidates: bySlug.map((e) => ({ trackId: e.trackId, title: e.title, author: e.author, url: `/t/${e.trackId}` })),
          });
          return;
        }
      }
      const file = safeChild(dir, 'bundles', `${id}.json`);
      if (!index[id] || !existsSync(file)) {
        sendJson(res, 404, { error: 'no such track' });
        return;
      }
      const raw = readFileSync(file, 'utf8');
      // ?meta=1 — enough to answer "is my local copy ahead?" without shipping the bundle
      // (the sync-state line in the workbench publish box).
      if (asJson && new URL(req.url ?? '/', 'http://x').searchParams.get('meta') !== null) {
        const e = index[id]!;
        sendJson(res, 200, { trackId: id, contentHash: e.contentHash, updatedAt: e.updatedAt });
        return;
      }
      // ?version=<contentHash> — an ARCHIVED version, verbatim. This is how a fork reads
      // its BASE for pull-with-a-base: the archive keeps every accepted version, and a browser
      // engine has no disk of its own to have kept one. Content-addressed, so only hashes that
      // were actually accepted resolve — and only for the track they belong to.
      const wantVersion = asJson ? new URL(req.url ?? '/', 'http://x').searchParams.get('version') : null;
      if (wantVersion !== null) {
        if (!/^[a-f0-9]{64}$/.test(wantVersion)) {
          sendJson(res, 400, { error: 'version must be a content hash' });
          return;
        }
        try {
          const archived = readFileSync(safeChild(dir, 'archive', `${wantVersion}.json`), 'utf8');
          if ((JSON.parse(archived) as { publication?: { trackId?: string } }).publication?.trackId !== id) {
            sendJson(res, 404, { error: 'no such version of this track' });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(archived);
        } catch {
          sendJson(res, 404, { error: 'no such version of this track' });
        }
        return;
      }
      if (asJson) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(raw);
        return;
      }
      const hash = index[id!]!.contentHash;
      let page = pageCache.get(hash);
      const cachedCsp = pageCspCache.get(hash);
      if (page === undefined) {
        try {
          page = buildPublicationHtml(JSON.parse(raw), uiDist);
        } catch {
          // Viewer not built on this host — the bundle is still fully usable as JSON.
          page = `<!doctype html><meta charset="utf-8"><p>Viewer not built on this registry. The track is available as <a href="/t/${esc(id!)}.json">JSON</a> — import it into your own Philomatic to read (and fork) it.</p>`;
        }
        pageCache.set(hash, page);
        // The exported page inlines its own script, so it needs its own policy — computed with
        // the page and cached beside it (see cspForInlinePage).
        pageCspCache.set(hash, cspForInlinePage(page));
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...CORS,
        ...SECURITY_HEADERS,
        'Content-Security-Policy': cachedCsp ?? pageCspCache.get(hash) ?? SECURITY_HEADERS['Content-Security-Policy']!,
      });
      res.end(page);
      return;
    }

    // The intro deck — "Keep the thread", one self-contained RevealJS page (docs/slides).
    if (method === 'GET' && introHtml !== undefined && (path === '/intro' || path === '/intro/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS, ...SECURITY_HEADERS });
      res.end(readFileSync(introHtml));
      return;
    }

    // The public bundle: exactly the two fixed-name files the library shell loads —
    // no directory serving, no other paths. 404 when the ui build hasn't run; the shell's
    // static content stands alone then.
    if (method === 'GET' && (path === '/assets/public.js' || path === '/assets/public.css')) {
      const file = join(uiDist, 'assets', path.slice('/assets/'.length));
      if (!existsSync(file)) {
        sendJson(res, 404, { error: 'public bundle not built — run pnpm ui:build' });
        return;
      }
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream', ...CORS, ...SECURITY_HEADERS });
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

/** `tsx src/registry/server.ts [--dir D] [--port N] [--host H]` */
function main(): void {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg('--port') ?? process.env.REGISTRY_PORT ?? 4400);
  const host = arg('--host') ?? process.env.REGISTRY_HOST ?? '0.0.0.0';
  const dir = arg('--dir') ?? process.env.REGISTRY_DIR ?? '.philomatic-registry';
  const server = createRegistryServer({ dir, port, host });
  server.listen(port, host, () => {
    console.log(`philomatic registry listening on http://${host}:${port}  (dir: ${dir})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
