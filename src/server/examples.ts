/**
 * The bundled example tracks — ONE reader, two servers.
 *
 * One reader shared by the ingest server and the registry: a browser-mode workbench has no
 * filesystem to read examples from and no server of its own to ask — the page's own origin is the
 * only place a browser tab is unconditionally allowed to fetch, so whichever server serves the
 * page serves the examples. Two copies of "what an example is" would drift, and the drift would
 * show up as one origin offering a track another does not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = fileURLToPath(new URL('../../examples', import.meta.url));

/** The allowlist IS the guard — no path built from user input ever reaches the filesystem. */
export const EXAMPLE_NAMES = ['deep-learning', 'logic-going-further', 'propositional-logic', 'hermeneutics', 'arithmetic'];

export interface ExampleMeta {
  name: string;
  title: string;
  goal?: string;
  sources: number;
  concepts: number;
}

/** Read one bundled example; `undefined` for an unknown name. */
export function readExample(name: string): { meta: ExampleMeta; payload: Record<string, unknown> } | undefined {
  if (!EXAMPLE_NAMES.includes(name)) return undefined;
  try {
    const payload = JSON.parse(readFileSync(join(EXAMPLES_DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
    // `syllabi` is the legacy key some examples still use; migrate handles it on import.
    const tracks = (payload.tracks ?? payload.syllabi ?? []) as { title?: string; goal?: string }[];
    const first = tracks[0];
    return {
      meta: {
        name,
        title: first?.title ?? name.replace(/-/g, ' '),
        ...(first?.goal !== undefined ? { goal: first.goal } : {}),
        sources: (payload.sources as unknown[] | undefined)?.length ?? 0,
        concepts: (payload.concepts as unknown[] | undefined)?.length ?? 0,
      },
      payload,
    };
  } catch {
    return undefined;
  }
}

/** Every example that reads cleanly, as the `/examples` listing. */
export const exampleList = (): ExampleMeta[] =>
  EXAMPLE_NAMES.map((n) => readExample(n)?.meta).filter((m): m is ExampleMeta => m !== undefined);
