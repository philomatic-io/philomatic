/**
 * The pure diff behind "Propose my additions": fork vs
 * upstream-current, additive only, every item anchored to something upstream can resolve.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { forkAdditions } from '../ui/src/lib/propose-upstream';

const setup = () => {
  const prof = PhilomaticEngine.open(':memory:');
  prof.captureSource({ url: 'https://ex.com/r1', title: 'Reading One', track: 'Logic 101' });
  prof.importPayload({ version: 2, concepts: [{ name: 'Completeness' }], tracks: [{ title: 'Logic 101', includes: ['Completeness'] }] });
  prof.publish({ ref: 'Logic 101' });
  const bundle = prof.publication('Logic 101')!;
  const stu = PhilomaticEngine.open(':memory:');
  stu.importPublication(JSON.parse(JSON.stringify(bundle)), { originUrl: 'https://reg.example/t/syl_logic-101' });
  return { stu, upstream: bundle.payload as never };
};

describe('forkAdditions', () => {
  it('proposes my new member source with its upstream ties, and my anchored question', () => {
    const { stu, upstream } = setup();
    const all = stu.exportAll();
    const conceptId = all.concepts.find((c) => c.name === 'Completeness')!.id;
    const baseSourceId = all.sources.find((s) => s.title === 'Reading One')!.id;
    stu.captureSource({ url: 'https://ex.com/mine', title: 'My Addition', author: 'Me', track: 'Logic 101' });
    const mineId = stu.exportAll().sources.find((s) => s.title === 'My Addition')!.id;
    stu.link({ srcType: 'source', srcId: mineId, type: 'ABOUT', dstType: 'concept', dstId: conceptId });
    stu.captureSnippet({ sourceId: baseSourceId, text: 'p', raises: ['Why soundness?'] });

    const { items, skipped } = forkAdditions(stu.exportAll() as never, all.tracks[0]!.id, upstream);
    expect(skipped).toBe(0);
    const src = items.find((i) => i.kind === 'source')!;
    expect(src).toMatchObject({ title: 'My Addition', author: 'Me', url: 'https://ex.com/mine', aboutId: conceptId, aboutTitle: 'Completeness' });
    const q = items.find((i) => i.kind === 'question')!;
    expect(q).toMatchObject({ text: 'Why soundness?', aboutId: baseSourceId, aboutTitle: 'Reading One' });
  });

  it('drops what upstream already took, and skips questions anchored only to my new material', () => {
    const { stu, upstream } = setup();
    const all = stu.exportAll();
    // A question hanging only off MY new source: no anchor the owner can resolve → skipped.
    stu.captureSource({ url: 'https://ex.com/mine2', title: 'Mine Too', track: 'Logic 101' });
    const mineId = stu.exportAll().sources.find((s) => s.title === 'Mine Too')!.id;
    stu.captureSnippet({ sourceId: mineId, text: 'p', raises: ['A question on my own reading?'] });
    const { items, skipped } = forkAdditions(stu.exportAll() as never, all.tracks[0]!.id, upstream);
    expect(items.filter((i) => i.kind === 'source')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'question')).toHaveLength(0);
    expect(skipped).toBe(1);
    // Upstream "takes" the source: it drops out of the next proposal.
    const upTook = { ...(upstream as Record<string, unknown>), sources: [...(upstream as { sources: unknown[] }).sources, { id: mineId, title: 'Mine Too' }] };
    const again = forkAdditions(stu.exportAll() as never, all.tracks[0]!.id, upTook as never);
    expect(again.items.filter((i) => i.kind === 'source')).toHaveLength(0);
  });
});
