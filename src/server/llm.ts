/**
 * The LLM client — a thin fetch against any OpenAI-compatible
 * `/chat/completions` endpoint. No framework: every local runner (Ollama, LM Studio, vLLM)
 * speaks this dialect, and cloud use is the same three env vars pointed elsewhere, explicitly.
 *
 * OFF by default — `LLM_BASE_URL` unset means the propose pass is simply not available and
 * nothing ever leaves the machine (the privacy default). Config:
 *   LLM_BASE_URL  e.g. http://localhost:11434/v1   (required to enable)
 *   LLM_MODEL     e.g. llama3.1:8b                 (required to enable)
 *   LLM_API_KEY   optional bearer token (cloud endpoints)
 */

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The live env config, or undefined when the LLM layer is disabled. */
export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return undefined;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}) };
}

/**
 * One chat call that must answer with a single JSON object (we instruct it, then parse
 * defensively — fenced or bare). Throws on transport errors or unparseable output; callers
 * treat that as a skipped step (failure isolation, like every adapter).
 */
export async function chatJson(
  cfg: LlmConfig,
  system: string,
  user: string,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const res = await fetcher(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${system}\nAnswer with a single JSON object and nothing else.` },
        // The format demand is REPEATED after the user content: on a long input (24k chars of
        // page text) a small model forgets top-of-prompt instructions and answers the text
        // instead — a prose summary, no JSON (observed live). Instructions at the
        // end survive long contexts.
        { role: 'user', content: `${user}\n\nAnswer with a single JSON object and nothing else.` },
      ],
    }),
  });
  if (!res.ok) {
    // Surface the endpoint's own message ("credit balance is too low", "model not found") —
    // a bare status code sent one owner debugging blind.
    const detail = await res.text().then(
      (t) => {
        try {
          const parsed = JSON.parse(t) as { error?: { message?: string } };
          return parsed.error?.message ?? t;
        } catch {
          return t;
        }
      },
      () => '',
    );
    throw new Error(`llm: ${res.status} ${detail.slice(0, 200) || res.statusText}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? '';
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1]! : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`llm: no JSON object in the reply — got: ${raw.slice(0, 160) || '(empty)'}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}
