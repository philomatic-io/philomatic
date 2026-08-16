/**
 * The FRAMEWORK EDITOR — where relations get minted. A Settings section over the
 * per-library framework store: the personal working framework ("[username]'s framework",
 * always active) gains concept↔concept LINK relations with a name, an inverse reading, a direction,
 * and a declared map mark; a second block sets LOCAL view overrides — re-mark or hide
 * anyone's relations, hide core edge types (never travels). Every save swaps the
 * runtime registry, so the concept dropdown, the Connections rows, and both maps speak the
 * new vocabulary on the next render — no reload.
 */
import { useEffect, useMemo, useState } from 'react';
import { DownloadSimple, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import { useEngine } from '../engine-context';
import { activeList, applyFrameworksView, activeFrameworks, CORE_FRAMEWORK } from '../lib/framework-registry';
import { FRAMEWORKS as BAKED } from '../generated/framework';
import { EdgeMark } from '../components/map-marks';
import { Icon, type IconName } from '../components/Icon';
import type { FrameworkEdgeTag, FrameworkFile, FrameworksView, ViewOverrides } from '../client/types';

type Mark = 'line' | 'group' | 'comet';
type Polarity = 'none' | 'for' | 'against';

/** "disputes with" → "DisputesWith" — the tag name is derived, never typed. */
const tagNameOf = (label: string): string =>
  label
    .trim()
    .split(/\s+/)
    .map((w) => (w[0] ?? '').toUpperCase() + w.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');

/** An endpoint kind as its colored glyph — sources wear the book, like the pickers. */
function KindGlyph({ kind }: { kind?: string }) {
  if (kind === undefined) return null;
  const name: IconName = kind === 'source' ? 'source:text' : (kind as IconName);
  return (
    <span className="fwed-kind" style={{ color: `var(--k-${kind})` }}>
      <Icon name={name} size={12} />
    </span>
  );
}

/** camelCase → words, for showing existing relations the way dropdowns word them. */
const wordOf = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** "Logic Lenses" → "logic-lenses" — the shape the registry's name wall accepts, so a named
 *  framework can later ride a push into the archive unchanged (drift-tested against FW_NAME
 *  in src/registry/server.ts — the lock line keeps the two sides separate). */
export const fwNameOf = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

/** A framework file as a download — used by the per-row export. */
const downloadFramework = (def: FrameworkFile): void => {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.framework}.framework.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** The tiny live preview: two endpoints and the chosen mark between them. */
function MarkPreview({ mark, polarity }: { mark: Mark; polarity: Polarity }) {
  const A = { x: 14, y: 22 };
  const B = { x: 106, y: 12 };
  const family = polarity === 'against' ? 'conflict' : polarity === 'for' ? 'support' : mark === 'comet' ? 'ordering' : 'plain';
  return (
    <svg className="fwed-preview" viewBox="0 0 120 32" aria-hidden="true">
      {mark === 'group' ? (
        <>
          <ellipse cx={60} cy={17} rx={54} ry={14} fill="var(--rank-field)" fillOpacity={0.12} stroke="var(--rank-field)" strokeOpacity={0.4} />
          <circle cx={A.x + 10} cy={A.y - 3} r={4.5} fill="none" stroke="var(--k-concept)" strokeWidth={1.5} />
          <circle cx={B.x - 10} cy={B.y + 5} r={4.5} fill="none" stroke="var(--k-concept)" strokeWidth={1.5} />
        </>
      ) : (
        <>
          <EdgeMark family={family} A={A} B={B} />
          <circle cx={A.x} cy={A.y} r={4.5} fill="var(--surface)" stroke="var(--k-concept)" strokeWidth={1.5} />
          <circle cx={B.x} cy={B.y} r={4.5} fill="var(--surface)" stroke="var(--k-concept)" strokeWidth={1.5} />
        </>
      )}
    </svg>
  );
}

export function FrameworkEditor({ username }: { username?: string }) {
  const { client, notify } = useEngine();
  const [view, setView] = useState<FrameworksView | undefined>();
  const [label, setLabel] = useState('');
  const [inverse, setInverse] = useState('');
  const [direction, setDirection] = useState<'directed' | 'symmetric'>('directed');
  const [mark, setMark] = useState<Mark>('line');
  const [polarity, setPolarity] = useState<Polarity>('none');
  const [description, setDescription] = useState('');
  const [editingName, setEditingName] = useState<string | undefined>();
  const [renameWarn, setRenameWarn] = useState<{ from: string; count: number } | undefined>();
  const [busy, setBusy] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installName, setInstallName] = useState('');
  const [installDesc, setInstallDesc] = useState('');

  const reload = async () => {
    const v = await client.frameworks();
    setView(v);
    applyFrameworksView(v);
    return v;
  };
  useEffect(() => {
    void reload().catch(() => setView(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const fwName = view?.mine?.framework ?? (username !== undefined && username !== '' ? username : 'my-framework');
  const displayName = username !== undefined && username !== '' ? `${username}'s framework` : 'My framework';
  const mine = view?.mine;
  const relations = mine?.edgeTags ?? [];

  // Every ACTIVE tag name, for collision refusal — one vocabulary, no shadowed words.
  const takenNames = useMemo(() => {
    const names = new Set<string>();
    if (view !== undefined) for (const f of activeList(view)) for (const t of f.edgeTags) names.add(t.name);
    for (const f of BAKED) for (const t of f.edgeTags as readonly { name: string }[]) names.add(t.name);
    return names;
  }, [view]);

  const resetForm = () => {
    setLabel('');
    setInverse('');
    setDirection('directed');
    setMark('line');
    setPolarity('none');
    setDescription('');
    setEditingName(undefined);
    setRenameWarn(undefined);
  };

  const startEdit = (t: FrameworkEdgeTag) => {
    setEditingName(t.name);
    setLabel(wordOf(t.name));
    setInverse(t.inverseLabel ?? '');
    setDirection(t.direction);
    setMark(t.render === 'group' || t.render === 'comet' ? t.render : 'line');
    setPolarity(t.polarity ?? 'none');
    setDescription(t.description ?? '');
  };

  const mineEntityTags = (mine?.entityTags ?? []) as readonly { name: string; on?: string[]; description?: string }[];

  const saveMine = async (
    edgeTags: readonly FrameworkEdgeTag[],
    toast: string,
    entityTags: readonly unknown[] = mineEntityTags,
  ) => {
    setBusy(true);
    try {
      const def: FrameworkFile = {
        framework: fwName,
        version: mine?.version ?? 0,
        description: mine?.description ?? `${displayName} — minted in the workbench`,
        edgeTags,
        entityTags,
      };
      await client.saveMyFramework(def);
      await reload();
      notify(toast);
      resetForm();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** How many edges in this library carry the tag — a rename strands every one of them. */
  const tieCount = async (tagName: string): Promise<number> => {
    const g = await client.getGraph();
    const exact = `#${tagName}`;
    return g.edges.filter((e) => e.tags.some((t) => t === exact || t.startsWith(`${exact}:`))).length;
  };

  const submit = async (renameConfirmed = false) => {
    const name = tagNameOf(label);
    if (name.length < 2) {
      notify('give the relation a name — two words beat two letters');
      return;
    }
    if (name !== editingName && takenNames.has(name)) {
      notify(`“${wordOf(name)}” already exists in an active framework — pick another wording`);
      return;
    }
    // A rename is a NEW relation wearing old clothes: existing ties keep
    // the old tag and render generic. With ties on the line, warn IN the form — toasts hide
    // under the settings scrim — and save only on an explicit "rename anyway".
    if (!renameConfirmed && editingName !== undefined && name !== editingName) {
      const count = await tieCount(editingName);
      if (count > 0) {
        setRenameWarn({ from: editingName, count });
        return;
      }
    }
    setRenameWarn(undefined);
    // Editing PRESERVES what the form doesn't speak: a loaded framework
    // may hold snippet↔snippet pairs or bundle grammar — renaming a mark must not rewrite
    // its endpoints to concept↔concept or drop subtypeRole.
    const orig = editingName !== undefined ? relations.find((t) => t.name === editingName) : undefined;
    const tag: FrameworkEdgeTag = {
      ...(orig ?? {}),
      name,
      on: orig?.on ?? { type: 'LINK', srcKind: 'concept', dstKind: 'concept' },
      direction,
      publish: orig?.publish ?? true,
    };
    if (direction === 'directed' && inverse.trim() !== '') tag.inverseLabel = inverse.trim();
    else delete tag.inverseLabel;
    if (mark !== 'line') tag.render = mark;
    else delete tag.render;
    if (polarity !== 'none') tag.polarity = polarity;
    else delete tag.polarity;
    if (description.trim() !== '') tag.description = description.trim();
    else delete tag.description;
    const rest = relations.filter((t) => t.name !== (editingName ?? name));
    await saveMine([...rest, tag], editingName !== undefined ? `Updated “${wordOf(name)}” ✓` : `Minted “${wordOf(name)}” ✓ — it's in your pickers now`);
  };

  const remove = async (t: FrameworkEdgeTag) => {
    await saveMine(
      relations.filter((x) => x.name !== t.name),
      `Removed “${wordOf(t.name)}” — existing ties keep the tag and render generic`,
    );
  };

  /** Naming IS the share gesture — the working relations become
   *  a NAMED framework in the installed list, and the working area starts fresh. */
  const installAsFramework = async () => {
    const name = fwNameOf(installName);
    if (name === '') {
      notify('give the framework a name — that name is how others will know it');
      return;
    }
    const held = new Set([
      ...(view?.builtin ?? []).map((f) => f.framework),
      ...(view?.installed ?? []).map((f) => f.framework),
    ]);
    if (held.has(name)) {
      notify(`“${name}” is already a framework here — pick another name`);
      return;
    }
    setBusy(true);
    try {
      const def: FrameworkFile = {
        framework: name,
        version: 1,
        ...(installDesc.trim() !== '' ? { description: installDesc.trim() } : {}),
        edgeTags: relations,
        entityTags: mineEntityTags,
        metadataFields: [],
      };
      await client.installFramework(def);
      await client.saveMyFramework({ framework: fwName, version: mine?.version ?? 0, edgeTags: [] });
      await reload();
      setInstallOpen(false);
      setInstallName('');
      setInstallDesc('');
      notify(`Installed “${name}” ✓ — export it from the list to share; your working framework is empty again`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Load a framework FILE into the working framework — the editable
   *  path. Merges: your existing relations stay, the file's join them. The load wall
   *: names a built-in holds skip (mint refuses those too); names the
   *  SUGAR GRAMMAR can't lex refuse (underscores/spaces/colons — a name you couldn't type,
   *  and a colon would misparse as the subtype grammar); case-twins of active names refuse
   *  (display lowercases, so `Echoestheme` beside `EchoesTheme` would wear identical words). */
  const loadIntoMine = async (raw: string) => {
    const def = JSON.parse(raw) as Partial<FrameworkFile>;
    if (!Array.isArray(def.edgeTags)) throw new Error('no edgeTags list');
    const inMine = new Set(relations.map((t) => t.name));
    const builtinNames = new Set(BAKED.flatMap((f) => (f.edgeTags as readonly { name: string }[]).map((t) => t.name)));
    const wellFormed = (t: Partial<FrameworkEdgeTag>): t is FrameworkEdgeTag =>
      typeof t.name === 'string' && typeof t.on?.type === 'string' && (t.direction === 'directed' || t.direction === 'symmetric');
    // The tag grammar's name charset (schema/tags TAG_RE): leading alnum, then alnum/hyphen.
    const lexable = (n: string): boolean => /^[a-z0-9][a-z0-9-]*$/i.test(n);
    const activeLower = new Map<string, string>();
    for (const n of takenNames) activeLower.set(n.toLowerCase(), n);
    let held = 0;
    let malformed = 0;
    let twins = 0;
    const fresh: FrameworkEdgeTag[] = [];
    for (const t of def.edgeTags as Partial<FrameworkEdgeTag>[]) {
      if (!wellFormed(t) || !lexable(t.name)) {
        malformed += 1;
        continue;
      }
      if (inMine.has(t.name) || builtinNames.has(t.name)) {
        held += 1;
        continue;
      }
      const twin = activeLower.get(t.name.toLowerCase());
      if ((twin !== undefined && twin !== t.name) || fresh.some((f) => f.name.toLowerCase() === t.name.toLowerCase())) {
        twins += 1;
        continue;
      }
      fresh.push(t);
    }
    // ENTITY tags ride the same load (a flavor vocabulary like inquiry's #hypothesis is most
    // of some frameworks' point) — same wall: lexable names, dedup against mine + built-ins.
    const entityHeld = new Set([
      ...mineEntityTags.map((t) => t.name),
      ...BAKED.flatMap((f) => (((f as unknown as { entityTags?: readonly { name: string }[] }).entityTags ?? []).map((t) => t.name))),
    ]);
    const freshEntity: { name: string }[] = [];
    for (const t of (Array.isArray(def.entityTags) ? def.entityTags : []) as { name?: unknown }[]) {
      if (typeof t.name !== 'string' || !lexable(t.name)) {
        malformed += 1;
        continue;
      }
      if (entityHeld.has(t.name) || freshEntity.some((f) => f.name === t.name)) {
        held += 1;
        continue;
      }
      freshEntity.push(t as { name: string });
    }
    const reasons = [
      held > 0 ? `${held} already held` : '',
      malformed > 0 ? `${malformed} unloadable name${malformed === 1 ? '' : 's'} (letters, digits, hyphens only)` : '',
      twins > 0 ? `${twins} case-twin${twins === 1 ? '' : 's'} of an existing name` : '',
    ].filter((r) => r !== '');
    if (fresh.length === 0 && freshEntity.length === 0) {
      throw new Error(`nothing to load — ${reasons.length > 0 ? reasons.join(', ') : 'the file declares no relations'}`);
    }
    const loadedBits = [
      fresh.length > 0 ? `${fresh.length} relation${fresh.length === 1 ? '' : 's'}` : '',
      freshEntity.length > 0 ? `${freshEntity.length} entity tag${freshEntity.length === 1 ? '' : 's'}` : '',
    ].filter((b) => b !== '');
    await saveMine(
      [...relations, ...fresh],
      `Loaded ${loadedBits.join(' + ')} into your framework — edit away${reasons.length > 0 ? ` (skipped: ${reasons.join(', ')})` : ''}`,
      [...mineEntityTags, ...freshEntity],
    );
  };

  const toggleInstalled = (name: string) => {
    const cur = new Set(view?.disabledInstalled ?? []);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    setBusy(true);
    void client
      .setDisabledInstalled([...cur])
      .then(reload)
      .catch((e: Error) => notify(e.message))
      .finally(() => setBusy(false));
  };

    if (view === undefined) return null;

  return (
    <section className="settings-section fwed">
      <h3>◇ {displayName}</h3>
      <p className="settings-note">
        Your own relations between concepts — they join every picker and draw on every map the moment they exist.
        When a set feels complete, install it as a NAMED framework: it moves to the installed list below, ready to
        toggle, export, and share, and this working area starts fresh.
      </p>
      {relations.length > 0 && (
        <ul className="fwed-list">
          {relations.map((t) => (
            <li key={t.name} className="fwed-row">
              <span className="fwed-word">{wordOf(t.name)}</span>
              {t.direction === 'directed' && t.inverseLabel !== undefined && <span className="fwed-inverse">⇄ {t.inverseLabel}</span>}
              {t.direction === 'symmetric' && <span className="fwed-inverse">symmetric</span>}
              <span className="fwed-mark">{t.render ?? 'line'}{t.polarity !== undefined ? ` · ${t.polarity}` : ''}</span>
              <button type="button" className="fwed-icon" title="edit" onClick={() => startEdit(t)}><PencilSimple size={13} /></button>
              <button type="button" className="fwed-icon" title="remove" onClick={() => void remove(t)}><TrashSimple size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      {mineEntityTags.length > 0 && (
        <div className="fwed-enttags">
          <span className="fwed-enttags-label">entity tags:</span>
          {mineEntityTags.map((t) => (
            <span key={t.name} className="connection-chip" title={[t.description, t.on !== undefined ? `on: ${t.on.join(', ')}` : ''].filter(Boolean).join(' — ')}>
              #{t.name}
              <button
                type="button"
                className="fwed-chip-x"
                title="remove from your framework — entities wearing the tag keep it, undeclared"
                onClick={() => void saveMine(relations, `Removed “#${t.name}” from your framework`, mineEntityTags.filter((x) => x.name !== t.name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="fwed-actions fwed-load">
        <label className="pm-btn" title="bring a framework file's relations INTO your working framework, editable — unlike Install from file, which keeps it sealed and read-only">
          Load from file…
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file === undefined) return;
              void file
                .text()
                .then(loadIntoMine)
                .catch((err: Error) => notify(`Couldn't load: ${err.message}`));
            }}
          />
        </label>
        {relations.length > 0 && (
          <button
            type="button"
            className="pm-btn"
            disabled={busy}
            title="name this set and move it to your installed frameworks — the working area starts fresh"
            onClick={() => setInstallOpen(true)}
          >
            Install as framework…
          </button>
        )}
      </div>
      <div className="fwed-form">
        <div className="fwed-grid">
          <input
            value={label}
            placeholder="relation — e.g. “disputes with”"
            onChange={(e) => {
              setLabel(e.target.value);
              setRenameWarn(undefined);
            }}
          />
          <input
            value={inverse}
            placeholder="reads back as — e.g. “disputed by”"
            disabled={direction === 'symmetric'}
            onChange={(e) => setInverse(e.target.value)}
          />
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'directed' | 'symmetric')} title="does the relation read differently from each end?">
            <option value="directed">directed</option>
            <option value="symmetric">symmetric</option>
          </select>
          {/* A valence IS a mark (green bow / red dash), so the two pickers are exclusive —
              an explicit mark would out-precedence the valence hue and read as a bug. */}
          <select value={mark} disabled={polarity !== 'none'} onChange={(e) => setMark(e.target.value as Mark)} title="how the maps draw it">
            <option value="line">connection (line)</option>
            <option value="group">group (hull)</option>
            <option value="comet">comet (tapered)</option>
          </select>
          <select
            value={polarity}
            onChange={(e) => {
              const v = e.target.value as Polarity;
              setPolarity(v);
              if (v !== 'none') setMark('line');
            }}
            title="epistemic valence — green for, red against"
          >
            <option value="none">no valence</option>
            <option value="for">for (green)</option>
            <option value="against">against (red)</option>
          </select>
          <MarkPreview mark={mark} polarity={polarity} />
        </div>
        <input className="fwed-desc" value={description} placeholder="what it means (shown on hover) — optional" onChange={(e) => setDescription(e.target.value)} />
        {renameWarn !== undefined && (
          <div className="fwed-warn" role="alert">
            <span>
              “{wordOf(renameWarn.from)}” has {renameWarn.count} existing tie{renameWarn.count === 1 ? '' : 's'} — a rename
              won't touch them: they keep the old name and render generic. This mints a NEW relation.
            </span>
            <span className="fwed-warn-actions">
              <button
                type="button"
                className="pm-btn"
                onClick={() => {
                  setLabel(wordOf(renameWarn.from));
                  setRenameWarn(undefined);
                }}
              >
                Keep the name
              </button>
              <button type="button" className="pm-btn" disabled={busy} onClick={() => void submit(true)}>
                Rename anyway
              </button>
            </span>
          </div>
        )}
        <div className="fwed-actions">
          {editingName !== undefined && (
            <button type="button" className="pm-btn" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button type="button" className="pm-btn primary" disabled={busy || label.trim() === ''} onClick={() => void submit()}>
            {editingName !== undefined ? 'Update relation' : '+ Mint relation'}
          </button>
        </div>
      </div>
      {installOpen && (
        <div className="pm-modal-scrim" onClick={() => setInstallOpen(false)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Name this framework</h2>
            <p className="settings-note">
              Your {relations.length} working relation{relations.length === 1 ? '' : 's'} become a named framework in
              the installed list — toggleable, exportable, shareable. Your working framework starts fresh.
            </p>
            <input
              value={installName}
              placeholder="name — e.g. “logic lenses”"
              autoFocus
              onChange={(e) => setInstallName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void installAsFramework(); }}
            />
            <input
              value={installDesc}
              placeholder="what it's for (shown in the list) — optional"
              onChange={(e) => setInstallDesc(e.target.value)}
            />
            {fwNameOf(installName) !== '' && fwNameOf(installName) !== installName.trim() && (
              <p className="settings-meta">will be named “{fwNameOf(installName)}”</p>
            )}
            <div className="fwed-actions">
              <button type="button" className="pm-btn" onClick={() => setInstallOpen(false)}>Cancel</button>
              <button type="button" className="pm-btn primary" disabled={busy || fwNameOf(installName) === ''} onClick={() => void installAsFramework()}>
                Install
              </button>
            </div>
          </div>
        </div>
      )}

      <h3 className="fwed-h2">Built-in frameworks</h3>
      <p className="settings-note">
        Core is always on — it is the app's own vocabulary. The specialist built-ins are opt-in: turn one on and
        its relations join your pickers and maps.
      </p>
      <ul className="fwed-list">
        {(view.builtin ?? []).map((f) => {
          const isCore = f.framework === CORE_FRAMEWORK;
          const on = isCore || (view.enabledBuiltins ?? []).includes(f.framework);
          return (
            <li key={f.framework} className="fwed-row">
              <span className="fwed-word">{f.framework}</span>
              {f.description !== undefined && <span className="fwed-from" title={f.description}>{f.description.slice(0, 60)}…</span>}
              {isCore && <span className="fwed-state">always on</span>}
              <button
                type="button"
                role="switch"
                aria-checked={on}
                className={`fwed-switch${on ? ' on' : ''}`}
                disabled={isCore || busy}
                title={isCore ? 'core is always on' : on ? 'turn off' : 'turn on'}
                onClick={() => {
                  const cur = new Set(view.enabledBuiltins ?? []);
                  if (cur.has(f.framework)) cur.delete(f.framework);
                  else cur.add(f.framework);
                  setBusy(true);
                  void client
                    .setEnabledBuiltins([...cur])
                    .then(reload)
                    .catch((e: Error) => notify(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <span className="fwed-knob" />
              </button>
            </li>
          );
        })}
      </ul>

      {(view.installed ?? []).length > 0 && (
        <>
          <h3 className="fwed-h2">Installed frameworks</h3>
          <ul className="fwed-list">
            {(view.installed ?? []).map((f) => {
              const on = !(view.disabledInstalled ?? []).includes(f.framework);
              const idx = activeFrameworks().findIndex((x) => x.framework === f.framework);
              const earlier = new Set(
                idx > 0 ? activeFrameworks().slice(0, idx).flatMap((x) => x.edgeTags.map((t) => t.name)) : [],
              );
              const shadowed = on ? f.edgeTags.filter((t) => earlier.has(t.name)).length : 0;
              return (
                <li key={f.framework} className="fwed-row">
                  <span className="fwed-word">{f.framework}</span>
                  <span className="fwed-from">
                    v{f.version}
                    {f.author !== undefined ? ` by ${f.author}` : ''}
                    {f.description !== undefined ? ` — ${f.description.slice(0, 40)}…` : ''}
                    {shadowed > 0 ? ` · ${shadowed} relation${shadowed === 1 ? '' : 's'} shadowed by earlier frameworks` : ''}
                  </span>
                  <button
                    type="button"
                    className="fwed-icon"
                    title="download as a file — hand it to anyone, they Install from file"
                    onClick={() => downloadFramework(f)}
                  >
                    <DownloadSimple size={13} />
                  </button>
                  <button
                    type="button"
                    className="fwed-icon"
                    title="remove — existing ties keep the tags and render generic"
                    onClick={() => {
                      setBusy(true);
                      void client.removeFramework(f.framework).then(reload).catch((e: Error) => notify(e.message)).finally(() => setBusy(false));
                    }}
                  >
                    <TrashSimple size={13} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    className={`fwed-switch${on ? ' on' : ''}`}
                    disabled={busy}
                    title={on ? 'on — its relations are in your pickers and maps' : 'off — ties keep the tags and render generic'}
                    onClick={() => toggleInstalled(f.framework)}
                  >
                    <span className="fwed-knob" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The MAP tab: local draw preferences over everyone's declarations —
 *  each relation's dropdown NAMES the declared default ("comet (default)"), and core edge
 *  types can leave the maps. Store-document state: never travels. */
export function MapDrawSettings() {
  const { client, notify } = useEngine();
  const [view, setView] = useState<FrameworksView | undefined>();
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const v = await client.frameworks();
    setView(v);
    applyFrameworksView(v);
    return v;
  };
  useEffect(() => {
    void reload().catch(() => setView(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const overrides: ViewOverrides = view?.viewOverrides ?? { tags: {}, types: {} };
  const rows = useMemo(
    () =>
      (view === undefined ? [] : activeList(view)).flatMap((f) =>
        f.edgeTags
          .filter((t) => t.on.type === 'LINK')
          .map((t) => ({ ...t, from: f.framework })),
      ),
    [view],
  );
  // Representative endpoint kinds per core TYPE (some allow more pairs — the icons show the
  // canonical reading; the tooltip stays the honest list).
  const HIDEABLE_TYPES: { type: string; src: string; dst: string }[] = [
    { type: 'ABOUT', src: 'source', dst: 'concept' },
    { type: 'CLARIFIES', src: 'snippet', dst: 'concept' },
    { type: 'CONTRADICTS', src: 'snippet', dst: 'concept' },
    { type: 'RAISES', src: 'source', dst: 'question' },
    { type: 'ANSWERS', src: 'source', dst: 'question' },
    { type: 'PREREQUISITE_OF', src: 'concept', dst: 'concept' },
    { type: 'PRECEDES', src: 'source', dst: 'source' },
  ];

  const saveOverrides = async (next: ViewOverrides) => {
    setBusy(true);
    try {
      await client.saveViewOverrides(next);
      await reload();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const setTagOverride = (tag: string, value: string) => {
    const tags = { ...overrides.tags };
    if (value === 'default') delete tags[tag];
    else tags[tag] = value as ViewOverrides['tags'][string];
    void saveOverrides({ ...overrides, tags });
  };
  const toggleType = (type: string) => {
    const types = { ...overrides.types };
    if (types[type] !== undefined) delete types[type];
    else types[type] = 'hidden';
    void saveOverrides({ ...overrides, types });
  };
  /** What the declaration draws when you don't override — named IN the dropdown. */
  const defaultWordOf = (t: FrameworkEdgeTag): string =>
    t.render ?? (t.polarity === 'for' ? 'for (green)' : t.polarity === 'against' ? 'against (red)' : 'line');

  if (view === undefined) return null;

  return (
    <section className="settings-section fwed">
      <h3>◇ How relations draw on your map</h3>
      <p className="settings-note">
        Your reading preferences over every active vocabulary — restyle or hide. Local to this library; never
        travels with a publish or an export.
      </p>
      <ul className="fwed-list">
        {rows.map((t) => (
          <li key={`${t.from}:${t.name}`} className="fwed-row">
            <span className="fwed-rel">
              <KindGlyph kind={t.on.srcKind} />
              <span className="connection-chip">{wordOf(t.name)}</span>
              <KindGlyph kind={t.on.dstKind} />
            </span>
            <span className="fwed-from">{t.from}</span>
            <select
              value={overrides.tags[t.name] ?? 'default'}
              disabled={busy}
              onChange={(e) => setTagOverride(t.name, e.target.value)}
              title="how this library draws it"
            >
              <option value="default">{defaultWordOf(t)} (default)</option>
              <option value="line">connection</option>
              <option value="group">group</option>
              <option value="comet">comet</option>
              <option value="hidden">hidden</option>
            </select>
          </li>
        ))}
      </ul>
      <h3 className="fwed-h2">Core connections</h3>
      <div className="fwed-types">
        {HIDEABLE_TYPES.map(({ type: ty, src, dst }) => {
          const shown = overrides.types[ty] === undefined;
          return (
            <button
              key={ty}
              type="button"
              className={shown ? 'fwed-token on' : 'fwed-token'}
              aria-pressed={shown}
              disabled={busy}
              title={shown ? 'shown on the maps — click to hide' : 'hidden from the maps — click to show'}
              onClick={() => toggleType(ty)}
            >
              <KindGlyph kind={src} />
              {ty.toLowerCase().replace(/_/g, ' ')}
              <KindGlyph kind={dst} />
            </button>
          );
        })}
      </div>
      <p className="settings-meta">Dimmed edge types leave the maps (they still exist, export, and list).</p>
    </section>
  );
}
