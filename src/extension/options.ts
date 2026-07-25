/// <reference types="chrome" />
/**
 * Options page (self-serve plan T1): where the capture client is pointed at a server. Test
 * connection hits GET /health on the *typed* (unsaved) URL so a user can verify before saving.
 * The token guards writes only, so a green health check with a wrong token is possible — the
 * first capture surfaces that; noted in the status message.
 */
import { DEFAULT_SERVER, getServerConfig, setServerConfig } from './config';
import { ServerUnreachableError } from './api';
import { archiveLegacy, legacyPayload, pushLegacyToServer } from './migrate';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setStatus(text: string, kind?: 'ok' | 'err'): void {
  const status = el<HTMLParagraphElement>('status');
  status.textContent = text;
  status.className = kind ?? '';
}

function setMigrateStatus(text: string, kind?: 'ok' | 'err'): void {
  const status = el<HTMLParagraphElement>('migrateStatus');
  status.textContent = text;
  status.className = kind ?? '';
}

const typedBase = (): string => (el<HTMLInputElement>('baseUrl').value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');

async function init(): Promise<void> {
  const cfg = await getServerConfig();
  el<HTMLInputElement>('baseUrl').value = cfg.baseUrl;
  el<HTMLInputElement>('token').value = cfg.token;
  el('migrate').hidden = (await legacyPayload()) === undefined;
}

// ── Pre-T2 hand-off: push the old in-browser library to the server, or just archive it ────────
async function pushLegacy(): Promise<void> {
  setMigrateStatus('Pushing your library to the server…');
  try {
    await pushLegacyToServer();
    setMigrateStatus('Pushed ✓ — merged into your server library; an archived local copy remains.', 'ok');
    setTimeout(() => (el('migrate').hidden = true), 4000);
  } catch (e) {
    setMigrateStatus(
      e instanceof ServerUnreachableError
        ? `${e.message} — start it (pnpm serve) or fix the URL above, then retry`
        : e instanceof Error
          ? e.message
          : String(e),
      'err',
    );
  }
}

async function archiveOnly(): Promise<void> {
  await archiveLegacy();
  setMigrateStatus('Archived locally without pushing — it stays under an archived: key.', 'ok');
  setTimeout(() => (el('migrate').hidden = true), 4000);
}

async function test(): Promise<void> {
  const base = typedBase();
  setStatus(`Checking ${base}…`);
  try {
    const res = await fetch(`${base}/health`);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (res.ok && json.ok) {
      setStatus('Connected ✓ (the token, if any, is checked on your first capture)', 'ok');
    } else {
      setStatus(`Server answered but not healthy (${res.status})`, 'err');
    }
  } catch {
    setStatus(`Can’t reach ${base} — is the server running? (pnpm serve)`, 'err');
  }
}

async function save(): Promise<void> {
  await setServerConfig({ baseUrl: typedBase(), token: el<HTMLInputElement>('token').value });
  setStatus('Saved ✓', 'ok');
}

void init();
el('test').addEventListener('click', () => void test());
el('save').addEventListener('click', () => void save());
el('pushLegacy').addEventListener('click', () => void pushLegacy());
el('archiveLegacy').addEventListener('click', () => void archiveOnly());
