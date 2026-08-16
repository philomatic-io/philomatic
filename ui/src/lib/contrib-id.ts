/**
 * Deterministic contribution ids — an anti-backfill reservation.
 *
 * Every accepted community contribution stamps a `#contrib:<id>` tag observation beside its
 * `#from:<name>` attribution. The id is a pure hash of {kind, value, assertedBy} — the same
 * shape the Phase-2 assertion layer will key claims by (the subject's own id is derived from
 * the same value, so this is the claim's address one level early). DORMANT by design: nothing
 * reads it today; its whole job is to exist in every graph and publication that accepts a
 * contribution from now on, so the assertion layer becomes a migration instead of an
 * excavation (provenance cannot be backfilled).
 *
 * A tag is deliberately the vehicle: free metadata, no schema change, unions on pull, and
 * travels with the entity through publish/fork/propose. The leading 'c' keeps the value a
 * SUBTYPE under the tag lexer (a purely numeric qualifier would parse as a degree).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface ContributionClaim {
  /** What kind of thing was contributed. */
  kind: 'question' | 'source';
  /** The contributed content itself — a question's text, a source's URL (or title when
   *  URL-less). The subject entity's id derives from this same value. */
  value: string;
  /** The contributor's public handle (username — real names never enter the graph). */
  assertedBy: string;
}

/** The deterministic id: `c` + 15 hex chars of sha256("kind|value|assertedBy"). */
export function contribId(claim: ContributionClaim): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(`${claim.kind}|${claim.value}|${claim.assertedBy}`)));
  return `c${digest.slice(0, 15)}`;
}

/** The tag observation an accept stamps: `#contrib:<id>`. */
export function contribTag(claim: ContributionClaim): string {
  return `#contrib:${contribId(claim)}`;
}
