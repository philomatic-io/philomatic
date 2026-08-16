/**
 * Atomic PRIVATE json persistence — the pattern the account store and the usage ledger both
 * hand-rolled. 0700/0600 throughout: these files hold emails, token hashes, and
 * per-tenant spend, and the default 0644 makes them readable by every local user on the box.
 * The mode is set on the TEMP file so the rename carries it, and re-applied because a file
 * created before this existed keeps its old permissions forever otherwise.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
