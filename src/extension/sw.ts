/**
 * MV3 service-worker entry — a thin capture client. The right-click
 * "Save to Philomatic" posts /ingest (+ /snippet for a selection) to the configured server,
 * exactly like the popup. The embedded engine host is retired: no sql.js, no local library —
 * a legacy install's payload is flagged on the action badge and moved via the options page
 * (./migrate, "push your library to the server").
 */
import { api } from './api';
import { flagLegacyData } from './migrate';

const MENU_ID = 'philomatic-save';
const PROPOSE_ID = 'philomatic-propose';
const PROBE_PARENT = 'philomatic-probe';
/** The six interrogatives. One tap at the moment of confusion — the
 *  learner never authors a question; the probe rides the snippet as `#probe:<word>` and
 *  CONDITIONS the propose pass, which drafts a question of that shape for accept/reject. */
const PROBES = ['why', 'what', 'how', 'who', 'where', 'when'] as const;
type Probe = (typeof PROBES)[number];

// Every service-worker life: surface a pending legacy library on the action badge.
void flagLegacyData();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Save to Philomatic',
    contexts: ['page', 'selection'],
  });
  // Probes live on a SELECTION only — they are about a passage, at the moment it confuses you.
  chrome.contextMenus.create({
    id: PROBE_PARENT,
    title: 'Ask about this passage',
    contexts: ['selection'],
  });
  for (const w of PROBES) {
    chrome.contextMenus.create({
      id: `${PROBE_PARENT}-${w}`,
      parentId: PROBE_PARENT,
      title: `${w.charAt(0).toUpperCase()}${w.slice(1)}?`,
      contexts: ['selection'],
    });
  }
  // The explicit structure-drafting action, reachable where you read.
  chrome.contextMenus.create({
    id: PROPOSE_ID,
    title: 'Save + suggest structure',
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

/**
 * A probe capture: the page as a source, the passage as its snippet, and the
 * interrogative as a `#probe:<word>` tag — zero schema change, and the propose pass reads
 * those tags as prompt conditioners. The learner writes nothing.
 */
async function probeFromMenu(
  word: Probe,
  info: { selectionText?: string },
  tab: { url?: string; title?: string } | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const selection = info.selectionText?.trim();
  if (!tab?.url || !/^https?:/.test(tab.url)) return { ok: false, error: 'not a web page' };
  if (!selection) return { ok: false, error: 'no passage selected' };
  try {
    await api('/ingest', { url: tab.url, title: tab.title });
    await api('/snippet', { url: tab.url, text: selection, tags: [`#probe:${word}`] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Save, then run the propose chain server-side. The server owns the LLM config, the
 * adapters, and the gates — the extension only asks. A host with no LLM configured answers
 * 503, which surfaces as a ✗ badge and the server's own explanation.
 */
async function proposeFromMenu(
  info: { selectionText?: string },
  tab: { url?: string; title?: string } | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const saved = await captureFromMenu(info, tab);
  if (!saved.ok) return saved;
  try {
    await api('/propose', { ref: tab!.url });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  const probe = id.startsWith(`${PROBE_PARENT}-`) ? (id.slice(PROBE_PARENT.length + 1) as Probe) : undefined;
  const run =
    probe !== undefined
      ? probeFromMenu(probe, info, tab)
      : id === PROPOSE_ID
        ? proposeFromMenu(info, tab)
        : captureFromMenu(info, tab);
  void run.then((result) => {
    // Badge feedback on the action icon: ✓ saved (page or page+snippet), ✗ on failure; then
    // restore the migration flag if one is pending (flagLegacyData clears to '' otherwise).
    void chrome.action.setBadgeBackgroundColor({ color: result.ok ? '#2f6f4f' : '#a33a2a' });
    void chrome.action.setBadgeText({ text: result.ok ? '✓' : '✗' });
    setTimeout(() => void flagLegacyData(), 2500);
  });
});
