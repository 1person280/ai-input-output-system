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

export interface CloudModelsResult {
  ok: boolean;
  /** Model ids advertised by the endpoint (best effort). */
  models: string[];
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Extract the URL hostname (no port) without throwing ('' when unknown). */
function extractHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

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

  /**
   * True for OpenAI-compatible endpoints that need no key (Ollama, llama.cpp,
   * LM Studio). A missing key is therefore only an error for real cloud
   * providers, which is what `listModels` surfaces to the UI.
   */
  get isKeylessEndpoint(): boolean {
    const host = extractHost(this.baseUrl);
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1'
    );
  }

  /**
   * Probe `GET /models` so the UI can verify the endpoint and offer the model
   * names it advertises. Best effort: any non-2xx or unparsable body returns
   * `{ ok: false }` with a readable reason instead of throwing.
   */
  async listModels(signal?: AbortSignal): Promise<CloudModelsResult> {
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/models`,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
        8_000,
        signal
      );
      if (!response.ok) {
        return {
          ok: false,
          models: [],
          error: `HTTP ${response.status} ${response.statusText}`.trim(),
        };
      }
      const payload = (await response.json()) as {
        data?: Array<{ id?: string; name?: string }>;
      };
      // OpenAI servers advertise `id`; llama.cpp's /v1/models uses `name`.
      const models = (payload.data ?? [])
        .map((entry) => entry.id ?? entry.name)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      return { ok: true, models };
    } catch (error) {
      return {
        ok: false,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async complete(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    if (!this.apiKey && !this.isKeylessEndpoint) {
      throw new LlmClientError(
        'Cloud API key is empty. Set "aiio.cloudApiKey", point "aiio.cloudBaseUrl" at a local OpenAI-compatible server (e.g. Ollama at http://localhost:11434/v1), or disable local routing.'
      );
    }

    const headers = this.authHeaders();

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