/// <reference types="chrome" />
/**
 * The capture popup — a capture client of the self-hosted ingest server (self-serve plan T1):
 * every read/write is HTTP against the configured server (./api, ./config). The entities are
 * bordered cards (source / snippets) with nested question/concept sub-boxes; a live
 * "connections to be made" preview shows what the save will write. The form is a per-page DRAFT
 * persisted to chrome.storage.session; a successful save clears it. No src/ imports — the wire
 * contract is the server's routes (relations the capture API doesn't carry ride POST /import
 * with canonical edges, as the Journey view does).
 */
import { api, ServerUnreachableError } from './api';
import { selectionToMarkdown } from './select-md';
import { getServerConfig } from './config';
import { FRAMEWORKS } from './framework.gen';

// ── Vocabulary from the installed frameworks (F0) — never hardcoded here again ────────────────
interface EdgeTagView {
  name: string;
  on: { type: string; srcKind?: string; dstKind?: string };
  description?: string;
}
interface MetadataFieldView {
  name: string;
  on: { type: string };
  vocabulary?: readonly { token: string; label?: string }[];
}
// The generated file is deep-`as const` (heterogeneous tuples); widen to the plain views.
const ALL_EDGE_TAGS: readonly EdgeTagView[] = FRAMEWORKS.flatMap((f) => f.edgeTags as readonly EdgeTagView[]);
const ALL_METADATA_FIELDS: readonly MetadataFieldView[] = FRAMEWORKS.flatMap(
  (f) => f.metadataFields as readonly MetadataFieldView[],
);
/** How a source relates to a concept: the frameworks' tags on source→concept ABOUT edges. */
const REL_TAGS = ALL_EDGE_TAGS.filter((t) => t.on.type === 'ABOUT' && t.on.srcKind === 'source');
const SENTIMENT_VOCAB: readonly { token: string; label?: string }[] =
  ALL_METADATA_FIELDS.find((m) => m.on.type === 'ANNOTATES' && m.name === 'sentiment')?.vocabulary ?? [];
/** camelCase tag name → the seg-option word ("AnalogousTo" → "analogous to"). */
const tagWord = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Human message for a failed server call — points at the fix (start it / settings). */
const errText = (e: unknown): string =>
  e instanceof ServerUnreachableError
    ? `${e.message} — is it running? (pnpm serve; server URL is set in the extension options)`
    : e instanceof Error
      ? e.message
      : String(e);

const tagsOf = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function setStatus(text: string, kind?: 'ok' | 'err'): void {
  const status = el<HTMLParagraphElement>('status');
  status.textContent = text;
  status.title = text; // the footer home ellipsizes long errors — hover reveals the rest
  status.className = kind ?? '';
}

// ── Popup sizing (owner request, 2026-07-18): a footer drag-grip, persisted. Chrome caps
// popups at 800×600, so we clamp inside that; the sticky footer keeps the controls (and the
// status message now living beside them) pinned at whatever size you choose.
const SIZE_KEY = 'popupSize';
function applySize(w: number, h: number): void {
  document.body.style.width = `${Math.min(Math.max(w, 480), 790)}px`;
  document.body.style.minHeight = `${Math.min(Math.max(h, 0), 580)}px`;
}
async function initResize(): Promise<void> {
  const saved = (await chrome.storage.local.get(SIZE_KEY))[SIZE_KEY] as { w: number; h: number } | undefined;
  if (saved) applySize(saved.w, saved.h);
  const grip = el<HTMLSpanElement>('resizeGrip');
  grip.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const startX = down.screenX;
    const startY = down.screenY;
    const startW = document.body.offsetWidth;
    const startH = document.body.offsetHeight;
    // Left-corner grip: the popup anchors to the toolbar (screen right) and grows LEFTWARD,
    // so dragging left enlarges width; down enlarges height as usual.
    const move = (e: PointerEvent): void => applySize(startW + (startX - e.screenX), startH + (e.screenY - startY));
    const up = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      void chrome.storage.local.set({ [SIZE_KEY]: { w: document.body.offsetWidth, h: document.body.offsetHeight } });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  // lastFocusedWindow (not currentWindow): the popup itself is a window; the page being
  // captured lives in the last-focused browser window (Chrome's own recommendation for popups).
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('open a web page to capture it');
  return tab;
}

/** The current selection in the page (all frames — a selection inside an iframe counts too). */
async function selectionOf(tab: chrome.tabs.Tab): Promise<string> {
  if (tab.id === undefined) return '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      // DOM-aware: real LaTeX from the page's own annotations, light markdown for formatting
      // (select-md.ts — self-contained by contract, executeScript serializes it).
      func: selectionToMarkdown,
    });
    for (const r of results) if (r?.result) return r.result;
    return '';
  } catch {
    return ''; // unscriptable page (chrome://, web store) — the source still captures
  }
}

// ── Reference data (existing tracks / concepts) ────────────────────────────────────────────────
interface Ref {
  id: string;
  name: string;
}
let tracks: string[] = [];
let concepts: Ref[] = [];
let openQuestions: Ref[] = [];

const conceptName = (id: string): string => concepts.find((c) => c.id === id)?.name ?? '';
const questionText = (id: string): string => openQuestions.find((q) => q.id === id)?.name ?? '';

async function loadRefData(): Promise<void> {
  try {
    const [snap, asm, qs] = await Promise.all([
      api<{ tracks: { title: string }[] }>('/snapshot'),
      api<{ levels: { id: string; name: string }[][] }>('/assemble'),
      api<{ questions: { id: string; text: string; answered: boolean }[] }>('/questions'),
    ]);
    tracks = snap.tracks.map((s) => s.title).sort((a, b) => a.localeCompare(b));
    concepts = asm.levels
      .flat()
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    openQuestions = qs.questions.filter((q) => !q.answered).map((q) => ({ id: q.id, name: q.text }));
  } catch (e) {
    // Captures will fail the same way — surface the server problem early, but keep the form
    // usable so nothing typed is lost when the server comes back.
    if (e instanceof ServerUnreachableError) setStatus(errText(e), 'err');
  }
  applyRefData();
}

// ── Create-a-concept inline (owner request, 2026-07-18): the concept selects gain a
// "+ new concept…" row that swaps to a text input; the mint goes through /import, the id is
// resolved from /graph (the server owns id derivation), and the fresh concept is selected in
// place — same one-gesture create-and-relate the workbench editors have.
const NEW_SENTINEL = '__new__';

async function createConcept(name: string): Promise<string | undefined> {
  try {
    await api('/import', { version: 2, concepts: [{ name }] });
    const g = await api<{ nodes: { id: string; kind: string; label: string }[] }>('/graph');
    const node = g.nodes.find((n) => n.kind === 'concept' && n.label === name);
    if (!node) throw new Error('created the concept, but could not resolve its id');
    if (!concepts.some((c) => c.id === node.id)) {
      concepts.push({ id: node.id, name: node.label });
      concepts.sort((a, b) => a.name.localeCompare(b.name));
    }
    applyRefData();
    return node.id;
  } catch (e) {
    setStatus(errText(e), 'err');
    return undefined;
  }
}

function addCreateOption(sel: HTMLSelectElement): void {
  const opt = document.createElement('option');
  opt.value = NEW_SENTINEL;
  opt.textContent = '+ new concept…';
  sel.append(opt);
}

function wireCreateNew(sel: HTMLSelectElement): void {
  if (sel.dataset.pmNew) return;
  sel.dataset.pmNew = '1';
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_SENTINEL) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'new concept name…';
    input.className = sel.className;
    input.style.minWidth = '10em';
    sel.hidden = true;
    sel.after(input);
    input.focus();
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      void (async () => {
        const id = value !== '' ? await createConcept(value) : undefined;
        sel.value = id ?? '';
        sel.hidden = false;
        input.remove();
        sel.dispatchEvent(new Event('change', { bubbles: true })); // persist the draft
      })();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim());
      if (e.key === 'Escape') finish('');
    });
    input.addEventListener('blur', () => finish(input.value.trim()));
  });
}

/** (Re)fill a select that lists reference data, keeping the current choice where still valid. */
function fillSelect(sel: HTMLSelectElement, options: Ref[], emptyLabel: string, maxLen: number): void {
  const prior = sel.value;
  sel.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = emptyLabel;
  sel.append(none);
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = trunc(o.name, maxLen);
    sel.append(opt);
  }
  if (options.some((o) => o.id === prior)) sel.value = prior;
}

function applyRefData(): void {
  el('relBlock').hidden = false; // create-new keeps this useful even before any concept exists
  fillSelect(el<HTMLSelectElement>('concept'), concepts, '— pick a concept —', 34);
  addCreateOption(el<HTMLSelectElement>('concept'));
  wireCreateNew(el<HTMLSelectElement>('concept'));
  // The draft may have restored a concept before its option existed — re-apply it now.
  if (desiredConcept && concepts.some((c) => c.id === desiredConcept)) el<HTMLSelectElement>('concept').value = desiredConcept;
  for (const { root, sn } of snipRows) {
    fillSelect(root.querySelector('.sn-answer') as HTMLSelectElement, openQuestions, '— pick an open question —', 48);
    (root.querySelector('.sn-answer') as HTMLSelectElement).value = sn.answerTarget;
    fillSelect(root.querySelector('.sn-anchor-concept') as HTMLSelectElement, concepts, '— no concept —', 34);
    addCreateOption(root.querySelector('.sn-anchor-concept') as HTMLSelectElement);
    wireCreateNew(root.querySelector('.sn-anchor-concept') as HTMLSelectElement);
    (root.querySelector('.sn-anchor-concept') as HTMLSelectElement).value = sn.anchorConcept;
    syncSnipVisibility(root, sn);
  }
  renderEdges();
}

// ── Per-page draft: survive the popup being dismissed ─────────────────────────────────────────
interface SnippetDraft {
  text: string;
  sentiment: string;
  /** A NEW question this snippet raises (typed) — independent of `answerTarget`: a snippet can
   *  answer one question and raise another in the same save. */
  question: string;
  /** An existing open question (by id) this snippet answers. */
  answerTarget: string;
  anchor: 'CLARIFIES' | 'CONTRADICTS';
  anchorConcept: string;
}
interface Draft {
  title: string;
  tags: string;
  track: string;
  modality: string;
  minutes: string;
  rel: string;
  concept: string;
  snippets: SnippetDraft[];
}
let draftKey = '';
let snippets: SnippetDraft[] = [];
/** Concept id restored from the draft, applied once the concept options have loaded. */
let desiredConcept = '';

const newSnippet = (text = ''): SnippetDraft => ({
  text,
  sentiment: '',
  question: '',
  answerTarget: '',
  anchor: 'CLARIFIES',
  anchorConcept: '',
});

// The relation is a framework TAG riding a source→concept ABOUT edge (model v2).
const relValue = (): string =>
  (el('relSeg').querySelector('input:checked') as HTMLInputElement | null)?.value ?? REL_TAGS[0]?.name ?? 'Explains';

/** Build a segmented radio control from framework vocabulary. */
function buildSeg(seg: HTMLElement, name: string, options: { value: string; word: string }[], checked: string): void {
  seg.replaceChildren();
  for (const opt of options) {
    const label = document.createElement('label');
    label.className = 'seg-opt';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = opt.value;
    input.checked = opt.value === checked;
    label.append(input, opt.word);
    seg.append(label);
  }
}

function readForm(): Draft {
  return {
    title: el<HTMLInputElement>('title').value,
    // Committed chips + whatever is still being typed in the add-input, so a half-typed tag
    // survives both the draft round-trip and a save.
    tags: [...tagList, ...tagsOf(el<HTMLInputElement>('tags').value)].join(' '),
    track: el<HTMLInputElement>('track').value,
    modality: el<HTMLSelectElement>('modality').value,
    minutes: el<HTMLInputElement>('minutes').value,
    rel: relValue(),
    // Mid-create the select holds the sentinel — never let it into drafts, previews, or capture.
    concept: el<HTMLSelectElement>('concept').value === NEW_SENTINEL ? '' : el<HTMLSelectElement>('concept').value,
    snippets,
  };
}
const saveDraft = (): void => {
  if (draftKey) void chrome.storage.session.set({ [draftKey]: readForm() });
};
const clearDraft = (): void => {
  if (draftKey) void chrome.storage.session.remove(draftKey);
};

// ── Tag chips — the workbench Detail pane's TagEditor, in vanilla DOM ──────────────────────────
let tagList: string[] = [];

function renderTags(): void {
  const editor = el<HTMLDivElement>('tagEditor');
  const input = el<HTMLInputElement>('tags');
  for (const n of editor.querySelectorAll('span.chip')) n.remove();
  for (const t of tagList) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.setAttribute('aria-label', `remove ${t}`);
    x.textContent = '×';
    x.addEventListener('click', () => {
      tagList = tagList.filter((v) => v !== t);
      renderTags();
      saveDraft();
    });
    chip.append(x);
    editor.insertBefore(chip, input);
  }
}

/** Commit the add-input's text into chips (Enter or blur — same rhythm as the Detail pane). */
function commitTagInput(): void {
  const input = el<HTMLInputElement>('tags');
  if (!input.value.trim()) return;
  const add = tagsOf(input.value).filter((t) => !tagList.includes(t));
  tagList = [...tagList, ...add];
  input.value = '';
  renderTags();
  saveDraft();
}

// ── Learning-track combobox — an owned dropdown (a native datalist can't be styled) ───────────
let comboActive = -1;

const trackMenu = (): HTMLDivElement => el<HTMLDivElement>('trackMenu');

function closeCombo(): void {
  trackMenu().hidden = true;
  comboActive = -1;
  document.body.style.minHeight = '';
}

function highlightCombo(): void {
  trackMenu()
    .querySelectorAll('button')
    .forEach((b, i) => {
      b.classList.toggle('active', i === comboActive);
      if (i === comboActive) b.scrollIntoView({ block: 'nearest' });
    });
}

function openCombo(showAll = false): void {
  const input = el<HTMLInputElement>('track');
  const q = showAll ? '' : input.value.trim().toLowerCase();
  const items = q ? tracks.filter((t) => t.toLowerCase().includes(q)) : tracks;
  const menu = trackMenu();
  menu.replaceChildren();
  if (items.length === 0) {
    closeCombo();
    return;
  }
  for (const t of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    // preventDefault on pointerdown keeps focus in the input, so blur doesn't eat the click.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      input.value = t;
      closeCombo();
      updateIntoTrack();
      renderEdges();
      saveDraft();
    });
    menu.append(b);
  }
  menu.hidden = false;
  highlightCombo();
  // The popup window sizes to the body; grow it so the menu never clips at the bottom edge.
  document.body.style.minHeight = `${menu.getBoundingClientRect().bottom + 8}px`;
}

function comboKeydown(e: KeyboardEvent): void {
  const open = !trackMenu().hidden;
  const count = trackMenu().querySelectorAll('button').length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) {
      openCombo(true);
      comboActive = 0;
    } else {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      comboActive = Math.max(0, Math.min(count - 1, comboActive + step));
    }
    highlightCombo();
  } else if (e.key === 'Enter' && open && comboActive >= 0) {
    e.preventDefault();
    trackMenu().querySelectorAll('button')[comboActive]?.click();
  } else if (e.key === 'Escape' && open) {
    e.preventDefault(); // consume: close the menu, not the whole popup
    e.stopPropagation();
    closeCombo();
  }
}

/** The header's "into ‹track›" subtitle follows the learning-track field live. */
function updateIntoTrack(): void {
  const track = el<HTMLInputElement>('track').value.trim();
  const target = el<HTMLSpanElement>('intoTrack');
  target.replaceChildren('into ');
  const b = document.createElement('b');
  b.textContent = track || 'your library';
  target.append(b);
}

// ── Snippet cards ──────────────────────────────────────────────────────────────────────────────
let snipRows: { root: HTMLElement; sn: SnippetDraft }[] = [];

/** Show/hide a snippet's sub-boxes: annotations need text; the pickers need their options. */
function syncSnipVisibility(root: HTMLElement, sn: SnippetDraft): void {
  const hasText = sn.text.trim().length > 0;
  (root.querySelector('.sn-sent') as HTMLElement).hidden = !hasText;
  (root.querySelector('.sn-qbox') as HTMLElement).hidden = !hasText;
  (root.querySelector('.sn-answers') as HTMLElement).hidden = openQuestions.length === 0;
  (root.querySelector('.sn-anchor') as HTMLElement).hidden = !hasText; // create-new works with zero concepts too
}

function onSnipChange(root: HTMLElement, sn: SnippetDraft): void {
  syncSnipVisibility(root, sn);
  updateSaveLabel();
  renderEdges();
  saveDraft();
}

function renderSnippets(): void {
  const list = el<HTMLDivElement>('snippetList');
  const tpl = el<HTMLTemplateElement>('snipTpl');
  list.replaceChildren();
  snipRows = [];
  snippets.forEach((sn, ix) => {
    const root = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    snipRows.push({ root, sn });

    // Number the card itself when there are several — the connection preview uses the SAME
    // card position, so "snippet 2" always names a card visibly labelled "snippet 2".
    if (snippets.length > 1) (root.querySelector('.card-kind') as HTMLElement).textContent = `snippet ${ix + 1}`;

    // Sentiment options come from the framework's ANNOTATES vocabulary ('–' = none). Built
    // BEFORE the radio-group naming below so these inputs are named/uniqued with the rest.
    buildSeg(
      root.querySelector('.sn-sent .seg') as HTMLElement,
      `snsent${ix}`,
      [{ value: '', word: '–' }, ...SENTIMENT_VOCAB.map((v) => ({ value: v.token, word: v.label ?? v.token }))],
      sn.sentiment,
    );

    // Unique the radio-group names per instance, then restore this snippet's choices.
    const groups: [string, string][] = [
      [`.sn-sent`, `snsent${ix}`],
      [`.sn-anchor .seg`, `snanchor${ix}`],
    ];
    for (const [selector, name] of groups) {
      for (const r of root.querySelectorAll<HTMLInputElement>(`${selector} input`)) r.name = name;
    }
    const check = (selector: string, value: string): void => {
      const r = root.querySelector<HTMLInputElement>(`${selector} input[value="${value}"]`);
      if (r) r.checked = true;
    };
    check('.sn-sent', sn.sentiment);
    check('.sn-anchor .seg', sn.anchor);

    const text = root.querySelector('.sn-text') as HTMLTextAreaElement;
    text.value = sn.text;
    text.addEventListener('input', () => {
      sn.text = text.value;
      autosize(text);
      onSnipChange(root, sn);
    });

    const question = root.querySelector('.sn-question') as HTMLInputElement;
    question.value = sn.question;
    question.addEventListener('input', () => {
      sn.question = question.value;
      renderEdges();
      saveDraft();
    });

    const answer = root.querySelector('.sn-answer') as HTMLSelectElement;
    fillSelect(answer, openQuestions, '— pick an open question —', 48);
    answer.value = sn.answerTarget;
    answer.addEventListener('change', () => {
      sn.answerTarget = answer.value;
      renderEdges();
      saveDraft();
    });

    const anchorConcept = root.querySelector('.sn-anchor-concept') as HTMLSelectElement;
    fillSelect(anchorConcept, concepts, '— no concept —', 34);
    addCreateOption(anchorConcept);
    wireCreateNew(anchorConcept);
    anchorConcept.value = sn.anchorConcept;
    anchorConcept.addEventListener('change', () => {
      if (anchorConcept.value === NEW_SENTINEL) return; // mid-create; the commit re-dispatches
      sn.anchorConcept = anchorConcept.value;
      renderEdges();
      saveDraft();
    });

    root.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type !== 'radio') return;
      if (t.name === `snsent${ix}`) sn.sentiment = t.value;
      else if (t.name === `snanchor${ix}`) sn.anchor = t.value as SnippetDraft['anchor'];
      onSnipChange(root, sn);
    });

    (root.querySelector('.sn-remove') as HTMLButtonElement).addEventListener('click', () => {
      snippets.splice(ix, 1);
      renderSnippets();
      renderEdges();
      saveDraft();
    });

    syncSnipVisibility(root, sn);
    list.append(root);
    // An image-token snippet (region capture) shows the PICTURE; the base64 wall stays
    // collapsed in the textarea underneath, still editable.
    const imgTok = /^!\[[^\]\n]*\]\((data:image\/[^)\s]+|https?:[^)\s]+)\)$/.exec(sn.text.trim());
    if (imgTok) {
      const prev = document.createElement('img');
      prev.className = 'sn-img-preview';
      prev.src = imgTok[1]!;
      prev.alt = '';
      text.before(prev);
    } else {
      autosize(text); // after append — scrollHeight needs layout
    }
  });
  updateSaveLabel();
}

/** Grow the excerpt box to its text (owner request, 2026-07-18), capped so the popup stays
 *  inside Chrome's ~600px height budget: whatever the rest of the popup already occupies,
 *  the box may take the remainder, never less than the CSS min-height. Past the cap the
 *  textarea scrolls internally. */
function autosize(t: HTMLTextAreaElement): void {
  t.style.height = 'auto';
  const chromeAround = document.body.scrollHeight - t.offsetHeight;
  const cap = Math.max(72, 580 - chromeAround);
  t.style.height = `${Math.min(t.scrollHeight + 2, cap)}px`;
}

function updateSaveLabel(): void {
  const n = snippets.filter((s) => s.text.trim()).length;
  el<HTMLButtonElement>('capture').textContent = n === 0 ? 'Save page' : n === 1 ? 'Save page + snippet' : `Save page + ${n} snippets`;
}

// ── Edge preview — what this save will write into the graph ───────────────────────────────────
/** Per-relation hint line, straight from the framework declarations. */
const REL_HINTS: Record<string, string> = Object.fromEntries(REL_TAGS.map((t) => [t.name, t.description ?? '']));

/** The kind glyphs of the card headers (Phosphor regular paths), reused on connection rows. */
type EndpointKind = 'source' | 'snippet' | 'question' | 'concept' | 'track';
const KIND_PATHS: Record<EndpointKind, string> = {
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
/** The user-facing word per kind (a track is a "track" everywhere in the popup). */
const KIND_WORDS: Record<EndpointKind, string> = {
  source: 'source',
  snippet: 'snippet',
  question: 'question',
  concept: 'concept',
  track: 'track',
};

/** A connection endpoint: kind glyph + label in the card-header style, then ": text" if given. */
function endpoint(kind: EndpointKind | 'you', text?: string, ordinal?: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'eend';
  if (kind === 'you') {
    wrap.textContent = 'you';
    return wrap;
  }
  const k = document.createElement('span');
  k.className = `ekind k-${kind}`;
  k.innerHTML = `<svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${KIND_PATHS[kind]}"/></svg>`;
  k.append(` ${KIND_WORDS[kind]}${ordinal !== undefined ? ` ${ordinal}` : ''}`);
  wrap.append(k);
  if (text) {
    const t = document.createElement('span');
    t.className = 'etext';
    t.textContent = `: ${text}`;
    wrap.append(t);
  }
  return wrap;
}

function renderEdges(): void {
  el<HTMLParagraphElement>('relHint').textContent = REL_HINTS[relValue()] ?? '';

  const rows: { from: HTMLElement; rel: string; to: HTMLElement }[] = [];
  const track = el<HTMLInputElement>('track').value.trim();
  if (track) rows.push({ from: endpoint('track', trunc(track, 20)), rel: 'INCLUDES', to: endpoint('source') });
  const cid = el<HTMLSelectElement>('concept').value;
  if (cid) rows.push({ from: endpoint('source'), rel: relValue(), to: endpoint('concept', trunc(conceptName(cid), 22)) });

  // Ordinals are the snippet's CARD position (shown on the card header when there are several),
  // not its rank among non-empty ones — the preview must name what the user can see.
  const withText = snippets.filter((s) => s.text.trim());
  const ordinalOf = (s: SnippetDraft): number | undefined => (snippets.length > 1 ? snippets.indexOf(s) + 1 : undefined);
  for (const s of withText) {
    const ord = ordinalOf(s);
    if (s.sentiment) rows.push({ from: endpoint('you'), rel: `annotates · ${s.sentiment}`, to: endpoint('snippet', undefined, ord) });
    if (s.question.trim()) rows.push({ from: endpoint('snippet', undefined, ord), rel: 'RAISES', to: endpoint('question', trunc(s.question.trim(), 26)) });
    if (s.answerTarget) rows.push({ from: endpoint('snippet', undefined, ord), rel: 'ANSWERS', to: endpoint('question', trunc(questionText(s.answerTarget), 26)) });
    if (s.anchorConcept) rows.push({ from: endpoint('snippet', undefined, ord), rel: s.anchor, to: endpoint('concept', trunc(conceptName(s.anchorConcept), 22)) });
  }

  el('edges').hidden = rows.length === 0;
  const box = el<HTMLDivElement>('edgeRows');
  box.replaceChildren();
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'edge';
    const rel = document.createElement('span');
    rel.className = 'rel';
    rel.textContent = r.rel;
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    row.append(r.from, rel, arrow, r.to);
    box.append(row);
  }
}

// ── Region capture (PDF math tier 2, owner design session 2026-07-18) ─────────────────────────
// captureVisibleTab needs no DOM access, so it works where the selection walker can't reach —
// Chrome's built-in PDF viewer above all. Cropping inside the 600px popup meant cropping a
// postage stamp (owner feedback), so the screenshot opens in a FULL TAB (crop.html) at the
// page's true size; the crop appends to this page's draft and the flow lands back here.
function initRegionCapture(): void {
  el('captureRegion').addEventListener('click', () => {
    void (async () => {
      try {
        const img = await chrome.tabs.captureVisibleTab({ format: 'png' });
        await chrome.storage.session.set({ pendingCrop: { img, draftKey, tabId: tab?.id } });
        await chrome.tabs.create({ url: chrome.runtime.getURL('crop.html') });
      } catch (e) {
        setStatus(`could not screenshot the tab: ${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    })();
  });
}


// ── Modality icon dropdown (owner request, 2026-07-18): the workbench ModalityPicker's
// vanilla-DOM twin. Drives the hidden <select id=modality> so readForm/draft logic is
// untouched; paths are Phosphor regular-weight, extracted at build design time.
const MODALITY_PATHS: Record<string, string> = {
  text: 'M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z',
  video: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm48.24-94.78-64-40A8,8,0,0,0,100,88v80a8,8,0,0,0,12.24,6.78l64-40a8,8,0,0,0,0-13.56ZM116,153.57V102.43L156.91,128Z',
  audio: 'M201.89,54.66A103.43,103.43,0,0,0,128.79,24H128A104,104,0,0,0,24,128v56a24,24,0,0,0,24,24H64a24,24,0,0,0,24-24V144a24,24,0,0,0-24-24H40.36A88,88,0,0,1,128,40h.67a87.71,87.71,0,0,1,87,80H192a24,24,0,0,0-24,24v40a24,24,0,0,0,24,24h16a24,24,0,0,0,24-24V128A103.41,103.41,0,0,0,201.89,54.66ZM64,136a8,8,0,0,1,8,8v40a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V136Zm152,48a8,8,0,0,1-8,8H192a8,8,0,0,1-8-8V144a8,8,0,0,1,8-8h24Z',
  interactive: 'M88,24V16a8,8,0,0,1,16,0v8a8,8,0,0,1-16,0ZM16,104h8a8,8,0,0,0,0-16H16a8,8,0,0,0,0,16ZM124.42,39.16a8,8,0,0,0,10.74-3.58l8-16a8,8,0,0,0-14.31-7.16l-8,16A8,8,0,0,0,124.42,39.16Zm-96,81.69-16,8a8,8,0,0,0,7.16,14.31l16-8a8,8,0,1,0-7.16-14.31ZM219.31,184a16,16,0,0,1,0,22.63l-12.68,12.68a16,16,0,0,1-22.63,0L132.7,168,115,214.09c0,.1-.08.21-.13.32a15.83,15.83,0,0,1-14.6,9.59l-.79,0a15.83,15.83,0,0,1-14.41-11L32.8,52.92A16,16,0,0,1,52.92,32.8L213,85.07a16,16,0,0,1,1.41,29.8l-.32.13L168,132.69ZM208,195.31,156.69,144h0a16,16,0,0,1,4.93-26l.32-.14,45.95-17.64L48,48l52.2,159.86,17.65-46c0-.11.08-.22.13-.33a16,16,0,0,1,11.69-9.34,16.72,16.72,0,0,1,3-.28,16,16,0,0,1,11.3,4.69L195.31,208Z',
  other: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  auto: 'M197.58,129.06,146,110l-19-51.62a15.92,15.92,0,0,0-29.88,0L78,110l-51.62,19a15.92,15.92,0,0,0,0,29.88L78,178l19,51.62a15.92,15.92,0,0,0,29.88,0L146,178l51.62-19a15.92,15.92,0,0,0,0-29.88ZM137,164.22a8,8,0,0,0-4.74,4.74L112,223.85,91.78,169A8,8,0,0,0,87,164.22L32.15,144,87,123.78A8,8,0,0,0,91.78,119L112,64.15,132.22,119a8,8,0,0,0,4.74,4.74L191.85,144ZM144,40a8,8,0,0,1,8-8h16V16a8,8,0,0,1,16,0V32h16a8,8,0,0,1,0,16H184V64a8,8,0,0,1-16,0V48H152A8,8,0,0,1,144,40ZM248,88a8,8,0,0,1-8,8h-8v8a8,8,0,0,1-16,0V96h-8a8,8,0,0,1,0-16h8V72a8,8,0,0,1,16,0v8h8A8,8,0,0,1,248,88Z',
};
const MODALITY_WORDS: Record<string, string> = {
  '': 'auto', text: 'text', video: 'video', audio: 'audio', interactive: 'interactive', other: 'other',
};
const modIcon = (key: string, size = 15): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${MODALITY_PATHS[key || 'auto'] ?? MODALITY_PATHS.auto}"/></svg>`;

function initModalityDrop(): void {
  const select = el<HTMLSelectElement>('modality');
  const btn = el<HTMLButtonElement>('modalityBtn');
  const menu = el<HTMLUListElement>('modalityMenu');

  const syncTrigger = (): void => {
    const v = select.value;
    btn.innerHTML = `${modIcon(v)}<span>${MODALITY_WORDS[v] ?? v}</span><svg class="caret" width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`;
  };
  const rebuildMenu = (): void => {
    menu.replaceChildren();
    for (const v of Object.keys(MODALITY_WORDS)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = v === select.value ? 'on' : '';
      b.innerHTML = `${modIcon(v)}<span>${MODALITY_WORDS[v]}</span>`;
      b.addEventListener('click', () => {
        select.value = v;
        menu.hidden = true;
        syncTrigger();
        saveDraft();
      });
      li.append(b);
      menu.append(li);
    }
  };
  btn.addEventListener('click', () => {
    if (menu.hidden) rebuildMenu();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('mousedown', (e) => {
    if (!el<HTMLDivElement>('modalityDrop').contains(e.target as Node)) menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.hidden = true;
  });
  // The draft restore writes the select directly — mirror it onto the trigger.
  select.addEventListener('sync', syncTrigger);
  syncTrigger();
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────
let tab: chrome.tabs.Tab | undefined;

async function init(): Promise<void> {
  void initResize();
  initRegionCapture();
  initModalityDrop();
  void loadRefData();
  try {
    tab = await activeTab();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'err');
    el<HTMLButtonElement>('capture').disabled = true;
    return;
  }
  // Framework-driven segments: the source→concept relation options come from the declarations.
  buildSeg(
    el('relSeg'),
    'rel',
    REL_TAGS.map((t) => ({ value: t.name, word: tagWord(t.name) })),
    REL_TAGS[0]?.name ?? '',
  );

  draftKey = `draft:${tab.url}`;
  el<HTMLSpanElement>('pageUrl').textContent = tab.url ?? '';

  const [live, stored] = await Promise.all([selectionOf(tab), chrome.storage.session.get(draftKey)]);
  const draft = stored[draftKey] as (Partial<Draft> & { snippet?: string }) | undefined;

  el<HTMLInputElement>('title').value = draft?.title || tab.title || '';
  tagList = tagsOf(draft?.tags ?? '');
  renderTags();
  el<HTMLInputElement>('track').value = draft?.track ?? '';
  el<HTMLSelectElement>('modality').value = draft?.modality ?? '';
  el<HTMLSelectElement>('modality').dispatchEvent(new Event('sync'));
  el<HTMLInputElement>('minutes').value = draft?.minutes ?? '';
  const relRadio = el('relSeg').querySelector<HTMLInputElement>(`input[value="${draft?.rel ?? 'Explains'}"]`);
  if (relRadio) relRadio.checked = true;
  desiredConcept = draft?.concept ?? '';
  el<HTMLSelectElement>('concept').value = desiredConcept; // re-applied by applyRefData once concepts load

  // Snippets: the draft's array (or its pre-redesign single `snippet` string), then a live
  // selection wins the top spot — a fresh highlight means fresh intent.
  snippets = (draft?.snippets ?? (draft?.snippet ? [newSnippet(draft.snippet)] : [])).map((s) => ({ ...newSnippet(), ...s }));
  if (live && !snippets.some((s) => s.text === live)) snippets.unshift(newSnippet(live));
  renderSnippets();
  updateIntoTrack();
  renderEdges();
  if (live) saveDraft(); // stash the fresh selection immediately, before any typing

  for (const id of ['title', 'tags', 'track', 'minutes']) {
    el(id).addEventListener('input', () => {
      renderEdges();
      saveDraft();
    });
  }
  el('track').addEventListener('input', updateIntoTrack);
  for (const id of ['modality', 'concept', 'relSeg']) {
    el(id).addEventListener('change', () => {
      renderEdges();
      saveDraft();
    });
  }
}

// ── Save ───────────────────────────────────────────────────────────────────────────────────────
async function capture(): Promise<void> {
  setStatus('Saving…');
  try {
    if (!tab?.url) throw new Error('open a web page to capture it');
    const form = readForm();
    // An UNEDITED title prefill is the browser's tab title, not the learner's words — send it
    // as a weak `resolved` hint so a server adapter (arXiv) can beat it (owner bug, 2026-07-18:
    // Chrome's PDF viewer titles the tab with the bare id, which then outranked the real
    // title forever under user>API precedence). An edited title is the learner's — it wins.
    const typed = form.title.trim();
    const isTabDefault = typed !== '' && typed === (tab.title ?? '').trim();
    const title = !isTabDefault && typed !== '' ? typed : undefined;
    const weakTitle = isTabDefault ? typed : (tab.title ?? '').trim() || undefined;
    const track = form.track.trim();
    const minutes = parseInt(form.minutes, 10);

    const src = await api<{ sourceId: string }>('/ingest', {
      url: tab.url,
      ...(title ? { title } : {}),
      ...(weakTitle ? { resolved: { title: weakTitle } } : {}),
      tags: tagsOf(form.tags),
      ...(form.modality ? { modality: form.modality } : {}),
      ...(track ? { track } : {}),
    });

    if (Number.isInteger(minutes) && minutes > 0) {
      await api('/update', { ref: src.sourceId, patch: { estimatedDurationMins: minutes } });
    }

    // Relations the capture API doesn't carry ride importPayload as canonical edges (same path
    // as the Journey view) — ids for both ends are in hand here. The source→concept relation is
    // a framework tag on an ABOUT edge (model v2): tags say HOW it's about the concept.
    const edges: Record<string, unknown>[] = [];
    if (form.concept) {
      edges.push({ srcType: 'source', srcId: src.sourceId, type: 'ABOUT', dstType: 'concept', dstId: form.concept, tags: [{ name: form.rel }] });
    }

    let saved = 0;
    let asked = 0;
    for (const s of snippets) {
      const text = s.text.trim();
      if (!text) continue;
      const anchorName = conceptName(s.anchorConcept);
      const q = s.question.trim();
      const snp = await api<{ snippetId: string }>('/snippet', {
        sourceId: src.sourceId,
        text,
        ...(s.sentiment ? { sentiment: s.sentiment } : {}),
        ...(anchorName ? { [s.anchor === 'CONTRADICTS' ? 'contradicts' : 'clarifies']: [anchorName] } : {}),
        ...(q ? { raises: [q] } : {}),
      });
      saved++;
      if (s.answerTarget) {
        edges.push({ srcType: 'snippet', srcId: snp.snippetId, type: 'ANSWERS', dstType: 'question', dstId: s.answerTarget });
      }
      if (q) {
        await api('/ask', { question: q }); // a typed question is an open question — it lands in Journey
        asked++;
      }
    }
    if (edges.length > 0) await api('/import', { version: 2, edges });

    const parts = [
      'page',
      ...(saved > 0 ? [saved === 1 ? 'snippet' : `${saved} snippets`] : []),
      ...(asked > 0 ? [asked === 1 ? 'question' : `${asked} questions`] : []),
    ];
    setStatus(`Saved ${parts.join(' + ')} ✓${track ? ` → ${track}` : ''}`, 'ok');
    clearDraft();
    snippets = [];
    renderSnippets();
    renderEdges();
    void loadRefData(); // the save may have minted concepts/tracks — refresh the pickers
  } catch (e) {
    setStatus(errText(e), 'err');
  }
}

void init();
el('capture').addEventListener('click', () => void capture());
el('library').addEventListener('click', () => {
  // The library viewer is served by the server (GET / on the ingest server).
  void getServerConfig().then(({ baseUrl }) => chrome.tabs.create({ url: baseUrl }));
});
el('cancel').addEventListener('click', () => window.close()); // the draft survives — Cancel just dismisses
el('closeBtn').addEventListener('click', () => window.close());
el('addSnippet').addEventListener('click', () => {
  snippets.push(newSnippet());
  renderSnippets();
  saveDraft();
  snipRows[snipRows.length - 1]?.root.querySelector<HTMLTextAreaElement>('.sn-text')?.focus();
});

// Tag chips: Enter or leaving the field commits the typed text into chips.
el('tags').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') commitTagInput();
});
el('tags').addEventListener('blur', commitTagInput);

// Learning-track combobox: type to filter, caret for the full list, blur closes.
el('track').addEventListener('focus', () => openCombo());
el('track').addEventListener('input', () => {
  comboActive = -1;
  openCombo();
});
el('track').addEventListener('keydown', (e) => comboKeydown(e as KeyboardEvent));
el('track').addEventListener('blur', closeCombo);
el('trackToggle').addEventListener('pointerdown', (e) => {
  e.preventDefault(); // keep (or put) focus on the input
  const wasOpen = !trackMenu().hidden;
  el<HTMLInputElement>('track').focus();
  if (wasOpen) closeCombo();
  else openCombo(true);
});
