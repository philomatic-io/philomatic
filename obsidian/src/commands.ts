/**
 * The creation + reference flows (plan OB-S4/OB6, split per owner feedback): every embeddable
 * kind gets `-ref` (browse the library, pick, embed) and `-create` (mint new, embed) variants,
 * all ending in a `pm:<id>` token at the cursor (OB4: user-triggered insertion, nothing else
 * ever touches the note). Insertion conventions:
 *   - question CREATED from a selection: the selection IS the question — replaced by the token
 *     (the chip renders the text back, live);
 *   - snippet from a selection: the quote is the note's own content — it STAYS, the token is
 *     appended right after it;
 *   - everything else: the token lands at the cursor.
 */
import { Editor, Menu, Notice } from 'obsidian';
import { api, errText } from './api';
import {
  EntityPickModal,
  NewSourceModal,
  QuestionModal,
  SnippetModal,
  SourcePickModal,
  TextFieldModal,
  type ConceptRef,
  type SourceRef,
  type VocabToken,
} from './modals';
import { createSourceNote, createTrackNotes, syncNote } from './template';
import type PhilomaticPlugin from './main';

const token = (id: string): string => `\`pm:${id}\``;

/** The scoped-map block: rendered live from whatever pm: tokens the note contains. */
export function insertMapBlock(editor: Editor): void {
  editor.replaceSelection('\n```philomatic\nmap: this-note\n```\n');
  new Notice('Philomatic: map embedded — it scopes to this note’s entities, live');
}
const insertAtCursor = (editor: Editor, id: string, what: string): void => {
  editor.replaceSelection(`${token(id)} `);
  new Notice(`Philomatic: ${what} embedded ✓`);
};

// ── -ref flows: browse the library, pick, embed ────────────────────────────────────────────────

/** The embeddable kinds, in graph-node terms ('track' is the user-facing word for track). */
export type RefKind = 'question' | 'snippet' | 'source' | 'concept' | 'track';
const GRAPH_KIND: Record<RefKind, string> = {
  question: 'question',
  snippet: 'snippet',
  source: 'source',
  concept: 'concept',
  track: 'track',
};

export async function refFlow(plugin: PhilomaticPlugin, editor: Editor, kind: RefKind): Promise<void> {
  try {
    const g = await api<{ nodes: { id: string; kind: string; label: string }[] }>(plugin.settings, '/graph');
    const items = g.nodes
      .filter((n) => n.kind === GRAPH_KIND[kind])
      .map((n) => ({ id: n.id, label: n.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (items.length === 0) {
      new Notice(`Philomatic: no ${kind}s in your library yet — try /pm-${kind}-create`);
      return;
    }
    new EntityPickModal(plugin.app, items, `Embed a ${kind}…`, (e) => insertAtCursor(editor, e.id, kind)).open();
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

// ── -create flows: mint new, embed ─────────────────────────────────────────────────────────────

export function questionCreate(plugin: PhilomaticPlugin, editor: Editor): void {
  const selection = editor.getSelection();
  new QuestionModal(plugin.app, plugin.settings, selection, (id) => {
    editor.replaceSelection(selection ? token(id) : `${token(id)} `);
    new Notice('Philomatic: question embedded ✓');
  }).open();
}

export function sourceCreate(plugin: PhilomaticPlugin, editor: Editor): void {
  new NewSourceModal(plugin.app, plugin.settings, (id) => insertAtCursor(editor, id, 'source')).open();
}

export function conceptCreate(plugin: PhilomaticPlugin, editor: Editor): void {
  new TextFieldModal(plugin.app, 'New concept', 'Name', 'Create', (name) => {
    void (async () => {
      try {
        await api(plugin.settings, '/import', { version: 2, concepts: [{ name }] });
        const id = await lookupByLabel(plugin, 'concept', name);
        insertAtCursor(editor, id, 'concept');
      } catch (e) {
        new Notice(`Philomatic: ${errText(e)}`, 8000);
      }
    })();
  }).open();
}

export function trackCreate(plugin: PhilomaticPlugin, editor: Editor): void {
  new TextFieldModal(plugin.app, 'New learning track', 'Title', 'Create', (title) => {
    void (async () => {
      try {
        await api(plugin.settings, '/import', { version: 2, tracks: [{ title }] });
        const id = await lookupByLabel(plugin, 'track', title);
        insertAtCursor(editor, id, 'track');
      } catch (e) {
        new Notice(`Philomatic: ${errText(e)}`, 8000);
      }
    })();
  }).open();
}

/** The server owns id derivation — resolve fresh mints by label, never re-derive client-side. */
async function lookupByLabel(plugin: PhilomaticPlugin, graphKind: string, label: string): Promise<string> {
  const g = await api<{ nodes: { id: string; kind: string; label: string }[] }>(plugin.settings, '/graph');
  const found = g.nodes.find((n) => n.kind === graphKind && n.label === label);
  if (!found) throw new Error(`created, but could not resolve the ${graphKind} id`);
  return found.id;
}

export async function snippetCreate(plugin: PhilomaticPlugin, editor: Editor): Promise<void> {
  const text = editor.getSelection().trim();
  if (!text) {
    new Notice('Philomatic: select the quote first');
    return;
  }
  try {
    const [snap, fw, asm] = await Promise.all([
      api<{ sources: SourceRef[] }>(plugin.settings, '/snapshot'),
      api<{ frameworks: { metadataFields: { name: string; on: { type: string }; vocabulary?: VocabToken[] }[] }[] }>(
        plugin.settings,
        '/framework',
      ),
      api<{ levels: ConceptRef[][] }>(plugin.settings, '/assemble'),
    ]);
    const vocab =
      fw.frameworks.flatMap((f) => f.metadataFields).find((m) => m.on.type === 'ANNOTATES' && m.name === 'sentiment')
        ?.vocabulary ?? [];
    const concepts = asm.levels
      .flat()
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // The quote stays where it is; the token lands right after the selection.
    const after = editor.getCursor('to');
    const save = (sourceId: string): void =>
      new SnippetModal(plugin.app, plugin.settings, text, sourceId, vocab, concepts, (id) => {
        editor.replaceRange(` ${token(id)}`, after);
        new Notice('Philomatic: snippet embedded ✓');
      }).open();

    new SourcePickModal(plugin.app, snap.sources, (pick) => {
      if (pick === 'new') new NewSourceModal(plugin.app, plugin.settings, save).open();
      else save(pick.id);
    }).open();
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

// ── Registration: palette + right-click ────────────────────────────────────────────────────────

export function registerCommands(plugin: PhilomaticPlugin): void {
  const refs: RefKind[] = ['question', 'snippet', 'source', 'concept', 'track'];
  for (const kind of refs) {
    plugin.addCommand({
      id: `ref-${kind}`,
      name: `Embed existing ${kind}`,
      editorCallback: (editor) => void refFlow(plugin, editor, kind),
    });
  }
  plugin.addCommand({ id: 'create-question', name: 'New question (embed at cursor)', editorCallback: (e) => questionCreate(plugin, e) });
  plugin.addCommand({ id: 'create-source', name: 'New source (embed at cursor)', editorCallback: (e) => sourceCreate(plugin, e) });
  plugin.addCommand({ id: 'create-concept', name: 'New concept (embed at cursor)', editorCallback: (e) => conceptCreate(plugin, e) });
  plugin.addCommand({ id: 'create-track', name: 'New learning track (embed at cursor)', editorCallback: (e) => trackCreate(plugin, e) });
  plugin.addCommand({ id: 'create-source-note', name: 'Create source note', callback: () => void createSourceNote(plugin) });
  plugin.addCommand({
    id: 'create-track-notes',
    name: 'Create track notes (a folder with a note per source)',
    callback: () => void createTrackNotes(plugin),
  });
  plugin.addCommand({ id: 'sync-note', name: 'Sync Philomatic note (append new entities)', callback: () => void syncNote(plugin) });
  plugin.addCommand({
    id: 'embed-map',
    name: 'Embed map of this note’s entities',
    editorCallback: (editor) => insertMapBlock(editor),
  });
  plugin.addCommand({
    id: 'create-snippet',
    name: 'Save selection as snippet',
    editorCheckCallback: (checking, editor) => {
      const has = editor.somethingSelected();
      if (!checking && has) void snippetCreate(plugin, editor);
      return has;
    },
  });

  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
      menu.addItem((i) =>
        i
          .setTitle('Philomatic: new question')
          .setIcon('circle-help')
          .onClick(() => questionCreate(plugin, editor)),
      );
      if (editor.somethingSelected()) {
        menu.addItem((i) =>
          i
            .setTitle('Philomatic: save selection as snippet')
            .setIcon('quote')
            .onClick(() => void snippetCreate(plugin, editor)),
        );
      }
      menu.addItem((i) =>
        i
          .setTitle('Philomatic: embed from library…')
          .setIcon('book-open')
          .onClick(() => void refFlow(plugin, editor, 'source')),
      );
    }),
  );
}
