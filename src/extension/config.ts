/// <reference types="chrome" />
/**
 * Server connection settings (self-serve plan T1) — the extension is a capture client of a
 * self-hosted ingest server; which server (and its optional write token) lives in
 * chrome.storage.sync so it roams with the browser profile. The options page writes it; the
 * popup and service worker read it per call (no caching — a settings change applies instantly).
 */
export interface ServerConfig {
  /** Base URL of the ingest server, no trailing slash. */
  baseUrl: string;
  /** Optional X-Ingest-Token for write routes ('' = server runs open). */
  token: string;
}

/** The ingest server's out-of-the-box address (src/server/ingest.ts default port). */
export const DEFAULT_SERVER = 'http://localhost:4321';

const KEY_BASE = 'server.baseUrl';
const KEY_TOKEN = 'server.token';

const normalizeBase = (raw: string): string => raw.trim().replace(/\/+$/, '');

export async function getServerConfig(): Promise<ServerConfig> {
  const got = await chrome.storage.sync.get([KEY_BASE, KEY_TOKEN]);
  return {
    baseUrl: normalizeBase((got[KEY_BASE] as string | undefined) ?? '') || DEFAULT_SERVER,
    token: ((got[KEY_TOKEN] as string | undefined) ?? '').trim(),
  };
}

export async function setServerConfig(cfg: ServerConfig): Promise<void> {
  await chrome.storage.sync.set({
    [KEY_BASE]: normalizeBase(cfg.baseUrl),
    [KEY_TOKEN]: cfg.token.trim(),
  });
}
