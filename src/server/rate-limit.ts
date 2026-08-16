/**
 * A limit on how often one caller may do an expensive thing (hardening).
 *
 * Nothing here defends the graph — the tenant seam already decides whose library a request may
 * touch. This defends the SERVER: the CPU, the disk, the outbound calls, and the operator's
 * money. Those were never at risk while the only caller was the person who owned the machine.
 *
 * Two decisions worth naming, because both are easy to get quietly wrong.
 *
 * **Who is "one caller".** An account when we know it, and the socket address otherwise. NOT
 * `X-Forwarded-For` unless the deployment says a proxy sets it: that header is written by
 * whoever is talking to us, so trusting it by default means every limit can be lifted by adding
 * a header. A limiter that can be bypassed is worse than none, because it is believed.
 *
 * **What happens when it breaks.** It fails OPEN. A limiter is a guard rail, not a gate: if the
 * bookkeeping throws, the request proceeds rather than the server refusing everyone. The
 * opposite choice turns a bug in this file into an outage.
 */
import type { IncomingMessage } from 'node:http';

export interface Bucket {
  /** How many requests are allowed in a burst. */
  capacity: number;
  /** How many refill per second — the sustained rate. */
  perSecond: number;
}

/**
 * A token bucket per key. Bursts are allowed up to `capacity` and then the caller is held to
 * `perSecond`, which is what you want for humans: clicking five things quickly is normal, and
 * five hundred is not.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Spend one token. Returns how many seconds to wait when there is none — 0 means allowed.
   * The number is what a `Retry-After` header should say, so a well-behaved client can obey it.
   */
  take(key: string, limit: Bucket): number {
    const at = this.now();
    const entry = this.buckets.get(key) ?? { tokens: limit.capacity, last: at };
    // Refill for the time that has passed, capped — an idle caller gets a full burst back, not
    // an unbounded credit for having been away.
    entry.tokens = Math.min(limit.capacity, entry.tokens + ((at - entry.last) / 1000) * limit.perSecond);
    entry.last = at;
    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      this.buckets.set(key, entry);
      this.sweep(at, limit);
      return 0;
    }
    this.buckets.set(key, entry);
    return Math.max(1, Math.ceil((1 - entry.tokens) / limit.perSecond));
  }

  /** Forget callers who have been idle long enough to be back at full — the map would otherwise
   *  grow with every distinct key ever seen, which an attacker can drive with spoofed ones. */
  private sweep(at: number, limit: Bucket): void {
    if (at - this.lastSweep < 60_000) return;
    this.lastSweep = at;
    const fullAfter = (limit.capacity / limit.perSecond) * 1000;
    for (const [key, entry] of this.buckets) if (at - entry.last > fullAfter) this.buckets.delete(key);
  }

  /** For tests and a health route. */
  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Who to count this request against.
 *
 * `trustProxy` must be switched on deliberately. Behind a load balancer the socket address is the
 * balancer's, so every caller shares one bucket and the limit is meaningless; in front of one,
 * believing the header means every caller can invent a fresh identity per request. Both failures
 * are silent, which is why this is config rather than a guess.
 */
export function callerKey(req: IncomingMessage, opts: { accountId?: string; trustProxy?: boolean } = {}): string {
  if (opts.accountId !== undefined) return `acc:${opts.accountId}`;
  if (opts.trustProxy === true) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return `ip:${first}`;
  }
  return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
}
