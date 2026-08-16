/**
 * The REAL deploy shape, as a fixture.
 *
 * Twice in one day a bug was invisible to tests because the fixture's shape differed from the
 * deploy's in exactly the dimension under test: the one-registry redirect needed HOSTING mode, and the
 * sign-in gate needed the instance to know accounts exist. This helper builds what Caddy builds —
 * one origin, /app* and the static assets to a HOSTED instance, everything else to a registry
 * with sign-in — so the true shape is the cheapest one to reach for. If a test wants a different
 * shape, that difference should be the point of the test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthProvider } from '../../src/registry/oauth';

/** The public handle a fixture sign-in claims for a subject: a valid username slug. */
export function usernameOf(subject: string): string {
  const slug = subject
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return slug.length >= 3 ? slug : `${slug || 'usr'}-usr`;
}

export interface OneOrigin {
  url: string;
  dataDir: string;
  registryDir: string;
  /** Sign `subject` in (identity rides in the OAuth code) and return the pm_session cookie value. */
  signIn(subject: string): Promise<string>;
  close(): void;
}

export async function oneOriginStack(): Promise<OneOrigin> {
  const { createRegistryServer } = await import('../../src/registry/server');
  const { createIngestServer } = await import('../../src/server/ingest');
  const provider: OAuthProvider = {
    id: 'fake',
    label: 'Fake',
    authorizeUrl: ({ state }) => `/auth/fake/callback?code=CODE&state=${state}`,
    exchange: async ({ code }) => ({ provider: 'fake', subject: code, name: code }),
  };
  // Sign-in needs PUBLIC_URL before listen, so the port is reserved first.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const url = `http://127.0.0.1:${port}`;

  const registryDir = mkdtempSync(join(tmpdir(), 'pm-oo-reg-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'pm-oo-data-'));
  const reg = createRegistryServer({ dir: registryDir, providers: [provider], sessionSecret: 'x'.repeat(32), publicUrl: url });
  const saved = { b: process.env.BASE_PATH, r: process.env.REGISTRY_URL, d: process.env.INGEST_DATA_DIR };
  process.env.BASE_PATH = '/app';
  process.env.REGISTRY_URL = url;
  process.env.INGEST_DATA_DIR = dataDir;
  let instance: Server;
  try {
    instance = createIngestServer({ db: ':memory:' });
  } finally {
    for (const [k, v] of [['BASE_PATH', saved.b], ['REGISTRY_URL', saved.r], ['INGEST_DATA_DIR', saved.d]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // Route exactly as the deployed Caddyfile does.
  const toInstance = (u: string) => u.startsWith('/app') || u.startsWith('/assets/') || u.startsWith('/ask/') || u === '/favicon.ico' || u === '/health';
  const proxy = createServer((rq, rs) => (toInstance(rq.url ?? '/') ? instance : reg).emit('request', rq, rs));
  await new Promise<void>((r) => proxy.listen(port, '127.0.0.1', r));

  return {
    url,
    dataDir,
    registryDir,
    async signIn(subject: string): Promise<string> {
      const st = await fetch(`${url}/auth/fake`, { redirect: 'manual' });
      const state = new URL(st.headers.get('location')!, url).searchParams.get('state')!;
      const parked = (st.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_oauth_state='))!.split(';')[0]!;
      const back = await fetch(`${url}/auth/fake/callback?code=${encodeURIComponent(subject)}&state=${state}`, { redirect: 'manual', headers: { cookie: parked } });
      const full = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pm_session='))!.split(';')[0]!;
      // Claim the required public handle (a valid slug of the subject) so the first-run username
      // gate does not block the workbench. The POST needs the whole cookie; callers want the value.
      await fetch(`${url}/account/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: full, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ username: usernameOf(subject) }),
      });
      return full.slice(full.indexOf('=') + 1);
    },
    close: () => proxy.close(),
  };
}
