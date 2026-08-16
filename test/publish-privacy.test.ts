/**
 * Publishing must not leak personal tags.
 *
 * Entity tags are free-form — the framework declared edge tags only, so anything a learner
 * typed rode along into a published bundle: reading preferences, private shelving, notes to
 * self. This pins the rule that replaced that (a framework must DECLARE a tag publishable) and,
 * more importantly, pins it as a DEFAULT-DENY: the test that matters is the undeclared tag,
 * because that is the one a future contributor adds without thinking about publishing at all.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhilomaticEngine } from '../src/engine';

function published(): PhilomaticEngine {
  const engine = PhilomaticEngine.open(join(mkdtempSync(join(tmpdir(), 'pm-priv-')), 'db.sqlite'));
  engine.importPayload({
    version: 2,
    concepts: [{ name: 'Fairness', tags: ['#difficulty:4', '#NeedsSources', '#myShelf'] }],
    tracks: [{ title: 'Public Track', includes: ['Fairness'], tags: ['#CasualReading', '#difficulty:2'] }],
    sources: [
      { title: 'A Book', modality: 'text', about: ['Fairness'], tags: ['#difficulty:3', '#beginner', '#CasualReading'] },
    ],
  });
  engine.link({ srcType: 'track', srcId: 'syl_public-track', type: 'INCLUDES', dstType: 'source', dstId: 'src_a-book' });
  engine.publish({ ref: 'syl_public-track', license: 'CC-BY-SA-4.0' });
  return engine;
}

const names = (tags: { name: string }[] | undefined): string[] => (tags ?? []).map((t) => t.name).sort();

describe('publish is FRAMEWORK-SPECIFIC', () => {
  /** A track on `framework`, with a snippet↔snippet tag only that framework declares. */
  function argumentTrack(framework?: string): PhilomaticEngine {
    const engine = PhilomaticEngine.open(join(mkdtempSync(join(tmpdir(), 'pm-fw-')), 'db.sqlite'));
    engine.importPayload({
      version: 2,
      tracks: [{ title: 'Arg Track', ...(framework !== undefined ? { framework } : {}) }],
    });
    engine.captureSource({ url: 'https://example.com/paper', title: 'Paper' });
    engine.captureSnippet({ url: 'https://example.com/paper', text: 'The claim.' });
    engine.captureSnippet({ url: 'https://example.com/paper', text: 'The evidence.' });
    const snaps = engine.exportLive().snippets;
    engine.link({
      srcType: 'snippet', srcId: snaps[1]!.id, type: 'LINK', dstType: 'snippet', dstId: snaps[0]!.id,
      tags: [{ name: 'Supports' }],
    });
    const paper = engine.exportLive().sources.find((x) => x.title === 'Paper')!.id;
    engine.link({ srcType: 'track', srcId: 'syl_arg-track', type: 'INCLUDES', dstType: 'source', dstId: paper });
    engine.publish({ ref: 'syl_arg-track', license: 'CC-BY-SA-4.0' });
    return engine;
  }
  const linkTags = (engine: PhilomaticEngine): string[] =>
    (engine.publication('syl_arg-track')!.payload.edges as unknown as { type: string; tags?: { name: string }[] }[])
      .filter((e) => e.type === 'LINK')
      .flatMap((e) => names(e.tags));

  it('a track ON the framework publishes its tags', () => {
    const engine = argumentTrack('argument-diagramming');
    expect(linkTags(engine)).toContain('Supports');
    engine.close();
  });

  it('a track NOT on it does not — the same tag, the same installed frameworks', () => {
    // The union across everything INSTALLED would make a bundle depend on the publisher's
    // machine, so the same track would publish differently from two computers.
    const engine = argumentTrack();
    expect(linkTags(engine)).not.toContain('Supports');
    engine.close();
  });
});

describe('publish keeps declared tags and leaves the rest at home', () => {
  it('an UNDECLARED tag never reaches the bundle — on any entity', () => {
    const engine = published();
    const p = engine.publication('syl_public-track')!.payload;
    const every = [...p.tracks, ...p.concepts, ...p.sources, ...p.snippets, ...p.questions];
    const leaked = every.flatMap((e) => names((e as { tags?: { name: string }[] }).tags)).filter((n) => !['difficulty', 'NeedsSources'].includes(n));
    expect(leaked).toEqual([]);
    engine.close();
  });

  it('#difficulty does NOT travel — it is relative to the reader, not the work', () => {
    // One learner's 3 is another's 1, so publishing it states a fact about
    // the work that is really a fact about the person.
    const engine = published();
    const p = engine.publication('syl_public-track')!.payload;
    const src = p.sources[0] as unknown as { tags: { name: string }[] };
    expect(names(src.tags)).toEqual([]);
    expect(names((p.concepts[0] as unknown as { tags: { name: string }[] }).tags)).toEqual(['NeedsSources']);
    engine.close();
  });

  it('EDGE tags are filtered too — declared ones travel, undeclared ones do not', () => {
    // The UI can only produce declared edge tags, so this door was shut by convention. The CLI
    // and API mint whatever is asked for (deliberately), which is why the boundary is publish
    // time rather than write time.
    const engine = published();
    engine.link({
      srcType: 'source', srcId: 'src_a-book', type: 'ABOUT', dstType: 'concept', dstId: 'cpt_fairness',
      tags: [{ name: 'Explains' }, { name: 'myOwnShorthand' }],
    });
    const p = engine.publication('syl_public-track')!.payload;
    const about = (p.edges as unknown as { type: string; tags?: { name: string }[] }[]).filter((e) => e.type === 'ABOUT');
    const all = about.flatMap((e) => names(e.tags));
    expect(all).toContain('Explains');
    expect(all).not.toContain('myOwnShorthand');
    engine.close();
  });

  it('NeedsSources travels — it is a published REQUEST, not a private judgement', () => {
    // Considered for stripping and deliberately kept: the unified track/contributions
    // page renders from the PUBLISHED state, and a registry serving it has no live engine to
    // ask which concepts are open to recommendations. Pinned so the earlier (wrong) reasoning
    // cannot be re-applied silently.
    const engine = published();
    const p = engine.publication('syl_public-track')!.payload;
    expect(names((p.concepts[0] as unknown as { tags: { name: string }[] }).tags)).toContain('NeedsSources');
    engine.close();
  });

  it('the learner’s OWN library is untouched — this is a publish-time projection', () => {
    // Nothing is deleted: the tags stay where the learner put them, they simply do not travel.
    const engine = published();
    const mine = engine.exportLive().sources.find((s) => s.title === 'A Book')!;
    expect(names(mine.tags)).toEqual(['CasualReading', 'beginner', 'difficulty']);
    engine.close();
  });
});
