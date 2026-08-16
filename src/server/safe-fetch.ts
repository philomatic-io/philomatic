/**
 * A fetcher that will not reach inside the network it runs on.
 *
 * Capture asks the SERVER to retrieve a URL a person pasted. That was unremarkable while
 * Philomatic was a loopback program serving one person: you were asking your own machine to
 * fetch something for you. Hosting changed what it means without changing a line of it — on a
 * shared instance, any signed-up stranger can now aim your server at
 *
 *     http://localhost:4400/…      the registry, from inside whatever fronts it
 *     http://10.0.0.5/…            anything else on the private network
 *     http://169.254.169.254/…     the cloud metadata service
 *
 * and read the answer back as a captured "source". Nobody added a vulnerability; an existing
 * feature started running somewhere its assumptions no longer held.
 *
 * Two things this gets right that a naive version does not:
 *
 *   - it checks the RESOLVED ADDRESS, never the hostname. A name is not a location: anyone can
 *     point `evil.example.com` at 127.0.0.1, and a blocklist of strings never sees it.
 *   - it re-checks EVERY REDIRECT. A public URL that 302s to an internal one is the same attack
 *     with one more step, so redirects are followed by hand rather than by the runtime.
 *
 * It is off in single-tenant mode by design: a self-hoster fetching from their own network is
 * doing something legitimate on their own machine, and taking that away protects nobody.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Fetcher } from './llm';

/** Why an address is refused — the message a person sees, and what the tests assert on. */
export type Refusal = 'scheme' | 'private' | 'unresolvable';

/** Private, loopback, link-local, and the rest of what must never be reachable from outside. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    // ::ffff:127.0.0.1 — an IPv4 address wearing a v6 coat, and an easy thing to forget.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped !== null) return isPrivateAddress(mapped[1]!);
    return false;
  }
  return true; // not an address at all: refuse rather than guess
}

/** Whether this URL may be fetched on a stranger's behalf, and why not when it may not. */
export async function checkTarget(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<Refusal | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'scheme';
  }
  // `file:`, `ftp:`, `gopher:` and friends have no business here; so does anything exotic that a
  // library might interpret differently from this check.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return isPrivateAddress(host) ? 'private' : undefined;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return 'unresolvable';
  }
  if (addresses.length === 0) return 'unresolvable';
  // EVERY address, not the first: a name that resolves to one public and one private address
  // would otherwise be a coin flip, and the attacker gets to flip it repeatedly.
  return addresses.some(isPrivateAddress) ? 'private' : undefined;
}

const MESSAGE: Record<Refusal, string> = {
  scheme: 'only http and https addresses can be captured',
  private: 'that address is inside this server’s own network, so it will not be fetched',
  unresolvable: 'that address could not be resolved',
};

/**
 * Wrap a fetcher so it refuses to reach inside. Redirects are followed by hand — up to `maxHops`
 * — because the whole point is to check each destination rather than trust the first.
 */
export function safeFetch(opts: { fetchImpl?: Fetcher; resolve?: (host: string) => Promise<string[]>; maxHops?: number } = {}): Fetcher {
  const impl = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? 5;
  return async (url, init) => {
    let target = url;
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const refusal = await checkTarget(target, opts.resolve);
      if (refusal !== undefined) throw new Error(MESSAGE[refusal]);
      const res = await impl(target, { ...init, redirect: 'manual' });
      if (res.status < 300 || res.status > 399) return res;
      const next = res.headers.get('location');
      if (next === null) return res;
      target = new URL(next, target).toString();
    }
    throw new Error('too many redirects');
  };
}
