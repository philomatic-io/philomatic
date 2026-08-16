/**
 * Settings — where "which Philomatic am I running?" is answered.
 *
 * Three questions that had no home land together because they are one question asked three
 * ways: *where does my work live*, *how is it protected*, and *what does this app do with
 * content*. Scattered affordances could answer none of them; a page can.
 *
 * The section that matters most is the one that asks about persistence. Browsers treat local
 * storage as evictable unless an origin asks otherwise, and asking makes a record of someone's
 * reading survive the browser's own housekeeping. That is a thing to be told about, not done on
 * their behalf — so `navigator.storage.persist()` is called from HERE, on a click, and nowhere
 * else (see lib/browser-store).
 */
import { useCallback, useEffect, useState } from 'react';
import { FrameworkEditor, MapDrawSettings } from './FrameworkEditor';
import { FloppyDisk, GithubLogo, HardDrives, Lock, ShieldCheck, X } from '@phosphor-icons/react';
import { clearBytes, requestPersistence, storageState } from '../lib/browser-store';
import { clearHostedChosen, probeServer, serverBase, serverToken, setBackend, setServerBase, setServerToken, type Backend } from '../lib/backend-pref';
import { browserArchivedAt, deleteHostedLibrary, type HostedIdentity } from '../lib/hosted';

export type { Backend };

const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

export function SettingsPanel({
  backend,
  identity,
  onSignIn,
  onMoveToHosted,
  onBackup,
  onImport,
  onClose,
}: {
  backend: Backend;
  /** Who is signed in, and whether this origin even offers accounts (undefined = still loading). */
  identity?: HostedIdentity;
  /** Send the browser to sign in, returning here (for publishing from the browser). */
  onSignIn: () => void;
  /** Copy this browser library up to the hosted account and switch onto it. */
  onMoveToHosted: () => void;
  onBackup: () => void;
  onImport: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'main' | 'frameworks' | 'map'>('main');
  const [state, setState] = useState<{ usage?: number; quota?: number; persisted: boolean }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingBackend, setPendingBackend] = useState<Backend>();
  // The address IN USE — a saved one, or the page's own when nothing is saved. Shown as the
  // field's value rather than narrated beside it: an empty box that quietly
  // means "follow this page" is state the reader cannot see, and describing it in prose only
  // added a third way of saying the same thing.
  // A relative base (''/'/app' — the mount prefix on the one-origin deploy) means "this origin";
  // only an absolute http(s) base is a real, other address (/app was once shown raw).
  const inUse = serverBase().startsWith('http') ? serverBase() : location.origin;
  const [addr, setAddr] = useState(inUse);
  const [token, setToken] = useState(serverToken());
  const [check, setCheck] = useState<{ ok: boolean; msg: string }>();
  // Am I on the HOSTED Philomatic, signed in? Then the "server" is Philomatic-with-a-session, and
  // the self-hosted address/token fields do not apply — that was the "looks identical" confusion.
  const onHostedAccount = backend === 'server' && identity?.hosted === true && identity.signedIn === true;
  // Shown as a date, not a timestamp: "have I got one, and roughly when?" is the question.
  const lastBackup = ((): string | undefined => {
    try {
      const raw = localStorage.getItem('pm.lastBackup');
      return raw === null ? undefined : new Date(raw).toISOString().slice(0, 10);
    } catch {
      return undefined;
    }
  })();

  const refresh = useCallback(() => {
    void storageState().then(setState).catch(() => setState(undefined));
  }, []);
  useEffect(refresh, [refresh]);

  const keepIt = async (): Promise<void> => {
    setBusy(true);
    try {
      const granted = await requestPersistence();
      // Browsers may decide on their own signals (engagement, installed-ness) and simply say
      // no. Report what happened rather than implying the click worked.
      setNote(
        granted
          ? 'Granted — this browser will not evict your library to reclaim space.'
          : 'Your browser declined for now. It may grant this later, once you have used Philomatic more.',
      );
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const wipe = async (): Promise<void> => {
    setBusy(true);
    try {
      // The browser library lives in IndexedDB; a hosted one is a file on the server, deleted
      // through the account endpoint. Same button, the right target for where you are.
      if (onHostedAccount) {
        await deleteHostedLibrary();
        // No hosted library left = no remembered choice: the next visit asks afresh.
        clearHostedChosen();
      } else await clearBytes();
      location.reload();
    } catch (e) {
      setNote(`Could not delete it: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <div className="settings-scrim" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <span className="settings-head-actions">
            {/* Moved off the toolbar: it is an About-ish link, not a thing
                you reach for while working. */}
            <a className="settings-gh" href="https://github.com/philomatic-io/philomatic" target="_blank" rel="noreferrer">
              <GithubLogo size={14} weight="fill" /> Philomatic on GitHub
            </a>
            <button className="pinned-x" onClick={onClose} title="close">
              <X size={13} />
            </button>
          </span>
        </header>

        {/* Settings tabs: the panel had outgrown one scroll — storage and
            privacy stay on Main; the framework editor and the map draw preferences get rooms. */}
        <nav className="settings-tabs">
          {(
            [
              ['main', 'Main'],
              ['frameworks', 'Frameworks'],
              ['map', 'Map'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'settings-tab on' : 'settings-tab'} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-body">

        {tab === 'main' && (<>
        <section className="settings-section">
          <h3><HardDrives size={15} /> Where your work lives</h3>
          {/* The choice itself. Switching does not MOVE anything — the two engines keep
              separate libraries — so the warning is part of the control, not a footnote. */}
          <div className="settings-choices">
            {(
              [
                { id: 'browser' as const, title: 'This browser', blurb: 'Runs entirely on this computer. Nothing to install or run.' },
                identity?.hosted === true
                  ? { id: 'server' as const, title: 'Philomatic (hosted)', blurb: 'Your library lives on Philomatic’s servers — reach it from any device, survives clearing your browser.' }
                  : { id: 'server' as const, title: 'Your own server', blurb: 'Talks to a Philomatic you run yourself. Needed for suggestions and publishing.' },
              ]
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                className={backend === o.id ? 'settings-choice on' : 'settings-choice'}
                aria-pressed={backend === o.id}
                onClick={() => {
                  if (backend === o.id) return;
                  setPendingBackend(o.id);
                }}
              >
                <strong>{o.title}</strong>
                <span>{o.blurb}</span>
              </button>
            ))}
          </div>
          {/* The account, and the way UP. Only where the origin offers
              accounts (a hosted Philomatic). In the browser: sign in (to publish) and/or move
              this library to the account. Signed in on the server: who you are. Self-hosters
              (identity.hosted false) never see this — there is nothing to sign into. */}
          {identity?.hosted === true && (
            <div className="settings-hosted">
              {backend === 'browser' ? (
                <>
                  <p className="settings-note">
                    {identity.signedIn === true
                      ? `Signed in as ${identity.account?.name ?? identity.account?.email ?? 'your account'}. Your work is still in this browser.`
                      : 'You are working in this browser. Sign in to publish tracks, or move your library to Philomatic to reach it anywhere.'}
                  </p>
                  <div className="settings-hosted-actions">
                    {identity.signedIn !== true && (
                      <button type="button" className="link-btn" onClick={onSignIn}>Sign in</button>
                    )}
                    <button type="button" className="action" onClick={onMoveToHosted}>
                      Move this library to Philomatic →
                    </button>
                  </div>
                </>
              ) : (
                identity.signedIn === true && (
                  <p className="settings-note">
                    Signed in as {identity.account?.name ?? identity.account?.email ?? 'your account'}.
                  </p>
                )
              )}
            </div>
          )}

          {/* After moving a library to a hosted account, the browser copy stays as a dormant
              archive. Say it exists and when — a person must be able to find
              the "old" library and know it was not deleted. */}
          {browserArchivedAt() !== undefined && backend === 'server' && (
            <p className="settings-note archive-note">
              A copy of your previous browser library is kept on this computer from{' '}
              {new Date(browserArchivedAt()!).toLocaleDateString()}. Switch to <em>This browser</em> above to open it, or
              clear it below once you are sure you no longer need it.
            </p>
          )}
          {pendingBackend !== undefined && (
            <div className="settings-note">
              <p>
                Switching to <strong>{pendingBackend === 'browser' ? 'this browser' : 'your own server'}</strong> reloads
                Philomatic. <strong>Your work does not move.</strong> Each engine keeps its own separate library — what
                you have here stays here, and you would be opening the other one, empty or not.
              </p>
              <p className="settings-meta">To carry work across, use <em>Share</em> to download it and <em>Import</em> on the other side.</p>
              <div className="settings-row">
                <span />
                <span>
                  <button className="pm-btn" onClick={() => setPendingBackend(undefined)}>Cancel</button>
                  <button
                    className="pm-btn"
                    onClick={() => {
                      setBackend(pendingBackend);
                      location.reload();
                    }}
                  >
                    Switch and reload
                  </button>
                </span>
              </div>
            </div>
          )}
          {backend === 'browser' ? (
            <>
              <p className="settings-meta">
                Your library is a database stored by this browser, on this computer. Nothing is sent anywhere —
                which also means it is not on your other devices, and another browser or profile has its own
                separate library.
              </p>
              {state !== undefined && (
                <p className="settings-meta">
                  {state.usage !== undefined && state.quota !== undefined
                    ? `Using ${mb(state.usage)} of about ${mb(state.quota)} available.`
                    : 'Size unavailable in this browser.'}
                </p>
              )}
              <div className="settings-row">
                <div>
                  <strong>{state?.persisted === true ? 'Protected from cleanup' : 'Not protected from cleanup'}</strong>
                  <p className="settings-meta">
                    {state?.persisted === true
                      ? 'This browser has agreed not to delete your library when it is short of space.'
                      : 'Browsers may delete stored data when disk space runs low. Asking to keep it makes that unlikely.'}
                  </p>
                </div>
                {state?.persisted !== true && (
                  <button className="pm-btn" disabled={busy} onClick={() => void keepIt()}>
                    Keep my library
                  </button>
                )}
              </div>
              <p className="settings-meta">
                Clearing your browser&rsquo;s site data still deletes it, protected or not — a backup is the only way
                back from that.
              </p>
            </>
          ) : onHostedAccount ? (
            <p className="settings-meta">
              Your library lives on Philomatic’s servers, signed in as{' '}
              <strong>{identity?.account?.name ?? identity?.account?.email ?? 'your account'}</strong>. It is backed up
              there and reachable from any device — this browser stores nothing.
            </p>
          ) : (
            <p className="settings-meta">
              Your library is a file on the machine running Philomatic, and that machine&rsquo;s own backups are what
              protect it. This browser stores nothing.
            </p>
          )}
          {/* WHICH server — shown while USING one and while switching TO one.
              Only in the first case, someone moving a hosted workbench onto their own machine
              would have to switch, land on an unreachable engine, and only then be offered the
              address field. */}
          {(backend === 'server' || pendingBackend === 'server') && !onHostedAccount && (
            <>

              <label className="settings-field">
                <span>Server address</span>
                <input
                  className="pm-input"
                  value={addr}
                  placeholder={location.origin}
                  onChange={(e) => {
                    setAddr(e.target.value);
                    setCheck(undefined);
                  }}
                />
              </label>
              <label className="settings-field">
                <span>Access token</span>
                <input
                  className="pm-input"
                  type="password"
                  value={token}
                  placeholder="only if you started Philomatic with INGEST_TOKEN"
                  onChange={(e) => {
                    setToken(e.target.value);
                    setCheck(undefined);
                  }}
                />
              </label>
              <div className="settings-row">
                <span className={check?.ok === false ? 'settings-check bad' : 'settings-check'}>
                  {check !== undefined
                    ? check.msg
                    : addr.replace(/\/+$/, '') !== inUse
                      ? 'Not in use yet — Save and reload to switch to this address.'
                      : 'The Philomatic this browser is talking to.'}
                </span>
                <span>
                  <button
                    className="pm-btn"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void probeServer(addr)
                        .then((r) => setCheck(r.ok ? { ok: true, msg: 'Philomatic answered ✓' } : { ok: false, msg: r.why }))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Check
                  </button>
                  <button
                    className="pm-btn"
                    disabled={busy}
                    onClick={() => {
                      // Saving the page's OWN address stores nothing: "follow this page" keeps
                      // working when the same server is opened by another name — from a phone on
                      // the LAN, say, whose localhost is not this machine's. Typing any other
                      // address pins it, which is what pinning is for.
                      setServerBase(addr.replace(/\/+$/, '') === location.origin ? '' : addr);
                      setServerToken(token);
                      location.reload();
                    }}
                  >
                    Save and reload
                  </button>
                </span>
              </div>
            </>
          )}
          {note !== undefined && <p className="settings-note">{note}</p>}
        </section>

        </>)}

        {tab === 'frameworks' && <FrameworkEditor username={identity?.account?.username} />}
        {tab === 'map' && <MapDrawSettings />}

        {tab === 'main' && (<>

        <section className="settings-section">
          <h3><FloppyDisk size={15} /> Backups</h3>
          <p>
            A backup is <strong>everything</strong> — including things you removed, so restoring puts your library back
            as it was rather than as it looks. It is one JSON file; keep it wherever you keep things you would hate to
            lose.
          </p>
          <div className="settings-row">
            <div>
              <strong>{lastBackup === undefined ? 'No backup taken from this browser' : `Last backup ${lastBackup}`}</strong>
              <p className="settings-meta">
                {backend === 'browser'
                  ? 'Nothing else has a copy of this library. If this browser loses it, a backup is the only way back.'
                  : 'Your server’s own backups cover the file; this is a portable copy you can carry elsewhere.'}
              </p>
            </div>
            <span>
              <button className="pm-btn" onClick={onImport}>Restore…</button>
              <button className="pm-btn" onClick={onBackup}>Back up now</button>
            </span>
          </div>
          <p className="settings-meta">
            <em>Restore</em> merges a file into this library rather than replacing it — importing a backup into an empty
            Philomatic rebuilds it; importing into a full one adds what is missing. <em>Share</em> in the toolbar is a
            different file: your live library without removed items, for giving to someone else.
          </p>
        </section>

        <section className="settings-section">
          <h3><Lock size={15} /> Protection</h3>
          <p>
            Your library is stored <strong>unencrypted</strong>. Anything running on this page can read it, and so can
            anyone with access to this computer&rsquo;s files. That matters here because a learning library is a record
            of what you read and what you did not understand.
          </p>
          <p className="settings-meta">
            An optional passphrase that encrypts it at rest is planned. It is not built yet, and this page will say so
            until it is rather than implying protection you do not have.
          </p>
        </section>

        <section className="settings-section">
          <h3><ShieldCheck size={15} /> Content this app did not write</h3>
          <p>
            Philomatic renders things captured from elsewhere: passage text and images from pages you saved, and — when
            you import one — a track written by someone else.
          </p>
          <ul className="settings-list">
            <li>Images render only from ordinary web addresses or self-contained image data. Anything else is shown as
              plain text rather than loaded.</li>
            <li>Saved links that carry scripts instead of a web address are refused when captured.</li>
            <li>Published pages turn remote images into links, so reading a shared track never quietly contacts the
              sites it mentions.</li>
          </ul>
        </section>

        {(backend === 'browser' || onHostedAccount) && (
          <section className="settings-section danger">
            <h3>Delete this library</h3>
            <p className="settings-meta">
              {onHostedAccount
                ? 'Removes your whole library from Philomatic’s servers. There is no undo, and no copy anywhere else unless you made one.'
                : 'Removes the whole library from this browser. There is no undo, and no copy anywhere else unless you made one.'}
            </p>
            {confirmClear ? (
              <div className="settings-row">
                <strong>{onHostedAccount ? 'Delete your whole hosted library?' : 'Delete everything in this browser?'}</strong>
                <span>
                  <button className="pm-btn" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</button>
                  <button className="pm-btn danger" disabled={busy} onClick={() => void wipe()}>Delete it</button>
                </span>
              </div>
            ) : (
              <button className="pm-btn danger" onClick={() => setConfirmClear(true)}>Delete this library…</button>
            )}
          </section>
        )}
        </>)}
        </div>
      </div>
    </div>
  );
}
