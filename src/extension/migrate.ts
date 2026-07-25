/// <reference types="chrome" />
/**
 * Legacy self-contained data hand-off (self-serve plan T2). Pre-T2 installs kept the whole
 * library payload in chrome.storage.local (the §2.7 self-contained shell). This module owns
 * that key's afterlife: detect it, push it to the configured server (POST /import — the
 * idempotent desugar→upsert path, so sugared seeds and canonical exports both work), and
 * archive the local copy under an `archived:` prefix — never delete it.
 */
import { api } from './api';

export const LEGACY_PAYLOAD_KEY = 'philomatic.payload';
export const ARCHIVED_PAYLOAD_KEY = 'archived:philomatic.payload';

export async function legacyPayload(): Promise<unknown> {
  const got = await chrome.storage.local.get(LEGACY_PAYLOAD_KEY);
  return got[LEGACY_PAYLOAD_KEY];
}

/** Set (or clear) the "you have a library to move" badge on the action icon. */
export async function flagLegacyData(): Promise<void> {
  const pending = (await legacyPayload()) !== undefined;
  if (pending) {
    await chrome.action.setBadgeBackgroundColor({ color: '#9184d9' });
    await chrome.action.setTitle({ title: 'Philomatic — your old in-browser library can move to your server (see Options)' });
  } else {
    await chrome.action.setTitle({ title: 'Philomatic — remember this page' });
  }
  await chrome.action.setBadgeText({ text: pending ? '!' : '' });
}

/** Move the legacy value under the archived key and clear the prompt. Idempotent. */
export async function archiveLegacy(): Promise<void> {
  const value = await legacyPayload();
  if (value !== undefined) {
    await chrome.storage.local.set({ [ARCHIVED_PAYLOAD_KEY]: value });
    await chrome.storage.local.remove(LEGACY_PAYLOAD_KEY);
  }
  await flagLegacyData();
}

/** Push the legacy library into the server, then archive the local copy. */
export async function pushLegacyToServer(): Promise<void> {
  const value = await legacyPayload();
  if (value === undefined) return;
  await api('/import', value); // throws on failure — the caller reports; nothing is archived
  await archiveLegacy();
}
