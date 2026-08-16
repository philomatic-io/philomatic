/**
 * PDF text extraction — the acquisition tier that unlocks PDF-only papers
 * (the owner's fairness survey has no HTML build, no ar5iv build, and a PDF-only e-print:
 * the PDF is the ONLY full text that exists). pdfjs-dist (Mozilla, pure JS) does the
 * heavy lifting; lazily imported so cold paths never pay for it.
 *
 * Page text arrives as positioned fragments with no document structure — headings are not
 * recoverable, so the SECTION view for a PDF is fixed-size windows (the survey pass treats
 * them as anonymous level-0 sections: per-window extraction still runs, heading-derived
 * concepts simply don't).
 */

export interface PdfText {
  text: string;
  pages: number;
}

export async function pdfToText(data: ArrayBuffer | Uint8Array): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // PDFs using the standard 14 fonts (non-embedded Helvetica etc.) need pdfjs's own font
  // metrics — resolve them from the installed package so every runtime finds them.
  const { createRequire } = await import('node:module');
  const standardFontDataUrl = createRequire(import.meta.url)
    .resolve('pdfjs-dist/package.json')
    .replace(/package\.json$/, 'standard_fonts/');
  const task = pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    useSystemFonts: true,
    standardFontDataUrl,
  });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(
        tc.items
          .map((it) => ('str' in it ? it.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    const text = parts.join('\n').replace(/ ([.,;:!?])(\s|$)/g, '$1$2').trim();
    if (text.replace(/\s/g, '').length < 100) {
      throw new Error('pdf: no extractable text (image-only scan?)');
    }
    return { text, pages: doc.numPages };
  } finally {
    await task.destroy(); // v6: teardown lives on the loading task, not the document proxy
  }
}
