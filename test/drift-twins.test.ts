/**
 * DRIFT TESTS for the deliberate cross-boundary twins. The lock line forbids shared
 * modules across src/ and ui/, so these copies stay copies — and each pair gets a test
 * that fails when one side moves without the other, the same discipline as the
 * tokens.css byte-identity test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fwNameOf } from '../ui/src/views/FrameworkEditor';
import { usernameOf } from './ui-smoke/one-origin';

const src = (p: string): string => readFileSync(p, 'utf8');

describe('cross-boundary twins stay in step', () => {
  it('the tag-name charset: schema TAG_RE ↔ the framework editor load wall', () => {
    // One grammar fragment, two literals: the sugar lexer's name group and the load wall's
    // "a name you couldn't type isn't loadable" check. If the grammar ever admits more
    // (underscores? unicode?), both must move together.
    const CHARSET = '[a-z0-9][a-z0-9-]*';
    expect(src('src/schema/tags.ts'), 'the lexer speaks the charset').toContain(`#(${CHARSET})`);
    expect(src('ui/src/views/FrameworkEditor.tsx'), 'the load wall speaks the same charset').toContain(`/^${CHARSET}$/i`);
  });

  it('the framework-name wall: registry FW_NAME accepts every fwNameOf output', () => {
    // The editor's kebab normalizer EMITS what the registry's path wall ACCEPTS — a named
    // framework must be able to ride a push into the archive unchanged. Fuzz the promise.
    const m = /const FW_NAME = (\/.+?\/)/.exec(src('src/registry/server.ts'));
    expect(m, 'FW_NAME still exists where the audit found it').not.toBeNull();
    const FW_NAME = new RegExp(m![1]!.slice(1, -1));
    const inputs = [
      'Logic Lenses', 'logic-lenses', '  spaced  out  ', 'Ünïcode Näme', 'a', 'x'.repeat(200),
      'trailing-', '-leading', 'dots.and/slashes', '..', 'MiXeD CaSe 123', '🙂 emoji name', 'tabs\tand\nnewlines',
    ];
    for (const input of inputs) {
      const out = fwNameOf(input);
      if (out !== '') expect(FW_NAME.test(out), `fwNameOf(${JSON.stringify(input)}) → ${JSON.stringify(out)} must pass the wall`).toBe(true);
      expect(out.length, 'the wall caps at 64').toBeLessThanOrEqual(64);
    }
  });

  it('the username rule: the test fixture mints handles the registry accepts', () => {
    // `usernameOf` seeds every lifecycle persona; if the registry rule ever tightens, the
    // fixture would silently mint invalid handles and every progression would fail obscurely.
    const line = src('src/registry/server.ts').split('\n').find((l) => l.includes('username.length >= 3'));
    expect(line, 'the registry username rule still exists').toBeDefined();
    const m = /(\/\^.+?\$\/)/.exec(line!);
    expect(m).not.toBeNull();
    const RULE = new RegExp(m![1]!.slice(1, -1));
    for (const subject of ['Prof', 'Alice A', 'Studious Stu', 'a', '--x--', 'Late Larry', 'Ünïcode Person', 'x'.repeat(80)]) {
      const handle = usernameOf(subject);
      expect(handle.length).toBeGreaterThanOrEqual(3);
      expect(handle.length).toBeLessThanOrEqual(32);
      expect(RULE.test(handle), `usernameOf(${JSON.stringify(subject)}) → ${JSON.stringify(handle)} must satisfy the registry rule`).toBe(true);
    }
  });
});
