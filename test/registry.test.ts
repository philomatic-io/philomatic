/**
 * The track registry — publish/update/fork/unpublish against a real
 * registry server with REAL signed bundles from real engines. Pinned: signature-required
 * policy, the per-track TOFU key pin (first publisher owns the name), tamper rejection, the
 * signed unpublish challenge, the library index, and that a registry bundle round-trips into
 * another Philomatic as a fork (the whole point).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { readReg, writeReg } from './registry-file';
import { createRegistryServer } from '../src/registry/server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(): Promise<{ base: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-registry-'));
  // A fake viewer dist so /t/:id renders without the real ui build.
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html><head><link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/a.js"></script></head><body></body></html>');
  writeFileSync(join(dist, 'assets', 'a.css'), 'body{}');
  writeFileSync(join(dist, 'assets', 'a.js'), 'globalThis.x=1');
  server = createRegistryServer({ dir, uiDist: dist, now: () => 7_000 });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, dir };
}

/** A publishing author: file-backed engine (author.key beside the DB) with one published track. */
function author(title = 'Fairness 101'): { engine: PhilomaticEngine; bundle: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'pm-author-'));
  const engine = PhilomaticEngine.open(join(dir, 'db.sqlite'));
  engine.captureSource({ url: 'https://ex.com/a', title: 'Paper A', track: title });
  engine.publish({ ref: title, license: 'CC-BY-SA-4.0' });
  const bundle = engine.publication(title);
  expect(bundle).not.toBeNull();
  return { engine, bundle };
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('track registry', () => {
  it('publish → library index → public page → fork into another Philomatic', async () => {
    const { base } = await start();
    const a = author();

    const pub = await post(base, '/publish', a.bundle);
    expect(pub.status).toBe(200);
    const res = (await pub.json()) as { url: string; updated: boolean };
    expect(res.updated).toBe(false);
    expect(res.url).toBe('/t/syl_fairness-101');

    const idx = (await (await fetch(`${base}/index.json`)).json()) as { tracks: { title: string; sources: number; authorKey: string }[] };
    expect(idx.tracks).toHaveLength(1);
    expect(idx.tracks[0]!).toMatchObject({ title: 'Fairness 101', sources: 1 });

    const page = await fetch(`${base}/t/syl_fairness-101`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('__PHILOMATIC_PUBLICATION__');

    const library = await (await fetch(`${base}/`)).text();
    expect(library).toContain('Fairness 101');

    // Fork: download the bundle, import into a fresh Philomatic — machinery unchanged.
    const raw = await (await fetch(`${base}/t/syl_fairness-101.json`)).json();
    const fork = PhilomaticEngine.open();
    const got = fork.importPublication(raw, { originUrl: `${base}/t/syl_fairness-101` });
    expect(got.title).toBe('Fairness 101');
    expect(fork.snapshot().tracks[0]!.sourceIds).toHaveLength(1);
    fork.close();
    a.engine.close();
  });

  it('discovery (RD-S1): goal + featured ride the index; the library page carries search', async () => {
    const { base, dir } = await start();
    const a = author();
    a.engine.update({ ref: 'Fairness 101', patch: { goal: 'Understand group fairness before optimizing it' } });
    a.engine.publish({ ref: 'Fairness 101', license: 'CC-BY-SA-4.0' });
    await post(base, '/publish', a.engine.publication('Fairness 101'));
    writeFileSync(join(dir, 'featured.json'), JSON.stringify(['syl_fairness-101']));

    const idx = (await (await fetch(`${base}/index.json`)).json()) as { tracks: Record<string, unknown>[] };
    expect(idx.tracks[0]).toMatchObject({
      goal: 'Understand group fairness before optimizing it',
      featured: true,
    });
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('Understand group fairness before optimizing it');
    expect(page).toContain('★');
    // The shell: static rows + the data island the public bundle mounts search over.
    expect(page).toContain('id="registry-data"');
    expect(page).toContain('/assets/public.js');
    expect(page).toContain('"featured":true');
    a.engine.close();
  });

  it('friendly URLs (RD-D1): prefix-less form resolves; an ambiguous slug lists candidates', async () => {
    const { base } = await start();
    const a = author();
    await post(base, '/publish', a.bundle);
    // syl_-prefix inference: /t/fairness-101 serves the same track as /t/syl_fairness-101
    expect((await fetch(`${base}/t/fairness-101`)).status).toBe(200);
    expect(((await (await fetch(`${base}/t/fairness-101.json`)).json()) as { publication: { title: string } }).publication.title).toBe('Fairness 101');

    // two explicit-id tracks sharing a TITLE: the slug is ambiguous → list, never guess
    const dirB = mkdtempSync(join(tmpdir(), 'pm-author-'));
    const b = PhilomaticEngine.open(join(dirB, 'db.sqlite'));
    for (const id of ['syl_custom-a', 'syl_custom-b']) {
      b.importPayload({ version: 2, tracks: [{ id, title: 'Same Name' }], sources: [{ title: `S ${id}`, modality: 'text' }] });
      b.link({ srcType: 'track', srcId: id, type: 'INCLUDES', dstType: 'source', dstId: b.snapshot().sources.find((s) => s.title === `S ${id}`)!.id });
      b.publish({ ref: id, license: 'CC-BY-SA-4.0' });
      expect((await post(base, '/publish', b.publication(id))).status).toBe(200);
    }
    const amb = await fetch(`${base}/t/same-name`);
    expect(amb.status).toBe(300);
    const body = (await amb.json()) as { candidates: { trackId: string }[] };
    expect(body.candidates.map((c) => c.trackId).sort()).toEqual(['syl_custom-a', 'syl_custom-b']);
    a.engine.close();
    b.close();
  });

  it('goal backfills from the bundle file at boot (bundles/ is the truth)', async () => {
    const { base, dir } = await start();
    const a = author();
    a.engine.update({ ref: 'Fairness 101', patch: { goal: 'The goal line' } });
    a.engine.publish({ ref: 'Fairness 101', license: 'CC-BY-SA-4.0' });
    await post(base, '/publish', a.engine.publication('Fairness 101'));
    // simulate an index from before goals were indexed: strip the goal, reboot the registry on the same dir
    const idx = readReg<Record<string, { goal?: string }>>(dir, 'index.json');
    delete idx['syl_fairness-101']!.goal;
    writeReg(dir, 'index.json', idx);
    server?.close();
    server = createRegistryServer({ dir, uiDist: join(dir, 'dist'), now: () => 8_000 });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    const rebooted = (await (await fetch(`http://127.0.0.1:${port}/index.json`)).json()) as { tracks: { goal?: string }[] };
    expect(rebooted.tracks[0]!.goal).toBe('The goal line');
    a.engine.close();
  });

  it('RD-S2: an ingest server browses its configured registry and forks with lineage', async () => {
    const { base } = await start();
    const a = author();
    a.engine.update({ ref: 'Fairness 101', patch: { goal: 'Group fairness first' } });
    a.engine.publish({ ref: 'Fairness 101', license: 'CC-BY-SA-4.0' });
    await post(base, '/publish', a.engine.publication('Fairness 101'));

    const { createIngestServer } = await import('../src/server/ingest');
    const ingest = createIngestServer({ db: ':memory:', registry: base });
    await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
    const iport = (ingest.address() as AddressInfo).port;
    try {
      const browse = (await (await fetch(`http://127.0.0.1:${iport}/registry`)).json()) as {
        registry: string;
        tracks: { trackId: string; goal?: string }[];
      };
      expect(browse.registry).toBe(base);
      expect(browse.tracks[0]).toMatchObject({ trackId: 'syl_fairness-101', goal: 'Group fairness first' });

      const fork = await fetch(`http://127.0.0.1:${iport}/registry-fork`, {
        method: 'POST',
        body: JSON.stringify({ trackId: 'syl_fairness-101' }),
      });
      expect(fork.status).toBe(200);
      expect((await fork.json()) as object).toMatchObject({ forked: true, title: 'Fairness 101' });
      const snap = (await (await fetch(`http://127.0.0.1:${iport}/snapshot`)).json()) as { tracks: { title: string }[] };
      expect(snap.tracks.map((t) => t.title)).toContain('Fairness 101');

      // and a server with NO registry answers 204 — the community section simply doesn't exist
      const bare = createIngestServer({ db: ':memory:', registry: '' });
      await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
      const bport = (bare.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${bport}/registry`)).status).toBe(204);
      bare.close();
    } finally {
      ingest.close();
      a.engine.close();
    }
  });

  it('requires signatures, rejects tampered bundles', async () => {
    const { base } = await start();
    const a = author();

    const tampered = JSON.parse(JSON.stringify(a.bundle)) as { payload: { sources: { title: string }[] } };
    tampered.payload.sources[0]!.title = 'Evil Retitle';
    const bad = await post(base, '/publish', tampered);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/contentHash mismatch/);

    const unsigned = JSON.parse(JSON.stringify(a.bundle)) as { publication: { signature?: string; authorKey?: string } };
    delete unsigned.publication.signature;
    delete unsigned.publication.authorKey;
    const no = await post(base, '/publish', unsigned);
    expect(no.status).toBe(400);
    expect(((await no.json()) as { error: string }).error).toMatch(/only accepts signed/);
    a.engine.close();
  });

  it('TOFU: the first publisher owns the name — same key updates, a different key is refused', async () => {
    const { base } = await start();
    const a = author();
    expect((await post(base, '/publish', a.bundle)).status).toBe(200);

    // Same author edits and re-pushes: accepted as an update.
    a.engine.captureSource({ url: 'https://ex.com/b', title: 'Paper B', track: 'Fairness 101' });
    const again = await post(base, '/publish', a.engine.publication('Fairness 101'));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { updated: boolean }).updated).toBe(true);
    const idx = (await (await fetch(`${base}/index.json`)).json()) as { tracks: { sources: number }[] };
    expect(idx.tracks[0]!.sources).toBe(2);

    // A DIFFERENT author (different keypair) publishing the same track id: refused.
    const b = author(); // same title → same syl_ id, fresh random key
    const stolen = await post(base, '/publish', b.bundle);
    expect(stolen.status).toBe(403);
    expect(((await stolen.json()) as { error: string }).error).toMatch(/pinned to a different author key/);
    a.engine.close();
    b.engine.close();
  });

  it('unpublish: only the pinned key’s signed challenge removes; archive persists', async () => {
    const { base } = await start();
    const a = author();
    expect((await post(base, '/publish', a.bundle)).status).toBe(200);
    const idx = (await (await fetch(`${base}/index.json`)).json()) as { tracks: { trackId: string; contentHash: string }[] };
    const { trackId, contentHash } = idx.tracks[0]!;

    // Wrong signature (a different key) → refused.
    const stranger = PhilomaticEngine.open();
    const forged = stranger.authorSign(`unpublish:${trackId}:${contentHash}`);
    expect((await post(base, '/unpublish', { trackId, signature: forged.signature })).status).toBe(403);
    stranger.close();

    // The pinned key's signature → removed from index and bundle route; archive stays.
    const { signature } = a.engine.authorSign(`unpublish:${trackId}:${contentHash}`);
    expect((await post(base, '/unpublish', { trackId, signature })).status).toBe(200);
    expect(((await (await fetch(`${base}/index.json`)).json()) as { tracks: unknown[] }).tracks).toHaveLength(0);
    expect((await fetch(`${base}/t/${trackId}.json`)).status).toBe(404);
    a.engine.close();
  });

  it('a VALIDLY SIGNED bundle carrying a traversal trackId is refused, and writes nothing outside the data dir', async () => {
    // The attacker owns a keypair (any engine mints one) and signs their OWN hostile manifest,
    // so the signature check passes — the trackId is the on-disk filename, and it is the one
    // field an author fully controls. The push boundary must reject the shape before any path
    // join. Forged here at the wire level because a real engine's slugify can't mint the id.
    const { base, dir } = await start();
    const secret = ed25519.utils.randomSecretKey();
    const authorKey = bytesToHex(ed25519.getPublicKey(secret));
    const payload = { sources: [], concepts: [], questions: [] };
    const contentHash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(payload))));
    // Key order must match the parsed manifest (schema order) the verifier signs over.
    const unsigned = { trackId: '../../pwned', title: 'Evil', license: 'CC-BY-SA-4.0', publishedAt: 1, contentHash, authorKey };
    const signature = bytesToHex(ed25519.sign(utf8ToBytes(JSON.stringify(unsigned)), secret));
    const bundle = { pubVersion: 1, publication: { ...unsigned, signature }, payload };

    const res = await post(base, '/publish', bundle);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/trackId/);
    // The write that a traversal would have produced: dir/bundles/../../pwned.json === <dir>/../pwned.json
    expect(existsSync(join(dir, '..', 'pwned.json')), 'nothing escaped the data dir').toBe(false);
  });
});

describe('encryption at rest — the registry (E-S3)', () => {
  it('private files are ciphertext, published bundles stay plaintext, and the public index still serves', async () => {
    const { base, dir } = await start();
    const a = author();
    expect((await post(base, '/publish', a.bundle)).status).toBe(200);

    // The published BUNDLE is public — a stranger fetches it verbatim, so it stays plaintext JSON.
    const bundleRaw = readFileSync(join(dir, 'bundles', 'syl_fairness-101.json'));
    expect(() => JSON.parse(bundleRaw.toString('utf8')), 'bundles are plaintext').not.toThrow();

    // The INDEX is private (it carries community invite tokens) — ciphertext on disk.
    const indexRaw = readFileSync(join(dir, 'index.json'));
    expect(() => JSON.parse(indexRaw.toString('utf8')), 'index.json is encrypted').toThrow();
    expect(indexRaw.includes('syl_fairness-101'), 'no plaintext trackId leaks from the index file').toBe(false);

    // …yet the public /index.json ROUTE still serves it (the in-memory index decrypts at boot).
    const served = (await (await fetch(`${base}/index.json`)).json()) as { tracks: { title: string }[] };
    expect(served.tracks[0]!.title).toBe('Fairness 101');
    // And the decrypt round-trips through the helper.
    expect(Object.keys(readReg<Record<string, unknown>>(dir, 'index.json'))).toContain('syl_fairness-101');
    a.engine.close();
  });

  it('R2 — a sign-in registry refuses to run plaintext without a KEK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-reg-r2-'));
    const saved = process.env.PHILOMATIC_KEK;
    const signIn = { providers: [{ id: 'google', label: 'Google', authorizeUrl: () => '/x', exchange: async () => ({ provider: 'google', subject: 's' }) }], sessionSecret: 'x'.repeat(32), publicUrl: 'http://127.0.0.1' };
    try {
      delete process.env.PHILOMATIC_KEK;
      expect(() => createRegistryServer({ dir, ...signIn })).toThrow(/encrypt them at rest|ALLOW_PLAINTEXT/);
      process.env.PHILOMATIC_ALLOW_PLAINTEXT = '1';
      const s = createRegistryServer({ dir, ...signIn });
      expect(s).toBeDefined();
      s.close();
    } finally {
      delete process.env.PHILOMATIC_ALLOW_PLAINTEXT;
      if (saved !== undefined) process.env.PHILOMATIC_KEK = saved;
    }
  });
});
