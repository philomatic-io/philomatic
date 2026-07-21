/**
 * The `/pm-` slash commands (plan OB6, ref/create split per owner feedback): Obsidian has no
 * native slash menu, so this EditorSuggest triggers when a line ends in `/pm` (optionally
 * `-query`) at the cursor. Every embeddable kind offers `-ref` (browse the library and pick —
 * e.g. `/pm-source-ref` lists your sources) and `-create` (mint new); typing a kind prefix
 * (`/pm-source`) shows both variants. The trigger text is removed before the flow runs — the
 * only text this plugin ever deletes is its own trigger.
 */
import { Editor, EditorPosition, EditorSuggest, TFile, type EditorSuggestContext, type EditorSuggestTriggerInfo } from 'obsidian';
import {
  conceptCreate,
  insertMapBlock,
  questionCreate,
  refFlow,
  snippetCreate,
  sourceCreate,
  trackCreate,
  type RefKind,
} from './commands';
import { createSourceNote, createTrackNotes, syncNote } from './template';
import type PhilomaticPlugin from './main';

interface PmCommand {
  key: string;
  label: string;
  run: (plugin: PhilomaticPlugin, editor: Editor) => void;
}

const REF_KINDS: RefKind[] = ['question', 'snippet', 'source', 'concept', 'track'];

const COMMANDS: PmCommand[] = [
  ...REF_KINDS.map((kind) => ({
    key: `${kind}-ref`,
    label: `embed an existing ${kind} from your library`,
    run: (p: PhilomaticPlugin, e: Editor) => void refFlow(p, e, kind),
  })),
  { key: 'question-create', label: 'ask a new question and embed it', run: (p, e) => questionCreate(p, e) },
  { key: 'snippet-create', label: 'save the selection as a new snippet', run: (p, e) => void snippetCreate(p, e) },
  { key: 'source-create', label: 'create a source by URL and embed it', run: (p, e) => sourceCreate(p, e) },
  { key: 'concept-create', label: 'create a concept and embed it', run: (p, e) => conceptCreate(p, e) },
  { key: 'track-create', label: 'create a learning track and embed it', run: (p, e) => trackCreate(p, e) },
  { key: 'source-note', label: 'create a source note (a structured workspace for a source)', run: (p) => void createSourceNote(p) },
  { key: 'track-notes', label: 'create a track folder: a root track note + a source note per source', run: (p) => void createTrackNotes(p) },
  { key: 'embed-map', label: "embed the map, scoped to this note's entities", run: (_p, e) => insertMapBlock(e) },
  { key: 'note-sync', label: 'append this note’s new entities (never touches your text)', run: (p) => void syncNote(p) },
];

export class PmSuggest extends EditorSuggest<PmCommand> {
  constructor(private readonly plugin: PhilomaticPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = /(?:^|\s)(\/pm(?:-([\w-]*))?)$/.exec(before);
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - match[1]!.length },
      end: cursor,
      query: match[2] ?? '',
    };
  }

  getSuggestions(context: EditorSuggestContext): PmCommand[] {
    const q = context.query.toLowerCase();
    return COMMANDS.filter((c) => c.key.startsWith(q)).sort((a, b) => a.key.localeCompare(b.key));
  }

  renderSuggestion(command: PmCommand, el: HTMLElement): void {
    el.createSpan({ text: `/pm-${command.key}` });
    el.createSpan({ text: ` — ${command.label}`, cls: 'pm-suggest-desc' });
  }

  selectSuggestion(command: PmCommand): void {
    const context = this.context;
    if (!context) return;
    context.editor.replaceRange('', context.start, context.end); // remove the trigger text
    command.run(this.plugin, context.editor);
  }
}
