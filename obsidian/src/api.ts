/**
 * The plugin's HTTP client of the ingest server (plan OB1) — the same route shapes as every
 * other client: GET when there is no body, POST JSON otherwise, `{error}` payloads on failure.
 * Uses Obsidian's `requestUrl` (CORS-free in Electron). A network-level failure becomes
 * ServerUnreachableError so callers can say "is your server running?" instead of a bare error.
 *
 * Writes carry the configured learnerId automatically (the T4 seam: body learnerId wins over
 * the instance default). NOTHING here imports from the repo's src/ — the lock line applied
 * externally; a capability gap means the server contract is missing a route.
 */
import { requestUrl } from 'obsidian';
import type { PhilomaticSettings } from './settings';

export class ServerUnreachableError extends Error {
  constructor(readonly baseUrl: string) {
    super(`can’t reach your Philomatic server at ${baseUrl}`);
    this.name = 'ServerUnreachableError';
  }
}

export async function api<T>(settings: PhilomaticSettings, path: string, body?: unknown): Promise<T> {
  const base = settings.serverUrl.trim().replace(/\/+$/, '');
  const learner = settings.learnerId.trim();
  const payload =
    body !== undefined && learner && typeof body === 'object' && body !== null && !('learnerId' in body)
      ? { ...(body as Record<string, unknown>), learnerId: learner }
      : body;

  let res: Awaited<ReturnType<typeof requestUrl>>;
  try {
    res = await requestUrl({
      url: base + path,
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...(settings.token.trim() ? { 'X-Ingest-Token': settings.token.trim() } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      throw: false, // status handled below; only network failure throws
    });
  } catch {
    throw new ServerUnreachableError(base);
  }
  if (res.status >= 400) {
    const message = (res.json as { error?: string } | undefined)?.error ?? `${res.status} on ${path}`;
    throw new Error(message);
  }
  return res.json as T;
}

/** Human message for a failed call — points at the fix (start the server / open settings). */
export const errText = (e: unknown): string =>
  e instanceof ServerUnreachableError
    ? `${e.message} — is it running? (pnpm serve; set the URL in Philomatic’s plugin settings)`
    : e instanceof Error
      ? e.message
      : String(e);
