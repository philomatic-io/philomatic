/**
 * THE ENGINE-PARITY CONTRACT.
 *
 * One workbench, two engines: the in-browser client (localClient over PhilomaticEngine) and the
 * HTTP client (httpClient over the ingest server, over the same PhilomaticEngine). Every view
 * talks to the EngineClient interface and cannot tell them apart — which means a behavior fixed
 * in one client and not the other ships as a bug that only half the users see. Every publishing
 * publishing bug that ships in one client and not the other is of this class.
 *
 * This suite runs the SAME assertions over BOTH clients. Add a case here whenever an
 * EngineClient method gains behavior beyond forwarding — especially anything that depends on
 * WHERE the app runs (origin, credential, registry) rather than WHAT is in the graph.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PhilomaticEngine } from '../src/engine';
import { createIngestServer } from '../src/server/ingest';
import { localClient } from '../ui/src/client/local';
import { httpClient, type EngineClient } from '../ui/src/client/transport';

const open: Server[] = [];
afterAll(() => {
  for (const s of open.splice(0)) s.close();
});

/** Both clients, freshly built over empty engines, plus teardown. */
async function bothClients(): Promise<{ name: string; client: EngineClient }[]> {
  const local = localClient(PhilomaticEngine.open(':memory:') as unknown as Parameters<typeof localClient>[0], () => {});
  const server = createIngestServer({ db: ':memory:' });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const http = httpClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, undefined);
  return [
    { name: 'in-browser', client: local },
    { name: 'http', client: http },
  ];
}

describe('EngineClient contract — both engines, one behavior', () => {
  it('identical writes produce identical snapshots', async () => {
    const clients = await bothClients();
    const shapes: string[] = [];
    for (const { client } of clients) {
      await client.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'T' });
      await client.captureSource({ url: 'https://ex.com/b', title: 'B' });
      const s = await client.getSnapshot();
      shapes.push(
        JSON.stringify({
          tracks: s.tracks.map((t) => [t.title, t.id]),
          sources: s.sources.map((x) => [x.title, x.id]).sort(),
        }),
      );
    }
    expect(shapes[0], 'the two engines disagree about the same writes').toBe(shapes[1]);
  });

  it('publish → publicationMeta agree, including the not-published answer', async () => {
    const clients = await bothClients();
    const metas: (string | undefined)[] = [];
    for (const { name, client } of clients) {
      expect(await client.publicationMeta('nope'), `${name}: unpublished is undefined`).toBeUndefined();
      await client.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'T' });
      await client.publish('T', 'CC-BY-SA-4.0');
      const meta = await client.publicationMeta('T');
      expect(meta?.contentHash, `${name}: published has a hash`).toMatch(/^[a-f0-9]{64}$/);
      metas.push(meta?.contentHash);
    }
    // Same content, same closure → the SAME hash from both engines, or sync-state comparisons
    // between a browser library and a hosted one are meaningless.
    expect(metas[0], 'content hashes must be engine-independent').toBe(metas[1]);
  });

  it('export → import round-trips across the two engines, both directions', async () => {
    const clients = await bothClients();
    const [a, b] = clients.map((c) => c.client) as [EngineClient, EngineClient];
    await a.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'T' });
    await b.importPayload(await a.exportAll());
    await b.captureSource({ url: 'https://ex.com/c', title: 'C', track: 'T' });
    await a.importPayload(await b.exportAll());
    const [sa, sb] = [await a.getSnapshot(), await b.getSnapshot()];
    expect(sa.sources.map((s) => s.title).sort(), 'a migration must not shed content').toEqual(sb.sources.map((s) => s.title).sort());
  });

  it('importPayload accepts a publication bundle as a FORK — in both engines', async () => {
    // A bundle must fork in the browser exactly as it does on the server: the /import route
    // sniffs pubVersion, and the in-browser client must sniff it identically (Principle 9).
    const author = PhilomaticEngine.open(':memory:');
    author.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Forked Track' });
    author.publish({ ref: 'Forked Track' });
    const bundle = author.publication('Forked Track')!;
    const clients = await bothClients();
    for (const { name, client } of clients) {
      await client.importPayload(JSON.parse(JSON.stringify(bundle)));
      const snap = await client.getSnapshot();
      const t = snap.tracks.find((x) => x.title === 'Forked Track');
      expect(t, `${name}: the fork arrived`).toBeDefined();
      expect(t!.published, `${name}: a fork arrives unpublished`).toBeUndefined();
    }
  });

  it('publish AS carries the fork identity — in both engines, hash-identical', async () => {
    // Fork identity: the alias must project identically wherever the engine runs, or a
    // browser fork and a hosted fork of the same track would publish different bundles.
    const clients = await bothClients();
    const metas: { trackId: string; contentHash: string }[] = [];
    for (const { name, client } of clients) {
      await client.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'T' });
      await client.publish('T', 'CC-BY-SA-4.0', 'My Own Version');
      const meta = await client.publicationMeta('T');
      expect(meta?.trackId, `${name}: the published identity is the alias`).toBe('syl_my-own-version');
      expect(meta?.title, name).toBe('My Own Version');
      metas.push(meta as { trackId: string; contentHash: string });
    }
    expect(metas[0]!.contentHash, 'alias projection is engine-independent').toBe(metas[1]!.contentHash);
  });

  it('pullFork takes upstream changes identically in both engines (M-S6)', async () => {
    // A real registry serves v1 (forked) then v2 (pulled); both clients must land the same
    // graph. The http instance is configured with the registry; the browser client reads the
    // fork's recorded origin. No providers → key-pinned anonymous publish, as a self-hosted
    // registry allows.
    const { createRegistryServer } = await import('../src/registry/server');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const reg = createRegistryServer({ dir: mkdtempSync(join(tmpdir(), 'pm-pullc-')), introHtml: false });
    open.push(reg);
    await new Promise<void>((r) => reg.listen(0, '127.0.0.1', r));
    const regUrl = `http://127.0.0.1:${(reg.address() as AddressInfo).port}`;

    const author = PhilomaticEngine.open(':memory:');
    author.captureSource({ url: 'https://ex.com/r1', title: 'R1', track: 'Pull Me' });
    author.publish({ ref: 'Pull Me' });
    expect((await fetch(`${regUrl}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(author.publication('Pull Me')) })).status).toBe(200);

    const saved = process.env.REGISTRY_URL;
    process.env.REGISTRY_URL = regUrl;
    let server: Server;
    try {
      server = createIngestServer({ db: ':memory:' });
    } finally {
      if (saved === undefined) delete process.env.REGISTRY_URL;
      else process.env.REGISTRY_URL = saved;
    }
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const http = httpClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, undefined);
    // The browser client resolves its registry from the page origin — point its engine's fork
    // at the same registry by recording the origin explicitly, as forkRegistryTrack does.
    const localEngine = PhilomaticEngine.open(':memory:');
    const local = localClient(localEngine as unknown as Parameters<typeof localClient>[0], () => {});
    localEngine.importPublication(JSON.parse(JSON.stringify(author.publication('Pull Me'))), { originUrl: `${regUrl}/t/syl_pull-me` });
    await http.forkRegistryTrack('syl_pull-me');

    // Upstream moves: a second reading, and the first retitled.
    author.captureSource({ url: 'https://ex.com/r2', title: 'R2', track: 'Pull Me' });
    author.update({ ref: author.exportAll().sources.find((x) => x.title === 'R1')!.id, patch: { title: 'R1 (2nd ed)' } });
    expect((await fetch(`${regUrl}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(author.publication('Pull Me')) })).status).toBe(200);

    const shapes: string[] = [];
    for (const { name, client } of [
      { name: 'in-browser', client: local },
      { name: 'http', client: http },
    ]) {
      const summary = await client.pullFork('syl_pull-me');
      expect(summary.took, `${name}: took the addition and the edit`).toBe(2);
      expect(summary.keptYours, name).toBe(0);
      const snap = await client.getSnapshot();
      shapes.push(JSON.stringify(snap.sources.map((x) => x.title).sort()));
      expect(shapes[shapes.length - 1]).toContain('R1 (2nd ed)');
    }
    expect(shapes[0], 'both engines landed the same graph').toBe(shapes[1]);
  });

  it('the framework store (FE-S2): built-ins, save-mine round-trip, install, refusals — in both engines', async () => {
    const clients = await bothClients();
    const MINE = {
      framework: 'stu',
      version: 0,
      edgeTags: [
        { name: 'DisputesWith', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'directed' as const, inverseLabel: 'disputed by', render: 'line' as const, polarity: 'against' as const },
      ],
    };
    const GUEST = { framework: 'visiting-lens', version: 3, edgeTags: [] };
    const shapes: string[] = [];
    for (const { name, client } of clients) {
      const before = await client.frameworks();
      expect(before.builtin.map((f) => f.framework), `${name}: built-ins ship`).toContain('philomatic-core');
      expect(before.mine, `${name}: no personal framework until saved`).toBeUndefined();
      await client.saveMyFramework(MINE);
      await client.installFramework(GUEST);
      await client.installFramework({ ...GUEST, version: 4 }); // same name replaces — an update
      // Both hosts store the CANONICAL parsed shape — the zod defaults filled in.
      const canon = (f: object) => ({ entityTags: [], metadataFields: [], ...f });
      const after = await client.frameworks();
      expect(after.mine, `${name}: mine round-trips`).toEqual(canon(MINE));
      expect(after.installed, `${name}: install replaces by name`).toEqual([canon({ ...GUEST, version: 4 })]);
      await expect(client.saveMyFramework({ ...MINE, framework: 'philomatic-core' }), `${name}: built-in names refuse`).rejects.toThrow(/built-in/);
      // View overrides ride the same store: local re-marks/hides, round-tripped.
      await client.saveViewOverrides({ tags: { TopicOf: 'hidden' }, types: { ABOUT: 'hidden' } });
      const viewed = await client.frameworks();
      expect(viewed.viewOverrides, `${name}: view overrides round-trip`).toEqual({ tags: { TopicOf: 'hidden' }, types: { ABOUT: 'hidden' } });
      // Optional built-ins are opt-in: off until enabled, and the choice round-trips.
      expect(viewed.enabledBuiltins, `${name}: built-ins start off`).toEqual([]);
      await client.setEnabledBuiltins(['hermeneutics', 'argument-diagramming']);
      const enabled = await client.frameworks();
      expect(enabled.enabledBuiltins, `${name}: enablement round-trips`).toEqual(['hermeneutics', 'argument-diagramming']);
      // Installed frameworks default ON; the disabled list records the exceptions and round-trips.
      expect(enabled.disabledInstalled, `${name}: installs start on`).toEqual([]);
      await client.setDisabledInstalled(['visiting-lens']);
      const dimmed = await client.frameworks();
      expect(dimmed.disabledInstalled, `${name}: the off-switch round-trips`).toEqual(['visiting-lens']);
      await client.removeFramework('visiting-lens');
      expect((await client.frameworks()).installed, `${name}: uninstall removes`).toEqual([]);
      shapes.push(JSON.stringify({ mine: after.mine, installed: after.installed, view: viewed.viewOverrides, on: enabled.enabledBuiltins, off: dimmed.disabledInstalled }));
    }
    expect(shapes[0], 'the two engines disagree about the store').toBe(shapes[1]);
  });

  it('a minted framework tag SURVIVES publish — in both engines, hash-identical', async () => {
    // A user-framework relation on a published track must never be silently
    // stripped by a projection allowlist that only knows the baked frameworks. The
    // library's own store now rides every publication read on both hosts.
    const clients = await bothClients();
    const hashes: string[] = [];
    for (const { name, client } of clients) {
      await client.saveMyFramework({
        framework: 'stu',
        version: 0,
        edgeTags: [{ name: 'DisputesWith', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'directed' as const, publish: true }],
      });
      await client.importPayload({
        version: 2,
        concepts: [{ name: 'Formalism' }, { name: 'Intuitionism' }],
        tracks: [{ title: 'T', includes: ['Formalism', 'Intuitionism'] }],
      });
      await client.link({ srcType: 'concept', srcId: 'cpt_formalism', type: 'LINK', dstType: 'concept', dstId: 'cpt_intuitionism', tags: [{ name: 'DisputesWith' }] });
      await client.publish('T', 'CC-BY-SA-4.0');
      const meta = await client.publicationMeta('T');
      expect(meta, `${name}: published`).toBeDefined();
      hashes.push(meta!.contentHash);
    }
    expect(hashes[0], 'both hosts publish the same bundle (tag included)').toBe(hashes[1]);
    // Equal hashes alone could mean "stripped identically" — read the bundle through the http
    // host's own route and pin the tag's presence.
    const server = createIngestServer({ db: ':memory:' });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post('/framework/mine', {
      framework: 'stu',
      version: 0,
      edgeTags: [{ name: 'DisputesWith', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'directed', publish: true }],
    });
    await post('/import', { version: 2, concepts: [{ name: 'Formalism' }, { name: 'Intuitionism' }], tracks: [{ title: 'T', includes: ['Formalism', 'Intuitionism'] }] });
    await post('/link', { srcType: 'concept', srcId: 'cpt_formalism', type: 'LINK', dstType: 'concept', dstId: 'cpt_intuitionism', tags: [{ name: 'DisputesWith' }] });
    await post('/publish', { ref: 'T' });
    const bundle = await (await fetch(`${base}/publication?ref=T`)).json();
    expect(JSON.stringify(bundle), 'the minted tag travels in the bundle').toContain('DisputesWith');
    const b = bundle as { payload: { frameworks?: unknown[] }; frameworkDefs?: { framework: string }[] };
    expect(b.payload.frameworks, 'manifest names the dependency').toEqual([{ name: 'stu', version: 0 }]);
    expect(b.frameworkDefs?.map((f) => f.framework), 'the definition rides along').toEqual(['stu']);
    // The ROUND TRIP: importing the bundle INSTALLS the definition — on both
    // hosts — so a fork renders the author's vocabulary with zero extra steps.
    for (const { name, client } of await bothClients()) {
      await client.importPayload(JSON.parse(JSON.stringify(bundle)));
      const fw = await client.frameworks();
      expect(fw.installed.map((f) => f.framework), `${name}: the fork installed the framework`).toEqual(['stu']);
    }
  });

  it('merge-patch import: a skeleton re-import keeps unmentioned fields — in both engines', async () => {
    // The merge-patch rule: absent = keep, null = clear, at the
    // ONE write gate. Both hosts run the same gate; this pins that neither grows a bypass.
    const clients = await bothClients();
    const shapes: string[] = [];
    for (const { name, client } of clients) {
      await client.importPayload({
        version: 2,
        sources: [{ id: 'src_t', title: 'T', directUrl: 'https://ex.com/t', modality: 'video', author: 'Jane', estimatedDurationMins: 60, tags: ['#keep'] }],
      });
      await client.importPayload({ version: 2, sources: [{ id: 'src_t', title: 'T', directUrl: 'https://ex.com/t', author: null }] });
      const s = (await client.getSnapshot()).sources[0]!;
      expect(s.author, `${name}: null cleared the author`).toBeUndefined();
      expect(s.estimatedDurationMins, `${name}: absent kept the duration`).toBe(60);
      shapes.push(JSON.stringify([s.modality, s.estimatedDurationMins, s.tags]));
    }
    expect(shapes[0], 'the two engines disagree about the merge').toBe(shapes[1]);
  });
});
