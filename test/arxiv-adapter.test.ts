/**
 * The arXiv adapter — the first real adapter (§2.5). Pinned: URL recognition across id eras,
 * Atom parsing (wrapped titles, entity decoding, author join), the API's soft-error entry,
 * failure isolation through applyResolvers, and the fill-empty fold into captureSource
 * (a learner's hand-typed title always beats the API).
 */
import { describe, expect, it } from 'vitest';
import { arxivAdapter, arxivId } from '../src/server/arxiv-adapter';
import { applyResolvers } from '../src/server/adapters';
import { PhilomaticEngine } from '../src/engine';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=1502.01852</title>
  <entry>
    <id>http://arxiv.org/abs/1502.01852v1</id>
    <title>Delving Deep into Rectifiers: Surpassing Human-Level Performance on
  ImageNet Classification &amp; Beyond</title>
    <author><name>Kaiming He</name></author>
    <author><name>Xiangyu Zhang</name></author>
    <author><name>Shaoqing Ren</name></author>
    <author><name>Jian Sun</name></author>
  </entry>
</feed>`;

const fakeFetch = (body: string, ok = true): typeof fetch =>
  (async () => ({ ok, text: async () => body }) as Response) as unknown as typeof fetch;

describe('arxivId', () => {
  it('recognizes both id eras on abs and pdf URLs', () => {
    expect(arxivId('https://arxiv.org/abs/1502.01852')).toBe('1502.01852');
    expect(arxivId('https://arxiv.org/pdf/1502.01852')).toBe('1502.01852');
    expect(arxivId('https://arxiv.org/pdf/1502.01852v3.pdf')).toBe('1502.01852v3');
    expect(arxivId('https://arxiv.org/abs/math.GT/0309136')).toBe('math.GT/0309136');
    expect(arxivId('https://www.arxiv.org/abs/2101.00001v2')).toBe('2101.00001v2');
  });
  it('ignores everything else', () => {
    expect(arxivId('https://arxiv.org/list/cs.AI/recent')).toBeUndefined();
    expect(arxivId('https://example.com/abs/1502.01852')).toBeUndefined();
    expect(arxivId('https://en.wikipedia.org/wiki/ArXiv')).toBeUndefined();
  });
});

describe('arxivAdapter.resolve', () => {
  const ctx = { now: () => 0 };

  it('parses title (wrapped lines collapsed, entities decoded) and joins authors', async () => {
    const patch = await arxivAdapter(fakeFetch(ATOM)).resolve!('https://arxiv.org/pdf/1502.01852', ctx);
    expect(patch.title).toBe('Delving Deep into Rectifiers: Surpassing Human-Level Performance on ImageNet Classification & Beyond');
    expect(patch.author).toBe('Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun');
  });

  it("the API's soft-error entry yields an empty patch", async () => {
    const err = '<feed><entry><title>Error for arXiv.org api request</title></entry></feed>';
    expect(await arxivAdapter(fakeFetch(err)).resolve!('https://arxiv.org/abs/9999.99999', ctx)).toEqual({});
  });

  it('a non-ok response yields an empty patch', async () => {
    expect(await arxivAdapter(fakeFetch('', false)).resolve!('https://arxiv.org/abs/1502.01852', ctx)).toEqual({});
  });
});

describe('through applyResolvers and into the engine', () => {
  const ctx = { now: () => 0 };

  it('folds title AND author (author joined the patch in model v2)', async () => {
    const patch = await applyResolvers('https://arxiv.org/abs/1502.01852', ctx, [arxivAdapter(fakeFetch(ATOM))]);
    expect(patch.title).toContain('Delving Deep into Rectifiers');
    expect(patch.author).toContain('Kaiming He');
  });

  it('a throwing fetcher is failure-isolated — capture proceeds with an empty patch', async () => {
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await applyResolvers('https://arxiv.org/abs/1502.01852', ctx, [arxivAdapter(boom)])).toEqual({});
  });

  it('non-arxiv URLs never invoke the adapter', async () => {
    const boom = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect(await applyResolvers('https://example.com/paper', ctx, [arxivAdapter(boom)])).toEqual({});
  });

  it('fill-empty into captureSource: the API fills blanks, a hand-typed title wins', async () => {
    const engine = PhilomaticEngine.open();
    const resolved = await applyResolvers('https://arxiv.org/abs/1502.01852', ctx, [arxivAdapter(fakeFetch(ATOM))]);

    engine.captureSource({ url: 'https://arxiv.org/abs/1502.01852', resolved });
    const filled = engine.snapshot().sources.find((s) => s.url === 'https://arxiv.org/abs/1502.01852')!;
    expect(filled.title).toContain('Delving Deep into Rectifiers');
    expect(filled.author).toBe('Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun');

    engine.captureSource({ url: 'https://arxiv.org/abs/2101.00001', title: 'My own name for it', resolved });
    const typed = engine.snapshot().sources.find((s) => s.url === 'https://arxiv.org/abs/2101.00001')!;
    expect(typed.title).toBe('My own name for it'); // user > API, always
    expect(typed.author).toBe('Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun'); // still fills the blank
    engine.close();
  });
});
