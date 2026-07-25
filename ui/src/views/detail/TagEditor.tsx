/**
 * The detail rail's tag editor: the shared TagField bound to a LIVE entity — every change
 * persists immediately and pushes its inverse (maintainability phase 3). The widget itself
 * lives in components/TagField, which the create form binds to local state instead.
 */
import { TagField } from '../../components/TagField';
import { useAction, useEngine } from '../../engine-context';

export function TagEditor({ id, tags }: { id: string; tags: string[] }) {
  const { client } = useEngine();
  const act = useAction();
  const patchTags = (next: string[]) => {
    const before = tags.slice();
    void act(async () => {
      await client.update(id, { tags: next });
      return { label: 'edit tags', invert: () => client.update(id, { tags: before }) };
    }, '');
  };
  return <TagField tags={tags} onChange={patchTags} />;
}
