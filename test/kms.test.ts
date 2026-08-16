/**
 * The KMS KEK path. KMS is used once at boot to unwrap a local KEK, which then drives
 * the ordinary synchronous envelope. Tested with an INJECTED transport — a fake KMS that wraps
 * with its own local key — so the envelope logic is proven without a real GCP project.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { kmsKek, type KmsTransport } from '../src/server/kms';
import { aesKek } from '../src/server/keys';

/** A fake KMS: encrypt/decrypt with a fixed local key, and count calls to prove KMS is touched
 *  once at boot and never per-DEK. */
function fakeKms(): KmsTransport & { calls: number } {
  const cipher = aesKek(randomBytes(32));
  const t = {
    calls: 0,
    encrypt: async (p: Buffer) => {
      t.calls += 1;
      return cipher.wrap(p);
    },
    decrypt: async (c: Buffer) => {
      t.calls += 1;
      return cipher.unwrap(c);
    },
  };
  return t;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'pm-kms-'));

describe('kmsKek — the boot-time unwrap', () => {
  it('mints a KEK on first boot (KMS-encrypts it), then loads it (KMS-decrypts) — one call each', async () => {
    const dir = tmp();
    const kekPath = join(dir, 'kek.enc');
    const kms = fakeKms();

    expect(existsSync(kekPath)).toBe(false);
    const kek1 = await kmsKek(kms, kekPath); // mint → one encrypt
    expect(existsSync(kekPath), 'the KMS-wrapped KEK is persisted').toBe(true);
    expect(kms.calls).toBe(1);

    // The persisted file is the KMS-wrapped KEK, never the raw key.
    const dek = randomBytes(32);
    const wrapped = kek1.wrap(dek);
    expect(kek1.unwrap(wrapped)).toEqual(dek); // the KEK works as an envelope

    // A second boot LOADS (one decrypt) with the same KMS, and yields a KEK that unwraps the
    // same DEK — i.e. the same underlying key material.
    kms.calls = 0;
    const kek2 = await kmsKek(kms, kekPath);
    expect(kms.calls).toBe(1);
    expect(kek2.unwrap(wrapped)).toEqual(dek);
  });

  it('KMS is touched ONCE regardless of how many DEKs the KEK then wraps', async () => {
    const dir = tmp();
    const kms = fakeKms();
    const kek = await kmsKek(kms, join(dir, 'kek.enc'));
    const callsAfterBoot = kms.calls;
    for (let i = 0; i < 50; i++) kek.unwrap(kek.wrap(randomBytes(32)));
    expect(kms.calls, 'wrapping DEKs never calls KMS').toBe(callsAfterBoot);
  });

  it('refuses a KEK blob that decrypts to the wrong length', async () => {
    const dir = tmp();
    const kekPath = join(dir, 'kek.enc');
    // A transport whose decrypt returns 16 bytes, not 32.
    const bad: KmsTransport = { encrypt: async (p) => p, decrypt: async () => randomBytes(16) };
    // Seed a file so the load path (decrypt) runs.
    await kmsKek({ encrypt: async (p) => p, decrypt: async (c) => c }, kekPath);
    await expect(kmsKek(bad, kekPath)).rejects.toThrow(/32 bytes/);
    expect(readFileSync(kekPath).length).toBeGreaterThan(0);
  });
});
