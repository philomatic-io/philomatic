/**
 * Tag-string lexer (DATA_MODEL.md §5).
 *
 * Grammar:
 *   #name
 *   #name:subtype            subtype is non-numeric   -> #closed:paywall
 *   #name:degree             degree is an integer     -> #difficulty:3
 *   #name:subtype:degree
 */
import type { TypedTag } from './entities';

const TAG_RE = /^#([a-z0-9][a-z0-9-]*)(?::([^:]+))?(?::(\d+))?$/i;

export function lexTag(raw: string): TypedTag {
  const m = TAG_RE.exec(raw.trim());
  if (!m) throw new Error(`Malformed tag: "${raw}"`);
  const name = m[1]!;
  const second = m[2];
  const third = m[3];

  // A lone numeric qualifier is a degree; otherwise it is a subtype.
  if (second !== undefined && third === undefined && /^\d+$/.test(second)) {
    return { name, degree: Number(second) };
  }
  const tag: TypedTag = { name };
  if (second !== undefined) tag.subtype = second;
  if (third !== undefined) tag.degree = Number(third);
  return tag;
}
