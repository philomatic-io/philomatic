import { sourceIcon } from '../../components/Icon';
import type { Snapshot } from '../../client/types';
import { PickerBox } from './PickerBox';

/** Add sources to a track (Journey's drag stays experimental —
 *  membership is managed HERE). A purple picker that opens into the source palette; multiselect
 * — check several, add them all at once. They join unordered, at the
 *  bottom. */
export function AddMemberRow({
  track,
  snapshot,
  onAdd,
  onCreate,
}: {
  track: { id: string; title: string; sourceIds: string[] };
  snapshot: Snapshot;
  onAdd: (sourceIds: string[]) => void;
  /** Create a new source and add it. `text` is the source name; `url` is the optional url from the
   *  create row's field — given → a link (url = identity), blank → an offline source titled `text`,
   *  a physical book (url-less sources are first-class, questions tie to
   *  them directly). Explicit either way — no guessing which the typed text is. */
  onCreate?: (text: string, url?: string) => void;
}) {
  const options = snapshot.sources
    .filter((s) => !track.sourceIds.includes(s.id))
    .map((s) => ({ id: s.id, label: s.title, icon: sourceIcon(s.modality) }));
  return <PickerBox options={options} placeholder="add a source…" variant="source" onPick={onAdd} onCreate={onCreate} createUrlField />;
}

/** The mirror of AddMemberRow, on a SOURCE's page: put THIS source
 *  on one or more tracks, picked from the palette. Same write either way — INCLUDES, membership
 *  only — so which page you happen to be on stops mattering. */
export function AddToTrackRow({
  source,
  snapshot,
  onAdd,
  onCreate,
}: {
  source: { id: string };
  snapshot: Snapshot;
  onAdd: (trackIds: string[]) => void;
  /** "＋ create" a NEW track by the typed title and add this source to it. */
  onCreate?: (title: string) => void;
}) {
  const options = snapshot.tracks
    .filter((t) => !t.sourceIds.includes(source.id))
    .map((t) => ({ id: t.id, label: t.title, icon: 'track' as const }));
  return <PickerBox options={options} placeholder="add this source to a track…" variant="track" onPick={onAdd} onCreate={onCreate} />;
}
