/**
 * Durable local storage for the in-browser workbench.
 *
 * What this replaces: the library lived in `localStorage` as `JSON.stringify(exportAll())`,
 * rewritten on every write. localStorage caps near 5MB; the quota failure was CAUGHT AND
 * DROPPED, so a learner whose library outgrew it kept working, closed the tab, and lost the
 * day with no error. Measured once: ~5MB there against a 7,516MB IndexedDB quota.
 *
 * What it is now: the SQLite file itself, as bytes, in IndexedDB — so loading is an open rather
 * than a replay of every row, and the cost of opening the app stops growing with the library.
 *
 * Three things this module refuses to do quietly:
 *   - It never swallows a write failure. `save` rejects, and the caller must say something.
 *   - It never requests persistence on its own. `navigator.storage.persist()` makes a reading
 *     history survive the browser's own housekeeping, which the learner should be told about,
 *     not have done for them — the settings page asks.
 *   - It never discards what it cannot read. A store it fails to open is reported, not reset.
 */

const DB_NAME = 'philomatic';
const DB_VERSION = 1;
const STORE = 'library';
/** One row: the database file. Keyed so a later slice can hold more than one library. */
const KEY = 'default';

/** localStorage key the demo used before this existed — migrated once, then removed. */
export const LEGACY_KEY = 'pm.demo';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open local storage'));
    // Another tab holding an older version open. Surfaced rather than hung on.
    req.onblocked = () => reject(new Error('another Philomatic tab is upgrading local storage — close it and reload'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('local storage request failed'));
      t.onabort = () => reject(t.error ?? new Error('local storage transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** The saved database, or undefined when there is none yet. Throws if the store is unreadable —
 *  an unreadable store is a thing to report, never a reason to start empty over someone's work. */
export async function loadBytes(): Promise<Uint8Array | undefined> {
  const raw = await tx<ArrayBuffer | Uint8Array | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<ArrayBuffer | Uint8Array | undefined>);
  if (raw === undefined) return undefined;
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

/** Persist the database. Rejects on quota or any other failure — callers MUST surface it. */
export async function saveBytes(bytes: Uint8Array): Promise<void> {
  // A fresh copy: the caller's view may be backed by WASM memory that moves under us.
  await tx('readwrite', (s) => s.put(new Uint8Array(bytes), KEY));
}

export async function clearBytes(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** How much room there is, and whether the browser has agreed to keep it (Settings shows this). */
export async function storageState(): Promise<{ usage?: number; quota?: number; persisted: boolean }> {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) return { persisted: false };
  const est = navigator.storage.estimate !== undefined ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage.persisted !== undefined ? await navigator.storage.persisted() : false;
  return { ...(est.usage !== undefined ? { usage: est.usage } : {}), ...(est.quota !== undefined ? { quota: est.quota } : {}), persisted };
}

/** Ask the browser not to evict this origin. Deliberately NOT called at boot — see the header. */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false;
  return navigator.storage.persist();
}

/**
 * A write coalescer. Every engine write asks to save; the database is megabytes, so saving on
 * each one would spend the session serializing. Trailing-edge, and `flush` exists because a
 * closing tab does not wait for a timer.
 */
export function debouncedSaver(
  bytes: () => Uint8Array,
  onError: (e: unknown) => void,
  waitMs = 400,
): { schedule: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const run = (): void => {
    timer = undefined;
    // Chain rather than race: two overlapping puts of the same key can land out of order, and
    // the loser would be the newer one.
    inFlight = inFlight.then(() => saveBytes(bytes())).catch(onError);
  };
  return {
    schedule: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, waitMs);
    },
    flush: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        run();
      }
    },
  };
}

// ── The framework store, browser host: the library's own vocabulary document —
// personal + installed frameworks — beside the database bytes, its own key in the same
// object store. The http host keeps its twin in a server-side sidecar; parity is pinned by
// the client contract suite.
const FW_KEY = 'frameworks';

export interface StoredFrameworkDoc {
  mine?: unknown;
  installed: unknown[];
}

export async function loadFrameworkDoc(): Promise<StoredFrameworkDoc | undefined> {
  const raw = await tx<StoredFrameworkDoc | undefined>('readonly', (s) => s.get(FW_KEY) as IDBRequest<StoredFrameworkDoc | undefined>);
  return raw ?? undefined;
}

export async function saveFrameworkDoc(doc: StoredFrameworkDoc): Promise<void> {
  await tx('readwrite', (s) => s.put(doc, FW_KEY));
}
