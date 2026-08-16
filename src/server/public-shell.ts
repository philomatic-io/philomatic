/**
 * The public-page shell (public-polish) — ONE implementation of how a
 * server-rendered public page works, shared by the ingest server (the ask page) and the
 * registry (the library page). One visual system, one shape: the shell owns
 * the head (title, OG meta, inline tokens so the page is styled standalone), the essential
 * content as static HTML inside #root (crawlers and noscript readers see it), and the data
 * island the public bundle (assets/public.{js,css}) mounts real components over. Two servers,
 * one skeleton — the skeleton can't drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The design tokens — the ONE styling rule, inlined into every public shell. */
export const TOKENS_CSS = readFileSync(fileURLToPath(new URL('../../ui/src/tokens.css', import.meta.url)), 'utf8');

/**
 * The mark, inline.
 *
 * Phosphor's `Path` at regular weight — the SAME icon the ask page and the publication page draw
 * from the icon package. A server-rendered page cannot import a React component, so the one place
 * the shape is duplicated is here; keeping it beside the shell means both public servers get the
 * brand from one string rather than each pasting their own.
 */
export const BRAND_MARK = `<svg class="pm-brand-mark" viewBox="0 0 256 256" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M200,168a32.06,32.06,0,0,0-31,24H72a32,32,0,0,1,0-64h96a40,40,0,0,0,0-80H72a8,8,0,0,0,0,16h96a24,24,0,0,1,0,48H72a48,48,0,0,0,0,96h97a32,32,0,1,0,31-40Zm0,48a16,16,0,1,1,16-16A16,16,0,0,1,200,216Z"/></svg>`;

/** The name of the thing serving this page, for a header bar. */
export const brandLabel = (): string => `<span class="reg-brand">${BRAND_MARK} Philomatic</span>`;

export const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function publicShellHtml(opts: {
  /** Page title — escaped here. */
  title: string;
  /** Extra head markup (OG meta etc.) — already escaped by the caller. */
  headExtra?: string;
  /** The static essentials rendered inside #root — already escaped markup. */
  essentials: string;
  /**
   * Markup rendered BEFORE #root, and therefore outside it.
   *
   * Anything inside #root is replaced the moment the island hydrates — the server's version
   * flashes and vanishes, which is exactly what the sign-in control once did. A control
   * the app does not know about has to live outside the app's root.
   */
  aboveRoot?: string;
  /**
   * Which island this shell carries. OMIT IT for a page the app should leave alone: with no
   * island script, `ui/src/public/main.tsx` mounts nothing and the server's HTML stands. That is
   * what a plain forms page wants — otherwise the registry app renders itself over it.
   */
  islandId?: 'ask-data' | 'registry-data';
  /** Serialized verbatim into the island; `<` is escaped so payload text can never close it. */
  islandData?: unknown;
}): string {
  const island = JSON.stringify(opts.islandData ?? null).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(opts.title)}</title>
${opts.headExtra ?? ''}<style>
${TOKENS_CSS}
  /* Shell fallback only — real styling arrives with public.css. */
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 'Inter', system-ui, sans-serif; }
  .ask-page { margin: 0 auto; max-width: 680px; padding: 2rem 1rem 4rem; }
  .reg-page { margin: 0 auto; max-width: 760px; padding: 2rem 1rem; }
  /* Account and sign-in — plain forms, no app. */
  /* Brand left, who-you-are right — the ask page's bar, on the registry.
     A bar across the WHOLE window, not the centred column: it is chrome, and its rule has to run
     edge to edge like the other two or it reads as a box drawn around the header. Same padding
     and same --topbar-h as the ask page, so the three rules land on one line. */
  .reg-authbar { display: flex; align-items: center; gap: 1rem; box-sizing: border-box; min-height: var(--topbar-h); padding: .6rem 1.2rem; border-bottom: 1px solid var(--divider); }
  .reg-brand { display: flex; align-items: center; gap: 9px; font-weight: 500; font-size: 17px; }
  .reg-brand svg { flex: none; color: var(--accent); }
  .reg-auth { display: flex; align-items: center; gap: .75rem; justify-content: flex-end; margin-bottom: 1rem; }
  /* Inside the bar the row IS the layout, so the control stops carrying its own spacing. */
  .reg-authbar .reg-auth { margin-left: auto; margin-bottom: 0; }
  /* The React AccountControl replaces #acct-root's children on mount — the corner position must
     live on the SLOT, which survives the swap. */
  .reg-authbar #acct-root { margin-left: auto; display: inline-flex; align-items: center; }
  .reg-authbar #acct-root .reg-auth { margin-left: 0; }
  .reg-auth form { margin: 0; }
  /* Rounded square, not a pill: the shape a button has everywhere else. */
  /* THE sign-in control: this bordered rectangle is the canonical one —
     the workbench topbar (.topbar-signin in ui/src/styles.css) copies IT, not the other way. */
  .reg-signin { display: inline-block; border: 1px solid var(--line-strong, currentColor); border-radius: 6px; padding: .35rem .9rem; font-weight: 600; text-decoration: none; color: var(--text, inherit); opacity: .85; }
  .reg-signin:hover { opacity: 1; }
  /* The sign-in / sign-up page: one column, centred, the provider button doing the work. */
  .reg-authpage { margin: 0 auto; max-width: 22rem; padding: 4rem 1rem; text-align: center; }
  .reg-welcome { display: flex; flex-direction: column; gap: .8rem; margin: 1rem 0; }
  .reg-welcome input { font: inherit; text-align: center; font-size: 1rem; padding: .6rem; background: var(--surface); color: var(--text); border: 1px solid var(--line-strong, currentColor); border-radius: var(--radius-md); }
  .reg-welcome input:focus { outline: none; border-color: var(--accent); }
  .reg-welcome .reg-provider { justify-content: center; cursor: pointer; }
  .reg-authpage h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
  /* Also rendered as a <button> (the join page) — kill the UA's white fill and default font, or
     the control renders as an unreadable light slab on the dark page. */
  .reg-provider { display: flex; align-items: center; justify-content: center; gap: .6rem; width: 100%; box-sizing: border-box; border: 1px solid rgba(128,128,128,.45); border-radius: 6px; padding: .7rem 1rem; margin-bottom: .6rem; font: inherit; font-weight: 600; text-decoration: none; color: inherit; background: none; cursor: pointer; }
  .reg-provider:hover { border-color: currentColor; }
  .reg-provider-mark { flex: none; }
  .reg-alt { margin-top: 1.5rem; }
  /* Sign out matches Sign in: the same rounded square, since they are the same kind of thing. */
  .reg-signout { background: none; border: 1px solid currentColor; border-radius: 6px; color: inherit; font: inherit; font-weight: 600; opacity: .85; padding: .35rem .9rem; cursor: pointer; }
  .reg-revoke { background: none; border: 1px solid currentColor; border-radius: 6px; color: inherit; font: inherit; font-size: .8rem; opacity: .7; padding: .1rem .6rem; cursor: pointer; }
  .reg-signout:hover, .reg-revoke:hover { opacity: 1; }
  /* An initial in a circle, not a name: it is the same width for everybody, so the header does
     not reflow around how long someone is called. */
  .reg-avatar { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border-radius: 50%; border: 1px solid currentColor; font-weight: 600; text-decoration: none; color: inherit; opacity: .85; }
  .reg-avatar:hover { opacity: 1; }
  /* An input and a button with no colour rules do not render "unstyled": they render the
     BROWSER's chrome — a white field and a light grey box — and the button's label inherits this
     theme's near-white text onto it and disappears. Second time this exact failure has shipped
     (the workbench); it looks like a missing feature rather than missing CSS. */
  .reg-mint { display: flex; gap: .5rem; margin: .75rem 0 1.25rem; }
  .reg-mint input { flex: 1; font: inherit; padding: .45rem .6rem; color: inherit; background: rgba(128,128,128,.12); border: 1px solid rgba(128,128,128,.45); border-radius: 6px; }
  .reg-mint input::placeholder { color: inherit; opacity: .5; }
  .reg-mint input:focus { outline: none; border-color: currentColor; }
  .reg-mint button { font: inherit; font-weight: 600; color: inherit; background: rgba(128,128,128,.12); border: 1px solid rgba(128,128,128,.45); border-radius: 6px; padding: .45rem 1rem; cursor: pointer; }
  .reg-mint button:hover { border-color: currentColor; }
  .reg-tokens { list-style: none; padding: 0; }
  .reg-tokens li { display: flex; align-items: baseline; gap: .6rem; padding: .5rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  .reg-tokens li.revoked { opacity: .45; }
  .reg-token-label { font-weight: 600; }
  .reg-token-meta { font-size: .8rem; opacity: .7; flex: 1; }
  /* The secret, shown once: big enough to select in one gesture, and unmistakably a thing to copy. */
  .reg-minted { border: 1px solid currentColor; border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
  .reg-secret { display: block; word-break: break-all; padding: .6rem; margin: .5rem 0; font-size: .95rem; background: rgba(128,128,128,.15); border-radius: 6px; }
  .reg-hint { font-size: .85rem; opacity: .75; }
</style>
<link rel="stylesheet" href="/assets/public.css">
<script type="module" src="/assets/public.js"></script>
</head><body>
${opts.aboveRoot ?? ''}
<div id="root">${opts.essentials}</div>
${opts.islandId === undefined ? '' : `<script id="${opts.islandId}" type="application/json">${island}</script>`}
</body></html>`;
}
