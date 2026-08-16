/**
 * Booting the IN-BROWSER backend: the full engine compiled to WASM, running and persisting
 * entirely in the tab. Always dynamically imported so a reader on the server backend never
 * downloads sql.js. A real first run starts EMPTY and says so — examples arrive by import,
 * never by surprise seeding.
 */
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { PhilomaticEngine } from '../../../src/engine';
import { localClient } from '../client/local';
import { debouncedSaver, LEGACY_KEY, loadBytes, loadFrameworkDoc, saveBytes, saveFrameworkDoc } from '../lib/browser-store';

/** A storage failure is the one error a learner must not be allowed to miss: everything else
 *  keeps working, so nothing else will tell them. */
export function reportStorageFailure(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[philomatic] could not save your library:', e);
  const existing = document.querySelector('.storage-alert');
  if (existing !== null) return; // one standing alert, not one per failed write
  const bar = document.createElement('div');
  bar.className = 'storage-alert';
  bar.setAttribute('role', 'alert');
  bar.textContent = `Philomatic could not save your library — ${msg}. Export a backup before closing this tab.`;
  document.body.appendChild(bar);
}

export interface LocalBackend {
  client: ReturnType<typeof localClient>;
}

/** Open the durable in-browser engine and wire it to the page's globals. */
export async function bootLocalBackend(): Promise<LocalBackend> {
  // The saved database, if there is one. An unreadable store is REPORTED, never quietly
  // replaced with a fresh library over the top of someone's work.
  let saved: Uint8Array | undefined;
  try {
    saved = await loadBytes();
  } catch (e) {
    reportStorageFailure(e);
  }
  const engine = await PhilomaticEngine.openBrowser({
    locateFile: () => wasmUrl,
    ...(saved !== undefined ? { data: saved } : {}),
  });

  if (saved === undefined) {
    // Nothing in IndexedDB: either a first visit, or a library saved under the old localStorage
    // scheme. Migrate it once — the payload replay is exactly what the old load did.
    const legacy = localStorage.getItem(LEGACY_KEY);
    try {
      if (legacy !== null) engine.importPayload(JSON.parse(legacy) as never);
    } catch {
      // A corrupt legacy payload never bricks the app — the fresh library stands.
    }
    // Save immediately: after this point what is on disk matches what is on screen, so closing
    // the tab without touching anything cannot lose a migrated library.
    try {
      await saveBytes(engine.exportBytes());
      // Drop the old key only once the library is safely in the new store — if the save above
      // failed, the localStorage copy is still the only copy and must survive to be retried.
      if (legacy !== null) localStorage.removeItem(LEGACY_KEY);
    } catch (e) {
      reportStorageFailure(e);
    }
  }

  const saver = debouncedSaver(() => engine.exportBytes(), reportStorageFailure);
  // A closing tab does not wait for a debounce timer.
  window.addEventListener('pagehide', () => saver.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saver.flush();
  });

  // The framework document rides IndexedDB beside the database bytes.
  const client = localClient(engine as never, () => saver.schedule(), { load: loadFrameworkDoc, save: saveFrameworkDoc });
  const g = globalThis as { __PM_CLIENT__?: unknown; __PM_SUBSCRIBE__?: unknown };
  g.__PM_CLIENT__ = client;
  g.__PM_SUBSCRIBE__ = client.subscribe;
  return { client };
}
