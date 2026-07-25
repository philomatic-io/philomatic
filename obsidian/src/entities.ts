/**
 * The live entity index (plan OB-S3) — one `/graph` fetch covers every embeddable kind
 * (id → kind + label), kept fresh by the server's SSE change feed (the T3 doorbell: events
 * carry no data; we refetch). Chips subscribe via `onChange` and re-label in place.
 * Unreachable server ⇒ the index stays empty and chips render their pending state; the
 * EventSource's built-in retry doubles as our recovery loop (`onopen` → refresh).
 */
import { api } from './api';
import type { PhilomaticSettings } from './settings';

export type EntityKind = 'track' | 'concept' | 'source' | 'snippet' | 'question';
export interface EntityInfo {
  kind: EntityKind;
  label: string;
}

export class EntityIndex {
  private byId = new Map<string, EntityInfo>();
  /** snippet id → owning source id (from the graph's synthesized SNIPPET_OF containment). */
  private snippetSource = new Map<string, string>();
  /** question id → overlay state (for the question card's state line). */
  private questionState = new Map<string, { asked: boolean; answered: boolean; gap: boolean }>();
  private es?: EventSource;
  private debounce?: number;
  private readonly listeners = new Set<() => void>();
  /** false until the first successful fetch — distinguishes "loading" from "not in library". */
  loaded = false;

  constructor(private readonly settings: PhilomaticSettings) {}

  /** (Re)connect to the current server — call on load and after settings change. */
  start(): void {
    this.stop();
    void this.refresh();
    const base = this.settings.serverUrl.trim().replace(/\/+$/, '');
    this.es = new EventSource(`${base}/changes`);
    this.es.onopen = () => void this.refresh(); // also fires on auto-reconnect: recovery for free
    this.es.onmessage = () => {
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => void this.refresh(), 300);
    };
  }

  stop(): void {
    this.es?.close();
    this.es = undefined;
    window.clearTimeout(this.debounce);
  }

  get(id: string): EntityInfo | undefined {
    return this.byId.get(id);
  }

  /** The source a snippet belongs to (for the quote card's attribution line). */
  sourceOf(snippetId: string): (EntityInfo & { id: string }) | undefined {
    const sourceId = this.snippetSource.get(snippetId);
    if (sourceId === undefined) return undefined;
    const info = this.byId.get(sourceId);
    return info ? { id: sourceId, ...info } : undefined;
  }

  /** A question's overlay state (for the question card's state line). */
  stateOf(questionId: string): { asked: boolean; answered: boolean; gap: boolean } | undefined {
    return this.questionState.get(questionId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async refresh(): Promise<void> {
    try {
      const [g, q] = await Promise.all([
        api<{
          nodes: { id: string; kind: EntityKind; label: string }[];
          edges: { srcId: string; dstId: string; type: string }[];
        }>(this.settings, '/graph'),
        api<{ questions: { id: string; asked: boolean; answered: boolean; gap: boolean }[] }>(this.settings, '/questions'),
      ]);
      this.byId = new Map(g.nodes.map((n) => [n.id, { kind: n.kind, label: n.label }]));
      this.snippetSource = new Map(g.edges.filter((e) => e.type === 'SNIPPET_OF').map((e) => [e.srcId, e.dstId]));
      this.questionState = new Map(q.questions.map((x) => [x.id, { asked: x.asked, answered: x.answered, gap: x.gap }]));
      this.loaded = true;
      for (const listener of this.listeners) listener();
    } catch {
      /* unreachable server — chips keep their pending state; onopen retries for us */
    }
  }
}
