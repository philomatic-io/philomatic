/**
 * Reading a session cookie off a request — the ONE place its name is written.
 *
 * It lives under `src/server` rather than `src/registry` because of the lock line: the registry
 * may import from the host, and the host may not import from the registry. Both need this — the
 * registry to MINT and verify sessions, the host to recognise one and ask who it belongs to — so
 * the shared half is the half with no secrets in it.
 *
 * The host deliberately cannot verify a session by itself. It has no `SESSION_SECRET` and does
 * not want one: it asks the registry "whose cookie is this?" exactly as it asks "whose token is
 * this?", which answers signature and REVOCATION in one question and keeps the signing key in
 * one process. See `sessionVerifier` in tenancy.ts.
 */

/** One cookie out of a Cookie header, undecoded name match, decoded value. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // a malformed %-escape is not a session
    }
  }
  return undefined;
}

/**
 * `__Host-` is a browser-enforced contract: the cookie must be Secure, path `/`, and carry no
 * `Domain`, which means a hostile SUBDOMAIN cannot set a session for the parent origin. Browsers
 * reject a `__Host-` cookie without Secure, so plain http (loopback, tests) uses the plain name.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-pm_session' : 'pm_session';
}

/** Either name — a server does not know from the request whether it is behind TLS. */
export function readSessionCookie(header: string | undefined): string | undefined {
  return readCookie(header, '__Host-pm_session') ?? readCookie(header, 'pm_session');
}
