/**
 * The Content-Security-Policy both servers send.
 *
 * Why it exists: Philomatic renders content it did not author — passage text and images captured
 * from arbitrary pages, and tracks written by other people. The per-call-site
 * guards are real (`safeImgSrc` admits only http(s) and `data:image/`; capture refuses
 * script-bearing schemes) but they are per-call-site. A CSP bounds what they miss, and the prize
 * behind a miss grew once the local library became durable and multi-gigabyte.
 *
 * Every allowance below is here because something needs it, and says which:
 *
 *   script-src 'wasm-unsafe-eval' — the in-browser engine is SQLite compiled to WebAssembly
 *       (sql.js). Without it the "this browser" backend cannot start at all. NOT 'unsafe-eval':
 *       that would also permit eval() of strings, which nothing here does.
 *   style-src 'unsafe-inline' — React writes element style attributes, and the public shells
 *       inline their design tokens so a page is styled before any bundle loads. Nonces cannot
 *       cover style ATTRIBUTES, so this is the honest state rather than a shortcut.
 *   img-src http: https: data: — the workbench shows images from pages you saved, and captured
 *       regions are stored as data: URIs. Public pages deliberately render remote images as
 *       links instead (a reader's browser never pings third parties), so this breadth is the
 *       workbench's need, not theirs.
 *   connect-src http(s) — the address field exists so a workbench can talk to a
 *       Philomatic somewhere else. Restricting this to 'self' would forbid the feature. It is
 *       the weakest line here and it is weak on purpose.
 *
 * The data island is `<script type="application/json">`, a data block rather than executable
 * script, so it needs no allowance — verified in a browser rather than assumed.
 */
import { createHash } from 'node:crypto';

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  // Nothing here embeds plugins, and nothing should be embeddable — a workbench in someone
  // else's iframe is a clickjacking surface over a library that can be edited.
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/**
 * A page that INLINES its own script (the self-contained publication export, which the registry
 * also serves) cannot use `script-src 'self'` — its script has no URL. Hashes rather than a
 * nonce, because that page is cached by content hash and a nonce would have to differ per
 * response: the hashes are computed once when the page is built and cached with it, so serving
 * costs nothing. Strictly narrower than `'unsafe-inline'`, which would permit ANY inline script
 * including one smuggled in through a bundle's text.
 */
export function cspForInlinePage(html: string): string {
  const hashes = new Set<string>();
  // Inline only — a tag with src= is covered by 'self'.
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.add(`'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`);
  }
  if (hashes.size === 0) return CSP;
  return CSP.replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' 'wasm-unsafe-eval' ${[...hashes].join(' ')}`);
}

/** Headers every HTML/asset response carries. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  // Captured URLs are private; a referrer would leak which page a learner is reading from.
  'Referrer-Policy': 'no-referrer',
};
