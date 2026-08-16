/**
 * Turn a PLAINTEXT deployment into an encrypted one — the path a self-hoster takes to adopt
 * encryption at rest after running plaintext (the beta box is greenfield and never needs this).
 *
 * Idempotent by construction: a library that already has a `.key` sibling, or a registry that
 * already has `registry.key`, is skipped — so a re-run after a partial failure finishes the job.
 * The caller is responsible for a backup first; this rewrites files in place.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aesKek, generateDEK, resolveDEK, type Kek } from './keys';
import { writeFilePrivate } from './json-file';
import { rekeyDb } from '../engine';

/**
 * Encrypt every plaintext `<accountId>.sqlite` in a hosted data directory. A library with a
 * `.key` already is skipped (already encrypted). Returns which were done and which were skipped.
 */
export function encryptLibraries(dataDir: string, kek: Kek): { encrypted: string[]; skipped: string[] } {
  const encrypted: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(dataDir)) return { encrypted, skipped };
  for (const name of readdirSync(dataDir)) {
    if (!name.endsWith('.sqlite')) continue;
    const dbPath = join(dataDir, name);
    const keyPath = `${dbPath.slice(0, -'.sqlite'.length)}.key`;
    if (existsSync(keyPath)) {
      skipped.push(name);
      continue;
    }
    const dek = generateDEK();
    rekeyDb(dbPath, dek);
    writeFilePrivate(keyPath, kek.wrap(dek));
    encrypted.push(name);
  }
  return { encrypted, skipped };
}

/** The registry's private files (see registry-crypto for why these and not the public ones). */
const REGISTRY_PRIVATE_FILES = ['accounts.json', 'tokens.json', 'index.json', 'frameworks.json'];

/**
 * Encrypt a registry directory's plaintext private state: the top-level PII files plus every
 * per-track contributions mailbox. Mints `registry.key` (the registry DEK, wrapped by the KEK).
 * A registry that already has `registry.key` is skipped whole — it is already encrypted.
 */
export function encryptRegistry(dir: string, kek: Kek): { encrypted: string[]; skipped: boolean } {
  if (existsSync(join(dir, 'registry.key'))) return { encrypted: [], skipped: true };
  const dek = resolveDEK(join(dir, 'registry.key'), kek); // mints + persists the wrapped registry DEK
  const cipher = aesKek(dek);
  const encrypted: string[] = [];
  const encryptFile = (path: string, rel: string): void => {
    if (!existsSync(path)) return;
    const plain = readFileSync(path);
    writeFilePrivate(path, cipher.wrap(plain));
    encrypted.push(rel);
  };
  for (const f of REGISTRY_PRIVATE_FILES) encryptFile(join(dir, f), f);
  const contribDir = join(dir, 'contributions');
  if (existsSync(contribDir)) {
    for (const name of readdirSync(contribDir)) {
      if (name.endsWith('.json')) encryptFile(join(contribDir, name), `contributions/${name}`);
    }
  }
  return { encrypted, skipped: false };
}
