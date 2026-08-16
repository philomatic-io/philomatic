/**
 * Deterministic contribution ids (the anti-backfill reservation) — the pure part:
 * the id is a stable function of {kind, value, assertedBy}, distinct per asserter and per
 * value, and always lexes as a SUBTYPE tag (never a numeric degree).
 */
import { describe, expect, it } from 'vitest';
import { contribId, contribTag } from '../ui/src/lib/contrib-id';
import { lexTag } from '../src/schema/tags';

describe('contribId', () => {
  const claim = { kind: 'question' as const, value: 'Why is soundness not completeness?', assertedBy: 'Studious-Stu' };

  it('is deterministic — same claim, same id, every time', () => {
    expect(contribId(claim)).toBe(contribId({ ...claim }));
    expect(contribId(claim)).toMatch(/^c[0-9a-f]{15}$/);
  });

  it('distinguishes asserter, value and kind', () => {
    expect(contribId(claim)).not.toBe(contribId({ ...claim, assertedBy: 'Alice-A' }));
    expect(contribId(claim)).not.toBe(contribId({ ...claim, value: 'A different question?' }));
    expect(contribId(claim)).not.toBe(contribId({ ...claim, kind: 'source' }));
  });

  it('the tag lexes as name+subtype (the leading c forbids the degree parse)', () => {
    const tag = lexTag(contribTag(claim));
    expect(tag.name).toBe('contrib');
    expect(tag.subtype).toBe(contribId(claim));
    expect(tag.degree).toBeUndefined();
  });
});
