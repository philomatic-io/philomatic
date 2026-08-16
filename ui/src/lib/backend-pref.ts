/**
 * Which engine this browser talks to.
 *
 * A PREFERENCE, not data — so it lives in localStorage, where losing it costs one re-choice
 * rather than a library. The library itself is in IndexedDB (lib/browser-store); the two must
 * not be confused, which is why they are separate modules with separate keys.
 *
 * The first run has no preference, so it has to guess, and the guess should be the honest one:
 * if a Philomatic server answered, the person is running one and means to use it; if nothing
 * answered, there is no server and the browser is the only engine there is. That probe happens
 * ONCE and the answer is stored, so every later boot is a straight read.
 *
 * Switching does NOT move data — the two engines have separate libraries. Every surface that
 * offers the switch has to say so (SettingsPanel does).
 */
export type Backend = 'browser' | 'server';

const KEY = 'pm.backend';
const URL_KEY = 'pm.serverUrl';
const TOKEN_KEY = 'pm.serverToken';
const HOSTED_KEY = 'pm.hostedChosen';

/**
 * The backend this page is ACTUALLY running, as opposed to the one stored as a preference.
 * The boot published a client iff it chose the in-browser engine, so the page itself is the
 * evidence — there is no second source of truth to drift from what the app is talking to.
 */
export function currentBackend(): Backend {
  return (globalThis as { __PM_CLIENT__?: unknown }).__PM_CLIENT__ !== undefined ? 'browser' : 'server';
}

/** The stored choice, or undefined on a first run. */
export function storedBackend(): Backend | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'browser' || v === 'server' ? v : undefined;
  } catch {
    return undefined; // storage blocked entirely — treat as unset and probe
  }
}

export function setBackend(b: Backend): void {
  try {
    localStorage.setItem(KEY, b);
    // Every road back to the browser engine passes through here, so leaving the hosted
    // library also forgets that it was ever chosen — the next hosted visit asks afresh.
    if (b === 'browser') localStorage.removeItem(HOSTED_KEY);
  } catch {
    /* a browser that refuses this will simply ask again next time */
  }
}

/**
 * Whether a hosted (multi-tenant) library was actually OPENED from this browser. Once true, a
 * signed-out return visit gets a sign-in prompt instead of the where-should-my-graph-live
 * question — that question was already answered, and re-asking it reads as the app forgetting.
 * Cleared by `setBackend('browser')` and by deleting the hosted library.
 */
export function hostedChosen(): boolean {
  try {
    return localStorage.getItem(HOSTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHostedChosen(): void {
  try {
    localStorage.setItem(HOSTED_KEY, '1');
  } catch {
    /* the storage choice will simply be asked again after a sign-out, which is safe */
  }
}

export function clearHostedChosen(): void {
  try {
    localStorage.removeItem(HOSTED_KEY);
  } catch {
    /* nothing to clear if nothing could ever be stored */
  }
}

/**
 * WHERE the server is. Empty means "wherever this page came from", which is right when the
 * server is serving the app — and wrong the moment it isn't: a hosted workbench pointed at a
 * machine of your own has to be told the address. Stored without a trailing
 * slash so `base + '/health'` never doubles it.
 */
/** Where this app is MOUNTED — '' at the root, '/app' on the one-origin deploy. Derived
 *  from the page's own path rather than configured: the server that served the bundle knows
 *  where it put it, and the URL is the one place that knowledge already reaches the browser. */
const mountBase = (): string => {
  try {
    return location.pathname.replace(/\/(index\.html)?$/, '');
  } catch {
    return ''; // no DOM (tests) — the root, as ever
  }
};

export function serverBase(): string {
  try {
    // No stored address = "the server that served me" — which, mounted under a prefix, is the
    // prefix, not the origin root. At `/` this is '' and nothing changes.
    return (localStorage.getItem(URL_KEY) ?? '').replace(/\/+$/, '') || mountBase();
  } catch {
    return mountBase();
  }
}

export function setServerBase(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url.trim().replace(/\/+$/, ''));
  } catch {
    /* nothing to do — the app keeps using the origin it was served from */
  }
}

/** The shared token, when the server was started with one (`INGEST_TOKEN` guards writes). */
export function serverToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setServerToken(t: string): void {
  try {
    if (t.trim() === '') localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, t.trim());
  } catch {
    /* as above */
  }
}

/**
 * Ask a Philomatic whether it is there. Returns the reason it is NOT, because the browser's own
 * error for the most likely failure is unreadable: a page served over https cannot reach a
 * plain-http machine at all (localhost excepted), and what surfaces is an opaque network error
 * rather than "the browser refused". That one deserves to be named.
 */
export async function probeServer(base: string, timeoutMs = 2500): Promise<{ ok: true } | { ok: false; why: string }> {
  const target = base.replace(/\/+$/, '');
  if (
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    /^http:\/\//i.test(target) &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/i.test(target)
  ) {
    return {
      ok: false,
      why: 'This page is served over https, and browsers refuse to let it talk to a plain http address. Give the server an https address, or open Philomatic from that machine directly.',
    };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${target}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok ? { ok: true } : { ok: false, why: `The address answered, but not like a Philomatic (HTTP ${res.status}).` };
  } catch {
    return { ok: false, why: 'Nothing answered there. Check the machine is running Philomatic, and that the address and port are right.' };
  }
}

/** Is a Philomatic server answering? One short probe, first run only. */
async function serverIsThere(): Promise<boolean> {
  return (await probeServer(serverBase(), 1500)).ok;
}

/**
 * The backend to use now. Reads the stored choice, or decides once and remembers.
 *
 * Note what this deliberately does NOT do: when the stored choice is 'server' and the server is
 * down, it still answers 'server'. Silently falling back to the browser would open an EMPTY
 * library that looks like data loss; the app's "can't reach the engine" message is the truthful
 * outcome, and the way back is settings.
 */
export async function resolveBackend(): Promise<Backend> {
  const stored = storedBackend();
  if (stored !== undefined) return stored;
  const chosen: Backend = (await serverIsThere()) ? 'server' : 'browser';
  setBackend(chosen);
  return chosen;
}
