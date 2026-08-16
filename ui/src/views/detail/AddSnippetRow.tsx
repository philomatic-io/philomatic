import { useAction, useEngine } from '../../engine-context';
import { captureSnippetOnSource } from '../../lib/ties';
import { PickerBox } from './PickerBox';

/** The Snippets-group adder on a source page (a source connects
 *  to snippets, so its rail must be able to author one). Pure creation — a snippet belongs to
 *  exactly this source — via the shared capture gesture Journey's snippet column also writes.
 *  The snippet content itself renders in the source body's snippet list, so the group here is
 *  adder-only. */
export function AddSnippetRow({ sourceId }: { sourceId: string }) {
  const { client } = useEngine();
  const act = useAction();
  return (
    <div className="anchor-picker">
      <PickerBox
        options={[]}
        placeholder="add a snippet…"
        variant="snippet"
        onPick={() => undefined}
        onCreate={(text) => text.trim() && void act(() => captureSnippetOnSource(client, sourceId, text), 'Added snippet ✓')}
      />
    </div>
  );
}
