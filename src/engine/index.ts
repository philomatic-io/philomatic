/**
 * PhilomaticEngine — the headless facade.
 * The ONLY entry point a CLI / UI / agent calls. No business logic lives above this line.
 *
 * The facade is deliberately thin wiring over three module tiers (“the lock line”, see CONTRIBUTING.md):
 *   - frozen core   — desugar → validate → upsert (`importPayload` is its single write gate)
 *   - command layer — `./commands` (capture + verbs) and `./capture` (the versioned write contract)
 *   - read contract — `./read` (`snapshot()` views + `assemble()`, pure over the exported payload)
 */
import { openDb, type DB, type SqliteConn } from '../storage/db';
import { openBrowserDb, type OpenBrowserDbOptions } from '../storage/db-browser';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { desugar } from '../io/sugar';
import { verifyPublicationBundle } from './pub-verify';
import { migrateV1, needsV2Migration } from '../io/migrate';
import { exportRawForMigration } from '../io/payload';
import { exportAll } from '../io/payload';
import { toMermaid } from '../io/mermaid';
import { deleteEdge, edgeExists, upsertPayload } from '../storage/upsert';
import { loadExistingGraph } from '../storage/repository';
import { validate } from '../parser/validate';
import { ValidationError, type ValidationReport } from '../parser/report';
import type { CanonicalPatchPayload, CanonicalPayload, EntityKind } from '../schema/entities';
import { CaptureError, DEFAULT_LEARNER, parseCapture, PublicationBundleInput, UNLINKABLE_TYPES, LinkInput, UnlinkInput } from './capture';
import { trackId } from '../schema/ids';
import {
  captureSource,
  captureSnippet,
  recordVerb,
  remove,
  resolveConceptRef,
  publishTrack,
  resolveQuestionRef,
  resolveSourceRef,
  restore,
  unpublishTrack,
  update,
  type CommandCtx,
  type VerbOptions,
  stageEntity,
  resolveStageRef,
} from './commands';
import {
  assemble,
  graphView,
  isRetracted,
  liveView,
  publicationView,
  questionsView,
  relationsView,
  removedView,
  snapshotViews,
  timelineView,
  type AssembleResult,
  type GraphView,
  type QuestionView,
  type Relation,
  type PublicationBundle,
  type RemovedItem,
  type Snapshot,
  type TimelineEntry,
} from './read';
import type { CaptureSnippetResult, CaptureSourceResult, EditResult } from './capture';

// Boundary re-exports: shells and views import ONLY from the engine facade —
// these are the contract/type surfaces a client legitimately needs, owned here so no client ever
// reaches into the frozen core for them. Enforced by test/lockline.test.ts.
export { DEFAULT_LEARNER, DEFAULT_LICENSE, CaptureError } from './capture';
export type { CaptureSourceResult, CaptureSnippetResult, EditKind, EditResult } from './capture';
export type { EditRefInput, UpdateInput } from './capture';
export type { VerbOptions } from './commands';
export { rekeyLearner } from './rekey';
// The per-library framework store — facade-tier file state beside the database,
// like the fork archives; both shells reach it through here (lock line, rule 1).
export { loadFrameworkDoc, parseFrameworkFile, saveFrameworkDoc, ViewOverridesSchema, type FrameworkStoreDoc, type ViewOverrides } from './framework-store';
// The framework layer (declarations only) — data the shells/UIs render; the engine never
// interprets it. Re-exported here so shells stay behind the facade (lock-line rule 1).
export {
  ARGUMENT_DIAGRAMMING,
  FRAMEWORKS,
  FrameworkFileSchema,
  HERMENEUTICS,
  PHILOMATIC_CORE,
  PROPOSITIONAL_LOGIC,
  edgeTagsFor,
  metadataVocabulary,
  type FrameworkFile,
  type EdgeTagDecl,
} from '../framework';
export {
  PUB_VERSION,
  READ_VERSION,
  type AssembleResult,
  type AssembledConcept,
  type AssembledQuestion,
  type AssembledSnippet,
  type AssembledSource,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type NodeKind,
  type PublicationBundle,
  type PublicationManifest,
  type QuestionProvenance,
  type QuestionView,
  type Relation,
  type RemovedDependent,
  type RemovedItem,
  type Snapshot,
  type SnippetView,
  type SourceView,
  type TrackView,
  type TimelineEntry,
} from './read';
export { ValidationError, type ValidationReport } from '../parser/report';
export type { CanonicalPatchPayload, CanonicalPayload, Modality, TypedTag } from '../schema/entities';
// Typed-id derivation, surfaced for shells that must reference entities they proposed via
// sugar (e.g. the /propose route staging by id). Single source stays src/schema/ids.
export { conceptId, questionId, snippetId, sourceId, trackId } from '../schema/ids';
// The annotated edge taxonomy: consumed by `pnpm diagram` and its drift test.
export { taxonomy, taxonomyMermaid } from '../io/taxonomy';
// The plaintext→encrypted migration's in-place rekey — a storage operation surfaced through the
// facade so the migration helper (a server-tier module) need not reach past the lock line.
export { rekeyDb } from '../storage/db';
export type { Taxonomy, TaxonomyEdge, TaxonomyVerb } from '../io/taxonomy';

/**
 * Revive-on-re-assert: re-creating an entity whose derived id matches a
 * RETRACTED one used to upsert the fresh data but leave the RETRACTED event standing — so the id
 * was taken, nothing showed in the UI, and the create appeared to fail (a concept/question/
 * offline source, since those mint via importPayload rather than captureSource, which already
 * revives). The write gate now appends a RESTORED event for any entity it RE-ASSERTS that is
 * currently retracted — the same "re-capture means I want it back" semantic captureSource uses.
 * A backup (exportAll) carries its OWN RETRACTED events, so those ids are exempt: importing a
 * backup restores the exact state, it does not un-delete what you deleted. `getStore` is lazy —
 * the retraction fold only runs when the payload re-asserts an entity that already exists.
 */
function reviveReasserted(
  canonical: CanonicalPatchPayload,
  existingIds: ReadonlySet<string>,
  getStore: () => CanonicalPayload,
  now: number,
): CanonicalPatchPayload {
  const asserted: { id: string; kind: EntityKind }[] = [
    ...canonical.tracks.map((e) => ({ id: e.id, kind: 'track' as const })),
    ...canonical.concepts.map((e) => ({ id: e.id, kind: 'concept' as const })),
    ...canonical.sources.map((e) => ({ id: e.id, kind: 'source' as const })),
    ...canonical.snippets.map((e) => ({ id: e.id, kind: 'snippet' as const })),
    ...canonical.questions.map((e) => ({ id: e.id, kind: 'question' as const })),
  ];
  const candidates = asserted.filter((a) => existingIds.has(a.id)); // a brand-new id can't be retracted
  if (candidates.length === 0) return canonical;
  const store = getStore();
  const carriesRetraction = new Set(canonical.events.filter((e) => e.verb === 'RETRACTED').map((e) => e.targetId));
  const revive = candidates.filter((a) => isRetracted(store, a.id) && !carriesRetraction.has(a.id));
  if (revive.length === 0) return canonical;
  return {
    ...canonical,
    events: [
      ...canonical.events,
      ...revive.map((a) => ({ targetType: a.kind, targetId: a.id, learnerId: DEFAULT_LEARNER, verb: 'RESTORED' as const, occurredAt: now })),
    ],
  };
}

export class PhilomaticEngine {
  private constructor(
    private readonly db: DB,
    private readonly sqlite: SqliteConn,
    /** Injected clock — the ONLY non-referentially-transparent input; sampled only at the
     *  imperative shell/command boundary, never inside desugar/validate/projections. */
    private readonly clock: () => number,
    /** The store's file path when file-backed — where fork archives land. */
    private readonly filePath?: string,
    /** Browser engines only: hand out the database FILE, for a host that persists bytes
     *  rather than a payload. Named for the driver operation, NOT
     *  `snapshot` — that is already this class's read projection. */
    private readonly serializeDb?: () => Uint8Array,
  ) {}

  /** Open an engine over a SQLite file (":memory:" by default). `now` injects the clock. */
  /**
   * Migrate a pre-v2 store FILE to the v2 model: the
   * payload shim covers imports, but a live DB written before v2 holds edge rows the v2 schema
   * rejects on every read. Append-only upsert forbids rewriting rows in place, so the file is
   * rebuilt: raw-export (unvalidated) → rename the old file to a `.v1-backup` (never deleted,
   * never overwritten) → fresh store at the same path ← shimmed re-import. No-op for missing
   * files, `:memory:`, and stores that are already v2. The server runs this at boot; the CLI
   * exposes it as `migrate-v2`.
   */
  static migrateDbV2(path: string): { migrated: boolean; backupPath?: string } {
    if (path === ':memory:' || !existsSync(path)) return { migrated: false };
    const { db, sqlite } = openDb(path);
    const raw = exportRawForMigration(db);
    sqlite.close();
    if (!needsV2Migration(raw)) return { migrated: false };

    let backupPath = `${path}.v1-backup`;
    if (existsSync(backupPath)) backupPath = `${backupPath}-${Date.now()}`;
    renameSync(path, backupPath);
    // WAL companions move WITH the file: the backup stays a consistent, openable store, and no
    // stale -wal of the old database can sit beside the fresh one about to be created here.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(`${path}${ext}`)) renameSync(`${path}${ext}`, `${backupPath}${ext}`);
    }
    const fresh = PhilomaticEngine.open(path);
    try {
      fresh.importPayload(raw); // version:1-tagged → the shim runs inside
    } finally {
      fresh.close();
    }
    return { migrated: true, backupPath };
  }

  /**
   * Reset the store FILE (an escape hatch, not a delete): rename the
   * database (+WAL/shm companions) to a timestamped `.pre-reset-…` backup — NEVER deleted,
   * per the file discipline migrate-v2 set — leaving the path free for a fresh store the
   * caller re-instantiates from an exported payload. Rebuilding from a payload discards the
   * event history (retraction/undo trails) by design; the backup file keeps it recoverable.
   */
  static resetDb(path: string): { backupPath?: string } {
    if (path === ':memory:' || !existsSync(path)) return {};
    const backupPath = `${path}.pre-reset-${Date.now()}`;
    renameSync(path, backupPath);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(`${path}${ext}`)) renameSync(`${path}${ext}`, `${backupPath}${ext}`);
    }
    return { backupPath };
  }

  static open(path = ':memory:', opts: { now?: () => number; key?: Buffer } = {}): PhilomaticEngine {
    const { db, sqlite } = openDb(path, opts.key);
    return new PhilomaticEngine(db, sqlite, opts.now ?? (() => Date.now()), path === ':memory:' ? undefined : path);
  }

  /**
   * Open an engine over an in-memory sql.js (WASM) database — the browser-host path (alpha UI
   * Same engine, second driver; shells still import only this facade. The caller
   * owns persistence as the *payload value*: hydrate with `importPayload(saved)` on boot
   * (idempotent), persist `exportAll()` after writes. Async only because sql.js initializes
   * its WASM module.
   */
  static async openBrowser(opts: OpenBrowserDbOptions & { now?: () => number } = {}): Promise<PhilomaticEngine> {
    const { db, sqlite, snapshot } = await openBrowserDb(opts);
    return new PhilomaticEngine(db, sqlite, opts.now ?? (() => Date.now()), undefined, snapshot);

  }

  /** The database FILE, for a host that persists bytes rather than a payload. Browser
   *  engines only — the node opener already has a file on disk. */
  exportBytes(): Uint8Array {
    if (this.serializeDb === undefined) throw new Error('exportBytes is a browser-engine capability — the node engine already has a file');
    return this.serializeDb();
  }

  /** The narrow surface the command layer composes against (see ./commands). */
  private ctx(): CommandCtx {
    return {
      importPayload: (input) => this.importPayload(input),
      exportAll: () => this.exportAll(),
      now: this.clock,
    };
  }

  // ── Frozen-core surface ────────────────────────────────────────────────────────────────────
  // These two methods ARE the core's gate: the desugar → validate → upsert pipeline. They are
  // frozen-core surface living in the facade file (lock-line kind 3 to change).

  /** Dry-run: (migrate v1 →) desugar + validate against the current store, return the report.
   *  No writes. */
  validate(input: unknown): ValidationReport {
    const canonical = desugar(migrateV1(input));
    return validate(canonical, loadExistingGraph(this.db));
  }

  /** Import a sugared (or canonical) payload: migrate (v1 → v2, a pure pre-desugar rewrite —
   *  src/io/migrate.ts) → desugar → validate → idempotent upsert. */
  /** NB: the return is the PATCH-shaped canonical — what the
   *  payload asserted, absence preserved. Read the merged truth back via exportAll/snapshot. */
  importPayload(input: unknown): CanonicalPatchPayload {
    const canonical = desugar(migrateV1(input));
    const existing = loadExistingGraph(this.db);
    const report = validate(canonical, existing);
    if (!report.ok) throw new ValidationError(report);
    const now = this.clock();
    upsertPayload(this.db, reviveReasserted(canonical, existing.nodeIds, () => this.exportAll(), now), now);
    return canonical;
  }

  /** Read the whole graph back as a canonical payload. */
  exportAll(): CanonicalPayload {
    return exportAll(this.db);
  }

  /** The LIVE world as a payload — retracted entities, their edges, and their events folded
   *  away (and editorial events dropped). This is the SHARE artifact; `exportAll()` stays the
   *  BACKUP (removal is retraction, never deletion — a backup must carry the undo history,
   *  but a share must match what the sharer sees). */
  exportLive(): CanonicalPayload {
    return liveView(this.exportAll());
  }

  // ── Command layer (delegations to ./commands) ─────────────────────────────────────────────

  /** Capture a source by URL — the write API browsers/CLI/agents target (see ./capture). */
  captureSource(input: unknown): CaptureSourceResult {
    return captureSource(this.ctx(), input);
  }

  /** Capture a highlighted passage as a Snippet (+ anchors, questions, annotation). */
  captureSnippet(input: unknown): CaptureSnippetResult {
    return captureSnippet(this.ctx(), input);
  }

  /**
   * The generic edit primitives — `{ref}` is a typed id or a natural
   * reference; the id prefix dispatches the kind, so the surface never grows per entity.
   * `remove` appends a retraction the views fold away (never deletion); `restore` is the
   * counter-observation (minimal ancestors); `update` is engine-centralized RMW supersession
   * (identity fields rejected with the reason).
   */
  remove(input: unknown): EditResult {
    return remove(this.ctx(), input);
  }
  restore(input: unknown): EditResult {
    return restore(this.ctx(), input);
  }
  update(input: unknown): EditResult {
    return update(this.ctx(), input);
  }

  /**
   * Assert a structural edge (LinkInput — the inverse of unlink). Runs the FULL import
   * pipeline for one edge: dangling-reference validation, per-context cycle checks, the
   * idempotent upsert. `created: false` = the identical edge already existed.
   */
  link(input: unknown): { created: boolean } {
    const req = parseCapture(LinkInput, input);
    if (!UNLINKABLE_TYPES.has(req.type)) {
      throw new CaptureError(`${req.type} is not a structural edge — behavioral facts arrive via the verbs`);
    }
    const existed = edgeExists(this.db, req);
    this.importPayload({
      version: 2,
      edges: [{ srcType: req.srcType, srcId: req.srcId, type: req.type, dstType: req.dstType, dstId: req.dstId, tags: req.tags ?? [], ...(req.trackContextId !== undefined ? { trackContextId: req.trackContextId } : {}) }],
    });
    return { created: !existed };
  }

  /**
   * Un-assert a structural edge by full coordinates (see UnlinkInput). Interim physical
   * deletion — the assertion layer upgrades this to retraction when edges get ids; the
   * calling UI's undo is re-assertion (link with the identical coordinates).
   */
  unlink(input: unknown): { changed: boolean } {
    const req = parseCapture(UnlinkInput, input);
    if (req.type === 'SNIPPET_OF') throw new CaptureError('containment is a field, not an edge — remove the snippet instead');
    if (!UNLINKABLE_TYPES.has(req.type)) {
      throw new CaptureError(`${req.type} is not a structural edge — behavioral history is not unlinkable (un-verbs arrive separately)`);
    }
    return { changed: deleteEdge(this.db, req) };
  }

  /**
   * The publish act: stamp/clear `published` on a track.
   * `publication()` is the read side — the track's PUBLIC bundle, or null when unpublished
   * (the /t routes' 404).
   */
  publish(input: unknown): EditResult {
    return publishTrack(this.ctx(), input);
  }
  unpublish(input: unknown): EditResult {
    return unpublishTrack(this.ctx(), input);
  }
  // ── Author identity ──────────────────────────────────────────────────────────────────────
  // One Ed25519 keypair per instance, minted lazily and kept beside the DB (`author.key`,
  // mode 0600 — the backup story is "keep this file"). Possession of the secret IS ownership
  // continuity; the public key travels on every signed manifest. `:memory:` engines hold an
  // ephemeral key for the process (tests). Signing happens HERE, not in the pure read view.
  private authorSecret?: Uint8Array;

  private loadAuthorSecret(): Uint8Array {
    if (this.authorSecret) return this.authorSecret;
    const keyPath = this.filePath !== undefined ? join(dirname(this.filePath), 'author.key') : undefined;
    if (keyPath !== undefined && existsSync(keyPath)) {
      const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as { secretKey: string };
      this.authorSecret = hexToBytes(parsed.secretKey);
      return this.authorSecret;
    }
    this.authorSecret = ed25519.utils.randomSecretKey();
    if (keyPath !== undefined) {
      writeFileSync(
        keyPath,
        JSON.stringify({ secretKey: bytesToHex(this.authorSecret), publicKey: bytesToHex(ed25519.getPublicKey(this.authorSecret)), createdAt: this.clock() }),
        { mode: 0o600 },
      );
    }
    return this.authorSecret;
  }

  /** The instance's author public key (hex) — `GET /author`, domain anchoring. */
  authorPublicKey(): string {
    return bytesToHex(ed25519.getPublicKey(this.loadAuthorSecret()));
  }

  /** Sign an arbitrary message with the author key (the registry's unpublish challenge). */
  authorSign(message: string): { authorKey: string; signature: string } {
    const secret = this.loadAuthorSecret();
    return {
      authorKey: bytesToHex(ed25519.getPublicKey(secret)),
      signature: bytesToHex(ed25519.sign(utf8ToBytes(message), secret)),
    };
  }

  publication(ref: string, opts?: { frameworks?: readonly import('../framework').FrameworkFile[] }): PublicationBundle | null {
    // A title resolves like everywhere else; ids pass through.
    const id = ref.startsWith('syl_') ? ref : trackId(ref);
    const bundle = publicationView(this.exportAll(), id, opts?.frameworks);
    if (!bundle) return null;
    // Author signing: sign the manifest (authorKey included, signature excluded) — computed
    // fresh per read, so the signature always covers the CURRENT content closure via contentHash.
    const secret = this.loadAuthorSecret();
    const unsigned = { ...bundle.publication, authorKey: bytesToHex(ed25519.getPublicKey(secret)) };
    const signature = bytesToHex(ed25519.sign(utf8ToBytes(JSON.stringify(unsigned)), secret));
    return { ...bundle, publication: { ...unsigned, signature } };
  }

  /**
   * Import a publication bundle = FORK it: verify the manifest and the
   * payload's contentHash (tamper/reformat evidence), import the payload (it arrives
   * unpublished by construction), record `origin` lineage on the track (set once — a
   * re-fork of the same track keeps the first lineage), and archive the parent bundle beside
   * the DB so descent-vs-deliberate-change stays diffable forever. `:memory:` stores skip the
   * archive (tests), never the lineage.
   */
  importPublication(input: unknown, opts: { originUrl?: string } = {}): { trackId: string; title: string } {
    // Verification is the shared pure module (pub-verify) — the registry runs the SAME checks.
    // Unsigned bundles pass (pre-signing era, unattested forever — documented posture).
    const v = verifyPublicationBundle(input);
    if (!v.ok || v.bundle === undefined) throw new CaptureError(v.reason ?? 'invalid publication bundle');
    const bundle = v.bundle;
    const hash = bundle.publication.contentHash;
    const { authorKey } = bundle.publication;
    // TOFU pin: a re-fork of a track whose recorded lineage carries a DIFFERENT author key is
    // refused loudly — either the author rotated keys (verify out of band) or this is an
    // impersonation. (Same key, or first fork, proceeds; lineage itself stays set-once.)
    const before = this.exportAll().tracks.find((s) => s.id === bundle.publication.trackId);
    if (before?.origin?.authorKey !== undefined && authorKey !== undefined && before.origin.authorKey !== authorKey) {
      throw new CaptureError(
        `author key changed for ${bundle.publication.trackId} (pinned ${before.origin.authorKey.slice(0, 12)}…, got ${authorKey.slice(0, 12)}…) — verify with the author out of band before trusting this bundle`,
      );
    }
    this.importPayload(bundle.payload);
    const sy = this.exportAll().tracks.find((s) => s.id === bundle.publication.trackId);
    if (sy && !sy.origin) {
      this.importPayload({
        version: 2,
        tracks: [
          {
            ...sy,
            origin: {
              trackId: bundle.publication.trackId,
              publishedAt: bundle.publication.publishedAt,
              contentHash: bundle.publication.contentHash,
              ...(opts.originUrl !== undefined ? { url: opts.originUrl } : {}),
              ...(authorKey !== undefined ? { authorKey } : {}),
            },
          },
        ],
      });
    }
    if (this.filePath !== undefined) {
      const dir = join(dirname(this.filePath), 'forks');
      // Beside the library, and no wider than it: on a hosted box the 0700 data directory is the
      // real gate, but an archive of what someone forked should not be the loosest thing in it.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${bundle.publication.trackId}-${hash.slice(0, 12)}.json`), JSON.stringify(bundle), { mode: 0o600 });
    }
    return { trackId: bundle.publication.trackId, title: bundle.publication.title };
  }

  /**
   * PULL upstream changes into a fork: an entity-level three-way against the BASE
   * (the version this fork last synchronized with), strictly ADDITIVE on the local graph:
   *
   *   - upstream entity absent here            → imported ("took"), unless the learner REMOVED
   *     it — a retraction is a decision, and a pull never overrules one;
   *   - present here, unchanged since base     → upstream's edit lands ("took");
   *   - present here, EDITED since base        → yours stays ("kept yours") — never overwritten;
   *   - in the base, gone upstream             → reported ("upstream deleted"), never deleted
   *     here — removal stays a learner's act (same doctrine as retraction).
   *
   * Edges arrive additively (endpoints permitting); local-only edges stay. Without a base
   * (older forks, unreadable archive), the degenerate rule is pure addition: absent → took,
   * present → kept — conservative, and said so by the counts. Finishes by moving the track's
   * origin marker to the pulled version, so "updates available" goes quiet until upstream moves
   * again.
   */
  pullPublication(
    current: unknown,
    base?: unknown,
  ): { took: number; keptYours: number; upstreamDeleted: number; edgesAdded: number; trackId: string } {
    const v = verifyPublicationBundle(current);
    if (!v.ok || v.bundle === undefined) throw new CaptureError(v.reason ?? 'invalid publication bundle');
    const bundle = v.bundle;
    const vb = base === undefined ? undefined : verifyPublicationBundle(base);
    if (vb !== undefined && (!vb.ok || vb.bundle === undefined)) throw new CaptureError(vb.reason ?? 'invalid base bundle');
    const baseBundle = vb?.bundle;

    // The fork this pull lands on: the local track whose ORIGIN names the upstream id. (The
    // local id usually equals it; an aliased republish never changes origin.)
    const upstreamId = bundle.publication.trackId;
    const local = this.exportAll();
    const track = local.tracks.find((t) => t.origin?.trackId === upstreamId || t.id === upstreamId);
    if (track === undefined) throw new CaptureError(`no local fork of ${upstreamId} — fork it first`);
    // The TOFU pin, same as importPublication: a different author key is refused loudly.
    const key = bundle.publication.authorKey;
    if (track.origin?.authorKey !== undefined && key !== undefined && track.origin.authorKey !== key) {
      throw new CaptureError(
        `author key changed for ${upstreamId} (pinned ${track.origin.authorKey.slice(0, 12)}…, got ${key.slice(0, 12)}…) — verify with the author out of band before trusting this bundle`,
      );
    }

    // Deep-stable stringify: entity equality must not depend on key order, which differs
    // between a bundle read off the wire and a row read back from the store.
    const stable = (x: unknown): string => {
      if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
      if (typeof x === 'object' && x !== null)
        return `{${Object.keys(x as object)
          .sort()
          // undefined-valued keys are absent, as JSON serialization treats them — exportAll
          // rows spell optional fields explicitly, bundles omit them, and that must not differ.
          .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`)
          .join(',')}}`;
      return JSON.stringify(x);
    };
    type Ent = { id: string; tags?: unknown[] } & Record<string, unknown>;
    const KINDS = ['concepts', 'sources', 'snippets', 'questions'] as const;
    const byId = (list: unknown[] | undefined): Map<string, Ent> => new Map(((list ?? []) as Ent[]).map((e) => [e.id, e]));
    const removedIds = new Set(this.removed().map((r) => r.id));
    // Equality that answers "did the CONTENT move?": tags are excluded (the bundle filters them
    // to publishable, so local personal tags would flag every entity as edited forever), and so
    // are the private/volatile fields a bundle never carries.
    const strip = (e: Ent): Record<string, unknown> => {
      const { tags: _t, creatorId: _c, published: _p, origin: _o, personalUrl: _u, ...rest } = e as Record<string, unknown>;
      return rest;
    };
    // Tags MERGE on take (observations are additive): the upstream row must not clobber local
    // personal tags — the upsert layer replaces fields wholesale, so the union happens here.
    const unionTags = (mine: unknown[] | undefined, theirs: unknown[] | undefined): unknown[] => {
      const key = (t: unknown) => stable(t);
      const seen = new Set((mine ?? []).map(key));
      return [...(mine ?? []), ...(theirs ?? []).filter((t) => !seen.has(key(t)))];
    };

    const summary = { took: 0, keptYours: 0, upstreamDeleted: 0, edgesAdded: 0, trackId: track.id };
    const toImport: Record<string, unknown[]> = {};
    for (const kind of KINDS) {
      const up = byId((bundle.payload as Record<string, unknown[]>)[kind]);
      const bs = byId(baseBundle === undefined ? [] : (baseBundle.payload as Record<string, unknown[]>)[kind]);
      const mine = byId(local[kind] as unknown as unknown[]);
      const out: unknown[] = [];
      for (const [id, ent] of up) {
        if (removedIds.has(id)) continue; // a retraction outranks a pull
        const ours = mine.get(id);
        if (ours === undefined) {
          out.push(ent);
          summary.took++;
          continue;
        }
        const baseEnt = bs.get(id);
        const editedSinceBase = baseEnt === undefined || stable(strip(ours)) !== stable(strip(baseEnt));
        const upstreamMoved = stable(strip(ent)) !== stable(strip(ours));
        if (!upstreamMoved) continue; // already identical — nothing to say
        if (editedSinceBase) summary.keptYours++;
        else {
          out.push({ ...ent, tags: unionTags(ours.tags, ent.tags) });
          summary.took++;
        }
      }
      for (const id of bs.keys()) {
        if (!up.has(id) && mine.has(id)) summary.upstreamDeleted++;
      }
      if (out.length > 0) toImport[kind] = out;
    }
    if (Object.keys(toImport).length > 0) this.importPayload({ version: 2, ...toImport });

    // Edges: additive. Identity = (srcId, type, dstId, context); endpoints must exist here
    // after the entity pass — an edge to something the learner removed (or kept out) is skipped.
    const after = this.exportAll();
    const have = new Set(after.edges.map((e) => `${e.srcId}|${e.type}|${e.dstId}|${(e as { trackContextId?: string }).trackContextId ?? ''}`));
    const ids = new Set<string>([
      ...after.tracks.map((t) => t.id),
      ...KINDS.flatMap((k) => (after[k] as { id: string }[]).map((e) => e.id)),
    ]);
    // The upstream track id maps onto OUR fork's id — the one remap a pull needs.
    const mapId = (id: string): string => (id === upstreamId ? track.id : id);
    const newEdges = ((bundle.payload as { edges?: Record<string, unknown>[] }).edges ?? [])
      .map((e): Record<string, unknown> => {
        const ctx = e.trackContextId as string | undefined;
        return {
          ...e,
          srcId: mapId(e.srcId as string),
          dstId: mapId(e.dstId as string),
          ...(ctx !== undefined ? { trackContextId: mapId(ctx) } : {}),
        };
      })
      .filter((e) => {
        const k = `${e.srcId as string}|${e.type as string}|${e.dstId as string}|${(e.trackContextId as string | undefined) ?? ''}`;
        return !have.has(k) && ids.has(e.srcId as string) && ids.has(e.dstId as string);
      });
    if (newEdges.length > 0) {
      this.importPayload({ version: 2, edges: newEdges });
      summary.edgesAdded = newEdges.length;
    }

    // Move the base marker: this version is now what the fork has seen.
    this.importPayload({
      version: 2,
      tracks: [
        {
          ...after.tracks.find((t) => t.id === track.id)!,
          origin: { ...track.origin, trackId: upstreamId, contentHash: bundle.publication.contentHash, publishedAt: bundle.publication.publishedAt },
        },
      ],
    });
    return summary;
  }

  /**
   * The behavioral verbs. Each records **both** the timeless core fact edge
   * *and* a timestamped log event, atomically (write-both). Idempotent in the core (one fact) and
   * append-only in the log; throws if the target does not exist (author it first).
   */
  consume(sourceRef: string, opts: VerbOptions = {}): void {
    recordVerb(this.ctx(), 'CONSUMED', 'source', resolveSourceRef(sourceRef), opts);
  }
  /** Read state toggles — the first un-verb. Removes the CONSUMED
   *  fact edge (the core's timeless "has read"), records an UNCONSUMED log event (event-only —
   *  history keeps both directions). No-op when not consumed. */
  unconsume(sourceRef: string, opts: VerbOptions = {}): { changed: boolean } {
    const id = resolveSourceRef(sourceRef);
    const learnerId = opts.learnerId ?? DEFAULT_LEARNER;
    const changed = deleteEdge(this.db, { srcId: learnerId, type: 'CONSUMED', dstId: id });
    if (changed) recordVerb(this.ctx(), 'UNCONSUMED', 'source', id, opts);
    return { changed };
  }
  track(conceptRef: string, opts: VerbOptions = {}): void {
    recordVerb(this.ctx(), 'TRACKS', 'concept', resolveConceptRef(conceptRef), opts);
  }
  /** Park/propose ANY entity into the pending-validation state: an
   *  adapter/LLM proposal or something you backlogged yourself. Idempotent. */
  stage(ref: string, opts: VerbOptions = {}): { kind: string; targetId: string } {
    return stageEntity(this.ctx(), ref, opts);
  }
  /** Mechanical reversal — the marker comes off with NO verdict ("oops"/un-park), exactly
   *  symmetric with `unconsume`. No-op when not staged. */
  unstage(ref: string, opts: VerbOptions = {}): { changed: boolean } {
    return this.leaveStaged(ref, 'UNSTAGED', opts);
  }
  /** VERDICT: the proposal becomes an ordinary entity — the marker folds away and the verdict
   *  is logged (the disposition log). No-op when not staged. */
  accept(ref: string, opts: VerbOptions = {}): { changed: boolean } {
    return this.leaveStaged(ref, 'ACCEPTED', opts);
  }
  /** VERDICT: the proposal is retracted (append-only — restorable, never deleted) and the
   *  verdict is logged. Rejections are signal. No-op when not staged. */
  reject(ref: string, opts: VerbOptions = {}): { changed: boolean } {
    const left = this.leaveStaged(ref, 'REJECTED', opts);
    if (left.changed) remove(this.ctx(), { ref, ...(opts.learnerId ? { learnerId: opts.learnerId } : {}) });
    return left;
  }
  /** Shared exit: drop the STAGED fact edge, log the verb that says WHY it left. */
  private leaveStaged(ref: string, verb: 'UNSTAGED' | 'ACCEPTED' | 'REJECTED', opts: VerbOptions): { changed: boolean } {
    const { kind, id } = resolveStageRef(this.exportAll(), ref);
    const learnerId = opts.learnerId ?? DEFAULT_LEARNER;
    const changed = deleteEdge(this.db, { srcId: learnerId, type: 'STAGED', dstId: id });
    if (changed) recordVerb(this.ctx(), verb, kind, id, opts);
    return { changed };
  }
  ask(questionRef: string, opts: VerbOptions = {}): void {
    recordVerb(this.ctx(), 'ASKS', 'question', resolveQuestionRef(questionRef), opts);
  }
  answer(questionRef: string, opts: VerbOptions = {}): void {
    recordVerb(this.ctx(), 'ANSWERED', 'question', resolveQuestionRef(questionRef), opts);
  }

  // ── Read contract (delegations to ./read) ────────────────────────────────────────────────

  /** The flat, versioned browse views (tracks/sources/snippets) — the owned read projection.
   *  `learnerId` scopes the behavioral overlay; omitted = the all-learners fold. */
  snapshot(learnerId?: string): Snapshot {
    return snapshotViews(this.exportAll(), learnerId);
  }

  /** The learning-path projection; `trackRef` is a title or `syl_` id (engine resolves it). */
  assemble(trackRef?: string, learnerId = DEFAULT_LEARNER): AssembleResult {
    return assemble(this.exportAll(), trackRef, learnerId);
  }

  /** The slim trash bin: retracted entities with their cascade-hidden dependents, newest first
   *  Read-only; restore lands as a command-layer verb. */
  removed(): RemovedItem[] {
    return removedView(this.exportAll());
  }

  /** The learner's engagement feed, newest first (Journey's vertical timeline). */
  timeline(learnerId?: string): TimelineEntry[] {
    return timelineView(this.exportAll(), learnerId);
  }

  /** Every live question with raised-by / answered-by provenance and the learner overlay. */
  questions(learnerId?: string): QuestionView[] {
    return questionsView(this.exportAll(), learnerId);
  }

  /** The typed edges touching an entity, from its point of view (workbench "Connections"). */
  relations(id: string): Relation[] {
    return relationsView(this.exportAll(), id);
  }

  /** The whole knowledge graph as nodes + structural edges (the Map tab). */
  graph(): GraphView {
    return graphView(this.exportAll());
  }

  /** Render the live graph as a Mermaid diagram; concepts the learner has answered a question
   *  about are highlighted (the question-overlay progress signal). */
  exportMermaid(learnerId = DEFAULT_LEARNER): string {
    const p = liveView(this.exportAll());
    const answeredQ = new Set(
      p.edges.filter((e) => e.type === 'ANSWERED' && e.srcId === learnerId).map((e) => e.dstId),
    );
    const answered = new Set(
      p.edges.filter((e) => e.type === 'ABOUT' && answeredQ.has(e.srcId)).map((e) => e.dstId),
    );
    return toMermaid(p, { answered });
  }

  close(): void {
    this.sqlite.close();
  }
}
