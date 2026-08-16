/**
 * Same-kind LINK authoring: enabling a framework whose relations
 * live on passages or works — argument-diagramming's supports/opposes, hermeneutics'
 * interprets — changed nothing visible, because no workbench surface authored snippet↔snippet
 * or source↔source links at all. This is that surface: the concept tie-editor's exact pattern
 * (flavor dropdown with converses, the multiselect palette, one undoable batch), fed by the
 * ACTIVE frameworks — it appears the moment a framework declaring such relations turns on,
 * and isn't there otherwise.
 */
import { useContext, useState } from 'react';
import { useAction, useEngine } from '../../engine-context';
import { activeFrameworks } from '../../lib/framework-registry';
import { inverseRelationWord, relationWord } from '../../lib/relations';
import { PickerBox } from './PickerBox';
import { EditModeCtx } from './shared';
import type { IconName } from '../../components/Icon';

/** Does any ACTIVE framework declare same-kind LINK relations for this kind? The caller uses
 *  this to decide whether the group/slot exists at all — an adder that expands to an empty
 *  dropdown is a broken promise. */
export function hasSameKindLinkTags(kind: 'snippet' | 'source'): boolean {
  return activeFrameworks().some((f) => f.edgeTags.some((t) => t.on.type === 'LINK' && t.on.srcKind === kind && t.on.dstKind === kind));
}

export function LinkAdder({
  kind,
  id,
  peers,
  slot = false,
}: {
  kind: 'snippet' | 'source';
  id: string;
  /** The other entities of this kind (self excluded by the caller). */
  peers: { id: string; label: string; icon?: IconName }[];
  /** true → render just the inner form, for a Connections addByKind slot (the ConnectionAdd
   *  wrapper and the edit-mode gating are the group's own — owner). */
  slot?: boolean;
}) {
  const editing = useContext(EditModeCtx);
  const { client } = useEngine();
  const act = useAction();

  const seen = new Set<string>();
  const declared = activeFrameworks()
    .flatMap((f) => f.edgeTags)
    .filter((t) => t.on.type === 'LINK' && t.on.srcKind === kind && t.on.dstKind === kind)
    .filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  const flavors = declared.flatMap((t) => {
    const forward = { value: `tag:${t.name}`, label: relationWord('LINK', [`#${t.name}`]), converse: false };
    const inv = inverseRelationWord('LINK', [`#${t.name}`]);
    return inv !== undefined && inv !== forward.label
      ? [forward, { value: `rtag:${t.name}`, label: inv, converse: true }]
      : [forward];
  });
  const [flavor, setFlavor] = useState<string | undefined>();
  const chosen = flavor ?? flavors[0]?.value;

  if ((!slot && !editing) || flavors.length === 0 || peers.length === 0) return null;

  const addLinks = async (ids: string[]) => {
    const tagName = chosen!.replace(/^r?tag:/, '');
    const reversed = chosen!.startsWith('rtag:');
    const label = flavors.find((f) => f.value === chosen)?.label ?? 'link';
    await act(async () => {
      const made: { srcId: string; dstId: string }[] = [];
      for (const other of ids) {
        const edge = reversed
          ? { srcType: kind, srcId: other, type: 'LINK', dstType: kind, dstId: id, tags: [{ name: tagName }] }
          : { srcType: kind, srcId: id, type: 'LINK', dstType: kind, dstId: other, tags: [{ name: tagName }] };
        await client.link(edge);
        made.push({ srcId: edge.srcId, dstId: edge.dstId });
      }
      return {
        label: `${label} ${made.length === 1 ? `a ${kind}` : `${made.length} ${kind}s`}`,
        invert: async () => {
          for (const m of made) await client.unlink({ srcId: m.srcId, type: 'LINK', dstId: m.dstId });
        },
      };
    }, `${label} ✓`);
  };

  const form = (
    <div className="anchor-picker">
      <select className="anchor-flavor" value={chosen} onChange={(e) => setFlavor(e.target.value)} title={`how this ${kind} relates`}>
        {flavors.map((f) => (
          <option key={f.value} value={f.value} className={f.converse ? 'converse-opt' : undefined}>
            {f.label}
          </option>
        ))}
      </select>
      <PickerBox
        options={peers.map((p) => ({ id: p.id, label: p.label, icon: p.icon ?? (kind === 'snippet' ? 'snippet' : 'source:text') }))}
        placeholder={kind === 'snippet' ? 'add a snippet…' : 'link a source…'}
        variant={kind}
        onPick={(ids) => void addLinks(ids)}
      />
    </div>
  );
  if (slot) return form;
  return (
    // Standalone (the source rail today): the Connections group shape — every adder sits under
    // a group label (the connections smoke test pins that invariant).
    <div className="connection-group">
      <div className="connection-group-label">Related sources</div>
      <div className="connection-add">{form}</div>
    </div>
  );
}
