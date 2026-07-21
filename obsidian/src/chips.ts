/**
 * The embed renderer (plan OB-S3): `pm:<id>` inline-code tokens in a note render as LIVE
 * entity chips — kind glyph + kind colour + current label, click-through to the workbench's
 * deep link (`#item=<id>`, OB-S2). The note stores ONLY the stable id (OB3): labels, state,
 * and server location come from the index at render time, so nothing written into a note ever
 * needs maintenance. Vanilla Obsidian (plugin missing) degrades to the visible `pm:…` token.
 *
 * Reading view only for now: Obsidian's post-processors don't run over live-preview inline
 * code; a CodeMirror widget for editing view is OB-S3 polish, tracked in the plan.
 */
import { MarkdownRenderer, TFile } from 'obsidian';
import { api } from './api';
import type { EntityIndex, EntityKind } from './entities';
import { findBoundNote } from './template';
import type PhilomaticPlugin from './main';

/** `pm:` + a typed id — slug ids (hyphens), hash ids, and explicit human ids (underscores). */
const TOKEN = /^pm:((?:syl|cpt|src|snp|qst)_[\w-]+)$/;

/** The workbench's kind glyphs (Phosphor regular paths — same set the popup embeds; duplicated
 *  here because this workspace may not import repo src/, by lock-line rule OB1). */
const KIND_PATHS: Record<EntityKind, string> = {
  source:
    'M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z',
  snippet:
    'M100,56H40A16,16,0,0,0,24,72v64a16,16,0,0,0,16,16h60v8a32,32,0,0,1-32,32,8,8,0,0,0,0,16,48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,100,56Zm0,80H40V72h60ZM216,56H156a16,16,0,0,0-16,16v64a16,16,0,0,0,16,16h60v8a32,32,0,0,1-32,32,8,8,0,0,0,0,16,48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,216,56Zm0,80H156V72h60Z',
  question:
    'M140,180a12,12,0,1,1-12-12A12,12,0,0,1,140,180ZM128,72c-22.06,0-40,16.15-40,36v4a8,8,0,0,0,16,0v-4c0-11,10.77-20,24-20s24,9,24,20-10.77,20-24,20a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-.72c18.24-3.35,32-17.9,32-35.28C168,88.15,150.06,72,128,72Zm104,56A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
  concept:
    'M235.33,116.72,139.28,20.66a16,16,0,0,0-22.56,0l-96,96.06a16,16,0,0,0,0,22.56l96.05,96.06h0a16,16,0,0,0,22.56,0l96.05-96.06a16,16,0,0,0,0-22.56ZM128,224h0L32,128,128,32,224,128Z',
  track:
    'M176,160a39.89,39.89,0,0,0-28.62,12.09l-46.1-29.63a39.8,39.8,0,0,0,0-28.92l46.1-29.63a40,40,0,1,0-8.66-13.45l-46.1,29.63a40,40,0,1,0,0,55.82l46.1,29.63A40,40,0,1,0,176,160Zm0-128a24,24,0,1,1-24,24A24,24,0,0,1,176,32ZM64,152a24,24,0,1,1,24-24A24,24,0,0,1,64,152Zm112,72a24,24,0,1,1,24-24A24,24,0,0,1,176,224Z',
};

/** The user-facing word per kind (a track is a "track" everywhere in the product). */
const KIND_WORDS: Record<EntityKind, string> = {
  track: 'track',
  concept: 'concept',
  source: 'source',
  snippet: 'snippet',
  question: 'question',
};

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The human word for an edge — the workbench's relationWord (ui/src/lib/relations.ts),
 *  duplicated by lock-line necessity: framework tags carry the meaning of LINK/ABOUT edges. */
const spacedTag = (t: string): string =>
  t.replace(/^#/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const relationWord = (type: string, tags: readonly string[]): string => {
  if (tags.length > 0) return tags.map(spacedTag).join(', ');
  if (type === 'LINK') return 'related to';
  return type.toLowerCase().replace(/_syl$/, '').replace(/_/g, ' ');
};

interface RelationRow {
  direction: 'out' | 'in';
  type: string;
  tags: string[];
  otherId: string;
  otherKind: EntityKind;
  otherLabel: string;
}

/** The Library detail view's Connections list, on a card ("Always show connections"). */
async function renderConnections(plugin: PhilomaticPlugin, host: HTMLElement, id: string, excludeQuestionTies = false): Promise<void> {
  try {
    const r = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(id)}`);
    host.empty();
    const rows = [...r.relations]
      .filter((x) => !(excludeQuestionTies && x.otherKind === 'question' && (x.type === 'RAISES' || x.type === 'ANSWERS')))
      .sort((a, b) => a.otherLabel.localeCompare(b.otherLabel) || a.type.localeCompare(b.type));
    if (rows.length === 0) {
      host.remove();
      return;
    }
    for (const rel of rows) {
      const row = host.createDiv({ cls: 'pm-conn' });
      const word = relationWord(rel.type, rel.tags);
      row.createSpan({ cls: 'pm-conn-word', text: rel.direction === 'out' ? `${word} →` : `← ${word}` });
      row.createSpan({ cls: `pm-conn-other pm-${rel.otherKind}`, text: trunc(rel.otherLabel, 70) });
      row.addEventListener('click', (e) => {
        e.stopPropagation(); // the card's own click opens the card's entity
        void plugin.openLibrary(rel.otherId);
      });
    }
  } catch {
    host.remove(); // unreachable — the card body still renders
  }
}

/** A snippet or question token standing alone as its own paragraph renders as a CARD
 *  (blockquote-style box, full text, a footer line) instead of an inline chip: snippets get
 *  their source attribution, questions their overlay state (open / answered). */
function decorateCard(plugin: PhilomaticPlugin, card: HTMLElement, id: string, index: EntityIndex, showTies = true): void {
  const info = index.get(id);
  const kind: EntityKind = info?.kind ?? (id.startsWith('qst_') ? 'question' : 'snippet');
  card.className = `philomatic-card pm-${kind} ${info ? '' : index.loaded ? 'pm-unknown' : 'pm-pending'}`.trim();
  card.replaceChildren();
  if (!info) {
    card.createSpan({ text: id, cls: 'pm-label' });
    card.setAttribute(
      'aria-label',
      index.loaded ? 'not in your Philomatic library' : 'Philomatic server unreachable — will render when it connects',
    );
    return;
  }
  const body = card.createDiv({ cls: 'pm-card-quote' });
  const svg = body.createSvg('svg', {
    attr: { viewBox: '0 0 256 256', width: '13', height: '13', fill: 'currentColor', 'aria-hidden': 'true' },
  });
  svg.createSvg('path', { attr: { d: KIND_PATHS[kind] } });
  if (kind === 'snippet') {
    // The snippet-markdown contract renders through the HOST's renderer: native look, and
    // $math$ typesets via Obsidian's own MathJax — enforcement by delegation.
    const text = body.createSpan({ cls: 'pm-card-text pm-card-md' });
    void MarkdownRenderer.render(plugin.app, info.label, text, '', plugin);
  } else {
    body.createSpan({ text: info.label, cls: 'pm-card-text' });
  }

  if (kind === 'question') {
    const state = index.stateOf(id);
    const line = state?.answered ? '✓ answered' : state?.gap ? 'open — nothing in your corpus answers it yet' : 'open question';
    card.createDiv({ cls: 'pm-card-src', text: line });
    card.setAttribute('aria-label', `question (${state?.answered ? 'answered' : 'open'}) — open in Philomatic`);
  } else {
    const source = index.sourceOf(id);
    if (source) card.createDiv({ cls: 'pm-card-src', text: `— ${source.label}` });
    card.setAttribute('aria-label', `snippet${source ? ` from ${source.label}` : ''} — open in Philomatic`);
    // Question ties render on snippet cards (the source-note structure), visually split:
    // ? raises (rose) vs ✓ answers (green). The detailed block nests full cards instead.
    if (showTies) {
      const ties = card.createDiv({ cls: 'pm-card-ties' });
      void renderQuestionTies(plugin, ties, id);
    }
  }
}

/** A snippet's question ties — raised vs answered, visually distinct. */
async function renderQuestionTies(plugin: PhilomaticPlugin, host: HTMLElement, id: string): Promise<void> {
  try {
    const r = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(id)}`);
    host.empty();
    const ties = r.relations.filter((x) => x.otherKind === 'question' && (x.type === 'RAISES' || x.type === 'ANSWERS'));
    if (ties.length === 0) {
      host.remove();
      return;
    }
    for (const tie of ties) {
      const raises = tie.type === 'RAISES';
      const row = host.createDiv({ cls: `pm-tie ${raises ? 'pm-tie-raises' : 'pm-tie-answers'}` });
      row.createSpan({ cls: 'pm-tie-badge', text: raises ? '? raises' : '✓ answers' });
      row.createSpan({ cls: 'pm-tie-text', text: trunc(tie.otherLabel, 80) });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void plugin.openLibrary(tie.otherId);
      });
    }
  } catch {
    host.remove();
  }
}

/** The contract's plain-text projection for one-line labels (chips, aria) — markup is noise there. */
const stripMd = (t: string): string =>
  t
    .replace(/!\[([^\]\n]*)\]\([^)\s\n]+\)/g, (_m, alt: string) => (alt.trim() !== '' ? alt.trim() : 'image'))
    .replace(/\$\$([^$]+)\$\$/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

function decorate(chip: HTMLElement, id: string, index: EntityIndex): void {
  const info = index.get(id);
  chip.className = `philomatic-chip ${info ? `pm-${info.kind}` : index.loaded ? 'pm-unknown' : 'pm-pending'}`;
  chip.replaceChildren();
  if (info) {
    const svg = chip.createSvg('svg', {
      attr: { viewBox: '0 0 256 256', width: '12', height: '12', fill: 'currentColor', 'aria-hidden': 'true' },
    });
    svg.createSvg('path', { attr: { d: KIND_PATHS[info.kind] } });
    chip.createSpan({ text: trunc(info.kind === 'snippet' ? stripMd(info.label) : info.label, 60), cls: 'pm-label' });
    chip.setAttribute('aria-label', `${KIND_WORDS[info.kind]}: ${info.label} — open in Philomatic`);
  } else {
    chip.createSpan({ text: id, cls: 'pm-label' });
    chip.setAttribute(
      'aria-label',
      index.loaded ? 'not in your Philomatic library' : 'Philomatic server unreachable — will render when it connects',
    );
  }
}

export function registerChips(plugin: PhilomaticPlugin, index: EntityIndex): void {
  const alive = new Set<{ el: HTMLElement; id: string; card: boolean }>();

  plugin.registerMarkdownPostProcessor((root) => {
    for (const code of Array.from(root.querySelectorAll('code'))) {
      const match = TOKEN.exec(code.textContent ?? '');
      if (!match) continue;
      const id = match[1]!;

      // A snippet or question token that IS its paragraph upgrades to a card; the kind is
      // knowable from the id prefix alone, so this needs no data. Everything else is a chip.
      const para = code.parentElement;
      const card =
        (id.startsWith('snp_') || id.startsWith('qst_')) &&
        para !== null &&
        para.tagName === 'P' &&
        para.childElementCount === 1 &&
        (para.textContent ?? '').trim() === (code.textContent ?? '').trim();

      const el = card ? createDiv() : createSpan();
      el.addEventListener('click', () => void plugin.openLibrary(id));
      if (card) {
        decorateCard(plugin, el, id, index);
        para.replaceWith(el);
      } else {
        decorate(el, id, index);
        code.replaceWith(el);
      }
      alive.add({ el, id, card });
    }
  });

  // The live HEADER BLOCKS (source/track notes, OB10): a ```philomatic fence declaring
  // `source: <id>` or `track: <id>` renders that entity's header — fetched fresh, so the note
  // "syncs" by never storing anything to sync.
  const blocks = new Set<{ el: HTMLElement; render: () => void }>();
  plugin.registerMarkdownCodeBlockProcessor('philomatic', (sourceText, el, ctx) => {
    // `map: this-note` — the Map view, scoped to every entity referenced in THIS document
    // (pm: tokens + the frontmatter bindings), computed fresh at render time and hosted
    // as a chromeless workbench iframe (#map=<ids>&embed).
    const mapMatch = /map:\s*(\S+)/.exec(sourceText);
    if (mapMatch) {
      el.addClass('pm-map-embed');
      const heightMatch = /height:\s*(\d+)/.exec(sourceText);
      void renderMapEmbed(plugin, el, ctx.sourcePath, heightMatch ? Number(heightMatch[1]) : 340);
      return;
    }
    // Header blocks dispatch on the ID (the key word is a courtesy): src_ → source header,
    // syl_ → track header, snp_ → detailed snippet (question boxes nested, relations below),
    // cpt_/qst_ → the entity itself with its relations below.
    const idMatch = /(?:source|track|snippet|concept|question):\s*(\S+)/.exec(sourceText);
    if (!idMatch) {
      el.createSpan({ text: 'philomatic block: expected `<kind>: <id>` (source/track/snippet/concept/question) or `map: this-note`' });
      return;
    }
    const id = idMatch[1]!;
    el.addClass('pm-source-block');
    const kindClass: Record<string, string> = {
      syl_: 'pm-track-block',
      snp_: 'pm-snippet-block',
      cpt_: 'pm-concept-block',
      qst_: 'pm-question-block',
    };
    for (const [prefix, cls] of Object.entries(kindClass)) if (id.startsWith(prefix)) el.addClass(cls);
    const render = id.startsWith('syl_')
      ? (): void => void renderTrackBlock(plugin, index, el, id)
      : id.startsWith('snp_')
        ? (): void => void renderSnippetBlock(plugin, index, el, id)
        : id.startsWith('cpt_') || id.startsWith('qst_')
          ? (): void => renderEntityBlock(plugin, index, el, id)
          : (): void => void renderSourceBlock(plugin, index, el, id);
    blocks.add({ el, render });
    render();
  });

  // Live: when the index refreshes (any client wrote, or the server came back), re-render every
  // embed still in a rendered document; prune the rest.
  plugin.register(
    index.onChange(() => {
      for (const entry of [...alive]) {
        if (!entry.el.isConnected) {
          alive.delete(entry);
          continue;
        }
        if (entry.card) decorateCard(plugin, entry.el, entry.id, index);
        else decorate(entry.el, entry.id, index);
      }
      for (const block of [...blocks]) {
        if (!block.el.isConnected) {
          blocks.delete(block);
          continue;
        }
        block.render();
      }
    }),
  );
}

/** Every entity referenced in a document: pm: tokens anywhere + the frontmatter binding. */
async function referencedIds(plugin: PhilomaticPlugin, sourcePath: string): Promise<string[]> {
  const ids = new Set<string>();
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (file instanceof TFile) {
    const content = await plugin.app.vault.cachedRead(file);
    for (const m of content.matchAll(/pm:((?:syl|cpt|src|snp|qst)_[\w-]+)/g)) ids.add(m[1]!);
    const fm = plugin.app.metadataCache.getCache(sourcePath)?.frontmatter;
    for (const key of ['philomatic-source', 'philomatic-track']) {
      const bound = fm?.[key];
      if (typeof bound === 'string') ids.add(bound);
    }
  }
  return [...ids];
}

/** The scoped Map embed: the real workbench in a chromeless iframe, ids computed live. */
async function renderMapEmbed(plugin: PhilomaticPlugin, host: HTMLElement, sourcePath: string, height: number): Promise<void> {
  const ids = await referencedIds(plugin, sourcePath);
  host.empty();
  if (ids.length === 0) {
    host.createDiv({ cls: 'pm-src-missing', text: 'no Philomatic entities referenced in this note yet' });
    return;
  }
  const base = plugin.settings.serverUrl.trim().replace(/\/+$/, '');
  const iframe = host.createEl('iframe');
  iframe.src = `${base}/#map=${ids.map(encodeURIComponent).join(',')}&embed`;
  iframe.style.height = `${height}px`;
}

/** The track note's `## Track` block: title row (track glyph, clickable), a metadata line
 *  (goal, member counts, tags) — concepts/reading order live in the note's own sections. */
async function renderTrackBlock(
  plugin: PhilomaticPlugin,
  index: EntityIndex,
  host: HTMLElement,
  trackId: string,
): Promise<void> {
  interface TrackMeta {
    id: string;
    title: string;
    goal?: string;
    tags: string[];
    sourceIds: string[];
    sourceLevels: string[][];
  }
  try {
    const [snap, rel] = await Promise.all([
      api<{ tracks: TrackMeta[] }>(plugin.settings, '/snapshot'),
      api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(trackId)}`),
    ]);
    host.empty();
    const meta = snap.tracks.find((s) => s.id === trackId);
    if (!meta) {
      host.createDiv({ cls: 'pm-src-missing', text: index.loaded ? `${trackId} — not in your library` : trackId });
      return;
    }

    const head = host.createDiv({ cls: 'pm-src-head' });
    const svg = head.createSvg('svg', {
      attr: { viewBox: '0 0 256 256', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' },
    });
    svg.createSvg('path', { attr: { d: KIND_PATHS.track } });
    head.createSpan({ cls: 'pm-src-title', text: meta.title });
    head.addEventListener('click', () => void plugin.openLibrary(trackId));

    const conceptCount = rel.relations.filter((r) => r.type === 'INCLUDES' && r.direction === 'out' && r.otherKind === 'concept').length;
    const line = host.createDiv({ cls: 'pm-src-meta' });
    const bits = [
      ...(meta.goal !== undefined && meta.goal !== '' ? [meta.goal] : []),
      `${meta.sourceIds.length} source${meta.sourceIds.length === 1 ? '' : 's'}`,
      `${conceptCount} concept${conceptCount === 1 ? '' : 's'}`,
      ...meta.tags,
    ];
    line.setText(bits.join(' · '));

    // The members, in reading order, each chip paired with its vault note (found live by
    // binding, so renames just work).
    const list = host.createDiv({ cls: 'pm-track-sources' });
    for (const srcId of meta.sourceLevels.flat()) {
      const row = list.createDiv({ cls: 'pm-track-src-row' });
      const chip = row.createSpan();
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        void plugin.openLibrary(srcId);
      });
      decorate(chip, srcId, index);
      const note = findBoundNote(plugin, 'philomatic-source', srcId);
      if (note) {
        row.createSpan({ cls: 'pm-track-note-label', text: '— Note:' });
        const a = row.createEl('a', { cls: 'internal-link pm-track-note-link', text: note.basename });
        a.addEventListener('click', (e) => {
          e.preventDefault();
          void plugin.app.workspace.openLinkText(note.path, '', false);
        });
      }
    }
  } catch {
    if (host.childElementCount === 0) {
      host.createDiv({ cls: 'pm-src-missing', text: 'Philomatic server unreachable — this block renders when it connects' });
    }
  }
}

/** The detailed concept/question block: the entity itself (question = its state card,
 *  concept = a header row) with its relations listed below. */
function renderEntityBlock(plugin: PhilomaticPlugin, index: EntityIndex, host: HTMLElement, id: string): void {
  host.empty();
  if (id.startsWith('qst_')) {
    const card = host.createDiv();
    card.addEventListener('click', () => void plugin.openLibrary(id));
    decorateCard(plugin, card, id, index);
  } else {
    const info = index.get(id);
    if (!info) {
      host.createDiv({ cls: 'pm-src-missing', text: index.loaded ? `${id} — not in your library` : id });
      return;
    }
    const head = host.createDiv({ cls: 'pm-src-head' });
    const svg = head.createSvg('svg', {
      attr: { viewBox: '0 0 256 256', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' },
    });
    svg.createSvg('path', { attr: { d: KIND_PATHS[info.kind] } });
    head.createSpan({ cls: 'pm-src-title', text: info.label });
    head.addEventListener('click', () => void plugin.openLibrary(id));
  }
  const conns = host.createDiv({ cls: 'pm-card-conns' });
  void renderConnections(plugin, conns, id);
}

/** The detailed snippet block (`snippet: snp_…` fence): the quote card with its question
 *  BOXES nested inside — full state cards, badged raised vs answered — and the snippet's
 *  other relations listed below. Replaces the "Always show connections" setting. */
async function renderSnippetBlock(
  plugin: PhilomaticPlugin,
  index: EntityIndex,
  host: HTMLElement,
  snippetId: string,
): Promise<void> {
  try {
    const rel = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(snippetId)}`);
    host.empty();

    const quote = host.createDiv();
    quote.addEventListener('click', () => void plugin.openLibrary(snippetId));
    decorateCard(plugin, quote, snippetId, index, false);

    const ties = rel.relations.filter((r) => r.otherKind === 'question' && (r.type === 'RAISES' || r.type === 'ANSWERS'));
    for (const tie of ties) {
      const raises = tie.type === 'RAISES';
      const wrap = host.createDiv({ cls: `pm-nested ${raises ? 'pm-tie-raises' : 'pm-tie-answers'}` });
      wrap.createDiv({ cls: 'pm-tie-badge', text: raises ? '? raises' : '✓ answers' });
      const qcard = wrap.createDiv();
      qcard.addEventListener('click', () => void plugin.openLibrary(tie.otherId));
      decorateCard(plugin, qcard, tie.otherId, index);
    }

    const conns = host.createDiv({ cls: 'pm-card-conns' });
    void renderConnections(plugin, conns, snippetId, true); // question ties are the boxes above
  } catch {
    if (host.childElementCount === 0) {
      host.createDiv({ cls: 'pm-src-missing', text: 'Philomatic server unreachable — this block renders when it connects' });
    }
  }
}

/** The source note's `## Source` block: title row (kind glyph, clickable), a metadata line,
 *  then requisite rows — snippets/questions live as tokens in the note's own sections. */
async function renderSourceBlock(
  plugin: PhilomaticPlugin,
  index: EntityIndex,
  host: HTMLElement,
  sourceId: string,
): Promise<void> {
  interface SourceMeta {
    id: string;
    title: string;
    modality: string;
    url?: string;
    estimatedDurationMins?: number;
    consumed: boolean;
    tags: string[];
  }
  try {
    const [snap, rel] = await Promise.all([
      api<{ sources: SourceMeta[]; tracks: { sourceLevels: string[][] }[] }>(plugin.settings, '/snapshot'),
      api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(sourceId)}`),
    ]);
    host.empty();
    const meta = snap.sources.find((s) => s.id === sourceId);
    if (!meta) {
      host.createDiv({ cls: 'pm-src-missing', text: index.loaded ? `${sourceId} — not in your library` : sourceId });
      return;
    }

    const head = host.createDiv({ cls: 'pm-src-head' });
    const svg = head.createSvg('svg', {
      attr: { viewBox: '0 0 256 256', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' },
    });
    svg.createSvg('path', { attr: { d: KIND_PATHS.source } });
    head.createSpan({ cls: 'pm-src-title', text: meta.title });
    head.addEventListener('click', () => void plugin.openLibrary(sourceId));

    const line = host.createDiv({ cls: 'pm-src-meta' });
    const bits = [
      meta.modality,
      ...(meta.estimatedDurationMins !== undefined ? [`~${meta.estimatedDurationMins} min`] : []),
      ...(meta.consumed ? ['consumed ✓'] : []),
      ...meta.tags,
    ];
    line.setText(bits.join(' · '));
    if (meta.url) {
      const a = host.createEl('a', { cls: 'pm-src-url', text: meta.url, href: meta.url });
      a.setAttribute('rel', 'noreferrer');
    }

    // Requisites (the source-note structure): what to read before, alongside, and after.
    // Pre/post = the source's PRECEDES neighbors; co-requisites = sources sharing its PRECEDES
    // level in a track (the engine's own definition — sourceLevels). Snippets/questions live
    // as markdown tokens in the note's own sections, so the block doesn't duplicate them.
    const requisites = (label: string, ids: string[]): void => {
      if (ids.length === 0) return;
      const rowEl = host.createDiv({ cls: 'pm-req-row' });
      rowEl.createSpan({ cls: 'pm-req-label', text: label });
      for (const otherId of ids) {
        const chip = rowEl.createSpan();
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          void plugin.openLibrary(otherId);
        });
        decorate(chip, otherId, index);
      }
    };
    const coReqs = new Set<string>();
    for (const sy of snap.tracks) {
      for (const level of sy.sourceLevels) {
        if (level.includes(sourceId)) for (const other of level) if (other !== sourceId) coReqs.add(other);
      }
    }
    requisites('Pre-requisites', rel.relations.filter((r) => r.type === 'PRECEDES' && r.direction === 'in').map((r) => r.otherId));
    requisites('Co-requisites', [...coReqs]);
    requisites('Post-requisites', rel.relations.filter((r) => r.type === 'PRECEDES' && r.direction === 'out').map((r) => r.otherId));
  } catch {
    if (host.childElementCount === 0) {
      host.createDiv({ cls: 'pm-src-missing', text: 'Philomatic server unreachable — this block renders when it connects' });
    }
  }
}
