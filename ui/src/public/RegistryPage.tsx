/**
 * The registry library page's live body — search, concept facets,
 * and the track list as real components over the shell's data island. The server renders the
 * sorted track list as static HTML (crawlers and noscript readers see every track);
 * this replaces it with the filterable version. Entries arrive PRE-SORTED (featured in the
 * operator's order, then recency) — the server owns ordering, this page owns filtering.
 */
import { useMemo, useState } from 'react';
import { Star } from '@phosphor-icons/react';

export interface RegistryEntryView {
  trackId: string;
  title: string;
  goal?: string;
  author?: string;
  sources: number;
  concepts: number;
  questions: number;
  license: string;
  updatedAt: number;
  authorKey: string;
  conceptNames?: string[];
  featured?: boolean;
}

export interface RegistryData {
  entries: RegistryEntryView[];
  intro: boolean;
}

export function RegistryPage({ data }: { data: RegistryData }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());

  // The same facet rule as the server-rendered era: the top 24 concept names,
  // alphabetical — the whole index is on the page, so discovery is a client-side filter.
  const facets = useMemo(
    () => [...new Set(data.entries.flatMap((e) => e.conceptNames ?? []))].sort((a, b) => a.localeCompare(b)).slice(0, 24),
    [data.entries],
  );

  const text = query.trim().toLowerCase();
  const shown = data.entries.filter((e) => {
    const hay = [e.title, e.goal ?? '', e.author ?? '', ...(e.conceptNames ?? [])].join(' ').toLowerCase();
    if (text !== '' && !hay.includes(text)) return false;
    const names = (e.conceptNames ?? []).map((n) => n.toLowerCase());
    return [...active].every((c) => names.includes(c));
  });

  const toggle = (c: string): void =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <div className="reg-page">
      <h1>
        Track registry <span>{data.entries.length} published track{data.entries.length === 1 ? '' : 's'}</span>
      </h1>
      {data.entries.length === 0 ? (
        <p className="reg-empty">
          Nothing published yet. <code>philomatic push &lt;track&gt; --registry &lt;this url&gt;</code>
        </p>
      ) : (
        <>
          <input
            id="q"
            className="pm-input"
            type="search"
            placeholder="search tracks — title, goal, author, concept…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {facets.length > 0 && (
            <div className="reg-facets">
              {facets.map((n) => (
                <button key={n} type="button" className={`chip${active.has(n.toLowerCase()) ? ' on' : ''}`} onClick={() => toggle(n.toLowerCase())}>
                  {n}
                </button>
              ))}
            </div>
          )}
          <ul className="reg-tracks">
            {shown.map((e) => (
              <li key={e.trackId}>
                <a href={`/t/${encodeURIComponent(e.trackId)}`}>
                  {e.featured === true && <Star size={12} weight="fill" style={{ verticalAlign: '-1px', marginRight: '0.25rem', color: 'var(--raised)' }} />}
                  {e.title}
                </a>
                {e.goal !== undefined && <span className="goal">{e.goal}</span>}
                <span className="meta">
                  {e.author !== undefined && e.author !== '' ? `${e.author} · ` : ''}
                  {e.sources} source{e.sources === 1 ? '' : 's'} · {e.concepts} concept{e.concepts === 1 ? '' : 's'}
                  {e.questions > 0 ? ` · ${e.questions} open thread${e.questions === 1 ? '' : 's'}` : ''} · {e.license} · updated{' '}
                  {new Date(e.updatedAt).toISOString().slice(0, 10)}
                </span>
                {(e.conceptNames ?? []).length > 0 && (
                  <span className="chips">
                    {(e.conceptNames ?? []).map((n) => (
                      <span key={n} className="chip">{n}</span>
                    ))}
                  </span>
                )}
                <span className="key" title="author key (identity is the keypair)">
                  {e.authorKey.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="reg-none">No tracks match.</p>}
        </>
      )}
      <footer>
        {data.intro && (
          <p>
            {data.intro && <a href="/intro">New here? The two-minute tour.</a>}{' '}
          </p>
        )}
        Every track is a self-contained publication bundle — <em>fork</em> one by downloading its JSON (add <code>.json</code> to
        any track URL) and importing it into your own Philomatic.
      </footer>
    </div>
  );
}
