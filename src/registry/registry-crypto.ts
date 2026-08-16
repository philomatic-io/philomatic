/**
 * Encryption at rest for the registry's PRIVATE state.
 *
 * The registry stores JSON, not a SQLite database, so SQLCipher does not reach it — this is the
 * companion layer. ONE registry DEK (wrapped by the KEK, kept as `registry.key`) encrypts every
 * private file with AES-256-GCM. The DEK's PRESENCE decides the format uniformly, so there is no
 * per-file detection: a registry with a KEK writes ciphertext, one without writes plaintext.
 *
 * ENCRYPTED (private / PII): `accounts.json` (emails, provider subjects), `tokens.json` (token
 * hashes), `index.json` (community INVITE TOKENS and follower cursors ride inside the entries —
 * the public projection strips them, but the file holds them), `frameworks.json` (which account
 * owns each framework name), and the `contributions/` mailbox.
 *
 * PLAINTEXT (public by definition): `bundles/*.json`, `archive/*.json`, the published
 * `frameworks/<name>@v*.json` defs, `featured.json` — anything a stranger already fetches.
 * Encrypting those buys nothing and would add a decrypt hop to every public render.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aesKek, resolveDEK, type Kek } from '../server/keys';
import { writeFilePrivate, writeJsonPrivate } from '../server/json-file';

/** The registry's data key, minted+wrapped on first boot, or undefined when no KEK is configured
 *  (a plaintext self-hosted registry). */
export function registryDEK(dir: string, kek: Kek | undefined): Buffer | undefined {
  return kek === undefined ? undefined : resolveDEK(join(dir, 'registry.key'), kek);
}

/** Read a private JSON file: decrypt when a DEK is in force, else parse plaintext. */
export function readPrivateJson<T>(path: string, dek: Buffer | undefined): T {
  const raw = readFileSync(path);
  const text = dek === undefined ? raw.toString('utf8') : aesKek(dek).unwrap(raw).toString('utf8');
  return JSON.parse(text) as T;
}

/** Write a private JSON file: 0600 always; ciphertext when a DEK is in force, else plaintext. */
export function writePrivateJson(path: string, value: unknown, dek: Buffer | undefined): void {
  if (dek === undefined) {
    writeJsonPrivate(path, value);
    return;
  }
  writeFilePrivate(path, aesKek(dek).wrap(Buffer.from(JSON.stringify(value, null, 2))));
}

export { existsSync };
