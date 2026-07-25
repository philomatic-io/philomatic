/**
 * Share vs backup (owner report, 2026-07-17: "I deleted entities but Share still shows them").
 * Removal is retraction, never deletion — so the raw export (the BACKUP, which must carry the
 * undo history) necessarily keeps removed rows. `exportLive()` is the SHARE shape: the same
 * fold the views use, so the file matches what the sharer sees.
 */
import { describe, expect, it } from 'vitest';
import { PhilomaticEngine } from '../src/engine';

describe('exportLive — the share shape', () => {
  it('folds retracted entities, their edges, and their events out; the backup keeps them', () => {
    const engine = PhilomaticEngine.open();
    engine.importPayload({
      version: 2,
      concepts: [{ name: 'Kept' }, { name: 'Dropped' }],
      sources: [
        {
          title: 'S',
          directUrl: 'https://example.com/s',
          modality: 'text',
          explains: ['Dropped'],
          snippets: [{ text: 'passage.', clarifies: ['Kept'] }],
        },
      ],
    });
    engine.consume('https://example.com/s');
    engine.remove({ ref: 'Dropped' });

    const backup = JSON.stringify(engine.exportAll());
    const share = JSON.stringify(engine.exportLive());

    expect(backup).toContain('Dropped'); // retraction, never deletion — restore needs this
    expect(backup).toContain('RETRACTED');
    expect(share).not.toContain('Dropped'); // the share matches what the sharer sees
    expect(share).not.toContain('RETRACTED');
    expect(share).toContain('Kept');
    expect(share).toContain('passage.');
    expect(share).toContain('CONSUMED'); // live behavioral history stays

    // The share re-imports cleanly into a fresh instance (no dangling refs).
    const other = PhilomaticEngine.open();
    other.importPayload(engine.exportLive());
    expect(other.snapshot().sources).toHaveLength(1);
    other.close();
    engine.close();
  });
});
