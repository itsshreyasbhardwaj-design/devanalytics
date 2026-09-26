/**
 * LLM access.
 *
 * Optional by design. With no API key configured, `OpenRouterClient.available`
 * is false, nothing is called, no money is spent, and the AI surface falls back
 * to the deterministic explainer — which is grounded in the same evidence and
 * requires no model at all. The model is a writing aid layered on top of a
 * working analytics engine, never the thing producing the numbers.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  readonly available: boolean;
  readonly model: string;
  complete(messages: LlmMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

export class DisabledLlmClient implements LlmClient {
  readonly available = false;
  readonly model = 'none';
  async complete(): Promise<string> {
    throw new Error('No LLM configured. Set OPENROUTER_API_KEY to enable narration.');
  }
}

export interface OpenRouterOptions {
  apiKey?: string | undefined;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Hard ceiling on tokens per request, so a long evidence bundle cannot run away. */
  maxTokens?: number;
  timeoutMs?: number;
}

export class OpenRouterClient implements LlmClient {
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: OpenRouterOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.model = opts.model ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-haiku';
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxTokens = opts.maxTokens ?? 1200;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(messages: LlmMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<string> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'DevAnalytics',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: Math.min(opts.maxTokens ?? this.maxTokens, this.maxTokens),
          // Narration restates verified facts; sampling adds nothing but risk.
          temperature: opts.temperature ?? 0,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenRouter returned no content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
