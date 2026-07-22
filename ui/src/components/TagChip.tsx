/**
 * The one tag chip (consolidation, 2026-07-21 — this lived as four per-view '#seminal'
 * literals). Special styling per ARCHITECTURE #2's corollary: the TSX gives NO tag special
 * treatment — every tag mechanically gets `chip tag-<name>`, and the stylesheet (presentation
 * layer) decides which classes look different (.chip.tag-seminal is amber). Adding styling
 * for another tag is a CSS rule, never a component change.
 */
import type { ReactNode } from 'react';

/** '#Supports:a' → 'chip tag-supports'; '#seminal' → 'chip tag-seminal'. */
export function tagClass(tag: string): string {
  const name = tag.replace(/^#/, '').split(':')[0]!.toLowerCase();
  return `chip tag-${name}`;
}

export function TagChip({ tag, label, title, children }: { tag: string; label?: string; title?: string; children?: ReactNode }) {
  return (
    <span className={tagClass(tag)} title={title}>
      {label ?? tag}
      {children}
    </span>
  );
}
