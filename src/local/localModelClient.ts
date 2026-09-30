/**
 * Infrastructure layer: talks to a locally running llama.cpp `llama-server`.
 *
 * Prefers the OpenAI-compatible `/v1/chat/completions` endpoint and can fall
 * back to the native `/completion` endpoint.
 */

import {
  ChatMessage,
  CompletionResult,
  LlmClientError,
  fetchWithTimeout,
  requireOk,
} from '../cloud/cloudClient';

export interface LocalModelClientOptions {
  serverUrl: string;
  /** Context window advertised to the server; must match the launched process. */
  contextTokens?: number;
  timeoutMs?: number;
}

export type LocalEndpoint = 'chat-completions' | 'completion';

const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 65536;

function flatten(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const label =
        message.role === 'system'
          ? 'System'
          : message.role === 'assistant'
            ? 'Assistant'
            : 'User';
      return `${label}: ${message.content}`;
    })
    .join('\n\n');
}

export class LocalModelClient {
  private readonly serverUrl: string;
  readonly contextTokens: number;
  private readonly timeoutMs: number;

  constructor(options: LocalModelClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.contextTokens = options.contextTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Cheap liveness probe used before routing a request locally. */
  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${this.serverUrl}/health`,
        { method: 'GET' },
        2_000,
        signal
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(
    messages: ChatMessage[],
    endpoint: LocalEndpoint = 'chat-completions',
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    return endpoint === 'completion'
      ? this.completeViaLegacyEndpoint(messages, signal)
      : this.completeViaChatEndpoint(messages, signal);
  }

  private async completeViaChatEndpoint(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const body = JSON.stringify({
      messages,
      temperature: 0.2,
      stream: false,
      max_tokens: 1024,
    });
    const response = await fetchWithTimeout(
      `${this.serverUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      this.timeoutMs,
      signal
    );
    requireOk(response, 'Local chat completion');

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new LlmClientError('Local server returned no completion text');
    }
    return {
      text,
      model: payload.model ?? 'local-gguf',
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
    };
  }

  private async completeViaLegacyEndpoint(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const body = JSON.stringify({
      prompt: flatten(messages),
      temperature: 0.2,
      stream: false,
      n_predict: 1024,
    });
    const response = await fetchWithTimeout(
      `${this.serverUrl}/completion`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      this.timeoutMs,
      signal
    );
    requireOk(response, 'Local legacy completion');

    const payload = (await response.json()) as {
      content?: string;
      model?: string;
      tokens_predicted?: number;
    };
    if (typeof payload.content !== 'string') {
      throw new LlmClientError('Local server returned no completion content');
    }
    return {
      text: payload.content,
      model: payload.model ?? 'local-gguf',
      completionTokens: payload.tokens_predicted,
    };
  }
}