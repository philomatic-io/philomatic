/**
 * DOM-aware selection capture (owner request, 2026-07-18): instead of flattening the selection
 * to plain text (which turns MediaWiki math into `{\displaystyle …}` mangling), walk the
 * selected DOM and emit light markdown — real LaTeX pulled from the page's own
 * `annotation[encoding="application/x-tex"]` (or the fallback image's alt), `**bold**`,
 * `*italic*`, `` `code` ``, list bullets, paragraph breaks — with citation brackets and edit
 * links dropped.
 *
 * MUST STAY FULLY SELF-CONTAINED: this function is passed to `chrome.scripting.executeScript`
 * as `func`, which serializes it — nothing outside its own body survives the trip. The
 * server's `tex-paste-artifacts` resolver remains the fallback for clients that paste plain
 * text (Obsidian, the workbench, curl).
 */
export function selectionToMarkdown(): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';

  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DD', 'DT', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE']);

  // MathML → linear TeX (MathJax pages carry MathML, not a TeX annotation; native-MathML
  // pages too). Mechanical: scripts to ^{}/_{}, mfrac to \frac, glyphs pass through.
  const mmlToTex = (n: Element): string => {
    const tag = n.tagName.toLowerCase().replace(/^(?:m|mml):/, '');
    const kids = Array.from(n.children).filter((k) => k.tagName.toLowerCase() !== 'annotation' && k.tagName.toLowerCase() !== 'annotation-xml');
    const K = (i: number): string => (kids[i] ? mmlToTex(kids[i]) : '');
    const all = (): string => kids.map(mmlToTex).join('');
    switch (tag) {
      case 'mi': case 'mn': case 'mo': case 'mtext': return n.textContent ?? '';
      case 'msup': return `${K(0)}^{${K(1)}}`;
      case 'msub': return `${K(0)}_{${K(1)}}`;
      case 'msubsup': case 'munderover': return `${K(0)}_{${K(1)}}^{${K(2)}}`;
      case 'munder': return `${K(0)}_{${K(1)}}`;
      case 'mover': return `${K(0)}^{${K(1)}}`;
      case 'mfrac': return `\\frac{${K(0)}}{${K(1)}}`;
      case 'msqrt': return `\\sqrt{${all()}}`;
      case 'mroot': return `\\sqrt[${K(1)}]{${K(0)}}`;
      case 'mtable': return kids.map(mmlToTex).join(' \\ ');
      case 'mtr': return Array.from(n.children).map(mmlToTex).join(' ');
      case 'mspace': return ' ';
      default: return kids.length > 0 ? all() : (n.textContent ?? '');
    }
  };

  /** The MathML source of a MathJax node: the assistive block, or the data-mathml attribute. */
  const mathjaxTex = (el: Element): string | undefined => {
    const assistive = el.querySelector('.MJX_Assistive_MathML math, mjx-assistive-mml math');
    if (assistive) return mmlToTex(assistive).trim();
    const raw = el.querySelector('[data-mathml]')?.getAttribute('data-mathml') ?? el.getAttribute('data-mathml');
    if (raw !== null && raw !== undefined && raw !== '') {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const math = doc.querySelector('math');
      if (math) return mmlToTex(math).trim();
    }
    return undefined;
  };

  const mathTex = (el: Element): string | undefined => {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    const tex = ann?.textContent?.trim() ?? el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
    if (tex === undefined || tex === '') return undefined;
    // MediaWiki wraps the annotation itself in {\displaystyle …} — unwrap to bare TeX.
    const m = /^\{\\(?:display|text|script)style\s*([\s\S]*)\}$/.exec(tex);
    return (m ? m[1]! : tex).trim();
  };

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName;

    // MathJax v2 keeps the TeX source in an adjacent script tag — the best source of all.
    if (tag === 'SCRIPT') {
      const type = el.getAttribute('type') ?? '';
      if (type.startsWith('math/tex')) {
        const tex = (el.textContent ?? '').trim();
        if (tex === '') return '';
        return type.includes('mode=display') ? `\n\n$$${tex}$$\n\n` : `$${tex.replace(/\s+/g, ' ')}$`;
      }
      return '';
    }

    // Noise MediaWiki interleaves with content: citation brackets, edit links, hidden bits.
    if (el.classList.contains('reference') || el.classList.contains('mw-editsection') || tag === 'STYLE') return '';

    // MathJax v2 (.MathJax_Display / .MathJax) and v3 (mjx-container): no TeX annotation, but
    // the MathML source travels along — convert it and skip the glyph soup entirely.
    if (el.classList.contains('MathJax_Display') || el.classList.contains('MathJax') || tag === 'MJX-CONTAINER') {
      // MathJax v2 pairs the rendered frame with a math/tex SCRIPT sibling carrying the true
      // TeX source (the owner's math-container sample) — when that twin is inside the
      // selection it wins outright, or the formula would capture twice. A cut-off selection
      // (no sibling in the fragment) falls through to the MathML conversion below.
      const frameId = (el.id !== '' ? el.id : (el.querySelector('[id$="-Frame"]')?.id ?? '')).replace(/-Frame$/, '');
      const sib = el.nextElementSibling;
      const sibIsScript = sib !== null && sib.tagName === 'SCRIPT' && (sib.getAttribute('type') ?? '').startsWith('math/tex');
      // Paired = the ids agree (MathJax's own -Frame convention), or the script is DIRECTLY
      // adjacent (no text between) — an unrelated script later in the prose is not a twin.
      if (sibIsScript && (frameId !== '' && sib.id !== '' ? sib.id === frameId : el.nextSibling === sib)) return '';
      const tex = mathjaxTex(el);
      if (tex !== undefined && tex !== '') {
        const block =
          el.classList.contains('MathJax_Display') ||
          el.getAttribute('display') === 'block' ||
          el.querySelector('math[display="block"]') !== null;
        return block ? `\n\n$$${tex}$$\n\n` : `$${tex.replace(/\s+/g, ' ')}$`;
      }
      return '';
    }
    if (el.classList.contains('MathJax_Preview') || el.classList.contains('MJX_Assistive_MathML')) return '';

    // KaTeX (blogs, docs sites, ML tutorials): the wrapper carries the original TeX in its
    // hidden MathML annotation — take it and skip the whole rendered subtree (.katex-html is
    // aria-hidden glyph soup that would otherwise duplicate into the capture).
    if (el.classList.contains('katex-display') || el.classList.contains('katex')) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      if (tex !== undefined && tex !== '') {
        const block = el.classList.contains('katex-display') || el.querySelector('.katex-display') !== null;
        return block ? `\n\n$$${tex}$$\n\n` : `$${tex.replace(/\s+/g, ' ')}$`;
      }
      return ''; // no annotation → nothing trustworthy to take from the soup
    }

    // Google's math widget (Search/Books): the true TeX rides data-xpm-latex on a placeholder
    // img; the sibling MathML annotation is SCREEN-READER SPEECH ("the 3 by 3 matrix; Row 1…")
    // and the SVG is glyph soup — take the attribute, skip the subtree.
    if (el.hasAttribute('data-xpm-copy-root') || (tag === 'IMG' && el.hasAttribute('data-xpm-latex'))) {
      const tex = (el.getAttribute('data-xpm-latex') ?? el.querySelector('img[data-xpm-latex]')?.getAttribute('data-xpm-latex') ?? '').trim();
      if (tex === '') return '';
      return /\\begin\{|\\displaystyle/.test(tex) ? `\n\n$$${tex}$$\n\n` : `$${tex.replace(/\s+/g, ' ')}$`;
    }

    // WordPress latex.php images (classic WP-LaTeX blogs): the alt IS the TeX; the URL's
    // latex= param is the backup. \displaystyle marks display and is layout, not content.
    if (tag === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const isWpLatex = /latex\.php\?latex=/.test(src) || (el.classList.contains('latex') && (el.getAttribute('alt') ?? '').includes('\\'));
      if (isWpLatex) {
        let tex = (el.getAttribute('alt') ?? '').trim();
        if (tex === '' && /latex\.php\?latex=/.test(src)) {
          try {
            tex = decodeURIComponent((new URL(src, 'https://x.invalid').searchParams.get('latex') ?? '').replace(/\+/g, ' '));
          } catch {
            tex = '';
          }
        }
        if (tex !== '') {
          const display = /\\displaystyle/.test(tex);
          const clean = tex.replace(/\\displaystyle\s*/g, '').trim();
          return display ? `\n\n$$${clean}$$\n\n` : `$${clean.replace(/\s+/g, ' ')}$`;
        }
      }
      // The alt-text fallback tier (Wolfram|Alpha-style result images): no TeX, no MathML —
      // the equation lives in the alt in linear notation. The heuristic is deliberately
      // strict (a relation sign AND explicit math structure) so ordinary captions never
      // trigger; sub/superscript parens convert to braces so the renderer's scripts work.
      // Bare numeric scripts (x_0, 10^-16 — Wolfram result cells) count as structure too, or
      // the image tier below would swallow an equation as a picture (owner bug, 2026-07-18).
      const alt = (el.getAttribute('alt') ?? '').trim();
      const mathishAlt =
        alt !== '' &&
        alt.length < 400 &&
        /[=≈<>≤≥]/.test(alt) &&
        /[_^]\(|\)\/\(|[_^]-?\d|\b(?:sqrt|cos|sin|tan|log|exp|integral|sum)\(/.test(alt);
      if (mathishAlt) {
        const tex = alt
          .replace(/_\(([^()]*)\)/g, (_m, b: string) => `_{${b.replace(/\s+/g, '')}}`)
          .replace(/\^\(([^()]*)\)/g, (_m, b: string) => `^{${b.replace(/\s+/g, '')}}`)
          .replace(/([_^])(-?\d+(?:\.\d+)?)/g, (_m, s: string, n: string) => `${s}{${n}}`);
        return `$${tex.replace(/\s+/g, ' ')}$`;
      }
      // Image capture (owner request, 2026-07-18): every math tier above outranks this — a node
      // that reads as math never captures as a picture. URL-first: the token carries the
      // absolute URL; data URIs ride along only when small AND actually images (a page-sized
      // base64 blob is not snippet text). Lazy-loaded pages park the real URL in data-src
      // behind a placeholder. Tiny declared sizes are tracking pixels/decoration — skipped.
      const lazySrc = el.getAttribute('data-src') ?? el.getAttribute('data-lazy-src') ?? '';
      const srcAttr = el.getAttribute('src') ?? '';
      const raw = lazySrc !== '' && (srcAttr === '' || /^data:image\/(?:gif|svg)/.test(srcAttr)) ? lazySrc : srcAttr;
      if (raw === '') return '';
      let abs = '';
      try {
        abs = new URL(raw, document.baseURI).href;
      } catch {
        return '';
      }
      if (abs.startsWith('data:')) {
        if (!/^data:image\//.test(abs) || abs.length > 32 * 1024) return '';
      } else if (!/^https?:/.test(abs)) {
        return '';
      }
      const wAttr = Number(el.getAttribute('width'));
      const hAttr = Number(el.getAttribute('height'));
      if ((wAttr > 0 && wAttr < 8) || (hAttr > 0 && hAttr < 8)) return '';
      // Parens are legal in URLs but close the markdown token — percent-encode for round-trip.
      const safeUrl = abs.replace(/\(/g, '%28').replace(/\)/g, '%29');
      const cleanAlt = (el.getAttribute('alt') ?? '').trim().replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ');
      return `![${cleanAlt}](${safeUrl})`;
    }
    if (tag === 'SVG') return ''; // vector glyph soup, never prose

    // Math: the page carries the true TeX — take it and skip the rendered subtree entirely.
    if (el.classList.contains('mwe-math-element') || tag === 'MATH') {
      const tex = mathTex(el);
      if (tex !== undefined) {
        const block = el.classList.contains('mwe-math-block') || el.getAttribute('display') === 'block' || (el.querySelector('math')?.getAttribute('display') ?? '') === 'block';
        return block ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
      }
      return `$${mmlToTex(el).replace(/\s+/g, ' ').trim()}$`; // no annotation → convert the MathML itself
    }

    let inner = '';
    for (const child of Array.from(el.childNodes)) inner += walk(child);

    if (tag === 'B' || tag === 'STRONG') return inner.trim() === '' ? inner : `**${inner.trim()}**`;
    if (tag === 'I' || tag === 'EM') return inner.trim() === '' ? inner : `*${inner.trim()}*`;
    if (tag === 'CODE' || tag === 'TT') return inner.trim() === '' ? inner : `\`${inner.trim()}\``;
    if (tag === 'LI') return `\n- ${inner.trim()}`;
    if (tag === 'BR') return '\n';
    if (BLOCK.has(tag)) return `\n${inner.trim()}\n`;
    return inner;
  };

  let out = '';
  for (let i = 0; i < sel.rangeCount; i += 1) {
    const holder = document.createElement('div');
    holder.append(sel.getRangeAt(i).cloneContents());
    out += walk(holder);
  }
  const cleaned = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    // Inline math ALONE on its line is display math (owner rule, 2026-07-18): the alt-text
    // tiers can only emit $…$, but a formula that is a whole line/paragraph on the page
    // should typeset as a centered block. One pass here covers every adapter tier.
    .replace(/^(\$[^$\n]+\$)$/gm, (m) => `$$${m.slice(1, -1)}$$`);
  // The 2000-char cap guards against runaway selections of PROSE — image tokens (which can be
  // data URIs) ride free, or one embedded picture would eat the whole budget. Whole tokens
  // only: a truncated ![…](… is worse than a dropped one.
  if (cleaned.length <= 2000) return cleaned;
  let budget = 2000;
  let capped = '';
  for (const part of cleaned.split(/(!\[[^\]\n]*\]\([^)\s\n]+\))/)) {
    if (/^!\[[^\]\n]*\]\([^)\s\n]+\)$/.test(part)) {
      capped += part;
    } else if (part.length <= budget) {
      capped += part;
      budget -= part.length;
    } else {
      // Prose past the budget is dropped, but LATER image tokens still ride — the cap is
      // about runaway text, not about losing the picture at the end of the selection.
      capped += part.slice(0, budget);
      budget = 0;
    }
  }
  return capped;
}
