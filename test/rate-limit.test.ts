/**
 * How often one caller may do an expensive thing.
 *
 * This defends the SERVER rather than the graph — the tenant seam already decides whose library
 * a request may touch. What was never at risk while the only caller owned the machine is the
 * CPU, the disk, the outbound calls, and the operator's money.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { callerKey, RateLimiter } from '../src/server/rate-limit';

const req = (headers: Record<string, string> = {}, remoteAddress = '203.0.113.7') =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('the bucket', () => {
  const limit = { capacity: 3, perSecond: 1 };

  it('allows a burst, then holds the caller to the rate', () => {
    let clock = 0;
    const rl = new RateLimiter({ now: () => clock });
    // Clicking three things quickly is normal; the fourth in the same instant is not.
    expect([rl.take('a', limit), rl.take('a', limit), rl.take('a', limit)]).toEqual([0, 0, 0]);
    expect(rl.take('a', limit)).toBeGreaterThan(0);
    clock += 1000;
    expect(rl.take('a', limit)).toBe(0);
  });

  it('says HOW LONG to wait, so a client can obey rather than guess', () => {
    let clock = 0;
    const rl = new RateLimiter({ now: () => clock });
    for (let i = 0; i < 3; i += 1) rl.take('a', limit);
    expect(rl.take('a', limit)).toBe(1); // seconds — what Retry-After should carry
  });

  it('keeps callers apart', () => {
    const rl = new RateLimiter({ now: () => 0 });
    for (let i = 0; i < 3; i += 1) rl.take('a', limit);
    expect(rl.take('a', limit)).toBeGreaterThan(0);
    expect(rl.take('b', limit)).toBe(0);
  });

  it('refills to a FULL burst and no further', () => {
    let clock = 0;
    const rl = new RateLimiter({ now: () => clock });
    rl.take('a', limit);
    clock += 3_600_000; // an hour away
    // An idle caller gets their burst back, not an hour's worth of credit to spend at once.
    expect([rl.take('a', limit), rl.take('a', limit), rl.take('a', limit)]).toEqual([0, 0, 0]);
    expect(rl.take('a', limit)).toBeGreaterThan(0);
  });

  it('forgets idle callers, so spoofed keys cannot grow the map forever', () => {
    let clock = 0;
    const rl = new RateLimiter({ now: () => clock });
    for (let i = 0; i < 500; i += 1) rl.take(`junk-${i}`, limit);
    expect(rl.size).toBe(500);
    clock += 120_000;
    rl.take('one-more', limit); // sweeps
    expect(rl.size).toBeLessThan(10);
  });
});

describe('who counts as one caller', () => {
  it('an account, when we know it', () => {
    expect(callerKey(req(), { accountId: 'acc_1' })).toBe('acc:acc_1');
  });

  it('IGNORES x-forwarded-for unless the deployment says a proxy sets it', () => {
    // The header is written by whoever is talking to us. Trusting it by default means every
    // limit can be lifted by adding a header — a limiter that can be bypassed is worse than
    // none, because it is believed.
    expect(callerKey(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('ip:203.0.113.7');
    expect(callerKey(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: true })).toBe('ip:1.2.3.4');
  });

  it('takes the FIRST hop when a proxy chain is trusted', () => {
    expect(callerKey(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), { trustProxy: true })).toBe('ip:1.2.3.4');
  });

  it('prefers the account over any address', () => {
    // Otherwise one person behind a shared address is limited by their neighbours.
    expect(callerKey(req({ 'x-forwarded-for': '1.2.3.4' }), { accountId: 'acc_1', trustProxy: true })).toBe('acc:acc_1');
  });
});
