/**
 * Philomatic for Obsidian — entities as assets inside notes. obsidian/README.md is the
 * reference; the build plan retired to git history (2026-07-17).
 * OB-S1: settings (server URL / token / learnerId) + test-connection.
 * OB-S3: the embed renderer — `pm:<id>` tokens render as live entity chips (reading view),
 *        backed by the SSE-fresh entity index, clicking through to the workbench deep link.
 * OB-S4: the creation flows — /pm-question, /pm-snippet, /pm-source (slash suggester,
 *        right-click, palette) minting entities and inserting their tokens at the cursor.
 * Pure HTTP client: nothing here imports repo src/ (lock-line rule OB1, CI-enforced).
 */
import { Notice, Plugin } from 'obsidian';
import { api, errText } from './api';
import { registerChips } from './chips';
import { registerCommands } from './commands';
import { EntityIndex } from './entities';
import { LIBRARY_VIEW_TYPE, LibraryView } from './library-view';
import { DEFAULT_SETTINGS, PhilomaticSettingTab, type PhilomaticSettings } from './settings';
import { PmSuggest } from './suggest';

export default class PhilomaticPlugin extends Plugin {
  settings: PhilomaticSettings = { ...DEFAULT_SETTINGS };
  index!: EntityIndex;

  override async onload(): Promise<void> {
    const raw = ((await this.loadData()) as (Partial<PhilomaticSettings> & { openInObsidian?: boolean }) | null) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...raw };
    // Migrate the pre-dropdown boolean (openInObsidian) into linkTarget.
    if (raw.linkTarget === undefined && raw.openInObsidian !== undefined) {
      this.settings.linkTarget = raw.openInObsidian ? 'obsidian' : 'browser';
    }
    this.addSettingTab(new PhilomaticSettingTab(this.app, this));

    this.index = new EntityIndex(this.settings);
    this.index.start();
    this.register(() => this.index.stop());
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf));
    registerChips(this, this.index);
    registerCommands(this);
    this.registerEditorSuggest(new PmSuggest(this));

    this.addRibbonIcon('library', 'Open Philomatic library', () => void this.openLibrary());
    this.addCommand({ id: 'open-library', name: 'Open library', callback: () => void this.openLibrary() });
    this.addCommand({
      id: 'test-connection',
      name: 'Test server connection',
      callback: () => void this.testConnection(),
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.index.start(); // reconnect the index + SSE to the (possibly new) server
  }

  /** Open the workbench — an Obsidian tab by default (settings toggle for the browser). One tab
   *  is reused: a second chip click retargets it via the URL hash (the OB-S2 deep-link listener
   *  navigates in place, no reload). */
  async openLibrary(entityId?: string): Promise<void> {
    const base = this.settings.serverUrl.trim().replace(/\/+$/, '');
    const url = entityId ? `${base}/#item=${encodeURIComponent(entityId)}` : base;
    if (this.settings.linkTarget === 'browser') {
      window.open(url);
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    (leaf.view as LibraryView).setUrl(url);
    await this.app.workspace.revealLeaf(leaf);
  }

  private async testConnection(): Promise<void> {
    try {
      await api<{ ok: boolean }>(this.settings, '/health');
      new Notice('Philomatic: connected ✓');
    } catch (e) {
      new Notice(`Philomatic: ${errText(e)}`, 8000);
    }
  }
}
