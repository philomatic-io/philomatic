/**
 * Plugin settings (plan OB-S1) — where the plugin is pointed at a server: URL, optional write
 * token, optional learnerId (rides the T4 seam on every write). The extension options page's
 * twin, in Obsidian's Setting idiom, with the same honest test-connection caveat: /health is
 * unguarded, so a token typo only surfaces on the first write.
 */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { api, errText } from './api';
import type PhilomaticPlugin from './main';

export interface PhilomaticSettings {
  serverUrl: string;
  token: string;
  learnerId: string;
  /** Where embed clicks and Open-library land: an Obsidian tab (default) or the system browser. */
  linkTarget: 'obsidian' | 'browser';
  /** Where generated source notes land in the vault. */
  sourceNotesFolder: string;
  /** Where track folders (root track note + a source note per member) land in the vault. */
  trackNotesFolder: string;
}

export const DEFAULT_SETTINGS: PhilomaticSettings = {
  serverUrl: 'http://localhost:4321',
  token: '',
  learnerId: '',
  linkTarget: 'obsidian',
  sourceNotesFolder: 'Philomatic sources',
  trackNotesFolder: 'Philomatic tracks',
};

export class PhilomaticSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PhilomaticPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your self-hosted Philomatic server (start it with `pnpm serve`); the library viewer lives there too.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.serverUrl)
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Only if your server sets one (X-Ingest-Token). Checked on your first capture, not by the connection test.')
      .addText((text) =>
        text
          .setPlaceholder('leave empty for an open local server')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Learner id')
      .setDesc('Optional: whose overlay your captures land under. Leave empty for the server default.')
      .addText((text) =>
        text
          .setPlaceholder('lnr_…')
          .setValue(this.plugin.settings.learnerId)
          .onChange(async (value) => {
            this.plugin.settings.learnerId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Open links in')
      .setDesc('Where embed clicks and the Open-library command land.')
      .addDropdown((d) =>
        d
          .addOption('obsidian', 'Obsidian tab')
          .addOption('browser', 'System browser')
          .setValue(this.plugin.settings.linkTarget)
          .onChange(async (value) => {
            this.plugin.settings.linkTarget = value === 'browser' ? 'browser' : 'obsidian';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Source notes folder')
      .setDesc('Where "Create source note" puts its notes.')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.sourceNotesFolder).setValue(this.plugin.settings.sourceNotesFolder).onChange(async (value) => {
          this.plugin.settings.sourceNotesFolder = value.trim() || DEFAULT_SETTINGS.sourceNotesFolder;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Track notes folder')
      .setDesc('Where "Create track notes" puts its folders (one per track).')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.trackNotesFolder).setValue(this.plugin.settings.trackNotesFolder).onChange(async (value) => {
          this.plugin.settings.trackNotesFolder = value.trim() || DEFAULT_SETTINGS.trackNotesFolder;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Pings the server’s /health.')
      .addButton((button) =>
        button.setButtonText('Test').onClick(async () => {
          button.setDisabled(true);
          try {
            await api<{ ok: boolean }>(this.plugin.settings, '/health');
            new Notice('Philomatic: connected ✓');
          } catch (e) {
            new Notice(`Philomatic: ${errText(e)}`, 8000);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
  }
}
