/**
 * The SURVEY→TRACK pass — "draft a whole track from this survey".
 * A survey is the best input the gates can get: section headings are verbatim text (and ARE
 * the topic taxonomy), citations are the readings (mentions gated, links harvested), and
 * ORDERING is mechanical — a citation's position in the document is a fact code computes,
 * trivially acyclic as PRECEDES demands.
 *
 * What the LLM does here is deliberately small: ONE call per substantive section, naming the
 * works that section cites (mention verbatim-gated against the SECTION text). Everything
 * structural — sections, concepts-from-headings, membership, order — is code.
 *
 * Invariant amendment (recorded with the membership
 * memory): every INCLUDES edge rides the PROPOSED track end; ACCEPTING the staged track IS
 * the explicit membership gesture, at track granularity. This pass never touches an existing
 * track's membership.
 */
import { z } from 'zod';
import { conceptId, sourceId, trackId } from '../engine';
import { acquireText, type PageSection } from './acquire';
import { chatJson, type Fetcher, type LlmConfig } from './llm';
import { makeLinkFor, norm, objects, strings, verbatimOnly } from './propose';
import { scholarLookup, surveyReferences, type ScholarWork } from './scholar-adapter';

export interface ProposeTrackConfig {
  /** Total reading cap across all sections — a 200-citation survey must not flood the inbox. */
  maxReadings: number;
  /** Section headings become proposed concepts (levels 2–3, junk-filtered). */
  conceptsFromHeadings: boolean;
  /** Scholarly enrichment: canonical metadata + citation counts per
   *  reading via OpenAlex — fills missing links/authors, tags `#citations:N`. */
  citationLookup: boolean;
}

export const DEFAULT_PROPOSE_TRACK: ProposeTrackConfig = { maxReadings: 24, conceptsFromHeadings: true, citationLookup: true };

export interface ProposeTrackInput {
  source: { id: string; title: string; url?: string };
  /** The track title to mint — the CALLER guarantees it collides with no existing track. */
  trackTitle: string;
  config: ProposeTrackConfig;
}

export interface ProposeTrackDeps {
  llm: LlmConfig;
  fetcher?: Fetcher;
  fetchPage?: Fetcher;
}

export interface TrackProposal {
  payload: Record<string, unknown>;
  /** Typed refs of every PROPOSED entity — track first, then readings and concepts. */
  stageRefs: string[];
  trackRef: string;
  notes: string[];
}

const SectionReadingsSchema = z.object({
  readings: objects(
    z.object({ mention: z.string(), title: z.string(), author: z.string().optional() }),
    'mention',
    6,
  ),
});

/** Sections that never carry survey content — page chrome, not taxonomy. */
const JUNK_HEADINGS = /^(comments?|related( posts)?|table of contents|contents|navigation|footer|share.*|newsletter|see also|external links|subscribe.*)$/i;
const MIN_SECTION_CHARS = 200;
const MAX_SECTIONS = 20;

const substantive = (s: PageSection): boolean => s.text.length >= MIN_SECTION_CHARS && !JUNK_HEADINGS.test(s.heading.trim());

export async function proposeTrack(input: ProposeTrackInput, deps: ProposeTrackDeps): Promise<TrackProposal> {
  const { source, trackTitle, config } = input;
  const notes: string[] = [];
  if (!source.url) throw new Error('propose-track: the source has no URL to read');

  // 0 — acquire: the section view is what this pass walks; links ground the reading URLs.
  const acquired = await acquireText(source.url, deps.fetchPage);
  const sections = acquired.sections.filter(substantive).slice(0, MAX_SECTIONS);
  const skipped = acquired.sections.length - sections.length;
  if (skipped > 0) notes.push(`${skipped} section${skipped === 1 ? '' : 's'} skipped (chrome or too thin)`);
  if (sections.length === 0) throw new Error('propose-track: no substantive sections acquired — is this really a survey page?');

  // 1 — per-section readings (the ONLY LLM work): mention verbatim-gated against the section.
  interface Candidate { title: string; author?: string; url?: string; sectionIdx: number; posInSection: number; heading: string }
  const candidates: Candidate[] = [];
  for (const [sectionIdx, sec] of sections.entries()) {
    try {
      const out = SectionReadingsSchema.parse(
        await chatJson(
          deps.llm,
          'You extract the works a survey section cites or recommends. Every mention must be copied VERBATIM from the section text. Never invent a work.',
          `Survey: ${source.title}\nSection: ${sec.heading || '(preamble)'}\n\nSECTION TEXT:\n${sec.text}\n\nReturn JSON {readings:[{mention, title, author?}]} — mention = the citing sentence or fragment copied EXACTLY; title = the cited work's name as stated; author only when stated. Up to 6; empty when the section cites nothing.`,
          deps.fetcher,
        ),
      );
      for (const r of out.readings) {
        if (r.title.trim() === '' || verbatimOnly(sec.text, [r.mention]).length !== 1) continue;
        candidates.push({
          title: r.title.trim(),
          ...(r.author !== undefined && r.author.trim() !== '' ? { author: r.author.trim() } : {}),
          sectionIdx,
          posInSection: norm(sec.text).indexOf(norm(r.mention)),
          heading: sec.heading,
        });
      }
    } catch (e) {
      notes.push(`section "${sec.heading || '(preamble)'}" skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2 — code: dedup by normalized title (first mention wins the position), attach page links,
  // enrich with scholarly metadata, keep only what a human can validate (link or author), cap.
  const seen = new Map<string, Candidate>();
  for (const c of candidates) if (!seen.has(norm(c.title))) seen.set(norm(c.title), c);
  const linkFor = makeLinkFor(acquired.links);
  const surveyTitleN = norm(source.title);
  interface Enriched extends Candidate { url?: string; citations?: number }
  const prelim: Enriched[] = [...seen.values()]
    .filter((c) => norm(c.title) !== surveyTitleN) // a survey citing itself is not a member twice
    .sort((a, b) => a.sectionIdx - b.sectionIdx || a.posInSection - b.posInSection)
    .slice(0, config.maxReadings + 8) // a small buffer: enrichment below can rescue link-less works
    .map((c) => ({ ...c, ...(linkFor(c.title) !== undefined ? { url: linkFor(c.title) } : {}) }));
  // Scholarly enrichment BEFORE the validation filter: the DOI fills a
  // missing link, authors fill when missing, cited_by_count rides as a #citations tag —
  // visible signal for "is this worth my time", never a silent decision.
  //
  // HYBRID: when the survey ITSELF is indexed, its `referenced_works`
  // — the actual citation graph — becomes the ground truth: extracted readings match against
  // that CLOSED list (near-zero wrong identities, one batch instead of N searches). The text
  // still owns what only it knows: section attribution and reading order. Unindexed surveys
  // (blogs, docs) fall back to per-title guarded search.
  if (config.citationLookup) {
    const apiFetch = deps.fetchPage ?? fetch;
    const fill = (c: Enriched, w: ScholarWork): void => {
      if (c.url === undefined && w.doi !== undefined) c.url = w.doi;
      if (c.author === undefined && w.authors.length > 0) c.author = w.authors.slice(0, 6).join(', ');
      c.citations = w.citations;
    };
    let refs: Awaited<ReturnType<typeof surveyReferences>>;
    try {
      refs = await surveyReferences({ title: source.title, ...(source.url ? { url: source.url } : {}) }, apiFetch);
    } catch {
      refs = undefined;
    }
    if (refs !== undefined) {
      const inRefs = (title: string): ScholarWork | undefined => {
        const t = norm(title);
        return refs!.cites.find((w) => {
          const wt = norm(w.title);
          return wt === t || (t.length >= 10 && wt.includes(t)) || (wt.length >= 10 && t.includes(wt));
        });
      };
      let confirmed = 0;
      for (const c of prelim) {
        const w = inRefs(c.title);
        if (w !== undefined) {
          confirmed += 1;
          fill(c, w);
        }
      }
      notes.push(
        `the survey cites ${refs.total} works; ${confirmed} of ${prelim.length} extracted readings confirmed against its reference list`,
      );
    } else {
      let hits = 0;
      for (const c of prelim) {
        try {
          const w = await scholarLookup(c.title, apiFetch);
          if (w === undefined) continue;
          hits += 1;
          fill(c, w);
        } catch {
          /* enrichment is optional — a dead API never breaks the draft */
        }
      }
      if (hits > 0) notes.push(`scholarly metadata matched for ${hits} of ${prelim.length} readings (OpenAlex)`);
    }
  }
  const readings = prelim
    .filter((c) => c.url !== undefined || c.author !== undefined)
    .slice(0, config.maxReadings);
  const dropped = seen.size - readings.length;
  if (dropped > 0) notes.push(`${dropped} cited work${dropped === 1 ? '' : 's'} dropped (duplicate of the survey, no link/author, or over the ${config.maxReadings} cap)`);

  // 3 — code: section headings → proposed concepts (the survey's own taxonomy, verbatim).
  let conceptNames = config.conceptsFromHeadings
    ? [...new Set(
        sections
          .filter((s) => s.heading !== '' && s.level >= 2 && s.level <= 3)
          .filter((s) => readings.some((r) => r.heading === s.heading) || s.text.length >= MIN_SECTION_CHARS)
          .map((s) => s.heading.trim()),
      )].slice(0, 12)
    : [];

  // 3b — headingless documents (PDFs: sections are anonymous windows) fall back to ONE model
  // call grounded in the opening text (a track with readings but no
  // concepts is half a map). The names are proposals like any other — staged, rejectable.
  if (config.conceptsFromHeadings && conceptNames.length === 0) {
    try {
      const out = z.object({ concepts: strings }).parse(
        await chatJson(
          deps.llm,
          'You name the topics a survey covers — short noun phrases a learner would file readings under. Ground every name in the text; never invent coverage the text does not show.',
          `Survey: ${source.title}\n\nTEXT (opening):\n${sections.map((s) => s.text).join('\n').slice(0, 10_000)}\n\nReturn JSON {concepts:[...]} — 4-10 short names of the areas this survey maps.`,
          deps.fetcher,
        ),
      );
      conceptNames = [...new Set(out.concepts.map((c) => c.trim()).filter((c) => c !== '' && c.length <= 60))].slice(0, 12);
      if (conceptNames.length > 0) {
        notes.push(`${conceptNames.length} concepts named by the model (no headings in this document) — review before accepting`);
      }
    } catch (e) {
      notes.push(`concepts skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4 — assemble ONE sugared payload. `order` implies membership AND the PRECEDES chain —
  // the survey itself reads first. All INCLUDES ride the proposed track (the invariant
  // amendment); the survey source is PINNED so enrichment never forks a twin.
  const order = [source.title, ...readings.map((r) => r.title)];
  const payload: Record<string, unknown> = {
    version: 2,
    ...(conceptNames.length > 0 ? { concepts: conceptNames.map((name) => ({ name })) } : {}),
    sources: [
      { id: source.id, title: source.title, ...(source.url ? { directUrl: source.url } : {}), modality: 'text' },
      ...readings.map((r) => ({
        title: r.title,
        modality: 'text' as const,
        ...(r.url ? { directUrl: r.url } : {}),
        ...(r.author ? { author: r.author } : {}),
        ...(r.citations !== undefined ? { tags: [`#citations:${r.citations}`] } : {}),
        ...(conceptNames.includes(r.heading.trim()) ? { about: [r.heading.trim()] } : {}),
      })),
    ],
    tracks: [
      {
        title: trackTitle,
        goal: `Drafted from the survey “${source.title}” — review, prune, accept.`,
        ...(conceptNames.length > 0 ? { includes: conceptNames } : {}),
        order,
      },
    ],
  };

  const stageRefs = [
    trackId(trackTitle),
    ...readings.map((r) => sourceId({ title: r.title, ...(r.url ? { directUrl: r.url } : {}) })),
    ...conceptNames.map((n) => conceptId(n)),
  ];
  notes.push(`${readings.length} readings across ${sections.length} sections; ${conceptNames.length} section concepts`);
  return { payload, stageRefs, trackRef: trackId(trackTitle), notes };
}
