import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PublicationPage } from './views/Publication';
import 'katex/dist/katex.min.css';
import './styles.css';

// `/t/<id>` is the PUBLIC publication page (publish plan P5) — a different app, not a mode of
// the workbench: it must never fetch /snapshot, only the publication bundle. A static export
// (PB-S3) embeds the bundle as a global instead of fetching it — one file, no server.
const inline = (window as { __PHILOMATIC_PUBLICATION__?: unknown }).__PHILOMATIC_PUBLICATION__;
const pubMatch = /^\/t\/([^/]+?)$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {inline !== undefined ? (
      <PublicationPage inline={inline} />
    ) : pubMatch ? (
      <PublicationPage trackId={decodeURIComponent(pubMatch[1]!)} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
