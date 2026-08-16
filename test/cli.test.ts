/**
 * Slice 4 — CLI smoke test. Drives the real binary (via tsx) against a temp database so the
 * argv → engine → stdout path and process exit codes are exercised end-to-end.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TSX = './node_modules/.bin/tsx';
const CLI = 'src/cli/index.ts';

let dir: string;
let db: string;
let fixture: string;

const run = (args: string[]): string =>
  execFileSync(TSX, [CLI, '--db', db, ...args], { encoding: 'utf8' });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'philomatic-cli-'));
  db = join(dir, 'cli.sqlite');
  fixture = join(dir, 'payload.json');
  writeFileSync(
    fixture,
    JSON.stringify({
      version: 1,
      concepts: [{ name: 'Addition' }, { name: 'Multiplication', prerequisites: ['Addition'] }],
      questions: [{ text: 'What is 2 + 2?', about: ['Addition'] }],
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Slice 4: CLI', () => {
  it('imports then shows the assembled plan', () => {
    expect(run(['import', fixture])).toContain('2 concepts');
    const show = run(['show']);
    expect(show).toContain('0 answered');
    expect(show).toContain('Addition');
  });

  it('answer updates the plan overlay', () => {
    run(['answer', 'What is 2 + 2?']);
    expect(run(['show'])).toContain('1 answered');
  });

  it('track marks a concept as following and logs an event', () => {
    run(['track', 'Addition']);
    expect(run(['show'])).toContain('★following');
    expect(run(['list', 'events'])).toContain('TRACKS cpt_addition');
  });

  it('captures a source and a snippet over the engine capture API', () => {
    const cap = run(['capture', 'https://youtu.be/x', '--title', 'NN', '--tags', 'ml,video', '--track', 'DL']);
    expect(cap).toContain('Remembered');
    expect(cap).toContain('(staged)');
    // Idempotent by URL: a second capture reports it was already known.
    expect(run(['capture', 'https://youtu.be/x', '--title', 'NN'])).toContain('Already had');

    const snip = run(['snippet', 'https://youtu.be/x', 'the chain rule composes', '--sentiment', 'aha', '--raises', 'Why?']);
    expect(snip).toContain('Captured');
    expect(snip).toContain('1 question(s)');

    expect(run(['list', 'sources'])).toContain('NN');
    expect(run(['list', 'questions'])).toContain('Why?');
    expect(run(['list', 'tracks'])).toContain('DL');
  });

  it('rejects an invalid capture input with a clean error and non-zero exit', () => {
    expect(() => run(['capture', 'https://e.com/x', '--modality', 'bogus'])).toThrow(/Invalid enum value/);
  });

  it('exports a Mermaid diagram', () => {
    expect(run(['export', '--format', 'mermaid'])).toContain('graph TD');
  });

  it('exits non-zero on invalid input (prerequisite cycle)', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        concepts: [
          { name: 'A', prerequisites: ['B'] },
          { name: 'B', prerequisites: ['A'] },
        ],
      }),
    );
    expect(() => run(['import', bad])).toThrow();
  });
});
