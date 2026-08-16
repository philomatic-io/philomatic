/**
 * The propose chain. Faked end to end — a canned page and a
 * scripted LLM, no network. Pinned: the verbatim gate (fabricated quotes die in code), the
 * question split (thesis = ANSWERS, open = RAISES), code-first concept resolution with
 * prefer-new-when-unsure, config toggles skipping categories, the reading candidates with
 * their #RefersTo ties returned OUTSIDE the payload, and the track suggestion as accept-time
 * data only. Then one integration pass: the payload imports, everything proposed stages, and
 * the disposition lifecycle (accept/reject) works on the results.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { propose, verbatimOnly, resolveConcept, contextAround, DEFAULT_PROPOSE, type ProposeInput } from '../src/server/propose';
import type { Fetcher, LlmConfig } from '../src/server/llm';

const PAGE_TEXT =
  'Ultrafilters give a uniform construction of models. ' +
  'Definition: an ultrafilter is a maximal proper filter on a set. ' +
  'The Los theorem states: \\prod M_i / U \\models \\varphi. ' +
  'For the model theory background, see Chang and Keisler, Model Theory. ';

const PAGE_HTML =
  '<html><body><article>' +
  PAGE_TEXT.replace('Chang and Keisler, Model Theory', 'Chang and Keisler, <a href="https://example.com/model-theory">Model Theory</a>') +
  '</article><script>x()</script></body></html>';

const llm: LlmConfig = { baseUrl: 'http://fake', model: 'fake' };

/** A scripted LLM: routes on prompt content, mirrors the real response envelope. */
function fakeLlm(script: Record<string, unknown>): Fetcher {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const prompt = body.messages.map((m) => m.content).join('\n');
    const key = Object.keys(script).find((k) => prompt.includes(k));
    if (!key) throw new Error(`fakeLlm: no script entry matches prompt:\n${prompt.slice(0, 120)}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script[key]) } }] }), { status: 200 });
  };
}

const fetchPage: Fetcher = async () => new Response(PAGE_HTML, { status: 200 });

/** The standard script: one entry per chain step, keyed on step-distinct prompt text. */
const SCRIPT: Record<string, unknown> = {
  'VERBATIM quotes': {
    thesis: ['Ultrafilters give a uniform construction of models.', 'THIS SENTENCE WAS NEVER IN THE TEXT.'],
    definitions: ['Definition: an ultrafilter is a maximal proper filter on a set.'],
    equations: [
      { tex: '\\prod M_i / U \\models \\varphi', name: 'Los theorem' }, // both verbatim — name rides
      { tex: 'e = mc^2', name: 'mass-energy' }, // tex not in the text — the gate kills it
    ],
    citations: [{ mention: 'see Chang and Keisler, Model Theory', title: 'Model Theory' }],
  },
  'thesisQuestion, openQuestions': {
    thesisQuestion: 'What do ultrafilters buy us in model construction?',
    openQuestions: ['Do ultraproducts preserve completeness?'],
  },
  'Existing concepts': {
    concepts: [
      { name: 'Model Theory', match: 'Model Theory' }, // resolves to the existing concept
      { name: 'Ultrafilters' }, // no match → proposed new (prefer-new-when-unsure)
    ],
  },
  'Citation mentions': {
    readings: [{ title: 'Model Theory', author: 'Chang & Keisler', thesisQuestion: undefined }],
  },
  'Tracks:': { suggestions: [{ title: 'Logic Track', reason: 'model-theoretic content' }] },
  'prerequisite pair': {
    pairs: [
      { before: 'Model Theory', after: 'Ultrafilters', reason: 'ultraproducts presuppose structures' },
      { before: 'Model Theory', after: 'Model Theory', reason: 'self-pair — must be dropped' },
      { before: 'Set Theory', after: 'Ultrafilters', reason: 'not touched by this capture — must be dropped' },
      { before: 'Ultrafilters', after: 'Model Theory', reason: 'reversed duplicate — first wins' },
    ],
  },
};

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    // trackSuggestion is opt-in (default OFF) — the full-chain tests opt in to exercise it
    source: { id: 'src_x', title: 'Ultrafilter Notes', url: 'https://x.test/uf' },
    config: { ...DEFAULT_PROPOSE, trackSuggestion: true },
    concepts: [{ id: 'cpt_model-theory', name: 'Model Theory', description: 'structures satisfying theories', aboutTitles: ['A Shorter Model Theory'] }],
    tracks: [{ id: 'syl_logic', title: 'Logic Track', goal: 'go further in logic' }],
    ...overrides,
  };
}

describe('the code gates', () => {
  it('verbatimOnly drops anything not literally in the text', () => {
    expect(verbatimOnly(PAGE_TEXT, ['Ultrafilters give a uniform construction of models.', 'fabricated'])).toEqual([
      'Ultrafilters give a uniform construction of models.',
    ]);
    // whitespace-insensitive but content-exact
    expect(verbatimOnly(PAGE_TEXT, ['ultrafilters   give a uniform construction of models.'])).toHaveLength(1);
  });

  it('contextAround slices the lead-in and the symbol legend around a located quote', () => {
    const text =
      'REBEL is simple. At each iteration t of REBEL, we aim to solve the following square ' +
      'loss regression problem: \\theta_{t+1}=\\arg\\min_\\theta L(\\theta) where \\eta is a ' +
      'hyperparameter, \\theta is the parameter of the model, and r(x,y) is the reward. Next section.';
    const ctx = contextAround(text, '\\theta_{t+1}=\\arg\\min_\\theta L(\\theta)');
    expect(ctx.before).toBe('At each iteration t of REBEL, we aim to solve the following square loss regression problem:');
    expect(ctx.after).toBe('where \\eta is a hyperparameter, \\theta is the parameter of the model, and r(x,y) is the reward.');
  });

  it('contextAround returns nothing for an unlocatable quote', () => {
    expect(contextAround('some text here.', 'not present')).toEqual({});
  });

  it('resolveConcept matches normalized names only — no fuzzy heroics', () => {
    const cands = [{ id: 'c1', name: 'Model Theory' }];
    expect(resolveConcept('model theory', cands)?.id).toBe('c1');
    expect(resolveConcept('Model-Theoretic Methods', cands)).toBeUndefined();
  });
});

describe('the chain', () => {
  it('runs every enabled step and assembles one proposal', async () => {
    const p = await propose(input(), { llm, fetcher: fakeLlm(SCRIPT), fetchPage });

    // the fabricated thesis sentence died at the gate → only the real one becomes a snippet
    const src = (p.payload.sources as Record<string, unknown>[])[0]!;
    expect(JSON.stringify(p.payload)).not.toContain('NEVER IN THE TEXT');
    expect(src.answers).toEqual(['What do ultrafilters buy us in model construction?']);
    expect(src.raises).toEqual(['Do ultraproducts preserve completeness?']);
    // resolution: existing concept tied by its exact name; unknown proposed as new
    expect(src.about).toEqual(['Model Theory', 'Ultrafilters']);
    expect(p.payload.concepts).toEqual([{ name: 'Ultrafilters' }]);
    // definitions arrive role-tagged
    const snippets = src.snippets as { text: string; tags?: string[] }[];
    expect(snippets.some((sn) => sn.tags?.includes('#definition'))).toBe(true);
    // the equation snippet: $$-wrapped so it RENDERS, flanked by the page's own surrounding
    // sentences (sliced in code, verbatim by construction); the lead-in names it, so the
    // separate name line is omitted; the fabricated second equation died at the gate
    const eqs = snippets.filter((sn) => sn.tags?.includes('#equation'));
    expect(eqs.map((sn) => sn.text)).toEqual([
      'The Los theorem states:\n\n$$\\prod M_i / U \\models \\varphi$$\n\nFor the model theory background, see Chang and Keisler, Model Theory.',
    ]);
    // the reading is a second source candidate; its tie returns OUTSIDE the payload
    expect((p.payload.sources as unknown[]).length).toBe(2);
    // its link comes from the PAGE's own anchors, matched in code — never from the LLM
    expect((p.payload.sources as Record<string, unknown>[])[1]).toMatchObject({
      title: 'Model Theory',
      directUrl: 'https://example.com/model-theory',
    });
    expect(p.refersTo).toEqual([{ fromSourceId: 'src_x', toTitle: 'Model Theory' }]);
    // the track suggestion is companion data, never part of the payload
    expect(p.trackSuggestion).toEqual([{ trackId: 'syl_logic', title: 'Logic Track', reason: 'model-theoretic content' }]);
    expect(JSON.stringify(p.payload)).not.toContain('Logic Track');
    // ordering: companion only; the gate drops self-pairs, untouched names, and the
    // reversed duplicate — one survivor with pre-derived ids (existing id kept, new derived)
    expect(p.orderingSuggestion).toEqual([
      {
        beforeId: 'cpt_model-theory',
        before: 'Model Theory',
        afterId: 'cpt_ultrafilters',
        after: 'Ultrafilters',
        reason: 'ultraproducts presuppose structures',
      },
    ]);
    expect(JSON.stringify(p.payload)).not.toContain('presuppose');
  });

  it('config toggles skip categories entirely', async () => {
    const cfg = {
      ...DEFAULT_PROPOSE,
      keySnippets: false,
      definitions: false,
      equations: false,
      recommendedReadings: false,
      trackSuggestion: false,
      ordering: false,
    };
    const p = await propose(input({ config: cfg }), { llm, fetcher: fakeLlm(SCRIPT), fetchPage });
    const src = (p.payload.sources as Record<string, unknown>[])[0]!;
    expect(src.snippets).toBeUndefined();
    expect((p.payload.sources as unknown[]).length).toBe(1); // no reading candidates
    expect(p.refersTo).toEqual([]);
    expect(p.trackSuggestion).toBeUndefined();
    expect(p.orderingSuggestion).toBeUndefined();
  });

  it('track suggestions are OPT-IN: the default config never raises the membership question', async () => {
    const p = await propose(input({ config: { ...DEFAULT_PROPOSE } }), { llm, fetcher: fakeLlm(SCRIPT), fetchPage });
    expect(p.trackSuggestion).toBeUndefined();
  });

  it('coerces small-model shape drift: bare strings where arrays/objects belong', async () => {
    // Seen live with a small model: thesis as ONE string, citations as plain
    // strings, concepts as names. Shape is coerced; the verbatim gate still guards content.
    const loose: Record<string, unknown> = {
      ...SCRIPT,
      'VERBATIM quotes': {
        thesis: 'Ultrafilters give a uniform construction of models.',
        definitions: 'Definition: an ultrafilter is a maximal proper filter on a set.',
        equations: null, // models emit null for an empty category (observed live)
        citations: ['see Chang and Keisler, Model Theory'],
      },
      'thesisQuestion, openQuestions': {
        thesisQuestion: ['What do ultrafilters buy us in model construction?'],
        openQuestions: 'Do ultraproducts preserve completeness?',
      },
      'Existing concepts': { concepts: ['Ultrafilters'] },
      'Citation mentions': { readings: ['Model Theory'] },
    };
    const p = await propose(input(), { llm, fetcher: fakeLlm(loose), fetchPage });
    const src = (p.payload.sources as Record<string, unknown>[])[0]!;
    expect(src.answers).toEqual(['What do ultrafilters buy us in model construction?']);
    expect(src.raises).toEqual(['Do ultraproducts preserve completeness?']);
    expect(src.about).toEqual(['Ultrafilters']);
    expect((p.payload.sources as unknown[]).length).toBe(2); // the reading survived as {title}
    const snippets = src.snippets as { text: string }[];
    expect(snippets.some((sn) => sn.text.startsWith('Definition:'))).toBe(true);
  });

  it('probes (D8) condition the questions step — one drafted question per tapped passage', async () => {
    let sawProbes = false;
    const script = {
      ...SCRIPT,
      'thesisQuestion, openQuestions': {
        thesisQuestion: 'What do ultrafilters buy us in model construction?',
        openQuestions: ['Why does the ultrapower construction preserve first-order truth?'],
      },
    };
    const spy: Fetcher = async (url, init) => {
      const prompt = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages
        .map((m) => m.content)
        .join('\n');
      if (prompt.includes('tapped these interrogatives')) {
        sawProbes = true;
        expect(prompt).toContain('"why?" on: Łoś’s theorem is the workhorse here.');
      }
      return fakeLlm(script)(url, init);
    };
    const p = await propose(
      input({ probes: [{ word: 'why', text: 'Łoś’s theorem is the workhorse here.' }] }),
      { llm, fetcher: spy, fetchPage },
    );
    expect(sawProbes).toBe(true);
    const src = (p.payload.sources as Record<string, unknown>[])[0]!;
    expect(src.raises).toEqual(['Why does the ultrapower construction preserve first-order truth?']);
  });

  it('deixis gate: a context-dependent question is anchored to its source title', async () => {
    const script = {
      ...SCRIPT,
      'thesisQuestion, openQuestions': {
        thesisQuestion: 'Does the ultrafilter construction yield saturated models?', // clean — untouched
        openQuestions: ['Can this criterion be efficiently integrated into existing optimization algorithms?'],
      },
    };
    const p = await propose(input(), { llm, fetcher: fakeLlm(script), fetchPage });
    const src = (p.payload.sources as Record<string, unknown>[])[0]!;
    expect(src.answers).toEqual(['Does the ultrafilter construction yield saturated models?']);
    expect(src.raises).toEqual([
      'Can this criterion be efficiently integrated into existing optimization algorithms (in “Ultrafilter Notes”)?',
    ]);
    expect(p.notes.some((n) => n.includes('anchored to the source title'))).toBe(true);
  });

  it('404 guardrail: a definitively dead harvested link is stripped; bot walls are not', async () => {
    const fetchWith = (deadStatus: number): Fetcher => async (url, init) => {
      if (String(url).includes('example.com/model-theory')) return new Response('', { status: deadStatus });
      void init;
      return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    // 404 → stripped; the reading survives on its author, linkless
    const p404 = await propose(input(), { llm, fetcher: fakeLlm(SCRIPT), fetchPage: fetchWith(404) });
    const reading404 = (p404.payload.sources as Record<string, unknown>[])[1]!;
    expect(reading404.directUrl).toBeUndefined();
    expect(p404.notes.some((n) => n.startsWith('dead link stripped'))).toBe(true);
    // 403 (bot wall) → benefit of the doubt, the link rides
    const p403 = await propose(input(), { llm, fetcher: fakeLlm(SCRIPT), fetchPage: fetchWith(403) });
    expect((p403.payload.sources as Record<string, unknown>[])[1]!.directUrl).toBe('https://example.com/model-theory');
  });

  it('scholarly hybrid: an indexed source confirms readings against its reference list', async () => {
    const fetchScholar: Fetcher = async (url, init) => {
      const u = String(url);
      if (u.includes('api.openalex.org/works/doi:10.48550/arXiv.7777.00001')) {
        return new Response(
          JSON.stringify({ display_name: 'Ultrafilter Notes', referenced_works: ['https://openalex.org/W9'] }),
          { status: 200 },
        );
      }
      if (u.includes('filter=openalex_id:W9')) {
        return new Response(
          JSON.stringify({
            results: [{
              display_name: 'Model Theory',
              doi: 'https://doi.org/10.1000/model-theory',
              cited_by_count: 5321,
              authorships: [{ author: { display_name: 'C.C. Chang' } }, { author: { display_name: 'H.J. Keisler' } }],
            }],
          }),
          { status: 200 },
        );
      }
      if (u.includes('api.openalex.org')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      void init;
      return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const p = await propose(
      input({ source: { id: 'src_x', title: 'Ultrafilter Notes', url: 'https://arxiv.org/abs/7777.00001' } }),
      { llm, fetcher: fakeLlm(SCRIPT), fetchPage: fetchScholar },
    );
    const reading = (p.payload.sources as Record<string, unknown>[])[1]!;
    expect(reading).toMatchObject({ title: 'Model Theory', tags: ['#citations:5321'] });
    expect(p.notes.some((n) => n.includes('confirmed against the source'))).toBe(true);
  });

  it('a reading with neither a page link nor an author is dropped, with a note', async () => {
    const script = {
      ...SCRIPT,
      'Citation mentions': {
        readings: [
          { title: 'Model Theory', author: 'Chang & Keisler' }, // link AND author — kept
          { title: 'Some Unfindable Work' }, // neither — useless for validation, dropped
        ],
      },
    };
    const p = await propose(input(), { llm, fetcher: fakeLlm(script), fetchPage });
    expect((p.payload.sources as { title: string }[]).map((s) => s.title)).toEqual([
      'Ultrafilter Notes',
      'Model Theory',
    ]);
    expect(p.notes).toContain('1 reading dropped — no link or author to validate by');
  });

  it('grounding gate: when nothing verbatim survives, dependent steps do not run at all', async () => {
    // Extraction returns only fabrications → the gate empties everything → the concepts step
    // must NOT fire (a model prompted with empty passages free-associates about the task —
    // observed live on a PDF that stripped to soup). fakeLlm would throw if it were called.
    const script = { 'VERBATIM quotes': { thesis: ['NOT IN THE TEXT'], definitions: [], equations: [], citations: [] } };
    const p = await propose(input(), { llm, fetcher: fakeLlm(script), fetchPage });
    expect(p.notes).toContain('concepts skipped: nothing verbatim survived to ground them');
    expect(p.payload.concepts).toBeUndefined();
    expect(p.stageRefs).toEqual([]);
    expect(p.trackSuggestion).toBeUndefined();
  });

  it('a failing step is skipped loudly, not fatally', async () => {
    const broken = { ...SCRIPT, 'thesisQuestion, openQuestions': undefined } as Record<string, unknown>;
    delete broken['thesisQuestion, openQuestions'];
    const p = await propose(input(), { llm, fetcher: fakeLlm(broken), fetchPage });
    expect(p.notes.some((n) => n.startsWith('questions skipped'))).toBe(true);
    expect((p.payload.sources as unknown[]).length).toBe(2); // the rest of the chain survived
  });
});

describe('integration: proposal → engine → disposition', () => {
  it('imports, stages everything, and the verdicts work', async () => {
    let t = 1_000;
    const engine = PhilomaticEngine.open(':memory:', { now: () => (t += 10) });
    engine.captureSource({ url: 'https://x.test/uf', title: 'Ultrafilter Notes', stage: false });
    engine.importPayload({ version: 2, concepts: [{ name: 'Model Theory' }], tracks: [{ title: 'Logic Track' }] });
    const srcId = engine.snapshot().sources[0]!.id;

    const p = await propose(input({ source: { id: srcId, title: 'Ultrafilter Notes', url: 'https://x.test/uf' } }), {
      llm,
      fetcher: fakeLlm(SCRIPT),
      fetchPage,
    });
    engine.importPayload(p.payload);
    const stagedIds = p.stageRefs.map((r) => engine.stage(r).targetId);
    for (const tie of p.refersTo) {
      const to = engine.snapshot().sources.find((x) => x.title === tie.toTitle)!;
      engine.link({ srcType: 'source', srcId: tie.fromSourceId, type: 'LINK', dstType: 'source', dstId: to.id, tags: [{ name: 'RefersTo' }] });
    }

    // everything proposed is pending: the new concept, both questions, the snippets, the reading
    expect(stagedIds.length).toBe(p.stageRefs.length);
    expect(engine.questions().every((q) => q.staged)).toBe(true);
    expect(engine.snapshot().snippets.every((sn) => sn.staged)).toBe(true);
    expect(engine.snapshot().sources.find((x) => x.title === 'Model Theory')!.staged).toBe(true);

    // reject the reading: it folds away WITH its #RefersTo tie (the tie rode the entity)
    const reading = engine.snapshot().sources.find((x) => x.title === 'Model Theory')!;
    engine.reject(reading.id);
    expect(engine.snapshot().sources.find((x) => x.title === 'Model Theory')).toBeUndefined();
    expect(engine.graph().edges.some((e) => e.dstId === reading.id)).toBe(false);

    // accept a question: ordinary entity, tie intact
    const q = engine.questions().find((x) => x.text.startsWith('What do ultrafilters'))!;
    engine.accept(q.id);
    expect(engine.questions().find((x) => x.id === q.id)!.staged).toBe(false);
    expect(engine.questions().find((x) => x.id === q.id)!.answeredBy.some((a) => a.id === srcId)).toBe(true);
    engine.close();
  });
});
