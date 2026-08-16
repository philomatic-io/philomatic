#!/usr/bin/env node
/**
 * OpenAI-compatible shim over the HEADLESS Antigravity CLI (`agy -p`) — the `agy` twin of
 * llm-shim-claude-code.mjs. Point Philomatic's LLM env here and the propose chain runs on
 * your Antigravity plan's models. Personal, local, loopback-only.
 *
 *   node scripts/llm-shim-antigravity.mjs            # listens on 127.0.0.1:8788
 *   LLM_BASE_URL=http://127.0.0.1:8788/v1 LLM_MODEL=gemini-3.6-flash-low pnpm serve
 *
 * Model names are agy's own (`agy models`): gemini-3.6-flash-{low,medium,high},
 * gemini-3.1-pro-{low,high}, claude-sonnet-4-6, … — the request's model passes through.
 *
 * How it drives the CLI: each request is flattened to ONE prompt and run as
 * `agy -p <prompt> --model <model> --sandbox`, cwd pinned to a throwaway temp dir — agy is an
 * agentic CLI, and the chain needs a pure text transform: the sandbox and the empty cwd keep
 * a curious model away from your files. Requests are serialized (the chain is sequential).
 *
 * Honest limits: a fresh CLI process per step (slower than an API); each step spends your
 * Antigravity quota; works only where `agy` is installed and logged in.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SHIM_PORT ?? 8788);
const TIMEOUT_MS = Number(process.env.SHIM_TIMEOUT_MS ?? 240_000);
const WORKDIR = mkdtempSync(join(tmpdir(), 'agy-shim-'));

/** Run one headless agy call: prompt as the -p argument, text on stdout. */
function runAgy(model, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('agy', ['-p', prompt, '--model', model, '--sandbox'], {
      cwd: WORKDIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agy -p timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`agy exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
      resolve(out.trim());
    });
  });
}

/** messages[] → one prompt. The chain sends [system, user]; anything else concatenates. */
const flatten = (messages) =>
  (messages ?? [])
    .map((m) => (m.role === 'system' ? `[instructions]\n${m.content}` : m.content))
    .join('\n\n');

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => resolve(raw));
  });

// One request at a time — a serial queue keeps quota spend predictable.
let chain = Promise.resolve();

const server = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    return json(404, { error: { message: 'POST /v1/chat/completions only' } });
  }
  chain = chain.then(async () => {
    try {
      const body = JSON.parse(await readBody(req));
      const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'gemini-3.6-flash-low';
      const started = Date.now();
      const text = await runAgy(model, flatten(body.messages));
      console.log(`[shim] ${model} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${text.length} chars`);
      json(200, {
        id: 'shim',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      });
    } catch (e) {
      console.error('[shim]', e.message ?? e);
      json(500, { error: { message: String(e.message ?? e) } });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`antigravity shim listening on http://${HOST}:${PORT}/v1  (models: see \`agy models\`)`);
});
