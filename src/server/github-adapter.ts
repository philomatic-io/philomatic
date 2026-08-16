/**
 * The GitHub source adapter — acquire-time only: a blob page is chrome around the
 * file; the raw host serves the file itself (markdown/plain arrives as text and passes
 * through acquisition verbatim, math intact). Pure URL knowledge, no I/O — the acquisition
 * service owns fetching and fallback, so a 404 on raw just falls back to the blob page.
 */
import type { SourceAdapter } from './adapters';

const BLOB = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

export function githubAdapter(): SourceAdapter {
  return {
    name: 'github',
    cost: 'cheap',
    applies: (url) => BLOB.test(url),
    acquireUrls: (url) => {
      const m = BLOB.exec(url);
      return m ? [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`] : [];
    },
  };
}
