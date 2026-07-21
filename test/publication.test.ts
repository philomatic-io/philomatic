/**
 * PB-S1 — the publication contract (publish plan P1/P2 — retired to git history, as-built in ROADMAP §2.6; DATA_GOVERNANCE §2).
 * The strip guarantees are pinned the strong way: tests enumerate what a bundle IS allowed to
 * contain, and assert the private material (overlay verbs, annotations, learners, personalUrl,
 * creator id, the publish stamp itself) is provably absent from the serialized bundle.
 */
import { describe, expect, it } from 'vitest';
import { CaptureError, DEFAULT_LICENSE, PUB_VERSION, PhilomaticEngine } from '../src/engine';

const SECRET_NOTE = 'my-private-aha-note';
const SECRET_VAULT = 'obsidian://open?vault=SecretVault&file=Notes';

/** A world with everything the publication must NOT leak, plus a second track as a bystander. */
function build(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(':memory:', { now: () => 1_000_000 });
  engine.importPayload({
    version: 2,
    learners: [{ id: 'lnr_default', displayName: 'Ada' }],
    concepts: [
      { name: 'Member Concept' },
      { name: 'Outside Concept' },
    ],
    sources: [
      {
        id: 'src_member',
        title: 'Member Source',
        author: 'Public Author',
        directUrl: 'https://example.com/member',
        personalUrl: SECRET_VAULT,
        modality: 'text',
        explains: ['Member Concept'],
        snippets: [
          {
            text: 'Member passage.',
            clarifies: ['Member Concept'],
            note: SECRET_NOTE,
            sentiment: 'aha',
            raises: ['Member question?'],
          },
        ],
      },
      {
        id: 'src_outside',
        title: 'Outside Source',
        modality: 'text',
        explains: ['Outside Concept'],
        snippets: [{ text: 'Outside passage.', raises: ['Outside question?'] }],
      },
    ],
    tracks: [
      { title: 'Public Track', goal: 'Publish me', includes: ['Member Concept'], order: ['Member Source'] },
      { title: 'Private Track', includes: ['Outside Concept'], includeSources: ['Outside Source'] },
    ],
  });
  engine.consume('src_member'); // learner overlay — must never publish
  return engine;
}

describe('publish / unpublish (P2)', () => {
  it('is an explicit, idempotent act stamping the license; unpublish clears it', () => {
    const engine = build();
    expect(engine.publication('syl_public-track')).toBeNull(); // unpublished = the routes' 404

    const first = engine.publish({ ref: 'Public Track' });
    expect(first).toMatchObject({ kind: 'track', targetId: 'syl_public-track', changed: true });
    const view = engine.snapshot().tracks.find((s) => s.id === 'syl_public-track');
    expect(view?.published).toEqual({ at: 1_000_000, license: DEFAULT_LICENSE });

    // Idempotent: the original stamp stands.
    expect(engine.publish({ ref: 'Public Track', license: 'ODbL-1.0' }).changed).toBe(false);
    expect(engine.snapshot().tracks.find((s) => s.id === 'syl_public-track')?.published?.license).toBe(DEFAULT_LICENSE);

    expect(engine.unpublish({ ref: 'Public Track' }).changed).toBe(true);
    expect(engine.publication('syl_public-track')).toBeNull();
    expect(engine.unpublish({ ref: 'Public Track' }).changed).toBe(false);
    engine.close();
  });

  it('only tracks publish; unknown refs and non-tracks are loud errors', () => {
    const engine = build();
    expect(() => engine.publish({ ref: 'Member Source' })).toThrow(CaptureError);
    expect(() => engine.publish({ ref: 'No Such Track' })).toThrow(CaptureError);
    engine.close();
  });

  it('survives an ordinary field edit (update RMWs through the sugar layer)', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    engine.update({ ref: 'Public Track', patch: { goal: 'Edited goal' } });
    const sy = engine.snapshot().tracks.find((s) => s.id === 'syl_public-track');
    expect(sy?.goal).toBe('Edited goal');
    expect(sy?.published).toBeDefined(); // the edit must not silently unpublish
    engine.close();
  });
});

describe('the publication bundle (P1/P4)', () => {
  it('contains exactly the content closure, and the payload re-imports as an unpublished fork', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track', license: 'CC-BY-SA-4.0' });
    const bundle = engine.publication('syl_public-track')!;

    expect(Object.keys(bundle).sort()).toEqual(['payload', 'pubVersion', 'publication']);
    expect(bundle.pubVersion).toBe(PUB_VERSION);
    expect(bundle.publication).toMatchObject({
      trackId: 'syl_public-track',
      title: 'Public Track',
      author: 'Ada',
      license: 'CC-BY-SA-4.0',
      publishedAt: 1_000_000,
    });
    expect(bundle.publication.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // The closure: member concept/source, its snippet, the question it raises — and only those.
    const payload = bundle.payload as unknown as {
      tracks: { id: string }[]; concepts: { id: string }[]; sources: { id: string }[];
      snippets: { id: string; text: string }[]; questions: { text: string }[]; edges: { type: string }[];
    };
    expect(Object.keys(bundle.payload).sort()).toEqual(['concepts', 'edges', 'questions', 'snippets', 'sources', 'tracks', 'version']);
    expect(payload.tracks.map((x) => x.id)).toEqual(['syl_public-track']);
    expect(payload.concepts.map((x) => x.id)).toEqual(['cpt_member-concept']);
    expect(payload.sources.map((x) => x.id)).toEqual(['src_member']);
    expect(payload.snippets.map((x) => x.text)).toEqual(['Member passage.']);
    expect(payload.questions.map((x) => x.text)).toEqual(['Member question?']);
    // Every edge stays among included entities; nothing reaches the outside track's world.
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('src_outside');
    expect(json).not.toContain('Outside');

    // Round-trip: the payload imports into a fresh instance as an UNPUBLISHED fork.
    const fork = PhilomaticEngine.open();
    fork.importPayload(bundle.payload);
    const forked = fork.snapshot().tracks.find((s) => s.id === 'syl_public-track');
    expect(forked?.title).toBe('Public Track');
    expect(forked?.published).toBeUndefined();
    expect(fork.snapshot().snippets.map((s) => s.text)).toEqual(['Member passage.']);
    fork.close();
    engine.close();
  });

  it('strips the private world: overlay, annotations, learners, personalUrl, creator id, stamp', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const json = JSON.stringify(engine.publication('syl_public-track'));

    expect(json).not.toContain(SECRET_NOTE); // the ANNOTATES note
    expect(json).not.toContain('sentiment');
    expect(json).not.toContain(SECRET_VAULT); // the private vault pointer
    expect(json).not.toContain('personalUrl');
    expect(json).not.toContain('lnr_'); // no learner id, creatorId included
    expect(json).not.toContain('creatorId');
    expect(json).not.toContain('CONSUMED'); // the overlay verb written by build()
    expect(json).not.toContain('ANNOTATES');
    expect(json).not.toContain('"published"'); // the stamp lives in the manifest, not the payload
    expect(json).not.toContain('events');
    // Attribution survives where it belongs: the manifest author and the source's public author.
    expect(json).toContain('"author":"Ada"');
    expect(json).toContain('Public Author');
    engine.close();
  });

  it('a retracted track (or a never-published one) has no publication', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    expect(engine.publication('syl_private-track')).toBeNull();
    engine.remove({ ref: 'Public Track' });
    expect(engine.publication('syl_public-track')).toBeNull(); // retraction folds it away
    engine.close();
  });
});

// ── PB-S2: the public routes (plan P3) ─────────────────────────────────────────────────────────
import { afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createIngestServer } from '../src/server/ingest';

describe('GET /t/:id + /t/:id.json (P3) — public exactly for published tracks', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const TOKEN = 'shh';
  async function start(): Promise<string> {
    const dist = mkdtempSync(join(tmpdir(), 'pub-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">viewer</div>');
    server = createIngestServer({ db: ':memory:', token: TOKEN, uiDist: dist });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const post = (base: string, path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token !== undefined ? { 'X-Ingest-Token': token } : {}) },
      body: JSON.stringify(body),
    });

  it('publish is a guarded write; the published bundle and page are public reads; 404 otherwise', async () => {
    const base = await start();
    await post(base, '/import', {
      version: 2,
      concepts: [{ name: 'C' }],
      sources: [{ title: 'S', directUrl: 'https://example.com/s', modality: 'text' }],
      tracks: [{ title: 'T', includes: ['C'], order: ['S'] }],
    }, TOKEN);

    // Unpublished: both routes 404, even with the token.
    expect((await fetch(`${base}/t/syl_t`)).status).toBe(404);
    expect((await fetch(`${base}/t/syl_t.json`)).status).toBe(404);

    // The publish act is a WRITE: token-guarded like every other write.
    expect((await post(base, '/publish', { ref: 'T' })).status).toBe(401);
    const published = await post(base, '/publish', { ref: 'T' }, TOKEN);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ kind: 'track', targetId: 'syl_t', changed: true });

    // Published: PUBLIC reads — deliberately no token on these fetches.
    const bundle = await fetch(`${base}/t/syl_t.json`);
    expect(bundle.status).toBe(200);
    const body = (await bundle.json()) as { pubVersion: number; publication: { trackId: string; license: string } };
    expect(body.pubVersion).toBe(1);
    expect(body.publication).toMatchObject({ trackId: 'syl_t', license: 'CC-BY-SA-4.0' });

    const page = await fetch(`${base}/t/syl_t`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('viewer');

    // Unpublish (guarded) closes the hole again.
    expect((await post(base, '/unpublish', { ref: 'T' }, TOKEN)).status).toBe(200);
    expect((await fetch(`${base}/t/syl_t.json`)).status).toBe(404);
    expect((await fetch(`${base}/t/syl_t`)).status).toBe(404);

    // Unknown ids and non-tracks 404 rather than leaking anything.
    expect((await fetch(`${base}/t/syl_nope.json`)).status).toBe(404);
    expect((await fetch(`${base}/t/src_whatever`)).status).toBe(404);
  });
});

// ── PB-S3: the static export; PB-S4: fork import with lineage ──────────────────────────────────
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { buildPublicationHtml } from '../src/cli/export-track';

describe('fork import with lineage (P4)', () => {
  const publishedBundle = () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = engine.publication('Public Track')!; // title resolution rides the facade
    engine.close();
    return bundle;
  };

  it('records origin once, verifies the contentHash, and archives beside a file-backed DB', () => {
    const bundle = publishedBundle();
    const dir = mkdtempSync(join(tmpdir(), 'pub-fork-'));
    const fork = PhilomaticEngine.open(join(dir, 'fork.sqlite'));
    const res = fork.importPublication(bundle, { originUrl: 'https://example.com/t/syl_public-track.json' });
    expect(res).toEqual({ trackId: 'syl_public-track', title: 'Public Track' });

    const sy = fork.exportAll().tracks.find((s) => s.id === 'syl_public-track')!;
    expect(sy.published).toBeUndefined(); // a fork arrives unpublished
    expect(sy.origin).toEqual({
      trackId: 'syl_public-track',
      publishedAt: 1_000_000,
      contentHash: bundle.publication.contentHash,
      url: 'https://example.com/t/syl_public-track.json',
      authorKey: (bundle.publication as { authorKey?: string }).authorKey, // D3: pinned at fork
    });

    // The parent bundle is archived for later descent-vs-change diffing.
    const archives = readdirSync(join(dir, 'forks'));
    expect(archives).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'forks', archives[0]!), 'utf8'))).toEqual(JSON.parse(JSON.stringify(bundle)));

    // Re-forking keeps the FIRST lineage (set once).
    fork.importPublication(bundle, { originUrl: 'https://elsewhere.example/t.json' });
    expect(fork.exportAll().tracks.find((s) => s.id === 'syl_public-track')!.origin?.url).toBe(
      'https://example.com/t/syl_public-track.json',
    );
    fork.close();
  });

  it('a tampered or reformatted bundle is rejected loudly', () => {
    const bundle = JSON.parse(JSON.stringify(publishedBundle())) as { payload: { tracks: { title: string }[] } };
    bundle.payload.tracks[0]!.title = 'Tampered Track';
    const fork = PhilomaticEngine.open();
    expect(() => fork.importPublication(bundle)).toThrow(/contentHash mismatch/);
    fork.close();
  });

  it('origin survives ordinary edits (sugar passthrough) — lineage is not losable by accident', () => {
    const bundle = publishedBundle();
    const fork = PhilomaticEngine.open();
    fork.importPublication(bundle);
    fork.update({ ref: 'Public Track', patch: { goal: 'my fork of it' } });
    expect(fork.exportAll().tracks[0]!.origin?.trackId).toBe('syl_public-track');
    fork.close();
  });
});

describe('the static export (P6)', () => {
  it('builds ONE self-contained file: assets inlined, bundle baked in, script-safe escapes', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = engine.publication('syl_public-track')!;
    engine.close();

    const dist = mkdtempSync(join(tmpdir(), 'pub-dist-'));
    const js = 'console.log("</script>");document.getElementById("root").textContent="app";';
    writeFileSync(join(dist, 'index.html'), [
      '<!doctype html><html><head>',
      '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
      '<link rel="stylesheet" crossorigin href="./assets/index-def.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-abc.js'), js);
    writeFileSync(join(dist, 'assets', 'index-def.css'), 'body{color:red}');

    const html = buildPublicationHtml(bundle, dist);
    expect(html).not.toContain('src="./assets'); // no external references survive
    expect(html).not.toContain('href="./assets');
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).toContain('window.__PHILOMATIC_PUBLICATION__ = ');
    // The baked JSON parses back to the bundle (angle brackets escaped, so no tag can break out).
    const jsonMatch = /__PHILOMATIC_PUBLICATION__ = (.*?);<\/script>/s.exec(html)!;
    expect(JSON.parse(jsonMatch[1]!)).toEqual(JSON.parse(JSON.stringify(bundle)));
    expect(jsonMatch[1]!).not.toContain('</'); // `<` is <-escaped throughout
    // The inline app script survived, its own </script> content defused.
    expect(html).toContain('<\\/script>');
    expect(html).toContain('textContent="app"');
  });

  it('builds against the REAL viewer dist (drift check: the tags stay findable)', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = engine.publication('syl_public-track')!;
    engine.close();
    const dist = join(__dirname, '..', 'ui', 'dist');
    if (!existsSync(join(dist, 'index.html'))) return; // viewer not built in this checkout — route/unit tests above cover the logic
    const html = buildPublicationHtml(bundle, dist);
    expect(html).toContain('window.__PHILOMATIC_PUBLICATION__');
    expect(html.length).toBeGreaterThan(100_000); // the app really is inlined
  });
});

// ── PB-S6 / D3: author keys — signed manifests, verify + TOFU on fork ──────────────────────────
import { statSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

describe('D3 — author keys', () => {
  it('signs the manifest; the signature verifies and the fork pins the key into origin', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = engine.publication('Public Track')!;
    const { authorKey, signature, ...unsigned } = bundle.publication as typeof bundle.publication & { authorKey: string; signature: string };
    expect(authorKey).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(ed25519.verify(hexToBytes(signature), utf8ToBytes(JSON.stringify({ ...unsigned, authorKey })), hexToBytes(authorKey))).toBe(true);

    const fork = PhilomaticEngine.open();
    fork.importPublication(bundle);
    expect(fork.exportAll().tracks[0]!.origin?.authorKey).toBe(authorKey);
    fork.close();
    engine.close();
  });

  it('the key is minted once beside a file-backed DB (mode 0600) and survives reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-key-'));
    const a = PhilomaticEngine.open(join(dir, 'a.sqlite'));
    const k1 = a.authorPublicKey();
    a.close();
    expect(statSync(join(dir, 'author.key')).mode & 0o777).toBe(0o600);
    const b = PhilomaticEngine.open(join(dir, 'a.sqlite'));
    expect(b.authorPublicKey()).toBe(k1); // possession of the file IS continuity
    b.close();
  });

  it('a tampered manifest is rejected: the signature no longer covers it', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = JSON.parse(JSON.stringify(engine.publication('Public Track'))) as { publication: { license: string } };
    bundle.publication.license = 'WTFPL'; // relicense someone else's work
    const fork = PhilomaticEngine.open();
    expect(() => fork.importPublication(bundle)).toThrow(/signature invalid/);
    fork.close();
    engine.close();
  });

  it('TOFU: a re-fork under a DIFFERENT author key is refused loudly', () => {
    const alice = build();
    alice.publish({ ref: 'Public Track' });
    const fromAlice = alice.publication('Public Track')!;

    const fork = PhilomaticEngine.open();
    fork.importPublication(fromAlice); // pins Alice's key

    // Mallory republishes the same track from her own instance (her own key).
    const mallory = PhilomaticEngine.open(':memory:', { now: () => 2_000_000 });
    mallory.importPayload(fromAlice.payload);
    mallory.publish({ ref: 'Public Track' });
    const fromMallory = mallory.publication('Public Track')!;

    expect(() => fork.importPublication(fromMallory)).toThrow(/author key changed/);
    fork.close();
    alice.close();
    mallory.close();
  });

  it('a pre-signing (unsigned) bundle still imports — unattested, no pin recorded', () => {
    const engine = build();
    engine.publish({ ref: 'Public Track' });
    const bundle = JSON.parse(JSON.stringify(engine.publication('Public Track'))) as {
      publication: { authorKey?: string; signature?: string };
    };
    delete bundle.publication.authorKey;
    delete bundle.publication.signature;
    const fork = PhilomaticEngine.open();
    fork.importPublication(bundle);
    expect(fork.exportAll().tracks[0]!.origin?.authorKey).toBeUndefined();
    fork.close();
    engine.close();
  });

  it('GET /author serves the public key', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'pub-dist-'));
    writeFileSync(join(dist, 'index.html'), '<div id="root"></div>');
    const server = createIngestServer({ db: ':memory:', uiDist: dist });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/author`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { authorKey: string }).authorKey).toMatch(/^[0-9a-f]{64}$/);
    server.close();
  });
});
