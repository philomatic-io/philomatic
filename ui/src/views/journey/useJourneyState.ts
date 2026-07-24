/**
 * Journey's own UI state — selection, edit mode, drag/drop targeting, inline rename, the
 * path lens, and concept expansion (maintainability phase 2b). Pure view state: nothing
 * here touches the engine. Destructured at the call site so the view body reads the same
 * as when these lived inline.
 */
import { useState } from 'react';
import type { Focus } from './shared';

export function useJourneyState() {
  const [sylId, setSylId] = useState<string | undefined>();
  const [srcId, setSrcId] = useState<string | undefined>();
  const [focus, setFocus] = useState<Focus | undefined>();
  const [edit, setEdit] = useState(false);
  // A source drag is in flight (row or palette) — shows the drop hint + empty-track target.
  const [draggingSrc, setDraggingSrc] = useState(false);
  // Zone-based drop targeting: the WHOLE row is the surface — top third places before it,
  // bottom third after it, the middle makes a co-requisite. An insertion line / outline on the
  // row itself shows the zone (feedback: the 8px gaps were needle-threading, and the palette
  // drag painted the whole column instead of a target).
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: 'above' | 'below' | 'coreq' } | undefined>();
  // Pencil rename in edit mode (tracks + sources). A track rename mints a NEW id (the title
  // slugs it — rename-by-supersession in the engine), so the selection follows targetId.
  const [renaming, setRenaming] = useState<{ kind: 'track' | 'source'; id: string } | undefined>();
  // Read state writes the real verbs (owner request, 2026-07-19 — the un-verb exists now);
  // follows remain a visual override until un-track ships.
  const [followedOverride, setFollowedOverride] = useState<Record<string, boolean>>({});
  // Concept lens for the path column: the track's whole family, flat, prerequisite-ordered.
  const [pathView, setPathView] = useState<'sources' | 'concepts'>('sources');
  // Concept structure editing (feature/journey-concept-rails, 2026-07-20): the concept column
  // is a flat guarded-DFS ordering; drag a concept ONTO the track to include it, or (with a
  // relation selected) onto another concept to author that tie.
  const [draggingConcept, setDraggingConcept] = useState<string | undefined>();
  const [conceptRel, setConceptRel] = useState<'requires' | 'prereq-of'>('prereq-of');
  // Clicking a concept shows its questions (owner request, 2026-07-20) — a concept selection
  // that supersedes the source selection in the Questions column.
  const [selectedConcept, setSelectedConcept] = useState<{ id: string; name: string } | undefined>();
  // Clicking a concept ALSO expands its direct sources inline (owner request, 2026-07-20) —
  // the drill-down to source-tied questions.
  const [expandedConcepts, setExpandedConcepts] = useState<ReadonlySet<string>>(new Set());
  const toggleConceptExpand = (cid: string) => setExpandedConcepts((prev) => {
    const n = new Set(prev);
    n.has(cid) ? n.delete(cid) : n.add(cid);
    return n;
  });

  return {
    sylId, setSylId,
    srcId, setSrcId,
    focus, setFocus,
    edit, setEdit,
    draggingSrc, setDraggingSrc,
    dropTarget, setDropTarget,
    renaming, setRenaming,
    followedOverride, setFollowedOverride,
    pathView, setPathView,
    draggingConcept, setDraggingConcept,
    conceptRel, setConceptRel,
    selectedConcept, setSelectedConcept,
    expandedConcepts, toggleConceptExpand,
  };
}
