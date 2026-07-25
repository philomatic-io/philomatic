/**
 * The diagram drift gate (alpha UI §2.6): the committed artifacts must match a regeneration —
 * a schema change without `pnpm diagram` is a CI failure, same philosophy as the lock line.
 * Coverage rides along: every edge type and event verb must carry a tester-language sentence,
 * so onboarding can't silently lag the model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARGUMENT_DIAGRAMMING, FRAMEWORKS, PHILOMATIC_CORE, edgeTagsFor, metadataVocabulary, taxonomy, taxonomyMermaid } from '../src/engine';
import { ENDPOINT_RULES } from '../src/schema/edges';
import { EventVerbSchema } from '../src/schema/entities';
import { MODEL } from '../ui/src/generated/model';

const ROOT = join(__dirname, '..');

describe('edge-taxonomy diagram (alpha UI §2.6)', () => {
  it('DATA_MODEL.md embeds the CURRENT taxonomy (drift → run pnpm diagram)', () => {
    const dm = readFileSync(join(ROOT, 'DATA_MODEL.md'), 'utf8');
    expect(dm).toContain(`\`\`\`mermaid\n${taxonomyMermaid()}\`\`\``);
  });

  it('the UI generated model matches a regeneration (drift → run pnpm diagram)', () => {
    const t = taxonomy();
    expect(MODEL.mermaid).toBe(taxonomyMermaid());
    expect(MODEL.edges).toEqual(t.edges);
    expect(MODEL.verbs).toEqual(t.verbs);
  });

  it('coverage: every edge type and event verb carries a glossary sentence', () => {
    const t = taxonomy(); // throws on any missing sentence
    expect(t.edges.map((e) => e.type).sort()).toEqual(Object.keys(ENDPOINT_RULES).sort());
    expect(t.verbs.map((v) => v.verb).sort()).toEqual([...EventVerbSchema.options].sort());
  });
});

describe('framework F0 — philomatic-core (model v2 §4)', () => {
  it('both baked copies match the source framework file (drift → run pnpm diagram)', () => {
    const expected = `export const FRAMEWORKS = ${JSON.stringify(FRAMEWORKS, null, 2)} as const;`;
    for (const path of ['ui/src/generated/framework.ts', 'src/extension/framework.gen.ts']) {
      expect(readFileSync(join(ROOT, path), 'utf8')).toContain(expected);
    }
  });

  it('declares only real edge shapes, and metadata vocabularies only on overlay edges (D8)', () => {
    for (const tag of FRAMEWORKS.flatMap((f) => f.edgeTags)) {
      const pairs = ENDPOINT_RULES[tag.on.type as keyof typeof ENDPOINT_RULES];
      expect(pairs, `unknown edge type ${tag.on.type} in #${tag.name}`).toBeDefined();
      expect(
        pairs.some(([s, d]) => (tag.on.srcKind ?? s) === s && (tag.on.dstKind ?? d) === d),
        `#${tag.name} declares an endpoint pair ${tag.on.srcKind}→${tag.on.dstKind} the schema forbids`,
      ).toBe(true);
    }
    for (const field of FRAMEWORKS.flatMap((f) => f.metadataFields)) {
      const pairs = ENDPOINT_RULES[field.on.type as keyof typeof ENDPOINT_RULES];
      expect(pairs.every(([s]) => s === 'learner'), `metadata field ${field.name} must ride a learner-overlay edge (audit A2)`).toBe(true);
    }
  });

  it('selector helpers scope tags and vocabularies correctly', () => {
    const rel = edgeTagsFor(PHILOMATIC_CORE, 'ABOUT', 'source', 'concept').map((t) => t.name);
    expect(rel).toEqual(['Explains', 'Demonstrates', 'Exercises']);
    expect(edgeTagsFor(PHILOMATIC_CORE, 'ABOUT', 'question', 'concept')).toEqual([]);
    expect(metadataVocabulary(PHILOMATIC_CORE, 'ANNOTATES', 'sentiment').map((v) => v.token)).toEqual(['aha', 'pondering', 'confused']);
    // The first non-core framework: argument diagramming over passages — and its bundle
    // convention must be machine-readable, not prose (front-end portability, DATA_MODEL §5).
    const argTags = edgeTagsFor(ARGUMENT_DIAGRAMMING, 'LINK', 'snippet', 'snippet');
    expect(argTags.map((t) => t.name)).toEqual(['Supports', 'Opposes']);
    expect(argTags.every((t) => t.subtypeRole === 'bundle')).toBe(true);
  });
});
