/* @jsxRuntime automatic @jsxImportSource react */
/**
 * The snippet-markdown contract (owner question, 2026-07-18): captured text carries a CLOSED
 * subset — bold/italic/code, bullets, paragraphs, $inline$/$$block$$ math — and ui surfaces
 * render it through ONE component. Pinned here: the exact markup per token, inline flattening
 * for one-line rows, the plain-text projection, and structural XSS safety (React nodes only —
 * angle brackets in text stay text).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SnippetText, stripSnippetMd } from '../ui/src/lib/snippet-md';
import { texToUnicode } from '../ui/src/lib/tex-unicode';

const FIXTURE =
  'In **statistics**, the *variance* is written $\\sigma ^{2}$ and computed with `var()`.\n\n$$\\operatorname {Var} (X)=E[(X-\\mu )^{2}]$$\n\n- first point\n- second **point**';

describe('SnippetText', () => {
  it('renders the whole contract subset', () => {
    const html = renderToStaticMarkup(<SnippetText text={FIXTURE} />);
    expect(html).toContain('<strong>statistics</strong>');
    expect(html).toContain('<em>variance</em>');
    expect(html).toContain('<code>var()</code>');
    // Math typesets through KaTeX (owner ruling, 2026-07-18); raw TeX stays in the title attr.
    expect(html).toContain('class="md-katex"');
    expect(html).toContain('title="$\\sigma ^{2}$"');
    expect(html).toContain('σ'); // KaTeX emits the real glyph
    expect(html).toContain('class="md-katex md-katex-display"'); // the $$ paragraph
    expect(html).toContain('<ul class="md-list"><li>first point</li><li>second <strong>point</strong></li></ul>');
    // Delimiters never leak into rendered CONTENT (the title attr keeps the raw TeX on purpose).
    expect(html).not.toContain('>$');
  });

  it('KaTeX types digits upright: the "2" is not inside an italic identifier span', () => {
    const html = renderToStaticMarkup(<SnippetText text={'$x^{2}=16$'} />);
    // KaTeX marks identifiers .mathnormal (italic) and numbers .mord without italic — the
    // whole point of adopting it (owner: "numbers are italicised").
    expect(html).toContain('mathnormal');
    expect(/class="mord mathnormal[^"]*">x</.test(html)).toBe(true);
    expect(/mathnormal[^>]*>1?6/.test(html)).toBe(false); // digits are never mathnormal
  });

  it('TeX KaTeX cannot parse falls back to the glyph translation — never an error render', () => {
    const html = renderToStaticMarkup(<SnippetText text={'broken $\\frac{a$ math'} />);
    expect(html).toContain('class="md-math"'); // the fallback span
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('md-katex');
  });

  it('inline mode flattens blocks for one-line rows', () => {
    const html = renderToStaticMarkup(<SnippetText text={'a **b**\n\n- c'} inline />);
    expect(html).toBe('a <strong>b</strong> - c');
  });

  it('is structurally XSS-safe: markup in TEXT stays text', () => {
    const html = renderToStaticMarkup(<SnippetText text={'evil <img src=x onerror=alert(1)> **bold**'} />);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('display math on SINGLE newlines never swallows prose (the garbled-Wikipedia regression)', () => {
    const captured =
      'we write\n$$R\\bot A.$$\n We can also express this with:\n$$P(R=r)$$\n This means $A$ stays prose-adjacent.';
    const html = renderToStaticMarkup(<SnippetText text={captured} />);
    expect(html).toContain('md-katex md-katex-display');
    expect(html).toContain('R\\bot A.'); // raw TeX preserved in the title attr
    // The prose between the two display blocks is NOT inside any math span.
    expect(/md-katex[^>]*>[^<]*We can also express/.test(html)).toBe(false);
    expect(html).not.toContain('>$'); // no stray delimiters leak
  });

  it('![alt](url) images: inline <img>, figure for image-only paragraphs, chips in rows', () => {
    const text = 'A caption with ![Euler diagram](https://ex.com/e.png) inline.\n\n![lone figure](data:image/png;base64,iVBORw0KGgo=)';
    const html = renderToStaticMarkup(<SnippetText text={text} />);
    expect(html).toContain('class="md-img md-img-zoom" src="https://ex.com/e.png" alt="Euler diagram"');
    expect(html).toContain('class="md-img-block"'); // the image-only paragraph is a figure
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    // One-line rows show the picture too — as a text-height thumbnail that can't break a row.
    const row = renderToStaticMarkup(<SnippetText text={text} inline />);
    expect(row).toContain('class="md-img-mini md-img-zoom"');
    expect(row).toContain('alt="Euler diagram"');
    expect(row).not.toContain('class="md-img md-img-zoom"'); // full-size only outside rows
  });

  it('images="link" (public pages): remote images become links, data URIs stay inline', () => {
    const text = '![remote](https://ex.com/e.png)\n\n![inline](data:image/png;base64,iVBORw0KGgo=)';
    const html = renderToStaticMarkup(<SnippetText text={text} images="link" />);
    expect(html).toContain('<a class="md-img-link" href="https://ex.com/e.png"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('src="https://ex.com/e.png" alt'); // no third-party <img> ping
    expect(html).toContain('class="md-img md-img-zoom" src="data:image/png'); // self-contained stays media
  });

  it('image scheme safety: only https?: and data:image/ render — the rest stays literal text', () => {
    const html = renderToStaticMarkup(<SnippetText text={'x ![a](javascript:alert(1)) y ![b](file:///etc/passwd) z'} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a');
    expect(html).toContain('![a](javascript:alert(1))'); // visible, inert
  });

  it('stripSnippetMd projects images to their alt text', () => {
    expect(stripSnippetMd('see ![Euler diagram](https://ex.com/e.png) and ![](https://ex.com/f.png)')).toBe(
      'see Euler diagram and image',
    );
  });

  it('stripSnippetMd projects to plain text — math translated to glyphs', () => {
    expect(stripSnippetMd(FIXTURE)).toBe(
      'In statistics, the variance is written σ² and computed with var(). Var (X)=E[(X-μ)²] first point second point',
    );
  });

  it('texToUnicode reads as math (the owner formulas; post-command spaces are TeX separators)', () => {
    expect(texToUnicode('R\\bot A.')).toBe('R⊥A.');
    expect(texToUnicode('P(R=r\\ |\\ A=a)\\quad \\forall r\\in R')).toBe('P(R=r | A=a) ∀r∈R'); // \quad = em space
    expect(texToUnicode('\\sigma ^{2}')).toBe('σ²');
    expect(texToUnicode('\\operatorname {Var} (X)=E[(X-\\mu )^{2}]')).toBe('Var (X)=E[(X-μ)²]');
    expect(texToUnicode('\\mathbb {R} ^{n}\\to \\mathbb {R}')).toBe('ℝ ⁿ→ℝ');
    expect(texToUnicode('\\frac {a+b}{2}')).toBe('(a+b)/2');
    expect(texToUnicode('x_{i}\\leq y_{j}')).toBe('xᵢ≤yⱼ');
    // Unknown commands stay visible — honesty over guessing (raw TeX lives in the title).
    expect(texToUnicode('\\weirdcmd x')).toBe('\\weirdcmd x');
  });

  it('texToUnicode handles KaTeX-era TeX: environments, accents, operator names', () => {
    const aligned = texToUnicode(
      '\\begin{aligned}\nKL(\\hat{y} || y) &= \\sum_{c=1}^{M}\\hat{y}_c \\log{\\frac{\\hat{y}_c}{y_c}}\\end{aligned}',
    );
    expect(aligned).toContain('KL(y\u0302 || y)'); // combining circumflex, not precomposed
    expect(aligned).toContain('∑');
    expect(aligned).toContain('log');
    expect(aligned).not.toContain('\\begin');
    expect(aligned).not.toContain('aligned');
    // The MathJax family arrives as MathML-derived pseudo-TeX (unicode glyphs + ^{}/_{}/\frac).
    expect(texToUnicode('∑_{i=0}^{n}i^{2}=\\frac{(n^{2}+n)(2n+1)}{6}')).toBe('∑ᵢ₌₀ⁿi²=((n²+n)(2n+1))/6');
    // Google-widget and WP-LaTeX era: matrices, style switches, dot fills.
    expect(texToUnicode('\\left[\\begin{matrix}d_{1}&&\\\\ &\\ddots &\\\\ &&d_{n}\\end{matrix}\\right]')).toBe('[d₁ ⋱ dₙ]');
    expect(texToUnicode('{\\bf P}( Z_s = k ) = \\frac{1}{\\zeta(s) k^s}.')).toBe('P( Z_s = k ) = 1/(ζ(s) k^s).');
    expect(texToUnicode('\\bar{x}\\to \\hat{\\mu}')).toBe('x\u0304→\\hatμ'); // single-CHAR accents only; a command body keeps \hat visible
  });
});
