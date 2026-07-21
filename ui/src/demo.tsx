/**
 * The zero-install demo (owner request, 2026-07-19; STRATEGY: the third rung of the adoption
 * ladder) — the FULL engine running in this tab via sql.js/WASM, seeded with an example graph.
 * Every interaction is real; the blast radius is one browser. State persists to localStorage
 * so play survives reload; Reset re-seeds. Publishing/registry pushes are disabled by the
 * local client — nothing here can leave the tab.
 */
import 'katex/dist/katex.min.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { PhilomaticEngine } from '../../src/engine';
import { localClient } from './client/local';
import seedDeepLearning from '../../examples/deep-learning.json';
import seedLogic from '../../examples/logic-going-further.json';

const STORE_KEY = 'pm.demo';

async function main(): Promise<void> {
  const engine = await PhilomaticEngine.openBrowser({ locateFile: () => wasmUrl });
  const saved = localStorage.getItem(STORE_KEY);
  const seedAll = () => {
    engine.importPayload(seedDeepLearning);
    engine.importPayload(seedLogic);
  };
  try {
    if (saved !== null) engine.importPayload(JSON.parse(saved));
    else seedAll();
  } catch {
    seedAll(); // a corrupt saved state never bricks the demo
  }
  const client = localClient(engine as never, () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(engine.exportAll()));
    } catch {
      /* storage full/blocked — the demo keeps working in-memory */
    }
  });
  const g = globalThis as { __PM_CLIENT__?: unknown; __PM_SUBSCRIBE__?: unknown; __PM_DEMO__?: boolean };
  g.__PM_CLIENT__ = client;
  g.__PM_SUBSCRIBE__ = client.subscribe;
  g.__PM_DEMO__ = true;

  // App reads the injected globals at module scope, so it must load AFTER they're set —
  // a static import would hoist its evaluation ahead of this function.
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
