/**
 * What a tenant has spent of the OPERATOR's money this month (hardening).
 *
 * Rate limits cap how FAST; they do nothing about how MUCH. At the current bucket a
 * tenant can run an LLM pass every twenty seconds indefinitely, which is thousands a day on
 * somebody else's API key. Rate limits protect the box; a budget protects the bill.
 *
 * Two things make this different from the limiter rather than a copy of it:
 *
 *   - it PERSISTS. Losing a rate limiter's state means someone gets a fresh burst, which is
 *     harmless. Losing a budget's state on every deploy means there is no budget.
 *   - it lives HERE, not on the account. The host cannot write to the registry's account store —
 *     the lock line keeps `src/server` out of `src/registry`, and the two must stay
 *     separable boxes. It is the host's bill, so it is the host's ledger.
 *
 * Calls rather than tokens, deliberately. Tokens are the real cost and vary by a hundredfold
 * between a short page and a long survey, but metering them means threading usage back out of
 * every provider call. A call count is crude in the safe direction: someone is refused sooner
 * than strictly necessary, never later.
 */
import { writeJsonPrivate } from './json-file';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Persisted {
  version: 1;
  /** accountId → { period, calls } */
  spend: Record<string, { period: string; calls: number }>;
}

/** `YYYY-MM` — a calendar month, so "resets on the 1st" is something a person can predict. */
function periodOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export class UsageLedger {
  private readonly path: string | undefined;
  private spend: Persisted['spend'] = {};

  constructor(path?: string) {
    this.path = path;
    if (path !== undefined && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Persisted;
        this.spend = typeof raw.spend === 'object' && raw.spend !== null ? raw.spend : {};
      } catch {
        // Unreadable ledger: start the month over rather than refuse everyone. The cost of the
        // wrong call here is one month's budget; the cost of failing closed is a dead feature
        // for every tenant because of a corrupt file.
        this.spend = {};
      }
    }
  }

  private flush(): void {
    if (this.path === undefined) return;
    writeJsonPrivate(this.path, { version: 1, spend: this.spend } satisfies Persisted);
  }

  /** What this account has spent in the current month. */
  used(accountId: string, now: () => number = Date.now): number {
    const entry = this.spend[accountId];
    return entry !== undefined && entry.period === periodOf(now()) ? entry.calls : 0;
  }

  /**
   * Spend one against `limit`. Returns undefined when allowed, or what to tell the person when
   * not — including WHEN it comes back, because "you have run out" without a date is a dead end.
   *
   * `limit` of 0 means the feature is off here; a negative limit means no budget at all.
   */
  spendOne(accountId: string, limit: number, now: () => number = Date.now): string | undefined {
    if (limit < 0) return undefined;
    const at = now();
    const period = periodOf(at);
    const entry = this.spend[accountId];
    const used = entry !== undefined && entry.period === period ? entry.calls : 0;
    if (used >= limit) {
      const next = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1));
      return limit === 0
        ? 'suggestions are not available on this server'
        : `you have used this month’s ${limit} suggestions — they reset on ${next.toISOString().slice(0, 10)}`;
    }
    this.spend[accountId] = { period, calls: used + 1 };
    this.flush();
    return undefined;
  }
}

/** Beside the libraries it is accounting for. */
export function usagePath(dataDir: string): string {
  return join(dataDir, 'usage.json');
}
