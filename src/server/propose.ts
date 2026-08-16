/**
 * The propose CHAIN — the structure-drafting pass behind the
 * explicit "suggest structure" action. Chained, not one mega-prompt, because CODE GATES EACH
 * HOP: step 1 extracts VERBATIM strings and anything that does not literally appear in the
 * page text is dropped (fabricated evidence dies mechanically); later steps ground in the
 * survivors. Every extraction category is a user toggle; each step is one small zod-validated
 * LLM call, so failures isolate per category and small local models stay in their depth.
 *
 * The chain PROPOSES — it returns a sugared payload plus the refs to stage. The caller (the
 * `/propose` route) does the writing, so this module stays pure of the engine: testable with a
 * fake fetcher and a fake LLM, no network, no store.
 *
 * Edge-candidacy rule: proposed ties ride only on PROPOSED entities, whose verdict
 * governs them. The track suggestion is NEVER graph state — it returns as accept-time
 * companion data for the inbox.
 */
import { z } from 'zod';
import { conceptId, questionId, snippetId, sourceId } from '../engine';
import { acquireText } from './acquire';
import { chatJson, type Fetcher, type LlmConfig } from './llm';

// ── Config ────────────────────────────────────────────────────────────────────────────────

export interface ProposeConfig {
  /** Which extraction categories run — every one is a user toggle. */
  thesisQuestion: boolean;
  openQuestions: boolean;
  concepts: boolean;
  definitions: boolean;
  equations: boolean;
  keySnippets: boolean;
  recommendedReadings: boolean;
  /** Suggest tracks only when the user gave no track context. */
  trackSuggestion: boolean;
  /** Prerequisite pairs among the concepts this capture touches — accept-time
   *  companion like the track suggestion, never graph state. */
  ordering: boolean;
}

export const DEFAULT_PROPOSE: ProposeConfig = {
  thesisQuestion: true,
  openQuestions: true,
  concepts: true,
  definitions: true,
  equations: true, // full fidelity: acquisition canonicalizes math to $-TeX
  keySnippets: true,
  recommendedReadings: true,
  // OFF by default: INCLUDES is the most personal gesture in the
  // graph — the AI shouldn't even raise the membership question unless explicitly asked
  // (opt in per call via config.trackSuggestion).
  trackSuggestion: false,
  ordering: true,
};

/** An existing concept, WITH its construction context (a bare name resolves badly). */
export interface ConceptCandidate {
  id: string;
  name: string;
  description?: string;
  /** A few titles of sources already ABOUT it — grounds what the name means HERE. */
  aboutTitles?: string[];
}

export interface TrackCandidate {
  id: string;
  title: string;
  goal?: string;
}

export interface ProposeInput {
  source: { id: string; title: string; url?: string };
  config: ProposeConfig;
  /** Resolution scope, already applied by the caller — pass fewer, richer candidates. */
  concepts: ConceptCandidate[];
  /** Only consulted when config.trackSuggestion (the user gave no track context). */
  tracks: TrackCandidate[];
  /** Interrogative probes already captured on this source: `#probe:<word>` snippets the
   *  learner tapped at the moment of confusion. They CONDITION the questions step — the
   *  learner never authored a question, so the pass drafts one of that shape from that
   *  passage. Never required; an empty list is the ordinary case. */
  probes?: { word: string; text: string }[];
}

export interface ProposeDeps {
  llm: LlmConfig;
  fetcher?: Fetcher;
  /** Page fetcher for step 0 (separate from the LLM fetcher so tests fake them apart). */
  fetchPage?: Fetcher;
}

export interface Proposal {
  /** ONE sugared payload — import it, then stage everything in `stageRefs`. */
  payload: Record<string, unknown>;
  /** Natural refs (texts/titles) of every PROPOSED entity — the caller stages these. */
  stageRefs: string[];
  /** `#RefersTo` ties from the existing source to each proposed reading — the caller links
   *  them after import (title → id), so the payload stays pure sugar. Allowed under the
   *  edge-candidacy rule: the tie's proposed end is the READING; rejecting it folds the edge
   *  away. */
  refersTo: { fromSourceId: string; toTitle: string }[];
  /** Accept-time companion, never graph state: suggested tracks for this source. */
  trackSuggestion?: { trackId: string; title: string; reason: string }[];
  /** Accept-time companion, never graph state: prerequisite pairs among the concepts
   *  this capture touched. Confirming one in the inbox writes PREREQUISITE_OF via the
   *  ordinary link path (acyclicity checks and all) — the ids are pre-derived here so the
   *  accept gesture needs no resolution step. */
  orderingSuggestion?: { beforeId: string; before: string; afterId: string; after: string; reason: string }[];
  /** Which categories ran / were skipped and why — honesty over silence. */
  notes: string[];
}

// ── Step 0 lives in ./acquire: tiered, math-preserving text acquisition ───────────────────

// ── Step 1: verbatim extraction + the code gate ───────────────────────────────────────────

// Small models drift on JSON SHAPE — a bare string where an array belongs, a plain string
// where an object was asked for (seen live with gemini-2.5-flash). Coerce the
// common drift instead of failing the step: the verbatim gate protects CONTENT either way,
// so shape strictness buys nothing.
// null tolerated everywhere: models emit `"definitions": null` for an empty category, and
// zod defaults fire only on undefined (observed live).
export const strings = z.preprocess((v) => (v == null ? [] : typeof v === 'string' ? [v] : v), z.array(z.string()).default([]));
/** An array whose elements may arrive as bare strings — `lift` names the intended field. */
export const objects = <S extends z.ZodRawShape>(shape: z.ZodObject<S>, lift: string, max = 8) =>
  z.preprocess(
    (v) => (v == null ? [] : typeof v === 'string' ? [v] : v),
    z.array(z.preprocess((el) => (typeof el === 'string' ? { [lift]: el } : el), shape)).max(max).default([]),
  );

const ExtractSchema = z.object({
  thesis: strings,
  definitions: strings,
  equations: objects(z.object({ tex: z.string(), name: z.string().optional() }), 'tex', 5),
  citations: objects(z.object({ mention: z.string(), title: z.string().optional() }), 'mention'),
});
type Extracted = z.infer<typeof ExtractSchema>;

export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Match a proposed title to a harvested page link — fuzzy containment over normalized text.
 *  Shared by the source and track propose passes. */
export function makeLinkFor(links: readonly { text: string; href: string }[]): (title: string) => string | undefined {
  return (title) => {
    const t = norm(title);
    return links.find((l) => {
      const lt = norm(l.text);
      return lt.length >= 5 && (lt.includes(t) || t.includes(lt));
    })?.href;
  };
}

/** THE verbatim gate: a quote survives only if it literally appears in the text. */
export function verbatimOnly(text: string, quotes: string[]): string[] {
  const hay = norm(text);
  return quotes.filter((q) => q.trim().length > 0 && hay.includes(norm(q)));
}

async function extractStep(deps: ProposeDeps, cfg: ProposeConfig, title: string, text: string): Promise<Extracted> {
  const want = [
    'thesis: the 1-3 sentences that state the central claim or topic, quoted EXACTLY',
    ...(cfg.definitions ? ['definitions: up to 5 sentences that DEFINE a term, quoted EXACTLY'] : []),
    ...(cfg.equations ? ['equations: up to 5 defined equations/formulas as {tex, name?} — tex quoted EXACTLY as printed; name = what the text CALLS the equation (its nearby heading or label, e.g. "Demographic Parity"), only when the text states one'] : []),
    ...(cfg.recommendedReadings ? ['citations: up to 8 mentions recommending further reading (quote the mention EXACTLY; add the work\'s title when stated)'] : []),
  ].join('\n');
  const out = await chatJson(
    deps.llm,
    'You extract VERBATIM quotes from a document. Every string you return must be copied character-for-character from the text. Never paraphrase.',
    `Document title: ${title}\n\nReturn JSON with keys {thesis, definitions, equations, citations}.\n${want}\n\nTEXT:\n${text}`,
    deps.fetcher,
  );
  const parsed = ExtractSchema.parse(out);
  return {
    thesis: verbatimOnly(text, parsed.thesis),
    definitions: verbatimOnly(text, parsed.definitions),
    // the TEX must be verbatim; the NAME rides only if it is also literally in the text —
    // a label the page never used is the same fabrication risk as an invented quote
    equations: parsed.equations
      .filter((q) => verbatimOnly(text, [q.tex]).length === 1)
      .map((q) => ({
        tex: q.tex,
        ...(q.name !== undefined && verbatimOnly(text, [q.name]).length === 1 ? { name: q.name } : {}),
      })),
    citations: parsed.citations.filter((c) => verbatimOnly(text, [c.mention]).length === 1),
  };
}

// ── Step 2: questions ─────────────────────────────────────────────────────────────────────

const QuestionsSchema = z.object({
  thesisQuestion: z.preprocess((v) => (v == null ? undefined : Array.isArray(v) ? v[0] : v), z.string().optional()),
  // 11 = 5 open + up to 6 probe-conditioned; the prompt asks for the honest number.
  openQuestions: z.preprocess((v) => (v == null ? [] : typeof v === 'string' ? [v] : v), z.array(z.string()).max(11).default([])),
});

// ── Step 3: concepts + resolution ─────────────────────────────────────────────────────────

const ConceptsSchema = z.object({
  concepts: objects(z.object({ name: z.string(), match: z.string().optional() }), 'name'),
});

/**
 * The sentences AROUND a verbatim quote, sliced mechanically from the acquired text (an
 * equation without its surrounding prose is unvalidatable). Because the quote
 * is verbatim-gated, code can LOCATE it — so the context is verbatim by construction, no LLM
 * involved. `before` runs from the previous sentence terminator to the quote (the classic
 * "we aim to solve the following problem:" lead-in); `after` runs to the next sentence end
 * (the classic "where η is a hyperparameter …" symbol legend), window-capped.
 */
export function contextAround(text: string, quote: string): { before?: string; after?: string } {
  const hay = text.replace(/\s+/g, ' ');
  const q = quote.replace(/\s+/g, ' ').trim();
  const idx = hay.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return {};
  const beforeRaw = hay.slice(Math.max(0, idx - 350), idx);
  const bMatch = /^[\s\S]*[.!?]\s+/.exec(beforeRaw); // greedy → cut at the LAST sentence end
  const before = (bMatch !== null ? beforeRaw.slice(bMatch[0].length) : beforeRaw).replace(/\$+\s*$/, '').trim();
  const afterRaw = hay
    .slice(idx + q.length, idx + q.length + 500)
    .replace(/^[\s$:;,.]+/, '');
  const aMatch = /^[\s\S]*?[.!?](?=\s|$)/.exec(afterRaw); // lazy → stop at the FIRST sentence end
  const after = (aMatch !== null ? aMatch[0] : afterRaw).trim();
  return { ...(before !== '' ? { before } : {}), ...(after !== '' ? { after } : {}) };
}

/** Code-first resolution: exact/normalized name match against the scoped candidates. */
export function resolveConcept(name: string, candidates: ConceptCandidate[]): ConceptCandidate | undefined {
  const n = norm(name);
  return candidates.find((c) => norm(c.name) === n);
}

// ── Step 4: recommended readings ──────────────────────────────────────────────────────────

const ReadingsSchema = z.object({
  readings: objects(
    z.object({ title: z.string(), author: z.string().optional(), thesisQuestion: z.string().optional() }),
    'title',
  ),
});

// ── Step 5: track suggestion (accept-time companion, never graph state) ───────────────────

const TrackSchema = z.object({
  suggestions: z.array(z.object({ title: z.string(), reason: z.string() })).max(3).default([]),
});

// ── Step 5.5: ordering suggestion (accept-time companion, never graph state) ──────────────

const OrderingSchema = z.object({
  pairs: z.array(z.object({ before: z.string(), after: z.string(), reason: z.string() })).max(6).default([]),
});

// ── The chain ─────────────────────────────────────────────────────────────────────────────

export async function propose(input: ProposeInput, deps: ProposeDeps): Promise<Proposal> {
  const { source, config } = input;
  const notes: string[] = [];
  const stageRefs: string[] = [];
  if (!source.url) throw new Error('propose: the source has no URL to read');

  // 0 + 1 — acquire and extract, gate verbatim.
  const acquired = await acquireText(source.url, deps.fetchPage);
  const text = acquired.text;
  if (acquired.via === 'markdown') notes.push('acquired markdown/plain source directly');
  const extracted = await extractStep(deps, config, source.title, text).catch((e: unknown) => {
    notes.push(`extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    return { thesis: [], definitions: [], equations: [], citations: [] } as Extracted;
  });

  const questions: { text: string; answers?: boolean }[] = [];
  const newConcepts: { name: string }[] = [];
  const aboutNames: string[] = [];
  const snippets: { text: string; tags: string[] }[] = [];
  const readings: { title: string; author?: string; thesisQuestion?: string; url?: string; citations?: number }[] = [];

  // 2 — questions, grounded in the surviving thesis passages. A question is a STANDALONE
  // entity — once it leaves the reading flow, "this criterion" points at nothing. The
  // prompt demands names; the code catches the deictic residue and anchors
  // it to the source title rather than dropping an otherwise-good question.
  const DEIXIS = /\b(?:this|these)\b|\bthe\s+(?:paper|article|document|author|text)\b/i;
  let anchored = 0;
  const selfContained = (q: string): string => {
    if (!DEIXIS.test(q)) return q;
    anchored += 1;
    return `${q.replace(/\?\s*$/, '')} (in “${source.title}”)?`;
  };
  const probes = (input.probes ?? []).slice(0, 6);
  if ((config.thesisQuestion || config.openQuestions) && extracted.thesis.length > 0) {
    try {
      // Probes ride into the SAME step as extra open questions — one per passage the
      // learner flagged, in the interrogative shape they tapped. The learner never wrote a
      // question; they pointed at a passage and said "why?".
      const probeBlock =
        probes.length > 0
          ? `\n\nThe learner tapped these interrogatives on passages they found confusing — draft ONE question of the tapped shape for each, grounded in its passage, and include them in openQuestions:\n${probes
              .map((p) => `- "${p.word}?" on: ${p.text.replace(/\s+/g, ' ').slice(0, 300)}`)
              .join('\n')}`
          : '';
      const out = QuestionsSchema.parse(
        await chatJson(
          deps.llm,
          'You turn a document\'s thesis into study questions. Every question must STAND ALONE for a reader who has never seen the document: never write "this", "these", "the paper", or "the author" — NAME the specific method, criterion, or concept, using its name from the passages.',
          `Thesis passages:\n${extracted.thesis.join('\n')}${probeBlock}\n\nReturn JSON {thesisQuestion, openQuestions}: thesisQuestion = ONE question this document ANSWERS (its core claim as a question); openQuestions = up to ${5 + probes.length} questions it raises but leaves open. Each question must be fully understandable with no surrounding context — name things by their names.`,
          deps.fetcher,
        ),
      );
      if (config.thesisQuestion && out.thesisQuestion) questions.push({ text: selfContained(out.thesisQuestion), answers: true });
      if (config.openQuestions) for (const q of out.openQuestions) questions.push({ text: selfContained(q) });
      if (anchored > 0) notes.push(`${anchored} question${anchored === 1 ? '' : 's'} used context-dependent wording — anchored to the source title`);
    } catch (e) {
      notes.push(`questions skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3 — concepts: propose from quotes, resolve code-first, prefer-new-when-unsure. GROUNDING
  // GATE: no surviving passages = no concepts step — a model prompted with empty passages
  // free-associates about the instructions themselves ("Document Concept Tagging", observed
  // live on a PDF that stripped to soup).
  if (config.concepts && extracted.thesis.length + extracted.definitions.length === 0) {
    notes.push('concepts skipped: nothing verbatim survived to ground them');
  } else if (config.concepts) {
    try {
      const roster = input.concepts
        .map((c) => `- ${c.name}${c.description ? ` — ${c.description.slice(0, 120)}` : ''}${c.aboutTitles?.length ? ` (sources: ${c.aboutTitles.slice(0, 2).join('; ')})` : ''}`)
        .join('\n');
      const out = ConceptsSchema.parse(
        await chatJson(
          deps.llm,
          'You name the concepts a document is about. ALWAYS name 2-6 concepts — short noun phrases a learner would file this under. Matching an existing concept is optional and only when its listed context clearly fits; never force a match, and never return an empty list for a substantive document.',
          `Passages:\n${[...extracted.thesis, ...extracted.definitions].join('\n')}\n\nExisting concepts (name — context):\n${roster || '(none)'}\n\nReturn JSON {concepts:[{name, match?}]} — 2-6 entries; match, IF PRESENT, must copy an existing concept name exactly.`,
          deps.fetcher,
        ),
      );
      if (out.concepts.length === 0) notes.push('concepts: the model named none');
      for (const c of out.concepts) {
        const resolved = resolveConcept(c.match ?? c.name, input.concepts);
        if (resolved) {
          // The ABOUT tie to an EXISTING concept: allowed under the edge-candidacy rule
          // because the tie is written through the source's sugar — and surfaced at review
          // so a mis-resolution is visible.
          aboutNames.push(resolved.name);
        } else {
          newConcepts.push({ name: c.name.trim() });
          aboutNames.push(c.name.trim());
        }
      }
    } catch (e) {
      notes.push(`concepts skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 1's categories → snippet candidates, capped. An equation snippet is GUARANTEED
  // renderable: bare TeX (pages ship it undelimited, and the whitespace-normalized gate
  // passes an unwrapped quote even when the page had delimiters) gets $$-wrapped here, and
  // the page's own name for it leads the snippet — an anonymous formula is unvalidatable
  //.
  const wrapMath = (t: string): string => (/\$\$[\s\S]+\$\$/.test(t) || /\$[^$\n]+\$/.test(t) ? t : `$$${t}$$`);
  if (config.keySnippets) for (const t of extracted.thesis.slice(0, 3)) snippets.push({ text: t, tags: [] });
  if (config.definitions) for (const d of extracted.definitions.slice(0, 5)) snippets.push({ text: d, tags: ['#definition'] });
  if (config.equations) {
    for (const q of extracted.equations.slice(0, 5)) {
      // The surrounding sentences, sliced verbatim from the page (code, not LLM). When a
      // lead-in sentence exists it usually names the equation, so the name line only fills
      // in when there is no lead-in.
      const ctx = contextAround(text, q.tex);
      const parts = [
        ...(ctx.before === undefined && q.name !== undefined ? [`${q.name}:`] : []),
        ...(ctx.before !== undefined ? [ctx.before] : []),
        wrapMath(q.tex),
        ...(ctx.after !== undefined ? [ctx.after] : []),
      ];
      snippets.push({ text: parts.join('\n\n'), tags: ['#equation'] });
    }
  }

  // 4 — recommended readings from the gated citation mentions. URLs are attached in CODE from
  // the page's own harvested anchors — the LLM never produces one (fabrication risk) — and a
  // reading survives only with a link or an author to validate by.
  if (config.recommendedReadings && extracted.citations.length > 0) {
    try {
      const out = ReadingsSchema.parse(
        await chatJson(
          deps.llm,
          'You turn citation mentions into a reading list. Use ONLY what the mentions state — include thesisQuestion only when the mention itself says what the work shows.',
          `Citation mentions:\n${extracted.citations.map((c) => `- ${c.mention}${c.title ? ` [title: ${c.title}]` : ''}`).join('\n')}\n\nReturn JSON {readings:[{title, author?, thesisQuestion?}]}.`,
          deps.fetcher,
        ),
      );
      const linkFor = makeLinkFor(acquired.links);
      // 404 guardrail: a harvested link is checked before it rides — but ONLY a definitive
      // 404/410 strips it (HEAD-refusing hosts, bot walls, and timeouts get the benefit of
      // the doubt: dropping a valid reading is the costlier error). A stripped link then
      // flows into the link-or-author rule like any other missing link.
      const fetchPage = deps.fetchPage ?? fetch;
      const dead = async (u: string): Promise<boolean> => {
        try {
          let r = await fetchPage(u, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
          if (r.status === 405 || r.status === 501) r = await fetchPage(u, { signal: AbortSignal.timeout(4000) });
          return r.status === 404 || r.status === 410;
        } catch {
          return false;
        }
      };
      const withLinks: typeof readings = [];
      for (const r of out.readings) {
        const url = linkFor(r.title);
        if (url !== undefined && (await dead(url))) {
          notes.push(`dead link stripped from "${r.title}" (${url})`);
          withLinks.push({ ...r });
        } else {
          withLinks.push({ ...r, ...(url !== undefined ? { url } : {}) });
        }
      }
      // Scholarly enrichment — the SAME hybrid the survey pass runs:
      // when the captured source is itself indexed, its referenced_works (the citation graph)
      // is the closed validation set; otherwise per-title guarded search. Runs BEFORE the
      // link-or-author filter so a canonical record can rescue a bare citation. Optional and
      // failure-isolated like every adapter.
      try {
        const { scholarLookup, surveyReferences } = await import('./scholar-adapter');
        const refs = await surveyReferences({ title: source.title, ...(source.url ? { url: source.url } : {}) }, fetchPage).catch(() => undefined);
        let matched = 0;
        for (const r of withLinks) {
          const w = refs !== undefined
            ? refs.cites.find((x) => {
                const wt = norm(x.title);
                const t = norm(r.title);
                return wt === t || (t.length >= 10 && wt.includes(t)) || (wt.length >= 10 && t.includes(wt));
              })
            : await scholarLookup(r.title, fetchPage).catch(() => undefined);
          if (w === undefined) continue;
          matched += 1;
          if (r.url === undefined && w.doi !== undefined) r.url = w.doi;
          if ((r.author === undefined || r.author.trim() === '') && w.authors.length > 0) r.author = w.authors.slice(0, 6).join(', ');
          r.citations = w.citations;
        }
        if (matched > 0) {
          notes.push(
            refs !== undefined
              ? `${matched} of ${withLinks.length} readings confirmed against the source's own reference list`
              : `scholarly metadata matched for ${matched} of ${withLinks.length} readings (OpenAlex)`,
          );
        }
      } catch {
        /* enrichment is optional — a dead API never breaks the pass */
      }
      const validated = withLinks.filter((r) => r.url !== undefined || (r.author !== undefined && r.author.trim() !== ''));
      const dropped = out.readings.length - validated.length;
      if (dropped > 0) notes.push(`${dropped} reading${dropped === 1 ? '' : 's'} dropped — no link or author to validate by`);
      readings.push(...validated);
    } catch (e) {
      notes.push(`readings skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5 — track suggestion (only when the caller says no track context was given).
  let trackSuggestion: Proposal['trackSuggestion'];
  if (config.trackSuggestion && input.tracks.length > 0 && extracted.thesis.length > 0) {
    try {
      const out = TrackSchema.parse(
        await chatJson(
          deps.llm,
          'You suggest which existing reading tracks a document belongs in. Suggest only clear fits.',
          `Document: ${source.title}\nThesis:\n${extracted.thesis.join('\n')}\n\nTracks:\n${input.tracks.map((t) => `- ${t.title}${t.goal ? ` — ${t.goal.slice(0, 120)}` : ''}`).join('\n')}\n\nReturn JSON {suggestions:[{title, reason}]} — titles copied exactly; empty when none fit.`,
          deps.fetcher,
        ),
      );
      trackSuggestion = out.suggestions
        .map((sg) => {
          const t = input.tracks.find((x) => norm(x.title) === norm(sg.title));
          return t ? { trackId: t.id, title: t.title, reason: sg.reason } : undefined;
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
    } catch (e) {
      notes.push(`track suggestion skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5.5 — ordering: prerequisite pairs among the concepts THIS capture touched — the
  // one structure entity proposals + derived co-occurrence cannot supply. Companion data only.
  let orderingSuggestion: Proposal['orderingSuggestion'];
  if (config.ordering && aboutNames.length >= 2) {
    try {
      const out = OrderingSchema.parse(
        await chatJson(
          deps.llm,
          'You order concepts for learning. Suggest a prerequisite pair ONLY when one concept is clearly needed to understand the other. When unsure, suggest nothing.',
          `Passages:\n${[...extracted.thesis, ...extracted.definitions].join('\n')}\n\nConcepts touched by this document:\n${aboutNames.map((n) => `- ${n}`).join('\n')}\n\nReturn JSON {pairs:[{before, after, reason}]} — "before" must be understood first; names copied exactly from the list; empty when no clear ordering exists.`,
          deps.fetcher,
        ),
      );
      const idOf = (name: string): string => resolveConcept(name, input.concepts)?.id ?? conceptId(name);
      const seen = new Set<string>();
      orderingSuggestion = out.pairs
        // the gate: both ends must be concepts this capture actually touched, no self-pairs,
        // first-wins dedup (an A<B after a B<A is a contradiction, not a second suggestion)
        .filter((p) => aboutNames.includes(p.before) && aboutNames.includes(p.after) && p.before !== p.after)
        .filter((p) => {
          const key = [p.before, p.after].sort().join(' ');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((p) => ({ beforeId: idOf(p.before), before: p.before, afterId: idOf(p.after), after: p.after, reason: p.reason }));
    } catch (e) {
      notes.push(`ordering skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6 — assemble ONE sugared payload. Proposed ties ride only on proposed entities:
  //   - a proposed question carries its RAISES/ANSWERS tie via the SOURCE's sugar fields;
  //   - a proposed snippet belongs to the source by construction;
  //   - a proposed reading carries its #RefersTo tie FROM the existing source (allowed: the
  //     tie's proposed END is the reading — reject it and the edge folds away with it).
  const raises = questions.filter((q) => !q.answers).map((q) => q.text);
  const answers = questions.filter((q) => q.answers).map((q) => q.text);
  const payload: Record<string, unknown> = {
    version: 2,
    ...(newConcepts.length ? { concepts: newConcepts } : {}),
    sources: [
      {
        id: source.id, // pin the EXISTING source — enrich it, never fork a title-derived twin
        title: source.title,
        ...(source.url ? { directUrl: source.url } : {}),
        modality: 'text',
        ...(aboutNames.length ? { about: aboutNames } : {}),
        ...(raises.length ? { raises } : {}),
        ...(answers.length ? { answers } : {}),
        ...(snippets.length ? { snippets: snippets.map((sn) => ({ text: sn.text, ...(sn.tags.length ? { tags: sn.tags } : {}) })) } : {}),
      },
      ...readings.map((r) => ({
        title: r.title,
        modality: 'text' as const,
        ...(r.url ? { directUrl: r.url } : {}),
        ...(r.author ? { author: r.author } : {}),
        ...(r.citations !== undefined ? { tags: [`#citations:${r.citations}`] } : {}),
        ...(r.thesisQuestion ? { answers: [r.thesisQuestion] } : {}),
      })),
    ],
  };

  // Always TYPED ids: snippets have no natural ref at all, and a reading titled like a concept
  // ("Model Theory" the book vs the concept) would make a natural ref ambiguous.
  stageRefs.push(...newConcepts.map((c) => conceptId(c.name)));
  stageRefs.push(...questions.map((q) => questionId({ text: q.text })));
  stageRefs.push(...snippets.map((sn) => snippetId({ sourceId: source.id, text: sn.text })));
  // id derivation must mirror the sugared entry exactly — directUrl participates in identity
  stageRefs.push(...readings.map((r) => sourceId({ title: r.title, ...(r.url ? { directUrl: r.url } : {}) })));

  const refersTo = readings.map((r) => ({ fromSourceId: source.id, toTitle: r.title }));
  return {
    payload,
    stageRefs,
    refersTo,
    ...(trackSuggestion?.length ? { trackSuggestion } : {}),
    ...(orderingSuggestion?.length ? { orderingSuggestion } : {}),
    notes,
  };
}
