/**
 * Edit plan M3 — transport + CLI, thin by construction:
 *   - POST /remove | /restore | /update are token-guarded writes; GET /removed is the trash bin
 *   - errors surface as clean JSON (CaptureError → 400), never a stack
 *   - the CLI drives the same primitives end-to-end (capture → remove → removed → restore →
 *     update) against a real database file
 * All semantics are engine-owned; these tests only prove the wiring.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createIngestServer } from '../src/server/ingest';
import { sourceId } from '../src/schema/ids';

const URL_A = 'https://example.com/article';
const SRC = sourceId({ title: URL_A, directUrl: URL_A });

describe('edit M3: HTTP transport', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(opts: Parameters<typeof createIngestServer>[0] = {}): Promise<string> {
    server = createIngestServer({ db: ':memory:', ...opts });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('remove → removed → restore round-trips over HTTP', async () => {
    const base = await start();
    await post(base, '/ingest', { url: URL_A, title: 'Article' });
    await post(base, '/snippet', { url: URL_A, text: 'A passage.' });

    const removed = await post(base, '/remove', { ref: URL_A });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ version: 1, kind: 'source', targetId: SRC, changed: true });

    const sources = (await (await fetch(`${base}/sources`)).json()) as { sources: { id: string }[] };
    expect(sources.sources).toEqual([]); // folded out of the read views

    const bin = (await (await fetch(`${base}/removed`)).json()) as {
      version: number;
      removed: { kind: string; id: string; label: string; hides: unknown[] }[];
    };
    expect(bin.version).toBe(2);
    expect(bin.removed).toHaveLength(1);
    expect(bin.removed[0]).toMatchObject({ kind: 'source', id: SRC, label: 'Article' });
    expect(bin.removed[0]!.hides).toHaveLength(1); // the cascade-hidden snippet is discoverable

    const restored = await post(base, '/restore', { ref: SRC });
    expect(await restored.json()).toMatchObject({ changed: true });
    const after = (await (await fetch(`${base}/sources`)).json()) as { sources: { id: string }[] };
    expect(after.sources.map((s) => s.id)).toEqual([SRC]);
  });

  it('POST /update patches non-identity fields and 400s identity fields', async () => {
    const base = await start();
    await post(base, '/ingest', { url: URL_A, title: 'Article' });

    const ok = await post(base, '/update', { ref: SRC, patch: { title: 'Article (annotated)' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: 'source', changed: true });

    const bad = await post(base, '/update', { ref: SRC, patch: { url: 'https://elsewhere' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/identity field/);
  });

  it('guards the edit writes with the ingest token', async () => {
    const base = await start({ token: 'sesame' });
    for (const path of ['/remove', '/restore', '/update']) {
      const denied = await post(base, path, { ref: 'x' });
      expect(denied.status).toBe(401);
    }
    // GET /removed is a read — open like the other reads.
    expect((await fetch(`${base}/removed`)).status).toBe(200);

    await post(base, '/ingest', { url: URL_A }, { 'X-Ingest-Token': 'sesame' });
    const allowed = await post(base, '/remove', { ref: URL_A }, { 'X-Ingest-Token': 'sesame' });
    expect(allowed.status).toBe(200);
  });

  it('maps engine ref errors to clean 400 JSON', async () => {
    const base = await start();
    const r = await post(base, '/remove', { ref: 'Nothing Here' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/unknown reference/);
  });
});

describe('edit M3: CLI', () => {
  it('capture → remove → removed → restore → update, end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'philomatic-edit-'));
    const db = join(dir, 'edit.sqlite');
    const run = (args: string[]): string =>
      execFileSync('./node_modules/.bin/tsx', ['src/cli/index.ts', '--db', db, ...args], { encoding: 'utf8' });
    try {
      run(['capture', URL_A, '--title', 'Article']);

      expect(run(['remove', URL_A])).toContain(`Removed source: ${SRC}`);
      expect(run(['remove', URL_A])).toContain('Already removed');
      expect(run(['removed'])).toContain('Article');

      expect(run(['restore', SRC])).toContain(`Restored source: ${SRC}`);
      expect(run(['removed'])).toContain('(nothing removed)');

      expect(run(['update', SRC, '--title', 'Article v2', '--duration', '15'])).toContain('Updated source');
      expect(run(['list', 'sources'])).toContain('Article v2');
      expect(run(['update', SRC, '--title', 'Article v2', '--duration', '15'])).toContain('No change');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
