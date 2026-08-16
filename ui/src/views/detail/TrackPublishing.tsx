import { useAction, useEngine } from '../../engine-context';
import { GitBranch } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { currentBackend, serverBase } from '../../lib/backend-pref';
import { unavailable } from '../../lib/capabilities';
import { hostedIdentity, signInHere, type HostedIdentity } from '../../lib/hosted';
import { setCommunity } from '../../lib/community';
import { proposeUpstream } from '../../lib/propose-upstream';
import { TrackCommunity } from './TrackCommunity';

/** Publishing controls (the LAST block of the pane, just above
 *  View-in-map/Remove). Publish/unpublish, the public link, and the registry push. */
export function TrackPublishing({
  track,
}: {
  track: {
    id: string;
    title: string;
    published?: { at: number; license: string };
    /** Fork lineage: where this track came from, and the base version last seen. */
    origin?: { trackId: string; contentHash: string; url?: string };
  };
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  // Publishing. The act stays
  // explicit and informed: the confirm panel names the license and states
  // what is and is not included before anything happens.
  const [publishOpen, setPublishOpen] = useState(false);
  const [license, setLicense] = useState('CC-BY-SA-4.0');
  // Visibility is part of the publishing DECISION, not a setting discovered
  // later: listed (the default, the commons) or unlisted (reachable by link and members only).
  const [unlisted, setUnlisted] = useState(false);
  /** Local copy vs the registry's: 'absent' (never pushed), 'behind' (edited since), 'current'. */
  const [syncState, setSyncState] = useState<'absent' | 'behind' | 'current' | undefined>();
  /** The PUBLISHED identity — differs from track.id when published AS your own version.
   *  Every registry-side lookup (meta, community, the public link) keys on THIS. */
  const [pubId, setPubId] = useState<string | undefined>();
  /** The registry refused the name (it belongs to someone else) — offer publishing YOUR version. */
  const [collision, setCollision] = useState(false);
  const [ownTitle, setOwnTitle] = useState('');
  /** Upstream, for a FORK: has the track this came from moved past our base? */
  const [upstream, setUpstream] = useState<'current' | 'updates' | undefined>();
  const [pulling, setPulling] = useState(false);
  // Publishing is OUTWARD-FACING: copies made while public persist, so it is not undoable by
  // a stack pop — unpublish is the explicit, separate act.
  const doPublish = async () => {
    await act(
      async () => {
        await client.publish(track.id, license.trim());
        // Publish is ONE act ("hit publish once, no update; hit publish
        // again, it's there" — the mint and the push had split into two presses in browser mode).
        // Where this origin's registry is the destination, the same click pushes the copy there:
        // the browser holds the session either way — a hosted instance deferred to it,
        // and the in-browser engine pushes same-origin itself.
        if (registryHere === window.location.origin) {
          await client.pushToRegistry(track.id, registryHere);
          // The visibility chosen at publish time reaches the entry the moment it exists.
          if (unlisted) await setCommunity(track.id, { unlisted: true });
          setEpochNudge((n) => n + 1);
        }
        setPublishOpen(false);
      },
      'Published ✓ — the public page is live',
      { irreversible: true },
    );
  };
  // Push to a registry: the server does the outbound POST; the
  // registry URL is a workbench setting, remembered once entered.
  const [registry, setRegistry] = useState(() => localStorage.getItem('pm.registry') ?? '');
  const [pushing, setPushing] = useState(false);
  const [epochNudge, setEpochNudge] = useState(0);
  const doPush = async (target?: string) => {
    const url = (target ?? registry).trim().replace(/\/$/, '');
    if (!url) return;
    localStorage.setItem('pm.registry', url);
    const applyUnlisted = unlisted && url === window.location.origin;
    setPushing(true);
    try {
      // Outward-facing: the bundle is on someone else's server now. `unpush` is the act.
      await act(
        async () => {
          try {
            const r = await client.pushToRegistry(track.id, url);
            // Registry-side acts key on the PUBLISHED identity, which the fresh meta names.
            const meta = await client.publicationMeta(track.id);
            if (applyUnlisted) await setCommunity(meta?.trackId ?? track.id, { unlisted: true });
            setCollision(false);
            setEpochNudge((n) => n + 1);
            notify(`${r.updated ? 'Updated on' : 'Published to'} the registry ✓ — ${r.url}`);
          } catch (e) {
            // The name belongs to someone else (a fork pushing upstream): not a dead end — the
            // way through is publishing YOUR version under YOUR name.
            if (e instanceof Error && e.message.includes('belongs to someone else')) {
              setCollision(true);
              setOwnTitle((cur) => (cur === '' ? `${track.title} (my version)` : cur));
              throw new Error(`that name belongs to someone else on the registry — publish your own version below`);
            }
            throw e;
          }
        },
        '',
        { irreversible: true },
      );
    } finally {
      setPushing(false);
    }
  };

  /** Adopt the new name (the alias rides the publish stamp), then push — now as a NEW entry. */
  const doPublishOwn = async () => {
    const title = ownTitle.trim();
    if (title === '') return;
    await client.publish(track.id, undefined, title);
    await doPush(registryHere ?? undefined);
  };

  const doUnpublish = async () => {
    await act(() => client.unpublish(track.id), 'Unpublished — distribution stopped; copies made while public persist', { irreversible: true });
  };
  // CAN this page publish? The in-browser engine can — same-origin, with the session cookie —
  // whenever the page was served by a registry. The old gate asked only which BACKEND
  // was in use and so hid publishing from every browser library, including a signed-in one on
  // philomatic.io. The honest question is about the ORIGIN, and only
  // the server can answer it, so it is asked rather than assumed.
  const [registryHere, setRegistryHere] = useState<string | null | undefined>(undefined);
  // WHO is publishing: where this registry has accounts, a publication
  // needs one — so a signed-out person gets a sign-in ask HERE, not a Publish button that
  // "succeeds" locally and lands nowhere. A self-hosted server (hosted false) is left alone.
  const [identity, setIdentity] = useState<HostedIdentity | undefined>();
  useEffect(() => {
    let live = true;
    void client
      .getRegistry()
      .then((r) => live && setRegistryHere(r?.registry ?? null))
      .catch(() => live && setRegistryHere(null));
    void hostedIdentity().then((i) => live && setIdentity(i));
    return () => {
      live = false;
    };
  }, [client]);

  // IS the public copy the current one? (a source added after
  // publishing never reached the registry, and nothing said so — the page just showed the old
  // version.) Compare content hashes: the local publication's against the registry entry's.
  useEffect(() => {
    if (track.published === undefined || registryHere === undefined || registryHere === null) {
      setSyncState(undefined);
      return;
    }
    let live = true;
    void (async () => {
      const local = await client.publicationMeta(track.id);
      if (local === undefined) return;
      if (live) setPubId(local.trackId);
      try {
        const r = await fetch(`${registryHere}/t/${encodeURIComponent(local.trackId)}.json?meta=1`);
        if (!live) return;
        if (r.status === 404) setSyncState('absent');
        else if (r.ok) setSyncState(((await r.json()) as { contentHash: string }).contentHash === local.contentHash ? 'current' : 'behind');
      } catch {
        /* registry unreachable — claim nothing */
      }
    })();
    return () => {
      live = false;
    };
  }, [client, track.id, track.published, registryHere, epochNudge]);
  // A fork checks its upstream: one meta probe against the RECORDED origin — the same
  // hash comparison as sync-state, pointed the other way. Quiet unless it can answer.
  useEffect(() => {
    const origin = track.origin;
    if (origin?.url === undefined) {
      setUpstream(undefined);
      return;
    }
    let live = true;
    void fetch(`${origin.url}.json?meta=1`)
      .then((r) => (r.ok ? (r.json() as Promise<{ contentHash: string }>) : undefined))
      .then((m) => live && m !== undefined && setUpstream(m.contentHash === origin.contentHash ? 'current' : 'updates'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [track.origin, epochNudge]);

  const [proposing, setProposing] = useState(false);
  const doPropose = async () => {
    setProposing(true);
    try {
      const r = await proposeUpstream(client, track.id);
      notify(
        r.nothing
          ? 'Nothing to propose — upstream already has everything your fork adds'
          : `Proposed ${r.sent} addition${r.sent === 1 ? '' : 's'} ✓ — waiting on the owner${r.alreadyPending > 0 ? ` (${r.alreadyPending} already pending)` : ''}${r.skipped > 0 ? `; ${r.skipped} question${r.skipped === 1 ? '' : 's'} skipped (anchored only to your own new material)` : ''}`,
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  };

  const doPull = async () => {
    setPulling(true);
    try {
      const r = await client.pullFork(track.id);
      notify(
        r.took === 0 && r.edgesAdded === 0
          ? 'Already up to date with upstream ✓'
          : `Pulled ✓ — took ${r.took}${r.keptYours > 0 ? `, kept ${r.keptYours} of yours` : ''}${r.upstreamDeleted > 0 ? `, upstream removed ${r.upstreamDeleted} (kept here)` : ''}`,
      );
      setEpochNudge((n) => n + 1);
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
    }
  };

  // Publishing from the browser needs the registry to BE this origin — anywhere else the cookie
  // is not sent. A server-backed library publishes either way (same-origin here, token push
  // otherwise), so it is never gated.
  const canPublishHere = currentBackend() !== 'browser' || registryHere === window.location.origin;
  // WHERE the public page actually is ("no such track"). Two answers,
  // and the origin root is neither: on the one-origin deploy `/t/<id>` there is the REGISTRY's
  // page, which has nothing until the track is pushed.
  //   server library — the page THIS engine serves, under its mount prefix: `<base>/t/<id>`.
  //   browser library — there is no server to serve one; the only public page is the registry's,
  //                     and only once pushed.
  const base = serverBase();
  const selfUrl = `${base.startsWith('http') ? base : `${window.location.origin}${base}`}/t/${track.id}`;
  const publicUrl = currentBackend() === 'browser' ? `${registryHere ?? window.location.origin}/t/${pubId ?? track.id}` : selfUrl;
  // The registry that served this page is the one to publish to; fill it in rather than making
  // someone type their own address back to themselves.
  useEffect(() => {
    if (registryHere !== null && registryHere !== undefined && registry.trim() === '') setRegistry(registryHere);
  }, [registryHere, registry]);

  // An engine that cannot publish says why HERE, where the button would be —
  // rather than offering the button and failing after the click. Nothing is claimed until the
  // answer is in: `undefined` is still-asking, and shows neither controls nor a refusal.
  if (registryHere === undefined && currentBackend() === 'browser') {
    return <div className="detail-section">Publishing</div>;
  }
  const cannot = canPublishHere ? undefined : unavailable('publish', currentBackend());
  if (cannot !== undefined) {
    return (
      <>
        <div className="detail-section">Publishing</div>
        <p className="needs-server-note">{cannot}</p>
      </>
    );
  }
  // Publishing here means publishing AS someone — greyed out with the way in, not a button that
  // mints locally, toasts success, and puts nothing where the link points.
  if (registryHere === window.location.origin && identity?.hosted === true && identity.signedIn !== true) {
    return (
      <>
        <div className="detail-section">Publishing</div>
        <div className="publish-box publish-signedout">
          <p className="publish-terms">
            Publishing puts this track on <strong>{registryHere.replace(/^https?:\/\//, '')}</strong> under your
            account, like a repository belongs to its owner. Sign in to publish.
          </p>
          <div className="publish-actions">
            <button className="link-btn publish-go" onClick={signInHere}>Sign in to publish</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="detail-section">Publishing</div>
      {track.origin?.url !== undefined && upstream !== undefined && (
        <div className="upstream-row">
          <span className="settings-meta">
            Forked from <a href={track.origin.url} target="_blank" rel="noreferrer">{track.origin.trackId}</a>
            {upstream === 'current' ? ' · up to date ✓' : ' · upstream has updates'}
          </span>
          <span className="upstream-actions">
            {upstream === 'updates' && (
              <button className="link-btn publish-go" disabled={pulling} onClick={() => void doPull()}>
                {pulling ? 'Pulling…' : 'Pull the update'}
              </button>
            )}
            {/* The pull-request half: my fork's ADDITIONS go back as mailbox
                contributions — proposed, attributed, accepted piecewise by the owner. Never a
                push; the inbox is the merge tool. */}
            <button className="link-btn" disabled={proposing} onClick={() => void doPropose()}>
              {proposing ? 'Proposing…' : 'Propose my additions'}
            </button>
          </span>
        </div>
      )}
      {track.published ? (
        <div className="publish-box">
          <div className="publish-state">
            <span className="publish-live">● public</span>
            <span>{track.published.license}</span>
            <span>since {new Date(track.published.at).toISOString().slice(0, 10)}</span>
          </div>
          <div className="publish-actions">
            <a className="link-btn" href={publicUrl} target="_blank" rel="noreferrer">
              Open public page ↗
            </a>
            <button className="link-btn" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => notify('Link copied ✓'))}>
              Copy link
            </button>
            <button className="link-btn publish-stop" title="stops distribution; copies made while public persist" onClick={() => void doUnpublish()}>
              Unpublish
            </button>
          </div>
          {/* WHERE this publishes is a fact, not a preference, wherever a registry served the
              page: it is that registry, and it is the only one this browser can authenticate to.
              A free-text field here went stale — an old address routed the push server-side,
              where there is no account, and the registry answered 401 (08). The field remains for a page NO registry served: the self-hoster
              pushing outward, whose credential is REGISTRY_TOKEN on their server. */}
          {registryHere !== null && registryHere !== undefined ? (
            <div className="publish-actions registry-row">
              <span className="registry-target" title="the registry that served this page">
                {registryHere.replace(/^https?:\/\//, '')}
                {syncState === 'current' && <em className="sync-state ok"> · up to date ✓</em>}
                {syncState === 'behind' && <em className="sync-state stale"> · has an older version</em>}
                {syncState === 'absent' && <em className="sync-state stale"> · not there yet</em>}
              </span>
              <button className="link-btn publish-go" disabled={pushing || syncState === 'current'} onClick={() => void doPush(registryHere)}>
                {pushing ? 'Publishing…' : syncState === 'behind' ? 'Publish the update' : 'Publish to the registry'}
              </button>
            </div>
          ) : (
            <div className="publish-actions registry-row">
              <input
                className="detail-field registry-url"
                value={registry}
                placeholder="registry URL (https://…)"
                title="a track registry to push this publication to — the public commons"
                onChange={(e) => setRegistry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doPush();
                }}
              />
              <button className="link-btn publish-go" disabled={registry.trim() === '' || pushing} onClick={() => void doPush()}>
                {pushing ? 'Pushing…' : 'Push to registry'}
              </button>
            </div>
          )}
          {collision && (
            <div className="publish-own">
              <p className="settings-meta">
                The first publisher owns a track&rsquo;s name. Yours can live beside it under its own name — lineage to
                the original travels with it.
              </p>
              <div className="publish-actions">
                <input
                  className="detail-field publish-own-title"
                  value={ownTitle}
                  onChange={(e) => setOwnTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doPublishOwn();
                  }}
                />
                <button className="link-btn publish-go" disabled={pushing || ownTitle.trim() === ''} onClick={() => void doPublishOwn()}>
                  Publish my version
                </button>
              </div>
            </div>
          )}
          {/* Community sharing: shown only when this track is published to THIS origin's
              registry and owned by the signed-in account. Invisible otherwise. */}
          <TrackCommunity trackId={pubId ?? track.id} notify={notify} />
        </div>
      ) : publishOpen ? (
        <div className="publish-box">
          <p className="publish-terms">
            Publishing puts this track's <strong>content</strong> — its concepts, sources, snippets, and questions — on a
            public page under the license below. Your private world stays home: notes, sentiments, progress, and personal
            links are never included. Unpublishing later stops distribution, but copies made while public persist.
          </p>
          {registryHere === window.location.origin && (
            <label className="community-toggle">
              <input type="checkbox" checked={unlisted} onChange={(e) => setUnlisted(e.target.checked)} />
              <span>Unlisted — keep it off the public registry (reachable by its link, and to people you invite)</span>
            </label>
          )}
          <div className="publish-actions">
            <input
              className="detail-field publish-license"
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              title="the license stamped on this publication"
            />
            <button className="link-btn publish-go" onClick={() => void doPublish()}>
              <GitBranch size={14} /> Publish
            </button>
            <button className="link-btn" onClick={() => setPublishOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="publish-actions">
          <button className="link-btn" onClick={() => setPublishOpen(true)}>
            <GitBranch size={14} /> Publish…
          </button>
        </div>
      )}
    </>
  );
}
