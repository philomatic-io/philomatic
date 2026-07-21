/**
 * The creation modals (plan OB-S4/OB6) — the popup's entity semantics behind Obsidian idioms.
 * Data (sources, sentiment vocabulary, concepts) is fetched by the command flow BEFORE a modal
 * opens, so modals are pure UI. Every flow ends by handing back the created entity's id for
 * the `pm:` token insertion at the cursor (the OB4 write policy: user-triggered, cursor-only).
 */
import { App, FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import { api, errText } from './api';
import type { PhilomaticSettings } from './settings';

export interface SourceRef {
  id: string;
  title: string;
}
export interface VocabToken {
  token: string;
  label?: string;
}
export interface ConceptRef {
  id: string;
  name: string;
}

const NEW_SOURCE: SourceRef = { id: '', title: '➕ New source from URL…' };

/** "Which source?" — fuzzy over the library, with create-new as the first entry. */
export class SourcePickModal extends FuzzySuggestModal<SourceRef> {
  constructor(
    app: App,
    private readonly sources: SourceRef[],
    private readonly onPick: (pick: SourceRef | 'new') => void,
  ) {
    super(app);
    this.setPlaceholder('Pick a source from your library…');
  }
  getItems(): SourceRef[] {
    return [NEW_SOURCE, ...this.sources];
  }
  getItemText(s: SourceRef): string {
    return s.title;
  }
  onChooseItem(s: SourceRef): void {
    this.onPick(s.id === '' ? 'new' : s);
  }
}

/** Mint a source by URL (sources are public entities — owner ruling OB5). */
export class NewSourceModal extends Modal {
  private url = '';
  private title = '';
  constructor(
    app: App,
    private readonly settings: PhilomaticSettings,
    private readonly onCreated: (id: string) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('New Philomatic source');
    new Setting(this.contentEl)
      .setName('URL')
      .setDesc('The publicly available thing you learned from.')
      .addText((t) => t.setPlaceholder('https://…').onChange((v) => (this.url = v.trim())));
    new Setting(this.contentEl)
      .setName('Title')
      .setDesc('Optional — defaults from the URL.')
      .addText((t) => t.onChange((v) => (this.title = v.trim())));
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('Create')
        .setCta()
        .onClick(() => void this.create()),
    );
  }
  private async create(): Promise<void> {
    if (!this.url) {
      new Notice('Philomatic: a URL is required');
      return;
    }
    try {
      const r = await api<{ sourceId: string }>(this.settings, '/ingest', {
        url: this.url,
        ...(this.title ? { title: this.title } : {}),
      });
      this.close();
      this.onCreated(r.sourceId);
    } catch (e) {
      new Notice(`Philomatic: ${errText(e)}`, 8000);
    }
  }
}

/** Ask a question (optionally prefilled from the selection). Created + ASKed, then the id is
 *  resolved by text lookup — the server owns id derivation, clients never re-derive it. */
export class QuestionModal extends Modal {
  private text: string;
  constructor(
    app: App,
    private readonly settings: PhilomaticSettings,
    prefill: string,
    private readonly onCreated: (id: string) => void,
  ) {
    super(app);
    this.text = prefill.trim();
  }
  override onOpen(): void {
    this.setTitle('Ask a question');
    new Setting(this.contentEl)
      .setName('Question')
      .addTextArea((t) => {
        t.setPlaceholder('What does this leave you wondering?')
          .setValue(this.text)
          .onChange((v) => (this.text = v));
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('Ask')
        .setCta()
        .onClick(() => void this.create()),
    );
  }
  private async create(): Promise<void> {
    const q = this.text.trim();
    if (!q) {
      new Notice('Philomatic: the question is empty');
      return;
    }
    try {
      await api(this.settings, '/import', { version: 2, questions: [{ text: q }] });
      await api(this.settings, '/ask', { question: q });
      const qs = await api<{ questions: { id: string; text: string }[] }>(this.settings, '/questions');
      const found = qs.questions.find((x) => x.text === q);
      if (!found) throw new Error('created, but could not resolve the question id');
      this.close();
      this.onCreated(found.id);
    } catch (e) {
      new Notice(`Philomatic: ${errText(e)}`, 8000);
    }
  }
}

/** The quote becomes a snippet of its public source, with the popup's optional annotations:
 *  sentiment (framework vocabulary), a question it raises, a concept it clarifies. */
export class SnippetModal extends Modal {
  private sentiment = '';
  private question = '';
  private conceptName = '';
  constructor(
    app: App,
    private readonly settings: PhilomaticSettings,
    private readonly text: string,
    private readonly sourceId: string,
    private readonly vocab: VocabToken[],
    private readonly concepts: ConceptRef[],
    private readonly onCreated: (id: string) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('Save quote as snippet');
    const quote = this.contentEl.createEl('blockquote');
    quote.setText(this.text.length > 200 ? `${this.text.slice(0, 199)}…` : this.text);

    new Setting(this.contentEl).setName('Sentiment').addDropdown((d) => {
      d.addOption('', '–');
      for (const v of this.vocab) d.addOption(v.token, v.label ?? v.token);
      d.onChange((v) => (this.sentiment = v));
    });
    new Setting(this.contentEl)
      .setName('Raises a question')
      .setDesc('Optional — a new question this passage poses.')
      .addText((t) => t.onChange((v) => (this.question = v)));
    if (this.concepts.length > 0) {
      new Setting(this.contentEl).setName('Clarifies a concept').addDropdown((d) => {
        d.addOption('', '— none —');
        for (const c of this.concepts) d.addOption(c.name, c.name);
        d.onChange((v) => (this.conceptName = v));
      });
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('Save snippet')
        .setCta()
        .onClick(() => void this.create()),
    );
  }
  private async create(): Promise<void> {
    const q = this.question.trim();
    try {
      const r = await api<{ snippetId: string }>(this.settings, '/snippet', {
        sourceId: this.sourceId,
        text: this.text,
        ...(this.sentiment ? { sentiment: this.sentiment } : {}),
        ...(q ? { raises: [q] } : {}),
        ...(this.conceptName ? { clarifies: [this.conceptName] } : {}),
      });
      if (q) await api(this.settings, '/ask', { question: q });
      this.close();
      this.onCreated(r.snippetId);
    } catch (e) {
      new Notice(`Philomatic: ${errText(e)}`, 8000);
    }
  }
}

/** Generic "pick an existing entity" — fuzzy over id+label pairs (fed from /graph). */
export interface EntityRef {
  id: string;
  label: string;
}
export class EntityPickModal extends FuzzySuggestModal<EntityRef> {
  constructor(
    app: App,
    private readonly items: EntityRef[],
    placeholder: string,
    private readonly onPick: (e: EntityRef) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems(): EntityRef[] {
    return this.items;
  }
  getItemText(e: EntityRef): string {
    return e.label;
  }
  onChooseItem(e: EntityRef): void {
    this.onPick(e);
  }
}

/** One-field creation modal (concept name, track title). */
export class TextFieldModal extends Modal {
  private value = '';
  constructor(
    app: App,
    private readonly heading: string,
    private readonly fieldName: string,
    private readonly cta: string,
    private readonly onSubmit: (value: string) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle(this.heading);
    new Setting(this.contentEl).setName(this.fieldName).addText((t) => {
      t.onChange((v) => (this.value = v));
      t.inputEl.style.width = '100%';
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText(this.cta)
        .setCta()
        .onClick(() => {
          const v = this.value.trim();
          if (!v) {
            new Notice('Philomatic: a value is required');
            return;
          }
          this.close();
          this.onSubmit(v);
        }),
    );
  }
}
