import { useState } from 'react';
import { useAction, useEngine } from '../../engine-context';
import { inverseRelationWord, relationWord, splitRelationRows } from '../../lib/relations';
import { relationEdge } from '../../lib/concepts';
import { isHierarchyTag } from '../../lib/ranks';
import type { NodeKind, Relation } from '../../client/types';
import { kindIcon } from './shared';

/**
 * The connections list: every row reads in the edge's TRUE
 * direction — `[src] [relation chip] [dst]` — as plain English, no arrows. The page's own
 * entity renders as its FILLED icon (distinct from the outlined neighbours); the other end is
 * icon + name and navigates. Clicking a chip flips the row to its EQUIVALENT REVERSE reading
 * ("Ultraproducts topic-of ◇" ⇄ "◇ parent-topic-of Ultraproducts") using the framework-declared
 * `inverseLabel` — same semantics, other direction — the reversed chip taking the UI background.
 * Rows group under kind headers (tracks, concepts, sources, questions, snippets; only
 * non-empty groups render), ordered within a group by relation (prerequisites, then the
 * declared taxonomy, then the rest) with self-first (outgoing) rows before incoming. Each row
 * carries a hover-× that unlinks (undoable). This row shape is deliberately the one candidate
 * ACTIONS will render in for accept/reject.
 */
const KIND_ORDER: NodeKind[] = ['track', 'concept', 'source', 'question', 'snippet'];

/** The dotted, kind-tinted add box — collapsed to "+ add <kind>" until hovered. Exported so
 *  Journey's columns wear the exact same adder skin as the library rails. */
export function ConnectionAdd({ groupKind, selfKind, label, children }: { groupKind: NodeKind; selfKind: NodeKind; label?: string; children: React.ReactNode }) {
  return (
    <div className="connection-add" style={{ ['--add-color' as never]: `var(--k-${groupKind})` }}>
      <span className="connection-add-label">+ {label ?? `add ${groupKind}`}</span>
      <span className="connection-end self">
        <span style={{ color: `var(--k-${selfKind})` }}>{kindIcon(selfKind, true)}</span>
      </span>
      <div className="connection-add-body">{children}</div>
    </div>
  );
}
const KIND_LABEL: Record<string, string> = { track: 'Tracks', concept: 'Concepts', source: 'Sources', question: 'Questions', snippet: 'Snippets' };

/** The relation chip: just the word — the row reads as English, no arrow.
 *  White chip by default; a declared inverse makes it a toggle, and the reversed view takes the
 *  UI's background instead. Exported for the static row variants (snippet ties). */
export function RelationChip({
  word,
  reversed = false,
  onToggle,
}: {
  word: string;
  reversed?: boolean;
  onToggle?: () => void;
}) {
  const cls = reversed ? 'connection-chip reversed' : 'connection-chip';
  return onToggle ? (
    <button className={cls} title="flip to the equivalent reverse reading" onClick={onToggle}>
      {word}
    </button>
  ) : (
    <span className={cls}>{word}</span>
  );
}

function ConnectionRow({
  self,
  r,
  onNavigate,
  onRemove,
}: {
  self: { id: string; kind: NodeKind };
  r: Relation;
  onNavigate: (id: string) => void;
  onRemove: (r: Relation) => void;
}) {
  // Viewing state only — the edge itself never changes; the chip flips which END reads first
  // and swaps the word for its declared inverse.
  const [reversed, setReversed] = useState(false);
  const word = relationWord(r.type, r.tags);
  const inverse = inverseRelationWord(r.type, r.tags);
  const other = (
    <button className="connection-end" title={`open “${r.otherLabel}”`} onClick={() => onNavigate(r.otherId)}>
      <span style={{ color: `var(--k-${r.otherKind})` }}>{kindIcon(r.otherKind)}</span>
      <span className="connection-target">{r.otherLabel}</span>
    </button>
  );
  // The page's own entity renders FILLED — instantly distinct from the
  // outlined icons of everything it relates to.
  const selfEnd = (
    <span className="connection-end self">
      <span style={{ color: `var(--k-${self.kind})` }}>{kindIcon(self.kind, true)}</span>
    </span>
  );
  const srcFirst = r.direction === 'out' ? [selfEnd, other] : [other, selfEnd];
  const [left, right] = reversed ? [srcFirst[1], srcFirst[0]] : srcFirst;
  return (
    <div className="connection">
      {left}
      <RelationChip
        word={reversed && inverse !== undefined ? inverse : word}
        reversed={reversed}
        onToggle={inverse !== undefined ? () => setReversed((v) => !v) : undefined}
      />
      {right}
      <span style={{ flex: 1 }} />
      {r.type !== 'SNIPPET_OF' && (
        <button className="connection-x" title="remove this connection" onClick={() => onRemove(r)}>
          ×
        </button>
      )}
    </div>
  );
}

export function Connections({
  self,
  relations,
  onNavigate,
  overrideRemove,
  addByKind,
  addLabelByKind,
  bodyByKind,
}: {
  self: { id: string; kind: NodeKind };
  relations: Relation[];
  onNavigate: (id: string) => void;
  /** Handled-elsewhere removal (e.g. leaving a track routes through the reorder plan so
   *  ordering keeps no ghosts). Return true to claim the removal; false falls through. */
  overrideRemove?: (r: Relation) => boolean;
  /** Per-kind ADD affordance, rendered at the END of that kind's group (every connection type gets its section, and the section ends with the way to
   *  add one). A group with an adder renders even when empty — that's how the first connection
   *  of a kind gets made. */
  addByKind?: Partial<Record<NodeKind, React.ReactNode>>;
  /** A group's adder label, where "+ add <kind>" isn't the truth (the snippet rail's snippet
   *  group AUTHORS RELATIONS to existing passages, it doesn't mint one — owner). */
  addLabelByKind?: Partial<Record<NodeKind, string>>;
  /** Content rendered INSIDE a kind's group, above its adder — for a tie whose payload is worth
   *  more than a row. A source's passages are the case that asked for it:
   *  they used to sit in a section of their own above this list, under an untinted heading, so
   *  the one kind of connection you can actually READ was the one filed outside the connections.
   *  A group with a body renders even with no rows and no adder. */
  bodyByKind?: Partial<Record<NodeKind, React.ReactNode>>;
}) {
  const { client } = useEngine();
  const act = useAction();
  const hasAdders = addByKind !== undefined && Object.values(addByKind).some((v) => v != null);
  const hasBodies = bodyByKind !== undefined && Object.values(bodyByKind).some((v) => v != null);
  if (relations.length === 0 && !hasAdders && !hasBodies) return null;
  // In-group order: relation first (prerequisites, declared taxonomy, the rest), then rows
  // that START with this entity (outgoing) before incoming, then alphabetically. EXCEPTION
  //: PRECEDES lists "this reads after X" (incoming) before "this reads
  // before X" — what to read first is the more useful fact.
  const typeRank = (r: Relation) => (r.type === 'PREREQUISITE_OF' ? 0 : r.tags.some(isHierarchyTag) ? 1 : 2);
  const dirRank = (r: Relation) => (r.type === 'PRECEDES' ? (r.direction === 'in' ? 0 : 1) : r.direction === 'out' ? 0 : 1);
  // ONE ROW PER MEANING: a multi-tagged edge ("draws on, topic of")
  // splits into a row per tag, each with its own × — see splitRelationRows.
  const rows = splitRelationRows(relations);
  const ordered = [...rows].sort(
    (a, b) =>
      typeRank(a) - typeRank(b) ||
      dirRank(a) - dirRank(b) ||
      a.otherLabel.localeCompare(b.otherLabel) ||
      a.type.localeCompare(b.type),
  );
  const removeRow = (r: Relation & { allTags?: string[] }) => {
    if (overrideRemove?.(r) === true) return;
    const ctx = r.trackContextId !== undefined ? { trackContextId: r.trackContextId } : {};
    const all = r.allTags ?? r.tags;
    if (all.length > 1) {
      // Removing ONE meaning from a multi-tagged edge: unlink the edge, re-link with the
      // remaining tags (the interim set-replace); undo re-links the removed tag, which
      // union-merges back in.
      const removed = r.tags[0]!;
      const keep = relationEdge(self, { ...r, tags: all.filter((t) => t !== removed) });
      void act(async () => {
        await client.unlink({ srcId: keep.srcId, type: keep.type, dstId: keep.dstId, ...ctx });
        await client.link({ ...keep, ...ctx });
        return {
          label: `remove “${relationWord(r.type, r.tags)}” tie to ${r.otherLabel}`,
          invert: () => client.link({ ...relationEdge(self, r), ...ctx }),
        };
      }, `Removed “${relationWord(r.type, r.tags)}” — the other meanings on this tie stay`);
      return;
    }
    const edge = relationEdge(self, r);
    void act(async () => {
      await client.unlink({ srcId: edge.srcId, type: edge.type, dstId: edge.dstId, ...ctx });
      return { label: `unlink “${r.otherLabel}”`, invert: () => client.link({ ...edge, ...ctx }) };
    }, `Removed connection to “${r.otherLabel}”`);
  };
  return (
    <>
      <div className="detail-section">Connections</div>
      <div className="connections">
        {KIND_ORDER.map((k) => {
          const group = ordered.filter((r) => r.otherKind === k);
          const add = addByKind?.[k];
          const body = bodyByKind?.[k];
          if (group.length === 0 && add == null && body == null) return null; // no header, no text, when nothing exists
          return (
            <div key={k}>
              <div className="connection-group-label" style={{ color: `var(--k-${k})` }}>{KIND_LABEL[k]}</div>
              {group.map((r) => (
                <ConnectionRow
                  key={`${r.type}-${r.direction}-${r.otherId}-${r.tags.join()}`}
                  self={self}
                  r={r}
                  onNavigate={onNavigate}
                  onRemove={removeRow}
                />
              ))}
              {body}
              {/* The ADD affordance: one line shaped like the rows it
                  creates — [self filled icon] [relation dropdown-as-chip] [picker] — inside a
                  dotted box tinted the group's kind color. */}
              {add != null && (
                <ConnectionAdd groupKind={k} selfKind={self.kind} label={addLabelByKind?.[k]}>
                  {add}
                </ConnectionAdd>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
