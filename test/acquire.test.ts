/**
 * Tiered text acquisition, composed from the adapter registries. The point under
 * test: math survives, and the knowledge lives in the registries — site adapters contribute
 * the preferred-fetch ladder, HTML_RESOLVERS recover each renderer's TeX before the strip,
 * and the SAME text-stage family snippet capture runs finishes the job (the Wikipedia
 * `{\displaystyle …}` artifact is deliberately left raw by the html stage for
 * `tex-paste-artifacts` to rewrite — the composition case). Also pinned: markdown/plain
 * passes through with newlines intact, and the ladder falls back to the original on failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { acquireText, acquisitionUrls } from '../src/server/acquire';
import { HTML_RESOLVERS, normalizeText } from '../src/server/adapters';
import type { Fetcher } from '../src/server/llm';

// pdfToText is STUBBED here: these tests pin the acquisition WIRING (tier order, fall-through,
// windows-as-sections), not pdfjs itself — the real extractor is exercised against actual
// arXiv PDFs in development (18-page paper → 62k chars), and synthetic minimal PDFs turn the
// test into a fight with pdfjs's recovery heuristics. The stub extracts when the body carries
// the GOODPDF marker and throws otherwise (the image-only-scan path).
vi.mock('../src/server/pdf', () => ({
  pdfToText: async (data: Uint8Array | ArrayBuffer) => {
    const head = new TextDecoder().decode(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice(0, 200));
    if (head.includes('GOODPDF')) {
      return {
        text: 'Fairness metrics are contested. This survey maps mitigation strategies across the whole machine learning pipeline, from data collection to deployment.',
        pages: 1,
      };
    }
    throw new Error('pdf: no extractable text (image-only scan?)');
  },
}));

const respond = (body: string, type?: string, status = 200): Response =>
  new Response(body, { status, ...(type ? { headers: { 'content-type': type } } : {}) });

const texify = (html: string): string => normalizeText('https://e.com/x', html, HTML_RESOLVERS);

describe('acquisitionUrls — the adapter-fed preferred-fetch ladder', () => {
  it('the arXiv adapter contributes html → pdf → abs for abs pages', () => {
    expect(acquisitionUrls('https://arxiv.org/abs/2401.00001')).toEqual([
      'https://arxiv.org/html/2401.00001',
      'https://arxiv.org/pdf/2401.00001',
      'https://arxiv.org/abs/2401.00001',
    ]);
  });

  it('the GitHub adapter contributes raw for blob pages', () => {
    expect(acquisitionUrls('https://github.com/o/r/blob/main/notes.md')).toEqual([
      'https://raw.githubusercontent.com/o/r/main/notes.md',
      'https://github.com/o/r/blob/main/notes.md',
    ]);
  });

  it('no matching adapter → just the original URL', () => {
    expect(acquisitionUrls('https://example.com/post')).toEqual(['https://example.com/post']);
  });

  it('a throwing adapter is skipped, never fatal', () => {
    const bad = [{ name: 'boom', applies: () => true, acquireUrls: (): string[] => { throw new Error('x'); } }];
    expect(acquisitionUrls('https://e.com/x', bad)).toEqual(['https://e.com/x']);
  });
});

describe('HTML_RESOLVERS — TeX recovery per renderer', () => {
  it('MathML: x-tex annotation wins, display attribute picks the delimiters', () => {
    const html =
      '<math display="block" alttext="wrong"><semantics><mrow/>' +
      '<annotation encoding="application/x-tex">\\int_0^1 f</annotation></semantics></math>';
    expect(texify(html)).toContain('$$\\int_0^1 f$$');
  });

  it('MathML: alttext is the fallback when no annotation exists', () => {
    const out = texify('<math alttext="e^{i\\pi}"><mrow/></math>');
    expect(out).toContain('$e^{i\\pi}$');
    expect(out).not.toContain('$$');
  });

  it('MathJax: math/tex scripts are recovered, not eaten by the script strip', async () => {
    const page =
      '<p>as shown: <script type="math/tex; mode=display">a^2+b^2=c^2</script> above</p>' +
      '<script>analytics()</script>';
    const fetchPage: Fetcher = async () => respond(page, 'text/html');
    const got = await acquireText('https://example.com/x', fetchPage);
    expect(got.text).toBe('as shown: $$a^2+b^2=c^2$$ above');
    expect(got.hasMath).toBe(true);
  });

  it('a math element with no recoverable TeX is left for the strip — never invented', () => {
    expect(texify('<math><mrow><mi>x</mi></mrow></math>')).not.toContain('$');
  });
});

describe('stage composition — html recovery hands artifacts to the shared text stage', () => {
  it("Wikipedia's fallback-image alt flows img → raw {\\displaystyle} → clean $…$", async () => {
    // The html stage recovers the alt but deliberately leaves the artifact blob RAW…
    const img = '<img class="mwe-math-fallback-image-inline" alt="{\\displaystyle x^{2}}" src="/render.svg">';
    expect(texify(img)).toContain('{\\displaystyle x^{2}}');
    expect(texify(img)).not.toContain('$');
    // …because tex-paste-artifacts (the SAME resolver snippet capture runs) owns the rewrite.
    const fetchPage: Fetcher = async () => respond(`<p>squares: ${img} grow fast</p>`, 'text/html');
    const got = await acquireText('https://en.wikipedia.org/wiki/Square', fetchPage);
    expect(got.text).toBe('squares: $x^{2}$ grow fast');
    expect(got.hasMath).toBe(true);
  });
});

describe('sections (D12b) — the heading-structured parallel view', () => {
  it('splits HTML on h1–h4 with the same cleaning pipeline; preamble is level 0', async () => {
    const page =
      '<p>A survey of things.</p>' +
      '<h2>Foundations</h2><p>Start with <math alttext="\\nabla f"><mrow/></math> basics.</p>' +
      '<h3>Metrics</h3><p>Then measure.</p>' +
      '<h2>Advanced</h2><p>Go deeper.</p>';
    const got = await acquireText('https://e.com/survey', async () => respond(page, 'text/html'));
    expect(got.sections).toEqual([
      { heading: '', level: 0, text: 'A survey of things.' },
      { heading: 'Foundations', level: 2, text: 'Start with $\\nabla f$ basics.' },
      { heading: 'Metrics', level: 3, text: 'Then measure.' },
      { heading: 'Advanced', level: 2, text: 'Go deeper.' },
    ]);
    // the flat text is unchanged by sectioning — same bytes the gate has always seen
    expect(got.text).toBe('A survey of things. Foundations Start with $\\nabla f$ basics. Metrics Then measure. Advanced Go deeper.');
  });

  it('splits markdown on # lines', async () => {
    const md = 'Intro line.\n\n## One\nfirst body\n\n### Sub\nsecond body\n';
    const got = await acquireText('https://e.com/notes', async () => respond(md, 'text/markdown'));
    expect(got.sections).toEqual([
      { heading: '', level: 0, text: 'Intro line.' },
      { heading: 'One', level: 2, text: 'first body' },
      { heading: 'Sub', level: 3, text: 'second body' },
    ]);
  });
});

describe('acquireText — the tiers', () => {
  it('markdown source passes through verbatim: newlines and TeX intact', async () => {
    const md = '# Notes\n\nEuler: $e^{i\\pi}+1=0$\n\nSee [Model Theory](https://example.com/mt).\n';
    const fetchPage: Fetcher = async () => respond(md, 'text/markdown');
    const got = await acquireText('https://example.com/notes', fetchPage);
    expect(got).toMatchObject({ text: md.trim(), hasMath: true, via: 'markdown' });
    expect(got.links).toEqual([{ text: 'Model Theory', href: 'https://example.com/mt' }]);
  });

  it('harvests absolute-href anchors with real text; relative and empty ones stay out', async () => {
    const page =
      '<p><a href="https://x.test/paper">The  Paper</a> and <a href="/local">local</a> ' +
      'and <a href="https://x.test/icon"><img src="i.png"></a></p>';
    const got = await acquireText('https://e.com/x', async () => respond(page, 'text/html'));
    expect(got.links).toEqual([{ text: 'The Paper', href: 'https://x.test/paper' }]);
  });

  it('an HTML page with recovered math reports hasMath; a mathless one does not', async () => {
    const mathy: Fetcher = async () => respond('<p>so <math alttext="\\nabla f"><mrow/></math> holds</p>', 'text/html');
    expect(await acquireText('https://e.com/a', mathy)).toMatchObject({
      text: 'so $\\nabla f$ holds',
      hasMath: true,
      via: 'html',
    });
    const plain: Fetcher = async () => respond('<p>no math here</p>', 'text/html');
    expect(await acquireText('https://e.com/b', plain)).toMatchObject({ text: 'no math here', hasMath: false });
  });

  it('HTML mislabeled as text/plain is sniffed onto the HTML path', async () => {
    const fetchPage: Fetcher = async () => respond('<p>mislabeled</p>', 'text/plain');
    expect(await acquireText('https://e.com/x', fetchPage)).toMatchObject({ text: 'mislabeled', via: 'html' });
  });

  it('a failed preferred tier falls back to the original URL', async () => {
    const fetchPage: Fetcher = async (url) =>
      String(url).includes('/html/') ? respond('nope', undefined, 404) : respond('<p>abs page</p>', 'text/html');
    const got = await acquireText('https://arxiv.org/abs/2401.00001', fetchPage);
    expect(got.text).toBe('abs page');
  });

  it('the arXiv ladder: html build, then the PDF (full text beats the abstract), abs floor', () => {
    expect(acquisitionUrls('https://arxiv.org/pdf/1610.02413')).toEqual([
      'https://arxiv.org/html/1610.02413',
      'https://arxiv.org/pdf/1610.02413',
      'https://arxiv.org/abs/1610.02413',
    ]);
  });

  it('an unextractable PDF tier falls through to the abs page', async () => {
    const fetchPage: Fetcher = async (url) => {
      const u = String(url);
      if (u.includes('/html/')) return respond('nope', undefined, 404);
      if (u.includes('/abs/')) return respond('<p>Abstract: fairness in supervised learning</p>', 'text/html');
      return respond('%PDF-1.5 binary soup', 'application/pdf'); // not a real PDF — extraction fails
    };
    const got = await acquireText('https://arxiv.org/pdf/1610.02413', fetchPage);
    expect(got.text).toBe('Abstract: fairness in supervised learning');
  });

  it('a text PDF extracts: via=pdf, no links, windows as anonymous sections', async () => {
    const fetchPage: Fetcher = async () =>
      new Response(new TextEncoder().encode('%PDF-1.4 GOODPDF'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    const got = await acquireText('https://e.com/paper.pdf', fetchPage);
    expect(got.via).toBe('pdf');
    expect(got.text).toContain('Fairness metrics are contested.');
    expect(got.links).toEqual([]);
    expect(got.sections.length).toBeGreaterThan(0);
    expect(got.sections[0]).toMatchObject({ heading: '', level: 0 });
  });

  it('throws a plain-language error when the only tier is an unextractable PDF', async () => {
    const fetchPage: Fetcher = async () => respond('%PDF-1.5 xyz', 'application/pdf');
    await expect(acquireText('https://e.com/paper.pdf', fetchPage)).rejects.toThrow('could not be extracted');
  });

  it('throws with the last status when every candidate fails', async () => {
    const fetchPage: Fetcher = async () => respond('gone', undefined, 410);
    await expect(acquireText('https://e.com/x', fetchPage)).rejects.toThrow('410');
  });
});
