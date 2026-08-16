/**
 * The capture-first start panel — what an EMPTY library says.
 *
 * Two doors, in the order the principle demands: CAPTURE leads (paste a URL — the minimum
 * gesture; structure is a byproduct of use, so nothing must be designed before saving the
 * first thing), and forking an example track follows for payoff-before-investment. Nothing
 * here is a wizard: both doors land you in the ordinary library, and every other affordance
 * stays exactly where it was (principle #8c — the deep model remains the ceiling).
 *
 * The EMPTY state only. A `compact` strip used to repeat these doors above a
 * sparse library and vanish at three items, which made it the only in-app way to capture a URL
 * AND made that way disappear from any real library. "+ New source" is the same act — DraftForm
 * calls `captureSource` too, with a title field and without the staging step you do not need
 * while sitting in the app on purpose. Capture earns its keep where it was always meant to live:
 * the extension and the CLI, grabbing something mid-read to sort out later.
 *
 */
import { useEffect, useState } from 'react';
import { TreeStructure } from '@phosphor-icons/react';
import type { ExampleMeta, RegistryTrack } from '../client/transport';
import { Icon } from '../components/Icon';
import { useEngine } from '../engine-context';
import { unavailable } from '../lib/capabilities';
import { currentBackend } from '../lib/backend-pref';

export function StartPanel({
  onCaptured,
  onCreate,
}: {
  onCaptured?: (id: string) => void;
  /** Open the create form for a kind (App's `startNew`) — the three doors of an empty library. */
  onCreate?: (kind: 'track' | 'concept' | 'source') => void;
}) {
  const { client, refresh, notify, pushUndo } = useEngine();
  const backend = currentBackend();
  const [examples, setExamples] = useState<ExampleMeta[]>([]);
  // The community registry: featured first, then recency — real tracks to fork,
  // above the bundled examples, when this server has a registry configured.
  const [community, setCommunity] = useState<{ registry: string; tracks: RegistryTrack[] } | undefined>();
  // Asked-and-answered, which is NOT the same as "no registry". The
  // in-browser build now asks its own origin, so the paragraph explaining the absence must wait
  // for the answer — otherwise it flashes up on every load of a page that does have one.
  const [probed, setProbed] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let stale = false;
    client
      .listExamples()
      .then((xs) => !stale && setExamples(xs))
      .catch(() => !stale && setExamples([])); // no examples on this origin → the capture door alone
    client
      .getRegistry()
      .then((r) => {
        if (stale || r === undefined) return;
        const tracks = r.tracks
          .slice()
          .sort((a, b) => Number(b.featured === true) - Number(a.featured === true) || b.updatedAt - a.updatedAt);
        setCommunity({ registry: r.registry, tracks });
      })
      .catch(() => undefined) // unreachable registry → the section simply doesn't render
      .finally(() => !stale && setProbed(true));
    return () => {
      stale = true;
    };
  }, [client]);

  const forkCommunity = async (t: RegistryTrack) => {
    if (busy !== '') return;
    setBusy(t.trackId);
    try {
      const r = await client.forkRegistryTrack(t.trackId);
      await refresh();
      notify(`Forked “${r.title ?? t.title}” from the community — it is yours now; lineage remembered`);
      onCaptured?.(t.trackId);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const fork = async (ex: ExampleMeta) => {
    if (busy !== '') return;
    setBusy(ex.name);
    try {
      await client.importPayload(await client.getExample(ex.name));
      await refresh();
      notify(`Forked “${ex.title}” — it is yours now: edit, prune, or remove anything`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  // The three things a library is made of. An empty library used to offer
  // ONLY "paste a URL" — one door, and it hid that you can start from a goal (a track) or an idea
  // (a concept), or add a reading you have no link for. Each door is the kind's own colour and
  // says plainly what it is; all three land in the ordinary create form (App's startNew), so the
  // deep model stays the ceiling and this is only a friendlier floor.
  const DOORS = [
    { kind: 'track' as const, title: 'Start a track', blurb: 'A reading path toward a goal — a sequence of sources you order and work through.' },
    { kind: 'concept' as const, title: 'Add a concept', blurb: 'An idea your reading is about. Concepts are what the graph organises around.' },
    { kind: 'source' as const, title: 'Add a source', blurb: 'A reading: an article, paper, book, or video — with a link, or just a title if you have none.' },
  ];

  return (
    <div className="pane list start-panel">
      <div className="start-block">
        <h2>Start your library</h2>
        <p className="hint">Add your first track, concept, or source — or bring one in from below.</p>
        <div className="start-doors">
          {DOORS.map((d) => (
            <button key={d.kind} type="button" className={`start-door ${d.kind}`} onClick={() => onCreate?.(d.kind)}>
              <span className="start-door-icon" style={{ color: `var(--k-${d.kind})` }}>
                <Icon name={d.kind} size={20} filled />
              </span>
              <span className="start-door-title">{d.title}</span>
              <span className="start-door-blurb">{d.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Community tracks appear when a registry answers — on a server, the one it is configured
          with; in the browser, the origin that served the page. This block is the OTHER case:
          asked, and there was none. It waits for `probed` so it cannot flash before the answer. */}
      {backend === 'browser' && probed && community === undefined && (
        <div className="start-block">
          <h2>Bringing in someone else&rsquo;s track</h2>
          <p className="hint">{unavailable('registry', backend)}</p>
        </div>
      )}

      {community !== undefined && community.tracks.length > 0 && (
        <div className="start-block">
          <h2>Or fork a community track</h2>
          <p className="hint">
            Published by other learners on{' '}
            <a href={community.registry} target="_blank" rel="noreferrer">
              the registry
            </a>
            . Forking copies it into your library with its lineage — yours to edit, prune, or remove.
          </p>
          <div className="start-examples">
            {community.tracks.slice(0, 6).map((t) => (
              <button key={t.trackId} className="start-example" disabled={busy !== ''} onClick={() => void forkCommunity(t)}>
                <span className="start-example-title">
                  <TreeStructure size={15} /> {t.featured === true ? '★ ' : ''}
                  {t.title}
                </span>
                {t.goal !== undefined && <span className="start-example-goal">{t.goal}</span>}
                <span className="start-example-meta">
                  {t.sources} source{t.sources === 1 ? '' : 's'} · {t.concepts} concept{t.concepts === 1 ? '' : 's'}
                  {t.author !== undefined ? ` · by ${t.author}` : ''}
                  {busy === t.trackId ? ' · forking…' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {examples.length > 0 && (
        <div className="start-block">
          <h2>Or start from an example track</h2>
          <p className="hint">
            A worked reading path you can explore, edit, or throw away. Forking copies it into your library — it is
            yours, not a template you are borrowing.
          </p>
          <div className="start-examples">
            {examples.map((ex) => (
              <button key={ex.name} className="start-example" disabled={busy !== ''} onClick={() => void fork(ex)}>
                <span className="start-example-title">
                  <TreeStructure size={15} /> {ex.title}
                </span>
                {ex.goal !== undefined && <span className="start-example-goal">{ex.goal}</span>}
                <span className="start-example-meta">
                  {ex.sources} source{ex.sources === 1 ? '' : 's'} · {ex.concepts} concept{ex.concepts === 1 ? '' : 's'}
                  {busy === ex.name ? ' · forking…' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
