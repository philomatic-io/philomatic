/**
 * The static export builder (publish plan P6, PB-S3): one self-contained HTML file — the
 * built viewer with the publication bundle baked in as a global — hostable on any static
 * host. This is the local-first publish path: self-hosters' servers live on localhost, so
 * "publish" must produce an ARTIFACT, not require a reachable URL.
 *
 * Mechanics: the viewer's index.html references exactly one JS and one CSS asset; both are
 * inlined (the stylesheet as <style>, the module script verbatim), and the bundle lands in
 * `window.__PHILOMATIC_PUBLICATION__` BEFORE the app script so main.tsx picks the publication
 * page with no fetch. Escapes: `</script` sequences in embedded JSON/JS are broken with a
 * backslash (identical semantics inside JS strings/regexes — the vite-plugin-singlefile trick).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `</script` inside an inline script would close the tag mid-content; `<\/script` can't. */
const escapeInline = (code: string): string => code.replace(/<\/script/gi, '<\\/script');

export function buildPublicationHtml(bundle: unknown, distDir: string): string {
  const index = readFileSync(join(distDir, 'index.html'), 'utf8');

  const scriptMatch = /<script[^>]*\bsrc="\.?\/?(assets\/[^"]+\.js)"[^>]*><\/script>/.exec(index);
  const styleMatch = /<link[^>]*\bhref="\.?\/?(assets\/[^"]+\.css)"[^>]*>/.exec(index);
  if (!scriptMatch || !styleMatch) {
    throw new Error(`could not find the viewer's script/style tags in ${join(distDir, 'index.html')} — run pnpm ui:build`);
  }
  const js = readFileSync(join(distDir, scriptMatch[1]!), 'utf8');
  // KaTeX's fonts ride along as data URIs (self-contained is the whole point of this artifact).
  // Only woff2 needs embedding: it leads every @font-face src list, so a browser that takes it
  // never fetches the woff/ttf fallbacks whose /assets/ URLs are meaningless in a lone file.
  const css = readFileSync(join(distDir, styleMatch[1]!), 'utf8').replace(
    /url\(\/?(assets\/[^)]+\.woff2)\)/g,
    (_m, rel: string) => `url(data:font/woff2;base64,${readFileSync(join(distDir, rel)).toString('base64')})`,
  );
  // JSON is embedded inside a script: escape `<` so no `</script>`/`<!--` sequence survives.
  const json = JSON.stringify(bundle).replace(/</g, '\\u003c');

  return index
    .replace(styleMatch[0], () => `<style>${css}</style>`)
    .replace(
      scriptMatch[0],
      () => `<script>window.__PHILOMATIC_PUBLICATION__ = ${json};</script>\n<script type="module">${escapeInline(js)}</script>`,
    );
}
