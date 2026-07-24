/** Small shared helpers for the detail rail's modules. */
import { Icon, sourceIcon } from '../../components/Icon';
import type { NodeKind } from '../../client/types';

export const parseTags = (raw: string): string[] =>
  raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));

// A source's track membership + reading order is shown as a track block (feedback round 3),
// so these edge types are folded out of the generic Connections list for sources.
export const PATH_EDGES = new Set(['INCLUDES', 'PRECEDES', 'SEMINAL']);

export const kindIcon = (kind: NodeKind) => <Icon name={kind === 'source' ? sourceIcon('text') : kind} />;
