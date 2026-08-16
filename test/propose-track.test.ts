/**
 * The survey→track pass. Faked end to end. Pinned: per-section
 * extraction with the mention gated against the SECTION text, cross-section dedup
 * (first mention wins the ordering slot), the link-or-author rule, concepts from section
 * headings, mechanical ordering (survey first, then citation position → sugar `order` →
 * PRECEDES chain), junk-section filtering — and the invariant amendment end to end: import,
 * stage, accept keeps the track WITH its membership; reject folds it all away.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { proposeTrack, DEFAULT_PROPOSE_TRACK } from '../src/server/propose-track';
import type { Fetcher, LlmConfig } from '../src/server/llm';

const llm: LlmConfig = { baseUrl: 'http://fake', model: 'fake' };

const PAGE =
  '<h1>A Survey of Widget Learning</h1>' +
  '<p>Widgets are studied broadly. This survey maps the field for newcomers and experts alike, covering foundations and modern methods in detail across the following sections of this document.</p>' +
  '<h2>Foundations</h2>' +
  '<p>The field began with <a href="https://x.test/widgets-considered">Widgets Considered Harmful</a>, which framed the problem. ' +
  'Later, Doe et al. introduced Widget Calculus, the standard formalism. Everything after builds on these two works and their long shadow over the field of widget learning research.</p>' +
  '<h2>Modern Methods</h2>' +
  '<p>Deep approaches arrived with <a href="https://x.test/deep-widgets">Deep Widgets</a>, and the field also cites Widgets Considered Harmful constantly as the origin of every benchmark used in modern widget learning systems today. Contemporary variants refine the same recipe with larger corpora, better tooling, and far more careful evaluation across many widget domains.</p>' +
  '<h2>Comments</h2>' +
  '<p>Great post! Loved it. Subscribe for more widget content and share this article with all your widget-loving friends everywhere.</p>';

const fetchPage: Fetcher = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });

/** Per-section script keyed on the section heading in the prompt. */
function fakeLlm(): Fetcher {
  return async (_url, init) => {
    const prompt = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages
      .map((m) => m.content)
      .join('\n');
    let readings: unknown[] = [];
    if (prompt.includes('Section: Foundations')) {
      readings = [
        { mention: 'The field began with Widgets Considered Harmful', title: 'Widgets Considered Harmful' },
        { mention: 'Doe et al. introduced Widget Calculus', title: 'Widget Calculus', author: 'Doe et al.' },
        { mention: 'THIS MENTION IS FABRICATED', title: 'Ghost Paper', author: 'Nobody' },
      ];
    } else if (prompt.includes('Section: Modern Methods')) {
      readings = [
        { mention: 'Deep approaches arrived with Deep Widgets', title: 'Deep Widgets' },
        { mention: 'cites Widgets Considered Harmful constantly', title: 'Widgets Considered Harmful' }, // dup — first wins
      ];
    } else if (prompt.includes('Section: Comments')) {
      throw new Error('junk section must not reach the LLM');
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ readings }) } }] }), { status: 200 });
  };
}

const input = () => ({
  source: { id: 'src_survey', title: 'A Survey of Widget Learning', url: 'https://e.com/survey' },
  trackTitle: 'A Survey of Widget Learning',
  config: { ...DEFAULT_PROPOSE_TRACK },
});

describe('the survey chain', () => {
  it('drafts one track: gated readings, heading concepts, mechanical order', async () => {
    const p = await proposeTrack(input(), { llm, fetcher: fakeLlm(), fetchPage });

    // the fabricated mention died at the section gate
    expect(JSON.stringify(p.payload)).not.toContain('Ghost Paper');
    const track = (p.payload.tracks as Record<string, unknown>[])[0]!;
    // order: the survey reads first, then citation position; the dup kept its FIRST slot
    expect(track.order).toEqual([
      'A Survey of Widget Learning',
      'Widgets Considered Harmful',
      'Widget Calculus',
      'Deep Widgets',
    ]);
    // section headings became the track's concepts — junk ('Comments') filtered
    expect(track.includes).toEqual(['Foundations', 'Modern Methods']);
    // readings carry the page's own links / stated authors, and their section as aboutness
    const sources = p.payload.sources as Record<string, unknown>[];
    expect(sources[0]).toMatchObject({ id: 'src_survey' }); // the survey is PINNED
    expect(sources.find((s) => s.title === 'Widgets Considered Harmful')).toMatchObject({
      directUrl: 'https://x.test/widgets-considered',
      about: ['Foundations'],
    });
    expect(sources.find((s) => s.title === 'Widget Calculus')).toMatchObject({ author: 'Doe et al.' });
    // stageRefs: the track + 3 readings + 2 concepts, all typed
    expect(p.stageRefs).toHaveLength(6);
    expect(p.trackRef).toBe('syl_a-survey-of-widget-learning');
  });

  it('scholarly enrichment: a matched work gains its DOI, authors, and a #citations tag — and can be RESCUED by it', async () => {
    // 'Widget Calculus' has an author but no page link; OpenAlex fills the DOI + citations.
    const fetchWithScholar: Fetcher = async (url) => {
      const u = String(url);
      if (u.startsWith('https://api.openalex.org/')) {
        if (decodeURIComponent(u).toLowerCase().includes('widget calculus')) {
          return new Response(
            JSON.stringify({
              results: [{
                display_name: 'Widget Calculus',
                doi: 'https://doi.org/10.1000/widgets',
                cited_by_count: 1927,
                authorships: [{ author: { display_name: 'Jane Doe' } }],
              }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const p = await proposeTrack(input(), { llm, fetcher: fakeLlm(), fetchPage: fetchWithScholar });
    const calc = (p.payload.sources as Record<string, unknown>[]).find((s) => s.title === 'Widget Calculus')!;
    expect(calc).toMatchObject({ directUrl: 'https://doi.org/10.1000/widgets', tags: ['#citations:1927'] });
    expect(p.notes.some((n) => n.includes('scholarly metadata matched'))).toBe(true);
  });

  it('hybrid: an indexed survey confirms readings against its OWN reference list', async () => {
    const fetchHybrid: Fetcher = async (url) => {
      const u = String(url);
      if (u.includes('api.openalex.org/works/doi:10.48550/arXiv.9999.00001')) {
        return new Response(
          JSON.stringify({ display_name: 'A Survey of Widget Learning', referenced_works: ['https://openalex.org/W7'] }),
          { status: 200 },
        );
      }
      if (u.includes('filter=openalex_id:W7')) {
        return new Response(
          JSON.stringify({
            results: [{
              display_name: 'Widget Calculus',
              doi: 'https://doi.org/10.1000/widget-calculus',
              cited_by_count: 431,
              authorships: [{ author: { display_name: 'Jane Doe' } }],
            }],
          }),
          { status: 200 },
        );
      }
      if (u.includes('api.openalex.org')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const p = await proposeTrack(
      { ...input(), source: { ...input().source, url: 'https://arxiv.org/abs/9999.00001' } },
      { llm, fetcher: fakeLlm(), fetchPage: fetchHybrid },
    );
    // Widget Calculus was confirmed against the reference list: DOI + citations attached
    const calc = (p.payload.sources as Record<string, unknown>[]).find((s) => s.title === 'Widget Calculus')!;
    expect(calc).toMatchObject({ directUrl: 'https://doi.org/10.1000/widget-calculus', tags: ['#citations:431'] });
    expect(p.notes.some((n) => n.includes('the survey cites 1 works; 1 of'))).toBe(true);
  });

  it('headingless documents (PDFs): concepts fall back to one grounded model call', async () => {
    // No <h2>s → the whole page is one anonymous preamble section, like a PDF's windows.
    const flatPage =
      '<p>Widgets are studied broadly across many disciplines and industries today. ' +
      'The field began with <a href="https://x.test/widgets-considered">Widgets Considered Harmful</a>, which framed the problem space. ' +
      'Since then bias sources, measurement, and mitigation strategies have each grown their own literatures with many dedicated venues and workshops.</p>';
    const fetchFlat: Fetcher = async () => new Response(flatPage, { status: 200, headers: { 'content-type': 'text/html' } });
    const fakeFlat: Fetcher = async (_url, init) => {
      const prompt = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n');
      const body = prompt.includes('areas this survey maps')
        ? { concepts: ['Bias Sources', 'Mitigation Strategies'] }
        : { readings: [{ mention: 'The field began with Widgets Considered Harmful', title: 'Widgets Considered Harmful' }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });
    };
    const p = await proposeTrack(input(), { llm, fetcher: fakeFlat, fetchPage: fetchFlat });
    const track = (p.payload.tracks as Record<string, unknown>[])[0]!;
    expect(track.includes).toEqual(['Bias Sources', 'Mitigation Strategies']);
    expect(p.stageRefs).toContain('cpt_bias-sources');
    expect(p.notes.some((n) => n.includes('named by the model'))).toBe(true);
  });

  it('integration: import → stage → accept keeps membership; reject folds it away', async () => {
    let t = 1_000;
    const engine = PhilomaticEngine.open(':memory:', { now: () => (t += 10) });
    engine.captureSource({ url: 'https://e.com/survey', title: 'A Survey of Widget Learning', stage: false });
    const srcId = engine.snapshot().sources[0]!.id;

    const p = await proposeTrack(
      { ...input(), source: { id: srcId, title: 'A Survey of Widget Learning', url: 'https://e.com/survey' } },
      { llm, fetcher: fakeLlm(), fetchPage },
    );
    engine.importPayload(p.payload);
    for (const r of p.stageRefs) engine.stage(r);

    const track = engine.snapshot().tracks[0]!;
    expect(track.staged).toBe(true);
    expect(track.sourceIds).toHaveLength(4); // survey + 3 readings, membership riding the track
    expect(track.precedes).toHaveLength(3); // the order chain

    // ACCEPT: the explicit INCLUDES gesture — membership stands, marker off
    engine.accept(track.id);
    expect(engine.snapshot().tracks[0]!).toMatchObject({ staged: false });
    expect(engine.snapshot().tracks[0]!.sourceIds).toHaveLength(4);

    // and the inverse world: reject a fresh proposal and the track folds away entirely
    engine.stage(track.id);
    engine.reject(track.id);
    expect(engine.snapshot().tracks).toHaveLength(0);
    // the readings are their own entities with their own verdicts — still present, still staged
    expect(engine.snapshot().sources.filter((s) => s.staged)).toHaveLength(3);
    engine.close();
  });
});
