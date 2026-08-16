/** Small shared helpers for the detail rail's modules. */
import { Icon, sourceIcon } from '../../components/Icon';
import type { NodeKind } from '../../client/types';

export const parseTags = (raw: string): string[] =>
  raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));

// A source's track membership + reading order is shown as a track block (feedback round 3),
// so these edge types are folded out of the generic Connections list for sources.
export const PATH_EDGES = new Set(['INCLUDES', 'PRECEDES', 'SEMINAL']);

export const kindIcon = (kind: NodeKind, filled = false) => <Icon name={kind === 'source' ? sourceIcon('text') : kind} filled={filled} />;

/** Per-rail edit mode — provided by Detail/ConceptDetail/DraftForm so
 *  field editors can open on a direct click (with a hover cue) when editing is on. */
import { createContext, useContext } from 'react';
export const EditModeCtx = createContext(false);
export const useEditMode = (): boolean => useContext(EditModeCtx);

/** The pending-validation banner: shown on any STAGED entity's rail, with
 *  the same two verdicts the inbox offers — the detail is where the learner inspects before
 *  judging, so the judgment belongs here too. */
import { useAction, useEngine } from '../../engine-context';
export function StagedBanner({ id, title }: { id: string; title: string }) {
  const { client } = useEngine();
  const act = useAction();
  return (
    <div className="staged-banner">
      <span className="staged-badge">staged</span>
      <span className="staged-note">pending your validation</span>
      <span style={{ flex: 1 }} />
      <button
        className="inbox-accept"
        title="Accept — keep as an ordinary item"
        onClick={() =>
          void act(async () => {
            await client.accept(id);
            return { label: `accept "${title.slice(0, 40)}"`, invert: () => client.stage(id) };
          }, 'Accepted ✓')
        }
      >
        ✓ accept
      </button>
      <button
        className="inbox-reject"
        title="Reject — retract (restorable from Removed)"
        onClick={() =>
          void act(async () => {
            await client.reject(id);
            return {
              label: `reject "${title.slice(0, 40)}"`,
              invert: async () => {
                await client.restore(id);
                await client.stage(id);
              },
            };
          }, 'Rejected — restorable from Removed')
        }
      >
        ✕ reject
      </button>
    </div>
  );
}

