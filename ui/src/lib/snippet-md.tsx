/* @jsxRuntime automatic @jsxImportSource react */
/**
 * The snippet-markdown contract (owner question, 2026-07-18): captured snippet text may carry
 * EXACTLY the subset the capture pipeline emits — **bold**, *italic*, `code`, `- ` bullets,
 * blank-line paragraphs, $inline$ and $$block$$ math, and `![alt](url)` images (image-capture
 * adapter, 2026-07-18) — and every ui surface renders it through THIS component. A closed
 * grammar, not markdown-at-large: no HTML, no links, so there is no sanitization problem to
 * have (we only ever build React nodes; KaTeX HTML is generated from TeX we escape into it,
 * and image srcs are scheme-checked). Math typesets through KaTeX (owner ruling, 2026-07-18 —
 * the glyph translation italicized digits); the raw TeX stays in the token's title attribute
 * and in the stored text, so rendering remains a pure function of the export. Tokens KaTeX
 * cannot parse fall back to the texToUnicode glyph translation — never a crash, never red
 * error soup. One-line rows keep the compact glyph form (no typeset layout in a row);
 * Obsidian typesets natively via its own renderer.
 */
import type { ReactNode } from 'react';
import katex from 'katex';
import { texToUnicode } from './tex-unicode';

// $$…$$ FIRST so display math wins over the inline form — real captures put display blocks
// on single newlines mid-paragraph, and a $$ mis-lexed as $…$ shifts every later pair across
// prose (the owner's garbled Wikipedia snippet). Newlines are collapsed before tokenizing.
// The image token leads: its alt may contain * without being emphasis.
const INLINE = /(!\[[^\]\n]*\]\([^)\s\n]+\)|\$\$[^$]+\$\$|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\$[^$\n]+\$)/g;

const IMG_TOKEN = /^!\[([^\]\n]*)\]\(([^)\s\n]+)\)$/;

/** The contract admits exactly two image schemes: the web, and self-contained data images.
 *  Anything else (javascript:, file:, blob:) renders as the literal text it came in as. */
const safeImgSrc = (url: string): boolean => /^https?:\/\//i.test(url) || /^data:image\//i.test(url);

/** How a surface shows `![alt](url)` images:
 *  - 'inline' (workbench): a real <img>, data URIs and remote alike.
 *  - 'link' (public pages / static export): remote images become links so a READER's browser
 *    never pings third-party hosts (privacy); self-contained data URIs still render inline.
 *  - 'mini' (one-line rows): a text-height thumbnail — the picture, not its markup, at a
 *    size that can't break a row (owner request, 2026-07-18). */
export type ImageMode = 'inline' | 'link' | 'mini';

function imageNode(alt: string, url: string, mode: ImageMode, key: string): ReactNode {
  if (!safeImgSrc(url)) return `![${alt}](${url})`;
  const label = alt !== '' ? alt : 'image';
  // Click any rendered image → native fullscreen (owner request 2026-07-20). stopPropagation
  // so clicking an image inside a snippet row/card doesn't also trigger the row's select.
  const goFullscreen = (e: { currentTarget: HTMLElement; stopPropagation: () => void }): void => {
    e.stopPropagation();
    void e.currentTarget.requestFullscreen?.().catch(() => {});
  };
  if (mode === 'mini') return <img key={key} className="md-img-mini md-img-zoom" src={url} alt={alt} title="click for fullscreen" loading="lazy" onClick={goFullscreen} />;
  if (mode === 'link' && !/^data:/i.test(url)) {
    return (
      <a key={key} className="md-img-link" href={url} target="_blank" rel="noopener noreferrer">
        ⧉ {label}
      </a>
    );
  }
  return <img key={key} className="md-img md-img-zoom" src={url} alt={alt} title="click for fullscreen" loading="lazy" onClick={goFullscreen} />;
}

/** TeX → a typeset node. KaTeX does the real work; anything it can't parse (our MathML-derived
 *  pseudo-TeX sometimes carries stray glyphs) falls back to the glyph translation. `compact`
 *  skips KaTeX entirely — one-line rows want text, not layout. Always span-based (KaTeX's
 *  display output is spans too), so display math is legal mid-paragraph. */
function mathNode(tex: string, display: boolean, compact: boolean, key: string): ReactNode {
  const raw = display ? `$$${tex}$$` : `$${tex}$`;
  if (!compact) {
    try {
      const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore' });
      return (
        <span key={key} className={display ? 'md-katex md-katex-display' : 'md-katex'} title={raw} dangerouslySetInnerHTML={{ __html: html }} />
      );
    } catch {
      /* fall through to the glyph translation */
    }
  }
  return (
    <span key={key} className={display && !compact ? 'md-math md-math-display' : 'md-math'} title={raw}>
      {texToUnicode(tex)}
    </span>
  );
}

function inlineNodes(text: string, keyBase: string, images: ImageMode, compact = false): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith('![')) {
      const im = IMG_TOKEN.exec(tok)!;
      out.push(imageNode(im[1]!, im[2]!, images, key));
    } else if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('$$')) out.push(mathNode(tok.slice(2, -2), true, compact, key));
    else if (tok.startsWith('$')) out.push(mathNode(tok.slice(1, -1), false, compact, key));
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render snippet text per the contract. `inline` flattens blocks for one-line rows (images
 *  become text-height thumbnails there). `images` sets the surface's image policy — see ImageMode. */
export function SnippetText({ text, inline = false, images = 'inline' }: { text: string; inline?: boolean; images?: ImageMode }) {
  if (inline) return <>{inlineNodes(text.replace(/\s*\n\s*/g, ' '), 'i', 'mini', true)}</>;
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const b = block.trim();
        if (b === '') return null;
        if (b.startsWith('$$') && b.endsWith('$$') && b.length > 4) {
          return mathNode(b.slice(2, -2), true, false, String(i));
        }
        // A paragraph that IS one image token gets figure treatment (centered block).
        if (IMG_TOKEN.test(b)) {
          return (
            <div key={i} className="md-img-block">
              {inlineNodes(b, String(i), images)}
            </div>
          );
        }
        const lines = b.split('\n');
        if (lines.every((l) => l.trimStart().startsWith('- '))) {
          return (
            <ul key={i} className="md-list">
              {lines.map((l, j) => (
                <li key={j}>{inlineNodes(l.trimStart().slice(2), `${i}-${j}`, images)}</li>
              ))}
            </ul>
          );
        }
        return <p key={i} className="md-p">{inlineNodes(b.replace(/\s*\n\s*/g, ' '), String(i), images)}</p>;
      })}
    </>
  );
}

/** The contract's plain-text projection — for labels/tooltips where markup would be noise. */
export function stripSnippetMd(text: string): string {
  return text
    .replace(/!\[([^\]\n]*)\]\([^)\s\n]+\)/g, (_, alt: string) => (alt.trim() !== '' ? alt.trim() : 'image'))
    .replace(/\$\$([^$]+)\$\$/g, (_, t: string) => texToUnicode(t))
    .replace(/\$([^$\n]+)\$/g, (_, t: string) => texToUnicode(t))
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
