/// <reference types="chrome" />
/**
 * The extension's HTTP client of the ingest server (self-serve plan T1) — the same route shapes
 * as the viewer's transport (ui/src/client/transport.ts httpClient): GET when there is no body,
 * POST JSON otherwise, `{error}` payloads on failure. The server URL/token come from settings
 * (./config). A network-level failure becomes ServerUnreachableError so callers can render the
 * "is your server running?" message instead of a bare fetch error.
 */
import { getServerConfig } from './config';

export class ServerUnreachableError extends Error {
  constructor(readonly baseUrl: string) {
    super(`can’t reach your Philomatic server at ${baseUrl}`);
    this.name = 'ServerUnreachableError';
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = await getServerConfig();
  const headers: Record<string, string> = token ? { 'X-Ingest-Token': token } : {};
  let res: Response;
  try {
    res = await fetch(
      baseUrl + path,
      body === undefined
        ? { headers }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ServerUnreachableError(baseUrl);
  }
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status} on ${path}`);
  return json as T;
}
