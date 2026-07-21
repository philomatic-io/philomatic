/**
 * The Library tab (owner request, 2026-07-16): the workbench itself, hosted in an Obsidian
 * tab — an ItemView wrapping an iframe on the self-serve server. Chips/cards navigate the
 * SAME tab by updating the iframe's URL hash; the workbench's own deep-link listener (OB-S2)
 * picks the selection up without a reload. The view-header action opens the current URL in
 * the system browser for anyone who wants the full window.
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';

export const LIBRARY_VIEW_TYPE = 'philomatic-library';

export class LibraryView extends ItemView {
  private iframe?: HTMLIFrameElement;
  private pendingUrl?: string;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return LIBRARY_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return 'Philomatic library';
  }
  override getIcon(): string {
    return 'library';
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass('philomatic-library');
    this.iframe = el.createEl('iframe');
    if (this.pendingUrl) this.iframe.src = this.pendingUrl;
    this.addAction('external-link', 'Open in browser', () => {
      if (this.iframe?.src) window.open(this.iframe.src);
    });
  }

  /** Point the tab at a workbench URL. A hash-only change navigates in place (no app reload). */
  setUrl(url: string): void {
    this.pendingUrl = url;
    if (this.iframe) this.iframe.src = url;
  }
}
