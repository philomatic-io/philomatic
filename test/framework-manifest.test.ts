/**
 * The framework manifest (the anti-backfill reservation): every export
 * names the frameworks it assumes; imports tolerate and ignore it; publication bundles stay
 * manifest-free (their payload is built field-by-field), so no contentHash moved.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';
import { FRAMEWORKS } from '../src/framework';

describe('the framework manifest', () => {
  it('every export stamps the installed set, {name, version} each', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, concepts: [{ name: 'Logic' }] });
    for (const p of [engine.exportAll(), engine.exportLive()]) {
      expect(p.frameworks).toEqual(FRAMEWORKS.map((f) => ({ name: f.framework, version: f.version })));
    }
    engine.close();
  });

  it('imports tolerate a manifest — round-trip is a no-op, and unknown lenses do not reject', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({ version: 2, concepts: [{ name: 'Logic' }] });
    const exported = engine.exportAll();
    engine.importPayload(exported); // carries the manifest
    engine.importPayload({ version: 2, frameworks: [{ name: 'someone-elses-lens', version: 3 }], concepts: [{ name: 'Logic' }] });
    expect(engine.exportAll()).toEqual(exported); // manifest is never stored — re-stamped per export
    engine.close();
  });

  it('a bundle using a LIBRARY framework carries the manifest AND the definition (FE-D5/D6)', () => {
    const MINE = {
      framework: 'stu-lenses',
      version: 3,
      edgeTags: [{ name: 'EchoesTheme', on: { type: 'LINK', srcKind: 'concept', dstKind: 'concept' }, direction: 'symmetric' as const, publish: true }],
      entityTags: [],
      metadataFields: [],
    };
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 2,
      concepts: [{ name: 'A' }, { name: 'B' }],
      tracks: [{ title: 'T', includes: ['A', 'B'] }],
    });
    engine.link({ srcType: 'concept', srcId: 'cpt_a', type: 'LINK', dstType: 'concept', dstId: 'cpt_b', tags: [{ name: 'EchoesTheme' }] });
    engine.publish({ ref: 'T' });
    const bundle = engine.publication('T', { frameworks: [MINE] }) as {
      payload: { frameworks?: { name: string; version: number }[] };
      frameworkDefs?: { framework: string }[];
    };
    expect(bundle.payload.frameworks, 'the manifest names the dependency (hash-covered)').toEqual([{ name: 'stu-lenses', version: 3 }]);
    expect(bundle.frameworkDefs?.map((f) => f.framework), 'the definition travels').toEqual(['stu-lenses']);
    engine.close();
  });

  it('publication bundles carry NO manifest — landing this moved no contentHash', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 2,
      sources: [{ title: 'R', directUrl: 'https://ex.com/r', modality: 'text' }],
      tracks: [{ title: 'T', includeSources: ['R'] }],
    });
    engine.publish({ ref: 'T' });
    const bundle = engine.publication('T') as { payload: Record<string, unknown> };
    expect(bundle.payload.frameworks).toBeUndefined();
    engine.close();
  });
});
