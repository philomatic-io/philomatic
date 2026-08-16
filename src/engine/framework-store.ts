/**
 * The per-library FRAMEWORK STORE — where a library's own vocabulary
 * lives: `mine` (the personal working framework the editor edits) and `installed` (frameworks
 * that arrived from elsewhere — a fork's dependencies, a downloaded file). Built-ins are NOT
 * stored — they ship with the build; the store holds only what this library added.
 *
 * A sidecar beside the database file (`<db>.frameworks.json`) — facade-tier file state,
 * like the fork archives and the author key: a
 * vocabulary document is not knowledge, so it stays out of the graph, and file-per-library
 * gives hosted tenants isolation for free. `:memory:` engines (tests) keep theirs in-process.
 * Validation is the SAME zod schema the built-ins load through — a malformed framework is
 * refused at the door, never stored.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { FrameworkFileSchema, type FrameworkFile } from '../framework';

/** Local VIEW OVERRIDES: how THIS library looks at other people's declarations —
 *  re-mark or hide a tag, hide an edge type. Deliberately part of the store document and
 *  never of any framework FILE, so a reading preference cannot travel with an export,
 *  a registration, or a bundle by construction. */
export const ViewOverridesSchema = z.object({
  /** tag name → the mark this library draws it with ('hidden' included). */
  tags: z.record(z.enum(['line', 'group', 'comet', 'hidden'])).default({}),
  /** edge TYPE → hidden. Types are hideable but never re-markable — their marks carry
   *  system meaning (ordering, containment). */
  types: z.record(z.literal('hidden')).default({}),
});
export type ViewOverrides = z.infer<typeof ViewOverridesSchema>;

export interface FrameworkStoreDoc {
  mine?: FrameworkFile;
  installed: FrameworkFile[];
  viewOverrides?: ViewOverrides;
  /** Which OPTIONAL built-ins this library turned on: only
   *  philomatic-core is ambient by default; the experimental built-ins are opt-in. Absent = none. */
  enabledBuiltins?: string[];
  /** Installed frameworks the library switched OFF — installs default ON
   *  (a fork's vocabulary should just work), so the toggle records the exceptions. */
  disabledInstalled?: string[];
}

const DocSchema = z.object({
  mine: FrameworkFileSchema.optional(),
  installed: z.array(FrameworkFileSchema).default([]),
  viewOverrides: ViewOverridesSchema.optional(),
  enabledBuiltins: z.array(z.string()).optional(),
  disabledInstalled: z.array(z.string()).optional(),
});

const MEM = new Map<string, FrameworkStoreDoc>();
const sidecar = (dbPath: string): string => `${dbPath}.frameworks.json`;
const inMemory = (dbPath: string): boolean => dbPath === ':memory:' || dbPath.startsWith('file::memory:');

export function loadFrameworkDoc(dbPath: string): FrameworkStoreDoc {
  if (inMemory(dbPath)) return MEM.get(dbPath) ?? { installed: [] };
  const path = sidecar(dbPath);
  if (!existsSync(path)) return { installed: [] };
  return DocSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveFrameworkDoc(dbPath: string, doc: FrameworkStoreDoc): void {
  const parsed = DocSchema.parse(doc);
  if (inMemory(dbPath)) {
    MEM.set(dbPath, parsed);
    return;
  }
  writeFileSync(sidecar(dbPath), JSON.stringify(parsed, null, 2));
}

/** Validate an incoming framework definition; throws zod's error for the 400 path. */
export function parseFrameworkFile(input: unknown): FrameworkFile {
  return FrameworkFileSchema.parse(input);
}
