/**
 * Publish AS — fork identity.
 *
 * A fork of someone else's track cannot take their registry name ("the first publisher owns the
 * name"), so publishing YOUR version means publishing under YOUR title. The alias lives on the
 * publish stamp and applies in the PROJECTION: the bundle that leaves carries the new identity
 * everywhere, while the local track keeps its id and history untouched.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

const fork = () => {
  const upstream = PhilomaticEngine.open(':memory:');
  upstream.captureSource({ url: 'https://ex.com/a', title: 'A', track: 'Logic 101' });
  upstream.publish({ ref: 'Logic 101' });
  const mine = PhilomaticEngine.open(':memory:');
  mine.importPublication(upstream.publication('Logic 101')!, { originUrl: 'https://reg.example/t/syl_logic-101' });
  return mine;
};

describe('publish as (fork identity)', () => {
  it('the bundle carries the new identity everywhere; the local track keeps its own', () => {
    const e = fork();
    e.captureSource({ url: 'https://ex.com/b', title: 'B', track: 'Logic 101' });
    e.publish({ ref: 'Logic 101', as: "Stu's Logic Notes" });
    const b = e.publication('Logic 101')!;
    expect(b.publication.trackId).toBe('syl_stu-s-logic-notes');
    expect(b.publication.title).toBe("Stu's Logic Notes");
    const tracks = b.payload.tracks as { id: string; title: string }[];
    expect(tracks).toEqual([expect.objectContaining({ id: 'syl_stu-s-logic-notes', title: "Stu's Logic Notes" })]);
    const edges = b.payload.edges as { srcId: string; type: string }[];
    // Every membership edge left under the NEW id — none under the old.
    expect(edges.filter((x) => x.type === 'INCLUDES').every((x) => x.srcId === 'syl_stu-s-logic-notes')).toBe(true);
    expect(JSON.stringify(b.payload)).not.toContain('syl_logic-101');
    // The LOCAL track is untouched: same id, origin lineage intact (the pull needs it).
    const local = e.exportAll().tracks.find((t) => t.title === 'Logic 101')!;
    expect(local.id).toBe('syl_logic-101');
    expect(local.origin?.trackId).toBe('syl_logic-101');
  });

  it('an already-published track ADOPTS an alias (the refused-push flow), once', () => {
    const e = fork();
    e.publish({ ref: 'Logic 101' }); // the naive publish that the registry then refuses
    expect(e.publication('Logic 101')!.publication.trackId).toBe('syl_logic-101');
    const adopted = e.publish({ ref: 'Logic 101', as: 'My Version' });
    expect(adopted.changed).toBe(true);
    expect(e.publication('Logic 101')!.publication.trackId).toBe('syl_my-version');
    // Idempotent: the same alias again is a no-op.
    expect(e.publish({ ref: 'Logic 101', as: 'My Version' }).changed).toBe(false);
  });

  it('unpublish clears the alias with the stamp', () => {
    const e = fork();
    e.publish({ ref: 'Logic 101', as: 'My Version' });
    e.unpublish({ ref: 'Logic 101' });
    expect(e.publication('Logic 101')).toBeNull();
    e.publish({ ref: 'Logic 101' });
    expect(e.publication('Logic 101')!.publication.trackId).toBe('syl_logic-101');
  });

  it('the aliased bundle round-trips: forking it lands the NEW identity', () => {
    const e = fork();
    e.publish({ ref: 'Logic 101', as: 'My Version' });
    const third = PhilomaticEngine.open(':memory:');
    const got = third.importPublication(e.publication('Logic 101')!, {});
    expect(got).toEqual({ trackId: 'syl_my-version', title: 'My Version' });
  });
});
