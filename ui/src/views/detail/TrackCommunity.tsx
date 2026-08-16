/**
 * Community controls in the Publishing box — the owner's sharing panel for a track
 * published to THIS origin's registry. Invisible otherwise: a track that is not published here,
 * or not owned by the signed-in account, returns `owner: false` and this renders nothing.
 *
 * One shared, revocable invite link onboards a class; an unlisted toggle keeps it off the public
 * commons. Members are shown so the owner can see who joined.
 */
import { useEffect, useState } from 'react';
import { communityOf, setCommunity, type CommunityView } from '../../lib/community';

export function TrackCommunity({ trackId, notify }: { trackId: string; notify: (m: string) => void }) {
  const [view, setView] = useState<CommunityView | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void communityOf(trackId).then((v) => live && setView(v));
    return () => {
      live = false;
    };
  }, [trackId]);

  // Only the owner of a track on this registry sees any of this.
  if (view?.owner !== true) return null;

  const act = (body: { unlisted?: boolean; invite?: 'mint' | 'revoke'; removeMember?: string }, msg: string) => {
    setBusy(true);
    void setCommunity(trackId, body)
      .then((v) => {
        setView(v);
        notify(msg);
      })
      .catch((e: Error) => notify(e.message))
      .finally(() => setBusy(false));
  };

  const link = view.invite?.link;

  return (
    <div className="community-box">
      <div className="detail-section">Community</div>
      <p className="settings-meta">
        Invite people to contribute — recommend sources and ask questions on this track. What they send lands in your
        inbox for review; nothing changes the track until you accept it.
      </p>

      <label className="community-toggle">
        <input
          type="checkbox"
          checked={view.unlisted === true}
          disabled={busy}
          onChange={(e) => act({ unlisted: e.target.checked }, e.target.checked ? 'Unlisted — off the public registry' : 'Listed on the public registry')}
        />
        <span>Unlisted — keep it off the public registry (reachable by its link and to members)</span>
      </label>

      {link === undefined ? (
        <button className="pm-btn" disabled={busy} onClick={() => act({ invite: 'mint' }, 'Invite link created')}>
          Create an invite link
        </button>
      ) : (
        <>
          <div className="community-invite">
            <input className="pm-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="pm-btn" disabled={busy} onClick={() => void navigator.clipboard.writeText(link).then(() => notify('Invite link copied ✓'))}>
              Copy
            </button>
          </div>
          <div className="community-invite-actions">
            <button className="link-btn" disabled={busy} onClick={() => act({ invite: 'mint' }, 'New invite link — the old one stops working')}>
              Replace link
            </button>
            <button className="link-btn danger" disabled={busy} onClick={() => act({ invite: 'revoke' }, 'Invite link revoked — members stay')}>
              Revoke
            </button>
          </div>
        </>
      )}

      {(view.members?.length ?? 0) > 0 && (
        <div className="community-members">
          <strong>{view.members!.length} contributor{view.members!.length === 1 ? '' : 's'}</strong>
          <ul>
            {view.members!.map((m) => (
              <li key={m.accountId}>
                {m.name}
                <button
                  type="button"
                  className="cmember-x"
                  title={`remove ${m.name} from this track — they can no longer contribute (their past contributions stay)`}
                  disabled={busy}
                  onClick={() => act({ removeMember: m.accountId }, `${m.name} removed`)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
