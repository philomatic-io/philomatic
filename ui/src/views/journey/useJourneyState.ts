/**
 * Journey's own UI state — selection, edit mode, inline rename, and concept selection. Pure
 * view state: nothing here touches the engine. Destructured at the call site so the view body
 * reads the same as when these lived inline.
 *
 * The lens toggle + drag-targeting state retired when the reading column became the
 * one unified TrackSection (membership is edited with the picker, like the Library track page).
 */
import { useState } from 'react';
import type { Focus } from './shared';

export function useJourneyState() {
  const [sylId, setSylId] = useState<string | undefined>();
  const [srcId, setSrcId] = useState<string | undefined>();
  const [focus, setFocus] = useState<Focus | undefined>();
  const [edit, setEdit] = useState(false);
  // Pencil rename in edit mode (tracks + sources). A track rename mints a NEW id (the title
  // slugs it — rename-by-supersession in the engine), so the selection follows targetId.
  const [renaming, setRenaming] = useState<{ kind: 'track' | 'source'; id: string } | undefined>();
  // Read state writes the real verbs (the un-verb exists now);
  // follows remain a visual override until un-track ships.
  // Clicking a concept heading shows its questions — a concept
  // selection that supersedes the source selection in the Questions column.
  const [selectedConcept, setSelectedConcept] = useState<{ id: string; name: string } | undefined>();

  return {
    sylId, setSylId,
    srcId, setSrcId,
    focus, setFocus,
    edit, setEdit,
    renaming, setRenaming,
    selectedConcept, setSelectedConcept,
  };
}
