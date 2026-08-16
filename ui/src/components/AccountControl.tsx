/**
 * The account control — ONE affordance for every screen ("add the account
 * dropdown to all screens"). Signed out on an origin that offers accounts: a Sign in button
 * that opens a MODAL (like the settings pane) rather than navigating away — it closes itself
 * once you are signed in. Signed in: the avatar with the same dropdown the workbench had —
 * name, email, handle, Account settings, Sign out.
 *
 * Plus the first-run gate: a REQUIRED "pick a username" modal when signed in with no public
 * handle yet, because a person's real name should never be what other people see (a
 * privacy decision) — the handle is the only name that leaves.
 */
import { useDismiss } from '../lib/use-dismiss';
import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_URL, signOut, type HostedIdentity } from '../lib/hosted';

const returnHere = (): string => window.location.pathname + window.location.search;

/** Google's G — the same mark the /signin page shows; recognition is the point of it. */
const GOOGLE_G = (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

/** The sign-in modal — the /signin PAGE's look, in a pane: centered title,
 *  the provider button with its mark, the create-account line, the one-sentence why. Exported
 * so EVERY sign-in door opens this same pane — the storage choice's
 *  "Host it on Philomatic" included, instead of bouncing through the full-page redirect. */
export function SignInModal({ identity, onClose }: { identity: HostedIdentity; onClose: () => void }) {
  const next = encodeURIComponent(returnHere());
  return (
    <div className="pm-modal-scrim" onClick={onClose}>
      <div className="pm-modal pm-signin" onClick={(e) => e.stopPropagation()}>
        <h2>Sign in to Philomatic</h2>
        {identity.providers.map((p) => (
          <a key={p.id} className="pm-provider" href={`/auth/${encodeURIComponent(p.id)}?next=${next}`}>
            {p.id === 'google' && GOOGLE_G}
            <span>Continue with {p.label}</span>
          </a>
        ))}
        <p className="pm-signin-alt">
          New here? <a href={`/signup?next=${next}`}>Create an account</a>
        </p>
        <p className="settings-meta pm-signin-hint">
          An account is how a published track keeps its owner when a laptop is lost — and how a library hosted here
          knows it is yours.
        </p>
        <button type="button" className="pm-modal-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

export function AccountControl({ identity }: { identity: HostedIdentity }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useDismiss(boxRef, menuOpen, () => setMenuOpen(false));

  // Show wherever the origin OFFERS accounts: providers to sign in with, or a session already
  // held. The registry's /auth/me carries no `hosted` flag — gating on it hid the control (and
  // sign-out with it) from every registry-served page. A
  // self-hosted single-tenant instance answers providers:[] signed-out, and stays clean.
  if (identity.signedIn !== true && identity.providers.length === 0) return null;

  if (identity.signedIn !== true) {
    return (
      <>
        <button type="button" className="topbar-signin" onClick={() => setSignInOpen(true)}>Sign in</button>
        {signInOpen && <SignInModal identity={identity} onClose={() => setSignInOpen(false)} />}
      </>
    );
  }

  const who = identity.account?.username ?? identity.account?.name ?? identity.account?.email ?? 'your account';
  const initial = [...who.trim()][0]?.toUpperCase() ?? '?';
  return (
    <div className="topbar-acct" ref={boxRef}>
      <button type="button" className="topbar-account" title={who} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
        {initial}
      </button>
      {menuOpen && (
        <div className="acct-menu" role="menu">
          <div className="acct-menu-who">{identity.account?.username ?? who}</div>
          {(identity.account?.name ?? identity.account?.email) !== undefined && (
            <div className="acct-menu-sub">{identity.account?.name ?? identity.account?.email}</div>
          )}
          <a className="acct-menu-item" href={ACCOUNT_URL} role="menuitem">Account settings</a>
          <button className="acct-menu-item danger" role="menuitem" onClick={() => void signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}
