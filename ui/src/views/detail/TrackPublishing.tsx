import { useAction, useEngine } from '../../engine-context';
import { GitBranch } from '@phosphor-icons/react';
import { useState } from 'react';

/** Publishing controls (owner placements, 2026-07-18: the LAST block of the pane, just above
 *  View-in-map/Remove). Publish/unpublish, the public link, and the registry push. */
export function TrackPublishing({
  track,
  conceptAnchored,
}: {
  track: { id: string; title: string; published?: { at: number; license: string } };
  /** Concepts-only membership: the publication carries the concept-anchored reading list. */
  conceptAnchored?: boolean;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const act = useAction();
  // Publishing (publish plan P2, workbench affordance from the PB-S5 ledger). The act stays
  // explicit and informed (DATA_GOVERNANCE 2): the confirm panel names the license and states
  // what is and is not included before anything happens.
  const [publishOpen, setPublishOpen] = useState(false);
  const [license, setLicense] = useState('CC-BY-SA-4.0');
  const publicUrl = `${window.location.origin}/t/${track.id}`;
  // Publishing is OUTWARD-FACING: copies made while public persist, so it is not undoable by
  // a stack pop — unpublish is the explicit, separate act.
  const doPublish = async () => {
    await act(
      async () => {
        await client.publish(track.id, license.trim());
        setPublishOpen(false);
      },
      'Published ✓ — the public page is live',
      { irreversible: true },
    );
  };
  // Push to a registry (track registry, 2026-07-18): the server does the outbound POST; the
  // registry URL is a workbench setting, remembered once entered.
  const [registry, setRegistry] = useState(() => localStorage.getItem('pm.registry') ?? '');
  const [pushing, setPushing] = useState(false);
  const doPush = async () => {
    const url = registry.trim().replace(/\/$/, '');
    if (!url) return;
    localStorage.setItem('pm.registry', url);
    setPushing(true);
    try {
      // Outward-facing: the bundle is on someone else's server now. `unpush` is the act.
      await act(
        async () => {
          const r = await client.pushToRegistry(track.id, url);
          notify(`${r.updated ? 'Updated on' : 'Published to'} the registry ✓ — ${r.url}`);
        },
        '',
        { irreversible: true },
      );
    } finally {
      setPushing(false);
    }
  };

  const doUnpublish = async () => {
    await act(() => client.unpublish(track.id), 'Unpublished — distribution stopped; copies made while public persist', { irreversible: true });
  };
  return (
    <>
      <div className="detail-section">Publishing</div>
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
        </div>
      ) : publishOpen ? (
        <div className="publish-box">
          <p className="publish-terms">
            Publishing puts this track's <strong>content</strong> — its concepts, sources, snippets, and questions — on a
            public page under the license below. Your private world stays home: notes, sentiments, progress, and personal
            links are never included. Unpublishing later stops distribution, but copies made while public persist.
          </p>
          {conceptAnchored === true && (
            <p className="publish-terms">
              This is a <strong>concepts-only</strong> track: the publication carries its concept topics <em>and every
              source tied to those concepts</em> (the reading list you see in the By-concept view), including their
              reading order.
            </p>
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
