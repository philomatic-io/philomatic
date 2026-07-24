/**
 * The engine seam for the workbench (maintainability plan, phase 1 — 2026-07-22).
 *
 * TWO jobs, both aimed at bug CLASSES rather than tidiness:
 *
 *  1. `useEngine()` — the client/refresh/notify/pushUndo/epoch quintet, provided once by App
 *     instead of drilled through ~20 component signatures.
 *
 *  2. `useAction()` — THE write path. Every UI mutation runs through `act()`, which does the
 *     write, registers its INVERSE on the undo stack, refreshes, and reports — one place, one
 *     shape. The inverse is required BY TYPE: the default overload only accepts a function
 *     returning an `Inverse`, so "I forgot to make this undoable" is a compile error rather
 *     than a bug report. Genuinely one-way acts (publish, push to a registry) must say so
 *     explicitly with `{ irreversible: true }`, which is greppable and reviewable.
 *
 * Why typed and not conventional: every undo gap found on 2026-07-21/22 (nothing in Journey
 * undid; Detail's rename/tags/author/goal didn't either) existed because "remember to push an
 * inverse" was a convention across 25 hand-rolled try/catch blocks. Conventions don't hold.
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { EngineClient } from './client/transport';

/** How to take a write back: the label the toast shows, and the opposite operation. */
export interface Inverse {
  label: string;
  invert: () => Promise<unknown>;
}

export interface Engine {
  client: EngineClient;
  /** Re-read the world (snapshot + questions + projection) and bump the epoch. */
  refresh: () => Promise<void>;
  notify: (message: string, undoRef?: string) => void;
  pushUndo: (label: string, invert: () => Promise<unknown>) => void;
  /** Bumped on every successful refresh — for views that fetch their own projections. */
  epoch: number;
}

const EngineCtx = createContext<Engine | undefined>(undefined);

export function EngineProvider({ value, children }: { value: Engine; children: ReactNode }) {
  return <EngineCtx.Provider value={value}>{children}</EngineCtx.Provider>;
}

export function useEngine(): Engine {
  const engine = useContext(EngineCtx);
  if (engine === undefined) throw new Error('useEngine() used outside <EngineProvider>');
  return engine;
}

/**
 * `act(write, okMessage)` — run a mutation as ONE unit: write → push its inverse → refresh →
 * toast. Returns whether it succeeded (failures toast the engine's message and leave the undo
 * stack untouched). The write returns its own `Inverse` because only the write knows what it
 * did — ids minted, edges touched, prior values.
 *
 *   await act(async () => {
 *     await client.link(edge);
 *     return { label: 'tie concepts', invert: () => client.unlink(edge) };
 *   }, 'Tied ✓');
 *
 * One-way acts opt out loudly:
 *   await act(() => client.publish(id, license), 'Published ✓', { irreversible: true });
 */
export interface Act {
  (write: () => Promise<Inverse>, ok: string): Promise<boolean>;
  (write: () => Promise<unknown>, ok: string, opts: { irreversible: true }): Promise<boolean>;
}

export function useAction(): Act {
  const { refresh, notify, pushUndo } = useEngine();
  return useCallback<Act>(
    async (write: () => Promise<unknown>, ok: string, opts?: { irreversible: true }) => {
      try {
        const result = await write();
        if (opts?.irreversible !== true) {
          const inverse = result as Inverse;
          pushUndo(inverse.label, inverse.invert);
        }
        await refresh();
        if (ok) notify(ok);
        return true;
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [refresh, notify, pushUndo],
  );
}
