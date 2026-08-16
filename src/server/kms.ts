/**
 * Cloud KMS as the KEK source (the production key path; env `PHILOMATIC_KEK` is the self-host
 * default). KMS calls are async and the hot path is synchronous, so KMS is used ONCE, at boot:
 *
 *   - a random 32-byte KEK is generated once and stored KMS-ENCRYPTED at `kek.enc`;
 *   - on boot, a single KMS `decrypt` unwraps it to the raw KEK, which then drives the ordinary
 *     synchronous `aesKek` envelope for every per-file DEK — no KMS call per open.
 *
 * So KMS is touched once per boot (the audit log shows boots); rotation re-wraps `kek.enc`;
 * revocation bites at the next restart. The raw KEK lives in process memory after boot — the
 * accepted tradeoff for a sync hot path, and no worse than the DEKs and plaintext a compromised
 * process already holds. The KEK is never on disk except KMS-wrapped.
 *
 * Transport is the KMS REST API with the VM's metadata-server token — no SDK dependency. The
 * `kms` transport is injectable so the envelope logic is testable without a real project.
 */
import { existsSync, readFileSync } from 'node:fs';
import { aesKek, generateDEK, type Kek } from './keys';
import { writeFilePrivate } from './json-file';

/** The two KMS operations we need, over a configured key. Injectable for tests. */
export interface KmsTransport {
  encrypt(plaintext: Buffer): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<Buffer>;
}

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** A KMS transport bound to one key, authenticating as the VM's service account. */
export function gcpKmsTransport(keyName: string): KmsTransport {
  const token = async (): Promise<string> => {
    const r = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw new Error(`KMS: could not get a metadata token (HTTP ${r.status}) — is this a GCP VM with a service account?`);
    return ((await r.json()) as { access_token: string }).access_token;
  };
  const call = async (op: 'encrypt' | 'decrypt', field: 'plaintext' | 'ciphertext', data: Buffer): Promise<Buffer> => {
    const r = await fetch(`https://cloudkms.googleapis.com/v1/${keyName}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: data.toString('base64') }),
    });
    if (!r.ok) throw new Error(`KMS ${op} failed (HTTP ${r.status}): ${await r.text()}`);
    const out = (await r.json()) as { plaintext?: string; ciphertext?: string };
    const b64 = op === 'encrypt' ? out.ciphertext : out.plaintext;
    if (b64 === undefined) throw new Error(`KMS ${op}: empty response`);
    return Buffer.from(b64, 'base64');
  };
  return {
    encrypt: (plaintext) => call('encrypt', 'plaintext', plaintext),
    decrypt: (ciphertext) => call('decrypt', 'ciphertext', ciphertext),
  };
}

/**
 * The KEK, unwrapped via KMS — auto-bootstrapping like `resolveDEK` one level up: load and
 * KMS-decrypt an existing `kekPath`, or mint a KEK, KMS-encrypt it, persist (0600), and use it.
 * The single async boundary in the whole encryption stack; everything below stays synchronous.
 */
export async function kmsKek(kms: KmsTransport, kekPath: string): Promise<Kek> {
  const raw = existsSync(kekPath) ? await kms.decrypt(readFileSync(kekPath)) : await mint(kms, kekPath);
  if (raw.length !== 32) throw new Error('the KMS-wrapped KEK did not decrypt to 32 bytes');
  return aesKek(raw);
}

async function mint(kms: KmsTransport, kekPath: string): Promise<Buffer> {
  const raw = generateDEK();
  writeFilePrivate(kekPath, await kms.encrypt(raw));
  return raw;
}

/**
 * Resolve the KEK for a server, async, from the environment: KMS when `PHILOMATIC_KMS_KEY` is
 * set (production), the plain env KEK otherwise (self-host/dev), or undefined when neither is —
 * the caller (`createIngestServer` / `createRegistryServer`) then applies its own no-KEK refusal.
 * The wrapped-KEK file sits beside the data it protects (`<dir>/kek.enc`).
 */
export async function resolveKekFromEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<Kek | undefined> {
  const keyName = env.PHILOMATIC_KMS_KEY?.trim();
  if (keyName !== undefined && keyName !== '') {
    const { join } = await import('node:path');
    return kmsKek(gcpKmsTransport(keyName), join(dir, 'kek.enc'));
  }
  const { envKek } = await import('./keys');
  return envKek(env);
}
