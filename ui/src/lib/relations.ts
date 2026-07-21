/**
 * The human word for an edge (model v2): framework tags carry the meaning of the generic
 * LINK/ABOUT edges (#Explains → "explains", #AnalogousTo → "analogous to"); a bare LINK is
 * honest about being unclassified; razor-kept types read as their name.
 */
const spacedTag = (t: string): string =>
  t
    .replace(/^#/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

export function relationWord(type: string, tags: readonly string[] = []): string {
  if (tags.length > 0) return tags.map(spacedTag).join(', ');
  if (type === 'LINK') return 'related to';
  return type.toLowerCase().replace(/_syl$/, '').replace(/_/g, ' ');
}
