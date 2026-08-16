/**
 * Read/write a registry's PRIVATE files in tests the same way the server does — through the
 * at-rest encryption layer. The suite runs with a KEK (test/setup.ts), so `index.json`,
 * `accounts.json`, and the rest are ciphertext on disk; a test that pokes at them directly
 * goes through here instead of a raw `JSON.parse(readFileSync(...))`.
 */
import { join } from 'node:path';
import { envKek } from '../src/server/keys';
import { registryDEK, readPrivateJson, writePrivateJson } from '../src/registry/registry-crypto';

export function readReg<T>(dir: string, name: string): T {
  return readPrivateJson<T>(join(dir, name), registryDEK(dir, envKek()));
}

export function writeReg(dir: string, name: string, value: unknown): void {
  writePrivateJson(join(dir, name), value, registryDEK(dir, envKek()));
}
