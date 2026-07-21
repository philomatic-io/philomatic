/**
 * MV3 service-worker entry (self-serve plan T1/T2) — a thin capture client. The right-click
 * "Save to Philomatic" posts /ingest (+ /snippet for a selection) to the configured server,
 * exactly like the popup. The embedded engine host retired in T2: no sql.js, no local library —
 * a pre-T2 install's payload is flagged on the action badge and moved via the options page
 * (./migrate, "push your library to the server").
 */
import { api } from './api';
import { flagLegacyData } from './migrate';

const MENU_ID = 'philomatic-save';

// Every service-worker life: surface a pending pre-T2 library on the action badge.
void flagLegacyData();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Save to Philomatic',
    contexts: ['page', 'selection'],
  });
});

/** The right-click capture: page as a source, a highlighted selection as its snippet. */
async function captureFromMenu(
  info: { selectionText?: string },
  tab: { url?: string; title?: string } | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!tab?.url || !/^https?:/.test(tab.url)) return { ok: false, error: 'not a web page' };
  try {
    await api('/ingest', { url: tab.url, title: tab.title });
    const selection = info.selectionText?.trim();
    if (selection) await api('/snippet', { url: tab.url, text: selection });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void captureFromMenu(info, tab).then((result) => {
    // Badge feedback on the action icon: ✓ saved (page or page+snippet), ✗ on failure; then
    // restore the migration flag if one is pending (flagLegacyData clears to '' otherwise).
    void chrome.action.setBadgeBackgroundColor({ color: result.ok ? '#2f6f4f' : '#a33a2a' });
    void chrome.action.setBadgeText({ text: result.ok ? '✓' : '✗' });
    setTimeout(() => void flagLegacyData(), 2500);
  });
});
