/**
 * Pure publication-bundle verification (track registry, 2026-07-18) — shared by the engine's
 * fork-import and the registry service, which must verify WITHOUT opening any database:
 *   - contentHash: sha256 over the canonical payload JSON (tamper/reformat evidence)
 *   - signature: Ed25519 over the manifest-without-signature (impersonation evidence)
 * Policy stays with the callers: the engine accepts unsigned bundles (pre-signing era,
 * unattested forever); the registry requires signatures (keys ARE its identity model).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { parseCapture, PublicationBundleInput } from './capture';

export interface BundleVerification {
  ok: boolean;
  reason?: string;
  /** Parsed bundle when structurally valid (set even when ok=false for hash/sig failures). */
  bundle?: PublicationBundleInput;
  /** True when a signature was present AND verified. */
  signed: boolean;
}

export function verifyPublicationBundle(input: unknown): BundleVerification {
  let bundle: PublicationBundleInput;
  try {
    bundle = parseCapture(PublicationBundleInput, input);
  } catch (e) {
    return { ok: false, signed: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const hash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(bundle.payload))));
  if (hash !== bundle.publication.contentHash) {
    return {
      ok: false,
      signed: false,
      bundle,
      reason: 'bundle contentHash mismatch — the file was modified or reformatted in transit; re-download it from the origin',
    };
  }
  const { authorKey, signature } = bundle.publication;
  if (signature === undefined) return { ok: true, signed: false, bundle };
  if (authorKey === undefined) {
    return { ok: false, signed: false, bundle, reason: 'bundle carries a signature but no authorKey' };
  }
  const { signature: _sig, ...unsigned } = bundle.publication;
  let valid = false;
  try {
    valid = ed25519.verify(hexToBytes(signature), utf8ToBytes(JSON.stringify(unsigned)), hexToBytes(authorKey));
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      ok: false,
      signed: false,
      bundle,
      reason: 'bundle signature invalid — the manifest was modified or the authorKey is not the signer',
    };
  }
  return { ok: true, signed: true, bundle };
}

/** Verify a detached Ed25519 signature over a UTF-8 message (the registry's unpublish challenge). */
export function verifyDetached(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
