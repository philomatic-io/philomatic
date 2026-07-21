/**
 * The in-browser EngineClient (demo mode, owner request 2026-07-19) — the same interface the
 * HTTP transport implements, mapped straight onto a `PhilomaticEngine.openBrowser` instance
 * running in this tab. Every interaction is REAL engine behavior; the blast radius is one
 * browser. Writes persist through the injected `persist` callback (localStorage in the demo)
 * and fire the change listeners the workbench's live-update path subscribes to.
 *
 * Publishing and registry pushes are deliberately disabled: the demo's whole promise is
 * "nothing you do here leaves this tab."
 */
import { READ_VERSION } from './types';
import type { EngineClient } from './transport';
import type {
  AssembleResult,
  EditResult,
  GraphEnvelope,
  QuestionsEnvelope,
  RelationsEnvelope,
  RemovedEnvelope,
  Snapshot,
  TimelineEnvelope,
} from './types';

/** The engine facade surface the local client needs (structural — avoids importing node types). */
export interface LocalEngine {
  snapshot(): unknown;
  assemble(trackRef?: string): unknown;
  ask(ref: string): void;
  answer(ref: string): void;
  consume(ref: string): void;
  unconsume(ref: string): { changed: boolean };
  track(ref: string): void;
  captureSource(input: unknown): unknown;
  captureSnippet(input: unknown): unknown;
  remove(input: { ref: string }): unknown;
  restore(input: { ref: string }): unknown;
  update(input: { ref: string; patch: Record<string, unknown> }): unknown;
  link(edge: unknown): { created: boolean };
  unlink(edge: unknown): { changed: boolean };
  removed(): unknown;
  timeline(): unknown;
  questions(): unknown;
  relations(id: string): unknown;
  graph(): unknown;
  exportAll(): unknown;
  exportLive(): unknown;
  importPayload(payload: unknown): unknown;
}

const DEMO_BLOCKED = 'Publishing is disabled in the demo — everything here stays in your browser. Run your own Philomatic to publish.';

export function localClient(engine: LocalEngine, persist: () => void): EngineClient & { subscribe: (cb: () => void) => () => void } {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    persist();
    for (const cb of listeners) cb();
  };
  /** Wrap a write: run it, persist, notify — synchronous engine, async interface. */
  const write = async <T>(fn: () => T): Promise<T> => {
    const out = fn();
    changed();
    return out;
  };

  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: async () => engine.snapshot() as Snapshot,
    getAssemble: async (track) => engine.assemble(track) as AssembleResult,
    ask: (q) => write(() => engine.ask(q)),
    markAnswered: (q) => write(() => engine.answer(q)),
    consume: (ref) => write(() => engine.consume(ref)),
    unconsume: (ref) => write(() => void engine.unconsume(ref)),
    track: (ref) => write(() => engine.track(ref)),
    captureSource: (input) => write(() => engine.captureSource(input)),
    captureSnippet: (input) => write(() => engine.captureSnippet(input)),
    remove: (ref) => write(() => engine.remove({ ref }) as EditResult),
    restore: (ref) => write(() => engine.restore({ ref }) as EditResult),
    update: (ref, patch) => write(() => engine.update({ ref, patch }) as EditResult),
    publish: async () => {
      throw new Error(DEMO_BLOCKED);
    },
    unpublish: async () => {
      throw new Error(DEMO_BLOCKED);
    },
    pushToRegistry: async () => {
      throw new Error(DEMO_BLOCKED);
    },
    link: (edge) => write(() => engine.link(edge)),
    unlink: (edge) => write(() => engine.unlink(edge)),
    getRemoved: async () => ({ version: READ_VERSION, removed: engine.removed() }) as RemovedEnvelope,
    getTimeline: async () => ({ version: READ_VERSION, timeline: engine.timeline() }) as TimelineEnvelope,
    getQuestions: async () => ({ version: READ_VERSION, questions: engine.questions() }) as QuestionsEnvelope,
    getRelations: async (id) => ({ version: READ_VERSION, relations: engine.relations(id) }) as RelationsEnvelope,
    getGraph: async () => ({ version: READ_VERSION, ...(engine.graph() as object) }) as GraphEnvelope,
    exportAll: async () => engine.exportAll(),
    exportLive: async () => engine.exportLive(),
    importPayload: (payload) => write(() => void engine.importPayload(payload)),
  };
}
