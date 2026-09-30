/**
 * Infrastructure layer: OpenAI-compatible chat completions over the built-in
 * Node `fetch` (no axios, no SDK). Also hosts the shared LLM protocol types
 * reused by the local client.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class LlmClientError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export interface CloudClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** `fetch` with an AbortController-backed timeout, wired to a cancellation token. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export function requireOk(response: Response, context: string): void {
  if (response.ok) {
    return;
  }
  throw new LlmClientError(
    `${context} failed with HTTP ${response.status} ${response.statusText}`.trim(),
    response.status
  );
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: CloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isConfigured(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async complete(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new LlmClientError(
        'Cloud API key is empty. Set "aiio.cloudApiKey" or disable local routing.'
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.2,
      stream: false,
    });

    const response = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers, body },
      this.timeoutMs,
      signal
    );
    requireOk(response, 'Cloud chat completion');

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new LlmClientError('Cloud response did not contain any choice text');
    }

    return {
      text,
      model: payload.model ?? this.model,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
    };
  }
}