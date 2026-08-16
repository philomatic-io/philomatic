/**
 * Encryption-at-rest keys for hosted libraries.
 *
 * Envelope model: each library file is encrypted with its own random 32-byte DATA key (DEK);
 * the DEK is stored WRAPPED (AES-256-GCM) beside the library as `<accountId>.key`, under the
 * one master KEY-encryption key (KEK). Rotating or revoking touches the small wrapped-key
 * files, never the databases. The KEK never touches disk here as anything but its own source
 * (an env var today; Cloud KMS in the production adapter, where the raw KEK never appears on
 * the box at all).
 *
 * The engine stays key-blind: it takes an opaque `Buffer` and issues `pragma key`. Key
 * generation, wrapping, and the KEK live here, at the server tier, exactly where per-account
 * files are already chosen.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFilePrivate } from './json-file';

/** Wraps and unwraps a DEK. The env implementation lives here; a KMS one is a drop-in later. */
export interface Kek {
  wrap(dek: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
}

/** AES-256-GCM envelope: `nonce(12) | ciphertext | tag(16)`. */
export function aesKek(key: Buffer): Kek {
  if (key.length !== 32) throw new Error('KEK must be 32 bytes');
  return {
    wrap(dek) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return Buffer.concat([iv, ct, c.getAuthTag()]);
    },
    unwrap(wrapped) {
      if (wrapped.length < 12 + 16) throw new Error('wrapped key is truncated');
      const iv = wrapped.subarray(0, 12);
      const tag = wrapped.subarray(wrapped.length - 16);
      const ct = wrapped.subarray(12, wrapped.length - 16);
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  };
}

/**
 * The KEK from the environment, or `undefined` when none is configured. `PHILOMATIC_KEK` is a
 * base64-encoded 32-byte key. This is the self-hoster and dev path; production resolves the KEK
 * through Cloud KMS instead (the KMS adapter returns a `Kek` with the same shape).
 */
export function envKek(env: NodeJS.ProcessEnv = process.env): Kek | undefined {
  const b64 = env.PHILOMATIC_KEK?.trim();
  if (!b64) return undefined;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('PHILOMATIC_KEK must decode to 32 bytes (base64 of a 256-bit key)');
  return aesKek(key);
}

/** A fresh per-library data key. */
export function generateDEK(): Buffer {
  return randomBytes(32);
}

/**
 * The DEK for one library: unwrap the existing key file, or — on genuine first provision, when
 * no key file exists yet — mint one, persist it wrapped (0600), and return it. Idempotent and
 * correct for both the provision moment and every later reopen, so there is no separate mint
 * path to keep in step.
 */
export function resolveDEK(keyPath: string, kek: Kek): Buffer {
  if (existsSync(keyPath)) return kek.unwrap(readFileSync(keyPath));
  const dek = generateDEK();
  writeFilePrivate(keyPath, kek.wrap(dek));
  return dek;
}

