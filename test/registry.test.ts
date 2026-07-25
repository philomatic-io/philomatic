/**
 * The track registry (owner plan, 2026-07-18) — publish/update/fork/unpublish against a real
 * registry server with REAL signed bundles from real engines. Pinned: signature-required
 * policy, the per-track TOFU key pin (first publisher owns the name), tamper rejection, the
 * signed unpublish challenge, the library index, and that a registry bundle round-trips into
 * another Philomatic as a fork (the whole point).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { createRegistryServer } from '../src/registry/server';

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

  it('serves the in-browser demo at /demo when a build is provided; off by demoDist: false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-registry-demo-'));
    const demo = join(dir, 'dist-demo');
    mkdirSync(join(demo, 'assets'), { recursive: true });
    writeFileSync(join(demo, 'demo.html'), '<html>demo</html>');
    writeFileSync(join(demo, 'assets', 'd.js'), 'globalThis.d=1');
    server = createRegistryServer({ dir, demoDist: demo });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const page = await fetch(`${base}/demo/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo');
    expect((await fetch(`${base}/demo`)).status).toBe(200); // no trailing slash
    expect((await fetch(`${base}/demo/assets/d.js`)).status).toBe(200);
    // Path traversal must not escape the demo dir.
    expect((await fetch(`${base}/demo/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    // The library page advertises the demo when it's enabled.
    expect(await (await fetch(`${base}/`)).text()).toContain('/demo/');
    server!.close();

    server = createRegistryServer({ dir, demoDist: false });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const off = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    expect((await fetch(`${off}/demo/`)).status).toBe(404);
  });
});
