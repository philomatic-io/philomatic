/**
 * The operator's settings, and the operator's bill.
 *
 * Rate limits cap how FAST a tenant works; neither of these is about speed. The ledger caps how
 * MUCH of somebody else's money one account may spend, and the config decides where every such
 * number comes from.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import { UsageLedger, usagePath } from '../src/server/usage';

const withFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'pm-cfg-')), 'philomatic.config.json');
  writeFileSync(path, contents);
  return path;
};

describe('the config file', () => {
  it('supplies defaults when there is no file at all', () => {
    const c = loadConfig({ PHILOMATIC_CONFIG: '/nonexistent/philomatic.config.json' });
    expect(c.llmCallsPerMonth).toBe(50);
    expect(c.trustProxy).toBe(false);
    expect(c.dataDir).toBeUndefined(); // single-tenant unless told otherwise
  });

  it('reads a file, and the ENVIRONMENT still wins', () => {
    // So a container overrides one setting without rebuilding an image, and a file cannot
    // silently countermand what an operator typed.
    const path = withFile(JSON.stringify({ llmCallsPerMonth: 10, dataDir: '/from/file', trustProxy: true }));
    expect(loadConfig({ PHILOMATIC_CONFIG: path }).llmCallsPerMonth).toBe(10);
    expect(loadConfig({ PHILOMATIC_CONFIG: path, LLM_CALLS_PER_MONTH: '99' }).llmCallsPerMonth).toBe(99);
    expect(loadConfig({ PHILOMATIC_CONFIG: path, INGEST_DATA_DIR: '/from/env' }).dataDir).toBe('/from/env');
    expect(loadConfig({ PHILOMATIC_CONFIG: path, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('REFUSES a malformed file rather than running on defaults', () => {
    // An operator who mistyped a brace has said something about how this should run. Starting
    // anyway would run a configuration nobody chose, differently from what they see on screen.
    const path = withFile('{ oops');
    expect(() => loadConfig({ PHILOMATIC_CONFIG: path })).toThrow(/not valid JSON/);
  });

  it('REFUSES to hold a secret', () => {
    // A config file sits beside the code and gets committed by accident — which is exactly how a
    // client secret leaks. Failing loudly is kinder than accepting it and being wrong later.
    const path = withFile(JSON.stringify({ clientSecret: 'oops' }));
    expect(() => loadConfig({ PHILOMATIC_CONFIG: path })).toThrow(/secrets belong in the environment/);
  });

  it('converts the units it advertises', () => {
    const path = withFile(JSON.stringify({ tokenVerifyTtlSeconds: 5, poolIdleSeconds: 30 }));
    const c = loadConfig({ PHILOMATIC_CONFIG: path });
    expect(c.tokenVerifyTtlMs).toBe(5000);
    expect(c.poolIdleMs).toBe(30_000);
  });
});

describe('the monthly budget', () => {
  const jan = Date.parse('2026-01-10T00:00:00Z');
  const feb = Date.parse('2026-02-02T00:00:00Z');

  it('allows the allowance, then refuses with a DATE', () => {
    const led = new UsageLedger();
    for (let i = 0; i < 3; i += 1) expect(led.spendOne('acc_1', 3, () => jan)).toBeUndefined();
    const refusal = led.spendOne('acc_1', 3, () => jan);
    // "You have run out" without a date is a dead end.
    expect(refusal).toMatch(/reset on 2026-02-01/);
  });

  it('resets with the calendar month', () => {
    const led = new UsageLedger();
    led.spendOne('acc_1', 1, () => jan);
    expect(led.spendOne('acc_1', 1, () => jan)).toBeDefined();
    expect(led.spendOne('acc_1', 1, () => feb)).toBeUndefined();
  });

  it('meters each account separately', () => {
    const led = new UsageLedger();
    led.spendOne('acc_1', 1, () => jan);
    expect(led.spendOne('acc_2', 1, () => jan)).toBeUndefined();
  });

  it('PERSISTS, or a deploy is a free refill', () => {
    // The difference from the rate limiter: losing a bucket means a fresh burst, which is
    // harmless. Losing a budget on every restart means there is no budget.
    const dir = mkdtempSync(join(tmpdir(), 'pm-usage-'));
    new UsageLedger(usagePath(dir)).spendOne('acc_1', 1, () => jan);
    expect(new UsageLedger(usagePath(dir)).spendOne('acc_1', 1, () => jan)).toBeDefined();
  });

  it('0 turns the feature off here, and a negative limit means no budget', () => {
    const led = new UsageLedger();
    expect(led.spendOne('acc_1', 0, () => jan)).toMatch(/not available/);
    for (let i = 0; i < 100; i += 1) expect(led.spendOne('acc_2', -1, () => jan)).toBeUndefined();
  });
});

describe('basePath (multiuser M-S1)', () => {
  it('defaults to the root, reads env over file, and normalizes to /prefix', () => {
    const none = { PHILOMATIC_CONFIG: '/nonexistent/philomatic.config.json' };
    expect(loadConfig(none).basePath).toBe('');
    expect(loadConfig({ ...none, BASE_PATH: '/app' }).basePath).toBe('/app');
    // Sloppy values normalize rather than half-working: no trailing slash, always a leading one.
    expect(loadConfig({ ...none, BASE_PATH: 'app/' }).basePath).toBe('/app');
    expect(loadConfig({ ...none, BASE_PATH: '/' }).basePath).toBe('');
    const path = withFile(JSON.stringify({ basePath: '/nested/app' }));
    expect(loadConfig({ PHILOMATIC_CONFIG: path }).basePath).toBe('/nested/app');
    expect(loadConfig({ PHILOMATIC_CONFIG: path, BASE_PATH: '/env-wins' }).basePath).toBe('/env-wins');
  });
});
