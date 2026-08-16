/**
 * Pull with a base: additive, learner-respecting, honest about what it did.
 *
 * The classroom moment this exists for: the professor accepts a student question, adds a
 * reading that ANSWERS it, republishes — and every member's pull takes both, while a member's
 * own edits survive and their retractions are never overruled.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

/** Professor publishes v1; the student forks it. Returns both engines + the v1 bundle. */
const classroom = () => {
  const prof = PhilomaticEngine.open(':memory:');
  prof.captureSource({ url: 'https://ex.com/reading1', title: 'Reading One', track: 'Logic 101' });
  prof.publish({ ref: 'Logic 101' });
  const v1 = prof.publication('Logic 101')!;
  const stu = PhilomaticEngine.open(':memory:');
  stu.importPublication(JSON.parse(JSON.stringify(v1)), { originUrl: 'https://reg.example/t/syl_logic-101' });
  return { prof, stu, v1 };
};

describe('pull with a base', () => {
  it('takes upstream additions — the accepted question and its ANSWERS reading arrive tied', () => {
    const { prof, stu, v1 } = classroom();
    // Upstream: the accepted question on Reading One, and a new reading.
    prof.captureSnippet({ url: 'https://ex.com/reading1', text: 'the key passage', raises: ['Why soundness?'] });
    prof.captureSource({ url: 'https://ex.com/reading2', title: 'Reading Two', track: 'Logic 101' });
    const summary = stu.pullPublication(JSON.parse(JSON.stringify(prof.publication('Logic 101')!)), JSON.parse(JSON.stringify(v1)));
    expect(summary.took).toBeGreaterThanOrEqual(3); // snippet + question + Reading Two
    expect(summary.keptYours).toBe(0);
    expect(summary.upstreamDeleted).toBe(0);
    expect(summary.edgesAdded).toBeGreaterThanOrEqual(2); // INCLUDES Reading Two, RAISES
    const qs = stu.questions();
    expect(qs.map((q) => q.text)).toContain('Why soundness?');
    expect(stu.exportAll().sources.map((s) => s.title).sort()).toEqual(['Reading One', 'Reading Two']);
  });

  it("a member's edit survives their pull, and the summary says theirs was kept", () => {
    const { prof, stu, v1 } = classroom();
    // The member retitles their copy of Reading One; upstream retitles it differently.
    const mineId = stu.exportAll().sources[0]!.id;
    stu.update({ ref: mineId, patch: { title: 'Reading One (my notes)' } });
    prof.update({ ref: mineId, patch: { title: 'Reading One, 2nd ed.' } });
    const summary = stu.pullPublication(JSON.parse(JSON.stringify(prof.publication('Logic 101')!)), JSON.parse(JSON.stringify(v1)));
    expect(summary.keptYours).toBe(1);
    expect(stu.exportAll().sources[0]!.title).toBe('Reading One (my notes)');
  });

  it('an UNEDITED entity takes the upstream edit — and local personal tags survive the take', () => {
    const { prof, stu, v1 } = classroom();
    const id = stu.exportAll().sources[0]!.id;
    stu.update({ ref: id, patch: { tags: ['#shelf:evening'] } }); // a personal observation, not an edit
    prof.update({ ref: id, patch: { title: 'Reading One, corrected' } });
    const summary = stu.pullPublication(JSON.parse(JSON.stringify(prof.publication('Logic 101')!)), JSON.parse(JSON.stringify(v1)));
    expect(summary.took).toBe(1);
    const mine = stu.exportAll().sources.find((s) => s.id === id)!;
    expect(mine.title).toBe('Reading One, corrected');
    expect(mine.tags.map((t) => t.name)).toContain('shelf');
  });

  it('never resurrects what the learner removed, and reports upstream deletions without acting', () => {
    const { prof, stu, v1 } = classroom();
    prof.captureSource({ url: 'https://ex.com/reading2', title: 'Reading Two', track: 'Logic 101' });
    prof.publish({ ref: 'Logic 101' });
    const v2 = prof.publication('Logic 101')!;
    stu.pullPublication(JSON.parse(JSON.stringify(v2)), JSON.parse(JSON.stringify(v1)));
    // The member removes Reading Two; upstream deletes Reading One.
    const twoId = stu.exportAll().sources.find((s) => s.title === 'Reading Two')!.id;
    stu.remove({ ref: twoId });
    const oneId = prof.exportAll().sources.find((s) => s.title === 'Reading One')!.id;
    prof.remove({ ref: oneId });
    const summary = stu.pullPublication(JSON.parse(JSON.stringify(prof.publication('Logic 101')!)), JSON.parse(JSON.stringify(v2)));
    // Reading Two stays removed (retraction outranks pull); Reading One stays present (deletion
    // is reported, never applied).
    expect(stu.exportAll().sources.filter((s) => s.title === 'Reading Two')).toHaveLength(1); // in store but retracted
    expect(stu.removed().map((r) => r.id)).toContain(twoId);
    expect(summary.upstreamDeleted).toBeGreaterThanOrEqual(1);
    const live = stu.snapshot().sources.map((s) => s.title);
    expect(live).toContain('Reading One');
    expect(live).not.toContain('Reading Two');
  });

  it('moves the base marker so a second pull of the same version is quiet', () => {
    const { prof, stu, v1 } = classroom();
    prof.captureSource({ url: 'https://ex.com/reading2', title: 'Reading Two', track: 'Logic 101' });
    const v2 = prof.publication('Logic 101')!;
    stu.pullPublication(JSON.parse(JSON.stringify(v2)), JSON.parse(JSON.stringify(v1)));
    expect(stu.exportAll().tracks[0]!.origin?.contentHash).toBe(v2.publication.contentHash);
    const again = stu.pullPublication(JSON.parse(JSON.stringify(v2)), JSON.parse(JSON.stringify(v2)));
    expect(again).toMatchObject({ took: 0, keptYours: 0, upstreamDeleted: 0, edgesAdded: 0 });
  });
});
