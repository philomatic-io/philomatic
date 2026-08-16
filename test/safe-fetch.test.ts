/**
 * The fetcher that will not reach inside.
 *
 * Capture asks the server to retrieve a URL a stranger pasted. Harmless on a loopback
 * single-user program; on a hosted instance it is a probe pointed at the inside of the network.
 * Nobody added a vulnerability — an existing feature started running somewhere its assumptions
 * no longer held, which is the shape of failure this whole hardening pass is looking for.
 */
import { describe, expect, it } from 'vitest';
import { checkTarget, isPrivateAddress, safeFetch } from '../src/server/safe-fetch';

const resolves = (map: Record<string, string[]>) => async (h: string) => map[h] ?? Promise.reject(new Error('NXDOMAIN'));

describe('what counts as inside', () => {
  it('knows the ranges that must never be reachable from outside', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('sees through an IPv4 address wearing a v6 coat', () => {
    // ::ffff:127.0.0.1 is loopback, and an easy thing to forget.
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('refuses anything that is not an address rather than guessing', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('checking a target', () => {
  const dns = resolves({ 'example.com': ['93.184.216.34'], 'evil.test': ['127.0.0.1'], 'split.test': ['93.184.216.34', '10.0.0.1'] });

  it('allows an ordinary public address', async () => {
    expect(await checkTarget('https://example.com/a', dns)).toBeUndefined();
  });

  it('refuses a NAME that points inside — the check is the address, not the string', async () => {
    // A blocklist of hostnames never sees this: anyone can point a domain they own at 127.0.0.1.
    expect(await checkTarget('http://evil.test/', dns)).toBe('private');
  });

  it('refuses a name that resolves to public AND private', async () => {
    // Otherwise it is a coin flip, and the attacker gets to flip it as often as they like.
    expect(await checkTarget('http://split.test/', dns)).toBe('private');
  });

  it('refuses literal addresses inside, and schemes that are not the web', async () => {
    expect(await checkTarget('http://169.254.169.254/latest/meta-data/', dns)).toBe('private');
    expect(await checkTarget('http://[::1]:4400/', dns)).toBe('private');
    expect(await checkTarget('file:///etc/passwd', dns)).toBe('scheme');
    expect(await checkTarget('gopher://example.com/', dns)).toBe('scheme');
    expect(await checkTarget('not a url', dns)).toBe('scheme');
  });

  it('refuses a name that does not resolve at all', async () => {
    expect(await checkTarget('http://nowhere.test/', dns)).toBe('unresolvable');
  });
});

describe('following redirects by hand', () => {
  const dns = resolves({ 'public.test': ['93.184.216.34'], 'inside.test': ['10.1.2.3'] });
  const responder = (map: Record<string, { status: number; location?: string }>) =>
    (async (url: string) => {
      const r = map[url] ?? { status: 200 };
      return new Response('body', { status: r.status, headers: r.location !== undefined ? { location: r.location } : {} });
    }) as never;

  it('follows a redirect and returns the destination', async () => {
    const f = safeFetch({ fetchImpl: responder({ 'http://public.test/a': { status: 302, location: 'http://public.test/b' } }), resolve: dns });
    expect((await f('http://public.test/a')).status).toBe(200);
  });

  it('refuses a PUBLIC url that redirects inside', async () => {
    // The same attack with one more step, and the reason redirects are followed by hand rather
    // than by the runtime — `redirect: follow` would fetch the destination unchecked.
    const f = safeFetch({ fetchImpl: responder({ 'http://public.test/a': { status: 302, location: 'http://inside.test/secret' } }), resolve: dns });
    await expect(f('http://public.test/a')).rejects.toThrow(/inside this server/);
  });

  it('gives up rather than looping forever', async () => {
    const f = safeFetch({ fetchImpl: responder({ 'http://public.test/a': { status: 302, location: 'http://public.test/a' } }), resolve: dns, maxHops: 2 });
    await expect(f('http://public.test/a')).rejects.toThrow(/too many redirects/);
  });

  it('refuses before making any request at all', async () => {
    let called = 0;
    const f = safeFetch({ fetchImpl: (async () => { called += 1; return new Response(''); }) as never, resolve: dns });
    await expect(f('http://inside.test/')).rejects.toThrow();
    // The point of checking first: a refused target is never contacted, so it cannot be probed
    // for timing or for a connection-refused that distinguishes a live host from a dead one.
    expect(called).toBe(0);
  });
});
