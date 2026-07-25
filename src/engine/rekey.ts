/**
 * Learner re-key (self-serve plan T4; scaling audit A3) — the pure map that moves a learner's
 * whole overlay to a new id: `lnr_default` graphs migrate to real learner ids before any
 * multi-tenant merge, so two people's behavior is never conflated. Pure payload→payload; the
 * caller decides where the result lands (a fresh DB, a file). It CANNOT be applied in-place to
 * a live store — upsert is append-only, so old-id rows would survive beside the new ones.
 *
 * Everything that references a learner moves: the learner row itself, `track.creatorId`,
 * every overlay edge (srcType 'learner'), and every event's `learnerId`. Nothing else in the
 * payload mentions learners — content ids never include them (the A3 keep-it-pure rule).
 */
import type { CanonicalPayload } from '../schema/entities';
import { CaptureError } from './capture';

export function rekeyLearner(payload: CanonicalPayload, oldId: string, newId: string): CanonicalPayload {
  if (!oldId.trim() || !newId.trim()) throw new CaptureError('rekey needs a non-empty old and new learner id');
  if (oldId === newId) return payload;
  if (!payload.learners.some((l) => l.id === oldId)) {
    throw new CaptureError(`no learner ${oldId} in this payload`);
  }
  if (payload.learners.some((l) => l.id === newId)) {
    // Merging two existing learners would conflate their behavior — never silently (invariant §4.4).
    throw new CaptureError(`learner ${newId} already exists — rekey never merges learners`);
  }

  const mapId = (id: string): string => (id === oldId ? newId : id);
  return {
    ...payload,
    learners: payload.learners.map((l) => (l.id === oldId ? { ...l, id: newId } : l)),
    tracks: payload.tracks.map((s) => ({ ...s, creatorId: mapId(s.creatorId) })),
    edges: payload.edges.map((e) => (e.srcType === 'learner' ? { ...e, srcId: mapId(e.srcId) } : e)),
    events: payload.events.map((ev) => ({ ...ev, learnerId: mapId(ev.learnerId) })),
  };
}
