/**
 * The pages a person needs to hold an account.
 *
 * Everything underneath already worked: sign in, mint, list, revoke. What was missing was any way
 * to reach it — a beta user had to type `/auth/google` into the address bar and paste a `fetch()`
 * into the browser console to get a token. That is the gate on handing the registry to anyone.
 *
 * Server-rendered forms, deliberately. The registry is a plain server that stores bundles and
 * answers questions about them; pulling the workbench's React app in to render three forms would
 * make it something else, and the thing it is now is easy to reason about.
 */
import { escHtml as esc, publicShellHtml } from '../server/public-shell';
import type { Account } from './accounts';
import type { TokenSummary } from './tokens';

/**
 * Google's own mark, inline. Their branding guidelines ask for the four-colour G beside the
 * words, and a provider button that looks like every other provider button is the one thing a
 * person recognises without reading it.
 */
const GOOGLE_G = `<svg class="reg-provider-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

/** One provider button — the shape a person has clicked a hundred times elsewhere. `next` is the
 *  return path, carried through the whole round trip so a workbench sign-in lands back on itself. */
function providerButton(p: { id: string; label: string }, next: string): string {
  const q = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;
  return `<a class="reg-provider" href="/auth/${esc(p.id)}${q}">${p.id === 'google' ? GOOGLE_G : ''}<span>Continue with ${esc(p.label)}</span></a>`;
}

/**
 * The sign-in / sign-up page.
 *
 * The two are the SAME act here and the page says so quietly rather than pretending otherwise:
 * with OAuth there is no separate registration — the first time you continue with Google, an
 * account appears. Two doors, because people look for the one they expect, and both lead to the
 * same place.
 */
export function authPageHtml(opts: { mode: 'signin' | 'signup'; providers: { id: string; label: string }[]; next?: string }): string {
  const signup = opts.mode === 'signup';
  const next = opts.next ?? '/';
  const withNext = (href: string): string => (next === '/' ? href : `${href}?next=${encodeURIComponent(next)}`);
  return publicShellHtml({
    title: signup ? 'Create a Philomatic account' : 'Sign in to Philomatic',
    essentials: `<div class="reg-authpage">
<h1>${signup ? 'Create a Philomatic account' : 'Sign in to Philomatic'}</h1>
${
  opts.providers.length === 0
    ? '<p class="reg-empty">This registry offers no sign-in.</p>'
    : opts.providers.map((pr) => providerButton(pr, next)).join('\n')
}
<p class="reg-alt">${
      signup
        ? `Already have an account? <a href="${esc(withNext('/signin'))}">Sign in</a>`
        : `New here? <a href="${esc(withNext('/signup'))}">Create an account</a>`
    }</p>
<p class="reg-hint">An account is how a published track keeps its owner when a laptop is lost — and how a library hosted here knows it is yours.</p>
<p class="reg-hint"><a href="${esc(next)}">← ${next.startsWith('/app') ? 'Back to your workbench' : next === '/' ? 'Back to the registry' : 'Back'}</a></p>
</div>`,
  });
}

/** The sign-in control for a page header — a button, or who you are and the way out. */
export function signInControl(account: Account | undefined, providers: { id: string; label: string }[]): string {
  if (providers.length === 0) return ''; // this deployment offers no sign-in at all
  // The REACT AccountControl mounts over #acct-root (ui/src/public/main.tsx) so the dropdown is
  // the SAME control as the workbench and track pages — <details> only served as the no-JS
  // fallback, and its toggle proved browser-dependent (unclickable in
  // Firefox). The island carries what the control needs; never the provider subject.
  const island = `<script id="acct-data" type="application/json">${JSON.stringify({
    signedIn: account !== undefined,
    ...(account !== undefined
      ? { account: { id: account.id, ...(account.name !== undefined ? { name: account.name } : {}), ...(account.email !== undefined ? { email: account.email } : {}), ...(account.username !== undefined ? { username: account.username } : {}) } }
      : {}),
    providers,
  }).replace(/</g, '\\u003c')}</script>`;
  if (account === undefined) {
    // One button, one word. Which provider is a question for the page it leads to, not for a
    // header — and it stops the header changing shape as providers are added.
    return `<span id="acct-root"><div class="reg-auth"><a class="reg-signin" href="/signin">Sign in</a></div></span>${island}`;
  }
  // The public HANDLE leads; the real name/email sit below
  // it inside the person's own menu, never in the open. The dropdown is a native <details>, so
  // the same avatar-and-menu shape as the workbench needs no script on a server-rendered page.
  const handle = account.username ?? account.name ?? account.email ?? 'your account';
  const initial = [...handle.trim()][0]?.toUpperCase() ?? '?';
  const sub = account.username !== undefined ? (account.name ?? account.email) : account.email;
  return `<span id="acct-root"><div class="reg-auth"><details class="reg-acct">
  <summary class="reg-avatar" title="${esc(handle)}" aria-label="${esc(handle)} — your account">${esc(initial)}</summary>
  <div class="acct-menu" role="menu">
    <div class="acct-menu-who">${esc(handle)}</div>
    ${sub !== undefined ? `<div class="acct-menu-sub">${esc(sub)}</div>` : ''}
    <a class="acct-menu-item" href="/account" role="menuitem">Account settings</a>
    <form method="post" action="/auth/signout"><button class="acct-menu-item danger" type="submit" role="menuitem">Sign out</button></form>
  </div>
</details></div></span>${island}`;
}

/**
 * The account page: who you are, and the tokens that act for you.
 *
 * `justMinted` is rendered by the POST that created it, never fetched again and never carried in
 * a redirect — a secret in a URL lands in browser history, in logs, and in whatever proxy sits
 * between. This is the only moment it exists outside the holder's hands.
 */
export function accountPageHtml(opts: {
  account: Account;
  tokens: TokenSummary[];
  justMinted?: { secret: string; label: string };
  /** The tracks this account owns — the "your repositories" list. */
  tracks?: { trackId: string; title: string; updatedAt?: number }[];
  /** Tracks this account CONTRIBUTES to (joined by invite) — the membership list. */
  memberOf?: { trackId: string; title: string; updatedAt?: number }[];
}): string {
  const { account, tokens, justMinted, tracks = [], memberOf = [] } = opts;
  const when = (iso: string): string => esc(iso.slice(0, 10));

  const minted =
    justMinted === undefined
      ? ''
      : `<div class="reg-minted">
  <h2>Your new token — copy it now</h2>
  <p>This is the only time it is shown. It is stored as a hash, so nobody can recover it for you: if you lose it, revoke it and make another.</p>
  <code class="reg-secret">${esc(justMinted.secret)}</code>
  <p class="reg-hint">Paste it into your workbench under <strong>Settings → Access token</strong>, with this registry's address as the server.</p>
</div>`;

  const rows = tokens
    .map((t) => {
      const dead = t.revokedAt !== undefined;
      return `<li class="${dead ? 'revoked' : ''}">
  <span class="reg-token-label">${esc(t.label)}</span>
  <span class="reg-token-meta">created ${when(t.createdAt)}${
    t.lastUsedAt !== undefined ? ` · last used ${when(t.lastUsedAt)}` : ' · never used'
  }${dead ? ` · revoked ${when(t.revokedAt!)}` : ''}</span>
  ${
    dead
      ? ''
      : `<form method="post" action="/account/tokens/${esc(t.id)}/revoke"><button class="reg-revoke" type="submit">Revoke</button></form>`
  }
</li>`;
    })
    .join('\n');

  return publicShellHtml({
    title: 'Your Philomatic account',
    essentials: `<div class="reg-page reg-account">
<h1>Your account <span>${esc(account.username ?? account.email ?? account.name ?? account.id)}</span></h1>
<p class="reg-hint"><a href="/">← Back to the registry</a></p>
${minted}
<h2>Username</h2>
<p class="reg-hint">Your PUBLIC handle — the only name other people see, on tracks you contribute to and anything you publish. Your real name (${esc(account.name ?? account.email ?? 'from your provider')}) stays private to this page.</p>
<form class="reg-username reg-mint" method="post" action="/account/username">
  <input name="username" value="${esc(account.username ?? '')}" placeholder="letters, digits, single hyphens" minlength="3" maxlength="32" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" title="3–32 characters: letters and digits joined by single hyphens" required />
  <button type="submit">Save username</button>
</form>
<h2>Your tracks</h2>
<p class="reg-hint">Published here and owned by this account. Ownership is the ACCOUNT, not the machine
  you published from — so you can update or withdraw one of these from anywhere you can sign in, even
  if the laptop that first published it is gone.</p>
${
      tracks.length === 0
        ? '<p class="reg-empty">Nothing published yet. Publish a track from your workbench and it appears here.</p>'
        : `<ul class="reg-tracks-owned">\n${tracks
            .map(
              (t) => `<li>
  <a href="/t/${esc(t.trackId)}">${esc(t.title)}</a>
  ${t.updatedAt !== undefined ? `<span class="reg-token-meta">updated ${esc(new Date(t.updatedAt).toISOString().slice(0, 10))}</span>` : ''}
  <form method="post" action="/account/tracks/${esc(t.trackId)}/unpublish"><button class="reg-revoke" type="submit">Withdraw</button></form>
</li>`,
            )
            .join('\n')}\n</ul>`
    }

${
      memberOf.length === 0
        ? ''
        : `<h2>Tracks you contribute to</h2>
<p class="reg-hint">Joined by invite. You can ask questions and recommend sources on these — what you send goes to the owner's inbox under your name.</p>
<ul class="reg-tracks-owned">
${memberOf
  .map(
    (t) => `<li>
  <a href="/t/${esc(t.trackId)}">${esc(t.title)}</a>
  ${t.updatedAt !== undefined ? `<span class="reg-token-meta">updated ${esc(new Date(t.updatedAt).toISOString().slice(0, 10))}</span>` : ''}
</li>`,
  )
  .join('\n')}
</ul>`
    }

<h2>Access tokens</h2>
<p class="reg-hint">The workbench in your browser needs no token — signing in is enough. Tokens are for programs: the <strong>command line</strong>, the <strong>capture extension</strong>, and a self-hosted server that publishes on your behalf (its <code>REGISTRY_TOKEN</code>). Not a password — give one per tool, and revoke it alone if a device is lost.</p>
<p class="reg-hint">Revoking is immediate here. A server hosting your library may keep accepting the token for up to a minute, because it remembers this answer rather than asking on every request.</p>
<form class="reg-mint" method="post" action="/account/tokens">
  <input name="label" placeholder="what is it for? e.g. my laptop" maxlength="60" />
  <button type="submit">Create a token</button>
</form>
${tokens.length === 0 ? '<p class="reg-empty">No tokens yet.</p>' : `<ul class="reg-tokens">\n${rows}\n</ul>`}
<h2>Signed-in devices</h2>
<p class="reg-hint">Lost a laptop? This ends every session you have, on every device, including this one. Your access tokens are separate — revoke those above.</p>
<form method="post" action="/account/signout-all"><button class="reg-signout" type="submit">Sign out everywhere</button></form>
</div>`,
    // No island: this page is plain forms, and the registry app would render itself over it.
  });
}

/** `label=my+laptop` → `my laptop`. Forms post urlencoded, not JSON. */
export function formField(body: string, name: string): string {
  const found = new URLSearchParams(body).get(name);
  return found === null ? '' : found;
}
