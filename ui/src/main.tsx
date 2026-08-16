import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PublicationPage } from './views/Publication';
import { resolveBackend } from './lib/backend-pref';
import 'katex/dist/katex.min.css';
import './styles.css';

// `/t/<id>` is the PUBLIC publication page — a different app, not a mode of
// the workbench: it must never fetch /snapshot, only the publication bundle. A static export
// embeds the bundle as a global instead of fetching it — one file, no server.
const inline = (window as { __PHILOMATIC_PUBLICATION__?: unknown }).__PHILOMATIC_PUBLICATION__;
const pubMatch = /^\/t\/([^/]+?)$/.exec(window.location.pathname);

const root: Root = createRoot(document.getElementById('root')!);

/**
 * The workbench boots against one of two engines: a server, or this browser.
 * The choice is a stored preference, decided once by asking whether a server answers.
 *
 * Two things here are load-bearing:
 *   - `App` reads its client from a page global at MODULE scope, so it must be imported AFTER
 *     the in-browser engine has published one. A static import would hoist past that.
 *   - `boot/local-backend` is only ever imported dynamically, so someone on the server backend
 *     never downloads sql.js and the WASM that comes with it.
 */
async function bootWorkbench(): Promise<void> {
  if ((await resolveBackend()) === 'browser') {
    const { bootLocalBackend } = await import('./boot/local-backend');
    // A real first run starts EMPTY and says so — examples come in by explicit import.
    await bootLocalBackend();
  }
  const { App } = await import('./App');
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if (inline !== undefined) {
  root.render(
    <StrictMode>
      <PublicationPage inline={inline} />
    </StrictMode>,
  );
} else if (pubMatch) {
  root.render(
    <StrictMode>
      <PublicationPage trackId={decodeURIComponent(pubMatch[1]!)} />
    </StrictMode>,
  );
} else {
  void bootWorkbench();
}
